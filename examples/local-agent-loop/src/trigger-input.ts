/**
 * Build a run's input from trigger flags and the repository's factory.json.
 * Shared by `demo trigger` and `demo seed`, so both fix a run the same way.
 */
import { constants, existsSync } from 'node:fs'
import { access, readFile, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { z } from 'zod'

import { runChild } from './engine/child.js'
import { repoRoot } from './engine/git.js'
import { parseProviderName } from './engine/providers/index.js'
import {
  assertSingleMode,
  DEFAULT_TIMEOUTS,
  fixProfile,
  positiveTimeout,
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

/** A loaded config and the directory its relative paths start from. */
interface LoadedConfig {
  config: FactoryConfig
  path: string
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
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new Error(`${path}: not valid JSON (${(error as Error).message})`)
  }
  const parsed = factoryConfigSchema.safeParse(raw)
  if (!parsed.success)
    throw new Error(`${path}: invalid factory config: ${parsed.error.message}`)
  return { config: parsed.data, path }
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
    }
  }
  const repoPath = isAbsolute(repo) ? repo : join(process.cwd(), repo)
  const loaded = await loadConfig(await repoRoot(repoPath), a['config'])
  const config = loaded?.config ?? null
  const checkCommand = a['check'] ? splitArgv(a['check']) : config?.check
  if (!checkCommand || checkCommand.length === 0)
    throw new Error(
      'a check command is required for --repo: set "check" in factory.json or pass --check "<command>". It is the pinned check that decides pass or fail',
    )
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
  const setupCommand = a['setup'] ? splitArgv(a['setup']) : config?.setup
  return {
    target: {
      kind: 'repo' as const,
      repoPath,
      baseRef: a['base'] ?? config?.base ?? 'HEAD',
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
      checkCommand,
      setupCommand:
        setupCommand && setupCommand.length > 0 ? setupCommand : null,
      publish: a['publish'] === 'true',
      baselineCheck: config?.baselineCheck ?? false,
    },
    config,
    codexPath: await resolveCodexPath(loaded),
  }
}

/**
 * Everything the run depends on, read and resolved before it exists: the
 * worker never reads factory.json or an input file again.
 */
export async function buildTriggerInput(a: Record<string, string>) {
  const context = a['context'] ?? 'reuse'
  if (context !== 'reuse' && context !== 'fresh')
    throw new Error('--context must be reuse|fresh')
  // Math.min/Math.max propagate NaN rather than clamping it, so a non-numeric
  // value would reach the job schema as NaN and surface as a zod stack trace.
  const rawIterations = a['max-iterations'] ?? '2'
  if (!/^[1-3]$/.test(rawIterations))
    throw new Error('--max-iterations must be an integer between 1 and 3')
  const maxIterations = Number(rawIterations)
  const { target, config, codexPath } = await resolveTarget(a)
  const { roles: profiles, triage } = resolveProfiles(a, config)
  // Fixed here, so the worker's environment never changes a stored run: the
  // config wins, then this process's environment, then the target default.
  const defaults = DEFAULT_TIMEOUTS[target.kind]
  const checkTimeoutMs =
    config?.checkTimeoutMs ??
    positiveTimeout('TEST_TIMEOUT_MS', defaults.checkTimeoutMs)
  const agentTimeoutMs =
    config?.agentTimeoutMs ??
    positiveTimeout('AGENT_TIMEOUT_MS', defaults.agentTimeoutMs)
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
  }
}
