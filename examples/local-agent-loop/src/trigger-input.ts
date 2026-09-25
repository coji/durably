/**
 * Build a run's input from trigger flags and the repository's factory.json.
 * Shared by `demo trigger` and `demo seed`, so both fix a run the same way.
 */
import { createHash } from 'node:crypto'
import { constants, existsSync } from 'node:fs'
import { access, readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { z } from 'zod'

import { runChild } from './engine/child.js'
import { repoRoot } from './engine/git.js'
import { parseProviderName } from './engine/providers/index.js'
import {
  assertSingleMode,
  fixProfile,
  resolveTimeouts,
  timeoutMsSchema,
  type FixedProfile,
} from './factory/job.js'
import type { InputFileRef } from './factory/target.js'
import type { ProfileRole } from './factory/types.js'

interface IssueRef {
  number: number
  title: string
  url: string
  body: string
}

/** Read one issue through the user's own `gh` login. */
async function fetchIssue(repoPath: string, number: string): Promise<IssueRef> {
  const res = await runChild(
    'gh',
    ['issue', 'view', number, '--json', 'number,title,url,body'],
    { cwd: repoPath, timeoutMs: 60000 },
  )
  if (res.code !== 0)
    throw new Error(
      `gh issue view ${number} failed (${res.code ?? 'null'}): ${res.stderr.slice(-500)}`,
    )
  const parsed = JSON.parse(res.stdout) as IssueRef
  if (typeof parsed.number !== 'number' || typeof parsed.body !== 'string')
    throw new Error(`unexpected gh issue payload for ${number}`)
  return parsed
}

const roleConfigSchema = z
  .object({
    provider: z.enum(['codex', 'claude', 'fake']).optional(),
    model: z.string().min(1).optional(),
    effort: z.string().min(1).optional(),
  })
  .strict()

/**
 * `factory.json`: what stays the same for every run against one repository.
 * Everything is optional here; `check` is required once flags are applied.
 */
const factoryConfigSchema = z
  .object({
    check: z.array(z.string().min(1)).min(1).optional(),
    setup: z.array(z.string().min(1)).min(1).optional(),
    base: z.string().min(1).optional(),
    profiles: z
      .object({
        code: roleConfigSchema.optional(),
        review: z
          .object({
            correctness: roleConfigSchema.optional(),
            'edge-cases': roleConfigSchema.optional(),
          })
          .strict()
          .optional(),
        /** Shadow triage before the code stage; no triage call when absent. */
        triage: roleConfigSchema.optional(),
      })
      .strict()
      .optional(),
    /** Run `check` once on the base commit before any agent call. */
    baselineCheck: z.boolean().optional(),
    /** The Codex CLI file to launch; relative to this file's directory. */
    codexPath: z.string().min(1).optional(),
    /** Milliseconds; win over `TEST_TIMEOUT_MS` / `AGENT_TIMEOUT_MS`. */
    checkTimeoutMs: timeoutMsSchema.optional(),
    agentTimeoutMs: timeoutMsSchema.optional(),
  })
  .strict()

type FactoryConfig = z.infer<typeof factoryConfigSchema>

/** A loaded config, the file it came from, and that file's SHA-256. */
interface LoadedConfig {
  config: FactoryConfig
  path: string
  sha256: string
}
type RoleConfig = z.infer<typeof roleConfigSchema>

/**
 * Load the repository's config: `--config <path>` when given, otherwise
 * `factory.json` at the repository root if there is one. Relative paths are
 * taken from the directory the command runs in.
 */
async function loadConfig(
  root: string,
  explicit: string | undefined,
): Promise<LoadedConfig | null> {
  const path = explicit ? resolve(explicit) : join(root, 'factory.json')
  if (!existsSync(path)) {
    if (explicit) throw new Error(`--config ${explicit}: file not found`)
    return null
  }
  const text = await readFile(path, 'utf8')
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (error) {
    throw new Error(`${path}: not valid JSON (${(error as Error).message})`)
  }
  const parsed = factoryConfigSchema.safeParse(raw)
  if (!parsed.success)
    throw new Error(`${path}: invalid factory config: ${parsed.error.message}`)
  return {
    config: parsed.data,
    path,
    sha256: createHash('sha256').update(text).digest('hex'),
  }
}

/**
 * The config's `codexPath` as an absolute path, checked once here: a relative
 * path is taken from the config file's directory, and the file must be an
 * executable regular file. The run keeps the result, so every preflight,
 * call and version probe launches this same file.
 */
async function resolveCodexPath(
  loaded: LoadedConfig | null,
): Promise<string | null> {
  const raw = loaded?.config.codexPath
  if (!loaded || raw === undefined) return null
  const abs = isAbsolute(raw) ? raw : resolve(dirname(loaded.path), raw)
  const refuse = (why: string) =>
    new Error(`${loaded.path}: codexPath ${raw}: ${why} (resolved to ${abs})`)
  let file
  try {
    file = await stat(abs)
  } catch {
    throw refuse('file not found')
  }
  if (!file.isFile()) throw refuse('not a regular file')
  try {
    await access(abs, constants.X_OK)
  } catch {
    throw refuse('not executable')
  }
  return abs
}

/** Input files are stored in the run and sent in every prompt, so keep them small. */
const MAX_INPUT_FILE_BYTES = 256 * 1024

/**
 * Read one input file once, here, before the run exists. The worker only ever
 * sees the content stored in the run input, so editing the file afterwards
 * changes nothing about the run. The content is not parsed. Its SHA-256 is
 * computed from the stored content when the report is built.
 */
async function readInputFile(
  flag: string,
  path: string,
): Promise<{ content: string; ref: InputFileRef }> {
  const abs = resolve(path)
  let size: number
  try {
    size = (await stat(abs)).size
  } catch {
    throw new Error(`--${flag} ${path}: cannot read file`)
  }
  // Check the size before reading, so a huge file is never loaded.
  if (size > MAX_INPUT_FILE_BYTES)
    throw new Error(
      `--${flag} ${path}: file is ${size} bytes; the limit is 256 KiB`,
    )
  let bytes: Buffer
  try {
    bytes = await readFile(abs)
  } catch {
    throw new Error(`--${flag} ${path}: cannot read file`)
  }
  if (bytes.length > MAX_INPUT_FILE_BYTES)
    throw new Error(
      `--${flag} ${path}: file is ${bytes.length} bytes; the limit is 256 KiB`,
    )
  let content: string
  try {
    // Keep a byte order mark, so the stored text hashes like the file does.
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
      bytes,
    )
  } catch {
    throw new Error(`--${flag} ${path}: not UTF-8 text`)
  }
  if (content.trim().length === 0)
    throw new Error(`--${flag} ${path}: file is empty`)
  return { content, ref: { path: abs } }
}

function splitArgv(value: string): string[] {
  return value.split(/\s+/).filter((part) => part.length > 0)
}

/**
 * Fix each role's settings. A role the config names keeps what it names. A
 * role it does not name uses `--provider`, `--model` and `--effort`. A field a
 * named role leaves out comes from `--model` / `--effort` when the role uses
 * the `--provider` provider, and otherwise from that provider's defaults.
 * Presets are applied here, so a bad effort fails before the run exists.
 */
export function resolveProfiles(
  a: Record<string, string>,
  config: FactoryConfig | null,
): { roles: Record<ProfileRole, FixedProfile>; triage: FixedProfile | null } {
  const fallbackProvider = parseProviderName(a['provider'] ?? 'fake')
  const fix = (role: RoleConfig | undefined) => {
    const provider = role?.provider ?? fallbackProvider
    // --model and --effort name the fallback provider's settings; a role on
    // another provider gets that provider's own default instead.
    const inherit = provider === fallbackProvider
    return fixProfile({
      provider,
      model: role?.model ?? (inherit ? a['model'] : undefined) ?? null,
      effort: role?.effort ?? (inherit ? a['effort'] : undefined) ?? null,
    })
  }
  const roles = {
    code: fix(config?.profiles?.code),
    correctness: fix(config?.profiles?.review?.correctness),
    'edge-cases': fix(config?.profiles?.review?.['edge-cases']),
  }
  // Triage runs only when the config names it; even `{}` turns it on and
  // takes the fallback settings like any other role.
  const triageConfig = config?.profiles?.triage
  const triage = triageConfig ? fix(triageConfig) : null
  assertSingleMode({ ...roles, ...(triage ? { triage } : {}) })
  return { roles, triage }
}

/** The trigger flags a config can be overridden by, kept for a reload. */
const CONFIG_FLAGS = ['provider', 'check', 'setup', 'base'] as const

/**
 * Where a repository run's settings came from: the config file it read, or
 * null when there was none, and the flags that won over it. A reload reads
 * the file again and applies the same flags.
 */
export interface ConfigSource {
  path: string | null
  flags: Partial<Record<(typeof CONFIG_FLAGS)[number], string>>
}

/**
 * Everything a repository run takes from the config and the flags that
 * override it. Shared by trigger and `retrigger --reload-config`, so both
 * resolve and validate the same way.
 */
async function repoSettings(
  a: Record<string, string>,
  loaded: LoadedConfig | null,
) {
  const config = loaded?.config ?? null
  const checkCommand = a['check'] ? splitArgv(a['check']) : config?.check
  if (!checkCommand || checkCommand.length === 0)
    throw new Error(
      'a check command is required for --repo: set "check" in factory.json or pass --check "<command>". It is the pinned check that decides pass or fail',
    )
  const setupCommand = a['setup'] ? splitArgv(a['setup']) : config?.setup
  return {
    settings: {
      baseRef: a['base'] ?? config?.base ?? 'HEAD',
      checkCommand,
      setupCommand:
        setupCommand && setupCommand.length > 0 ? setupCommand : null,
      baselineCheck: config?.baselineCheck ?? false,
    },
    codexPath: await resolveCodexPath(loaded),
    configSource: {
      path: loaded?.path ?? null,
      flags: {
        ...Object.fromEntries(
          CONFIG_FLAGS.flatMap((flag) =>
            a[flag] === undefined ? [] : [[flag, a[flag]]],
          ),
        ),
        // The fallback provider as applied, so a reload fills the roles the
        // config leaves out the same way.
        provider: a['provider'] ?? 'fake',
      },
    } satisfies ConfigSource,
  }
}

/**
 * Build the job's target from the flags and the repository's config.
 *
 * A check command is required for a repository target and is recorded before
 * the agent starts, so nothing the agent edits can change what grading runs.
 * A flag value is argv split on whitespace, not a shell line; a config value
 * is already argv. Flags win over the config.
 */
export async function resolveTarget(a: Record<string, string>) {
  const repo = a['repo']
  if (!repo) {
    for (const flag of [
      'issue',
      'task',
      'task-file',
      'spec-file',
      'dispositions-file',
      'config',
    ]) {
      if (a[flag]) throw new Error(`--${flag} needs --repo <path>`)
    }
    return {
      target: { kind: 'subject' as const },
      config: null,
      codexPath: null,
      configSource: null,
    }
  }
  const repoPath = isAbsolute(repo) ? repo : join(process.cwd(), repo)
  const loaded = await loadConfig(await repoRoot(repoPath), a['config'])
  const { settings, codexPath, configSource } = await repoSettings(a, loaded)
  const sources = ['issue', 'task', 'task-file'].filter((flag) => a[flag])
  if (sources.length > 1)
    throw new Error(
      `pass one of --issue, --task or --task-file, not ${sources.map((f) => `--${f}`).join(' and ')}`,
    )
  if (sources.length === 0)
    throw new Error(
      '--repo needs --issue <number>, --task "<text>" or --task-file <path>',
    )
  const taskFile = a['task-file']
    ? await readInputFile('task-file', a['task-file'])
    : null
  const specFile = a['spec-file']
    ? await readInputFile('spec-file', a['spec-file'])
    : null
  const dispositionsFile = a['dispositions-file']
    ? await readInputFile('dispositions-file', a['dispositions-file'])
    : null
  const issueNumber = a['issue']
  const issue = issueNumber
    ? await fetchIssue(repoPath, issueNumber.replace(/^#/, ''))
    : null
  const task = issue ? issue.body : (taskFile?.content ?? a['task'])
  if (!task || task.trim().length === 0)
    throw new Error('the task is empty; there is nothing to implement')
  return {
    target: {
      kind: 'repo' as const,
      repoPath,
      task,
      spec: specFile?.content ?? null,
      dispositions: dispositionsFile?.content ?? null,
      inputFiles: {
        task: taskFile?.ref ?? null,
        spec: specFile?.ref ?? null,
        dispositions: dispositionsFile?.ref ?? null,
      },
      issue: issue
        ? { number: issue.number, title: issue.title, url: issue.url }
        : null,
      publish: a['publish'] === 'true',
      ...settings,
    },
    config: loaded?.config ?? null,
    codexPath,
    configSource,
  }
}

type ResolvedTarget = Awaited<ReturnType<typeof resolveTarget>>

/**
 * The run input from a resolved target and the flags that are not about the
 * repository. Trigger and reload both end here.
 */
function assembleInput(a: Record<string, string>, resolved: ResolvedTarget) {
  const context = a['context'] ?? 'reuse'
  if (context !== 'reuse' && context !== 'fresh')
    throw new Error('--context must be reuse|fresh')
  // Math.min/Math.max propagate NaN rather than clamping it, so a non-numeric
  // value would reach the job schema as NaN and surface as a zod stack trace.
  const rawIterations = a['max-iterations'] ?? '2'
  if (!/^[1-3]$/.test(rawIterations))
    throw new Error('--max-iterations must be an integer between 1 and 3')
  const maxIterations = Number(rawIterations)
  const { target, config, codexPath, configSource } = resolved
  const { roles: profiles, triage } = resolveProfiles(a, config)
  // Fixed here, so the worker's environment never changes a stored run: the
  // config wins, then this process's environment, then the target default.
  const { checkTimeoutMs, agentTimeoutMs } = resolveTimeouts(
    target.kind,
    config,
  )
  const approve = a['approve']
  if (approve !== undefined && approve !== 'auto' && approve !== 'manual')
    throw new Error('--approve must be auto|manual')
  // Only the requested settings go into the run; the worker resolves them
  // again, the same way, so no stored effective value can disagree.
  const requested = (p: FixedProfile) => ({
    provider: p.provider,
    requestedModel: p.requestedModel,
    requestedEffort: p.requestedEffort,
  })
  return {
    provider: profiles.code.provider,
    profiles: {
      code: requested(profiles.code),
      correctness: requested(profiles.correctness),
      'edge-cases': requested(profiles['edge-cases']),
      ...(triage ? { triage: requested(triage) } : {}),
    },
    target,
    maxIterations,
    model: a['model'],
    effort: a['effort'],
    context: context as 'reuse' | 'fresh',
    ...(approve ? { autoApprove: approve === 'auto' } : {}),
    checkTimeoutMs,
    agentTimeoutMs,
    codexPath,
    ...(configSource ? { configSource } : {}),
  }
}

/**
 * Everything the run depends on, read and resolved before it exists: the
 * worker never reads factory.json or an input file again.
 */
export async function buildTriggerInput(a: Record<string, string>) {
  return assembleInput(a, await resolveTarget(a))
}

/** The parts of a stored run input a reload reads. */
interface StoredInput {
  provider: string
  model?: string
  effort?: string
  context?: string
  maxIterations?: number
  autoApprove?: boolean
  fakeScenario?: unknown
  configSource?: ConfigSource
  target: { kind: string; repoPath?: string }
}

/**
 * A new run input for `retrigger --reload-config`: the stored run's task,
 * spec, dispositions, issue and repository, with everything the config
 * decides read again from the current config file and resolved and checked
 * as at trigger. The file is the one the run read with `--config`;
 * otherwise `factory.json` at the repository root, if there is one now.
 * `configSha256` names the config version, so each version starts at most
 * one run.
 */
export async function reloadTriggerInput(stored: StoredInput): Promise<{
  input: ReturnType<typeof assembleInput> & { fakeScenario?: unknown }
  configSha256: string | null
}> {
  if (stored.target.kind !== 'repo' || !stored.target.repoPath)
    throw new Error(
      '--reload-config needs a repository run; the bundled sample reads no factory.json',
    )
  const source = stored.configSource ?? { path: null, flags: {} }
  const a: Record<string, string> = {
    // Only a run stored before the flags were kept lacks `provider`; its
    // code role's provider is what the flag would have been.
    provider: stored.provider,
    ...source.flags,
    ...(stored.model !== undefined ? { model: stored.model } : {}),
    ...(stored.effort !== undefined ? { effort: stored.effort } : {}),
    ...(stored.context !== undefined ? { context: stored.context } : {}),
    ...(stored.maxIterations !== undefined
      ? { 'max-iterations': String(stored.maxIterations) }
      : {}),
    ...(stored.autoApprove !== undefined
      ? { approve: stored.autoApprove ? 'auto' : 'manual' }
      : {}),
  }
  const repoPath = stored.target.repoPath
  const root = await repoRoot(repoPath)
  // The default factory.json is read as a trigger reads it, so one removed
  // since means no config rather than a missing --config file.
  const explicit =
    source.path && source.path !== join(root, 'factory.json')
      ? source.path
      : undefined
  const loaded = await loadConfig(root, explicit)
  const { settings, codexPath, configSource } = await repoSettings(a, loaded)
  const input = assembleInput(a, {
    target: {
      ...(stored.target as Extract<ResolvedTarget['target'], { kind: 'repo' }>),
      ...settings,
    },
    config: loaded?.config ?? null,
    codexPath,
    configSource,
  })
  return {
    input: {
      ...input,
      ...(stored.fakeScenario !== undefined
        ? { fakeScenario: stored.fakeScenario }
        : {}),
    },
    configSha256: loaded?.sha256 ?? null,
  }
}
