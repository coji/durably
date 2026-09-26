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
import { branchCommit, repoRoot, resolveCommit } from './engine/git.js'
import { parseProviderName } from './engine/providers/index.js'
import {
  assertSingleMode,
  fixProfile,
  type AgentLoopInput,
  nonBlank,
  resolveTimeouts,
  timeoutMsSchema,
  type FixedProfile,
} from './factory/job.js'
import {
  DEFAULT_COMMIT_SETTINGS,
  type CommitSettings,
  type InputFileRef,
  type RepoTargetConfig,
} from './factory/target.js'
import type { FactorySetup, ProfileRole } from './factory/types.js'

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

/** How the run's commits are made; every field optional. */
const commitConfigSchema = z
  .object({
    authorName: nonBlank.optional(),
    authorEmail: nonBlank.optional(),
    /** `{iteration}`, `{runId}` and `{task}` are replaced. */
    messageTemplate: nonBlank.optional(),
    /** With `--publish`, publish the squashed branch instead. */
    publishSquashed: z.boolean().optional(),
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
        /** Repair's own settings; repair runs on `code` when absent. */
        repair: roleConfigSchema.optional(),
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
    /** Commit author, message template, and the branch `--publish` pushes. */
    commit: commitConfigSchema.optional(),
  })
  .strict()

type FactoryConfig = z.infer<typeof factoryConfigSchema>

/**
 * A loaded config, the file it came from, whether `--config` named that
 * file, and the file's SHA-256.
 */
interface LoadedConfig {
  config: FactoryConfig
  path: string
  explicit: boolean
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
    explicit: Boolean(explicit),
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
 * Repair is the exception: what it leaves out comes from the code profile.
 * Presets are applied here, so a bad effort fails before the run exists.
 */
export function resolveProfiles(
  a: Record<string, string>,
  config: FactoryConfig | null,
): {
  roles: Record<ProfileRole, FixedProfile>
  triage: FixedProfile | null
  repair: FixedProfile | null
} {
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
  // Repair has its own profile only when the config names one; otherwise it
  // runs on code's, continuing the implementation session in reuse mode. A
  // field it leaves out comes from the resolved code profile, not from the
  // flags, so `{ "effort": "high" }` changes the effort and nothing else. On
  // another provider, code's model and effort do not apply, and that
  // provider's defaults fill in.
  const repairConfig = config?.profiles?.repair
  const repairProvider = repairConfig?.provider ?? roles.code.provider
  const sameAsCode = repairProvider === roles.code.provider
  const repair = repairConfig
    ? fixProfile({
        provider: repairProvider,
        model:
          repairConfig.model ?? (sameAsCode ? roles.code.requestedModel : null),
        effort:
          repairConfig.effort ??
          (sameAsCode ? roles.code.requestedEffort : null),
      })
    : null
  assertSingleMode({
    ...roles,
    ...(triage ? { triage } : {}),
    ...(repair ? { repair } : {}),
  })
  return { roles, triage, repair }
}

/** The trigger flags a config can be overridden by, kept for a reload. */
const CONFIG_FLAGS = ['provider', 'check', 'setup', 'base'] as const

/**
 * Where a repository run's settings came from: the config file it read, or
 * null when there was none, whether `--config` named it, and the flags that
 * won over it. A reload reads the file again and applies the same flags.
 */
export interface ConfigSource {
  path: string | null
  /** Named by `--config`, so a reload that cannot find it fails. */
  explicit?: boolean
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
  const commit = config?.commit
  return {
    settings: {
      baseRef: a['base'] ?? config?.base ?? 'HEAD',
      checkCommand,
      setupCommand:
        setupCommand && setupCommand.length > 0 ? setupCommand : null,
      baselineCheck: config?.baselineCheck ?? false,
      // Fixed here with every default filled in, so the run never reads
      // factory.json again and a reload reads it afresh.
      commit: {
        authorName: commit?.authorName ?? null,
        authorEmail: commit?.authorEmail ?? null,
        messageTemplate: commit?.messageTemplate ?? null,
        publishSquashed: commit?.publishSquashed ?? false,
      },
    },
    codexPath: await resolveCodexPath(loaded),
    configSource: {
      path: loaded?.path ?? null,
      explicit: loaded?.explicit ?? false,
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
  const { roles: profiles, triage, repair } = resolveProfiles(a, config)
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
      ...(repair ? { repair: requested(repair) } : {}),
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
  repairOf?: unknown
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
  if (stored.repairOf)
    throw new Error(
      "--reload-config does not apply to a repair run: it keeps its parent's settings. To run with other settings, start a normal run with trigger",
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
  // A file named by --config must still exist. The default factory.json is
  // read as a trigger reads it, so one removed since means no config. A run
  // stored before `explicit` was kept counts any other path as named.
  const named =
    source.explicit ??
    (source.path !== null && source.path !== join(root, 'factory.json'))
  const explicit = named && source.path ? source.path : undefined
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

/** The outside findings and optional dispositions a repair run is given. */
export interface RepairFiles {
  findings: { content: string; ref: InputFileRef }
  dispositions: { content: string; ref: InputFileRef } | null
}

/**
 * Read `demo repair`'s input files once, with the same limits as trigger's:
 * at most 256 KiB, UTF-8, not blank. `--reload-config` is refused: a repair
 * run takes its parent's stored settings, and nothing else.
 */
export async function readRepairFiles(
  a: Record<string, string>,
): Promise<RepairFiles> {
  if (a['reload-config'] !== undefined)
    throw new Error(
      "repair keeps the parent run's stored settings; --reload-config is not accepted. To run with other settings, start a normal run with trigger",
    )
  const findings = a['findings-file']
  if (!findings) throw new Error('--findings-file <path> required')
  const dispositions = a['dispositions-file']
  return {
    findings: await readInputFile('findings-file', findings),
    dispositions: dispositions
      ? await readInputFile('dispositions-file', dispositions)
      : null,
  }
}

/** The parts of a stored parent run a repair run is built from. */
export interface RepairParent {
  id: string
  status: string
  input: unknown
  output: unknown
}

interface StoredRepairInput {
  provider?: string
  model?: string
  effort?: string
  profiles?: Record<string, unknown>
  codexPath?: string | null
  target?: {
    kind?: string
    inputFiles?: {
      task?: InputFileRef | null
      spec?: InputFileRef | null
      dispositions?: InputFileRef | null
    }
    commit?: CommitSettings
    baselineCheck?: boolean
  }
}

type RepoSetup = FactorySetup & { target: RepoTargetConfig }

interface StoredOutput {
  approved?: boolean
  conclusion?: string
  candidate?: { commit?: string; branch?: string } | null
  delivery?: { commit?: string | null } | null
}

/**
 * The parent's candidate, when the parent may be repaired: a repository run
 * that completed approved and delivered its last candidate. Anything else,
 * including a run that stopped with a candidate, is refused.
 */
export function repairableCandidate(
  parent: RepairParent,
  setup: unknown,
): {
  setup: RepoSetup
  commit: string
  branch: string
} {
  const refuse = (why: string) =>
    new Error(`refusing to repair ${parent.id}: ${why}`)
  const input = parent.input as StoredRepairInput | null
  if (input?.target?.kind !== 'repo') throw refuse('it is not a repository run')
  if (parent.status !== 'completed')
    throw refuse(`it is ${parent.status}, not completed`)
  const output = parent.output as StoredOutput | null
  if (output?.conclusion !== 'approved' || output.approved !== true)
    throw refuse(
      `its conclusion is ${output?.conclusion ?? 'unknown'}, not approved`,
    )
  const commit = output.candidate?.commit
  const branch = output.candidate?.branch
  if (!commit || !branch) throw refuse('it recorded no candidate commit')
  const delivered = output.delivery?.commit
  if (!delivered) throw refuse('it recorded no delivery')
  if (delivered !== commit)
    throw refuse(
      `its delivered commit ${delivered.slice(0, 12)} is not its last candidate ${commit.slice(0, 12)}`,
    )
  const stored = setup as Partial<FactorySetup> | null
  if (stored?.target?.kind !== 'repo' || !stored.profiles)
    throw refuse('its setup record is missing')
  return {
    setup: stored as RepoSetup,
    commit,
    branch,
  }
}

/**
 * The candidate commit must still be in the repository and still be the tip
 * of the branch the parent recorded. A branch moved since means someone
 * changed the work after approval, so nothing is started from it.
 */
export async function assertCandidateUnmoved(
  repoPath: string,
  commit: string,
  branch: string,
): Promise<void> {
  let found: string
  try {
    found = await resolveCommit(repoPath, commit)
  } catch {
    throw new Error(
      `candidate commit ${commit.slice(0, 12)} is not in ${repoPath}`,
    )
  }
  if (found !== commit)
    throw new Error(
      `candidate commit ${commit.slice(0, 12)} is not in ${repoPath}`,
    )
  const tip = await branchCommit(repoPath, branch)
  if (tip !== commit)
    throw new Error(
      tip
        ? `candidate branch ${branch} moved to ${tip.slice(0, 12)}; the parent's candidate is ${commit.slice(0, 12)}`
        : `candidate branch ${branch} no longer exists in ${repoPath}`,
    )
}

const sha256Of = (text: string) =>
  createHash('sha256').update(text).digest('hex')

/**
 * A repair run's input: everything the parent stored and resolved, based on
 * its candidate commit, with the findings stored as untrusted input. Nothing
 * comes from the current factory.json or this process's environment. A value
 * a parent's setup predates is taken from the parent's stored input.
 *
 * Dispositions replace the parent's when given and are inherited otherwise.
 * The idempotency key names the parent and the SHA-256 of the findings and
 * of the dispositions the child really gets, so the same content from
 * another path returns the same run.
 */
export function buildRepairInput(
  parent: RepairParent,
  setup: unknown,
  files: RepairFiles,
  /** Demo and test only: the fake provider's behavior for the child. */
  fakeScenario?: unknown,
) {
  const { setup: stored, commit, branch } = repairableCandidate(parent, setup)
  const parentInput = parent.input as StoredRepairInput
  const t = stored.target
  const storedFiles = parentInput.target?.inputFiles ?? {}
  const dispositions = files.dispositions
    ? files.dispositions.content
    : t.dispositions
  const dispositionsRef = files.dispositions
    ? files.dispositions.ref
    : (storedFiles.dispositions ?? null)
  // A value the parent's setup recorded is inherited as it is, null
  // included; only a setup from before the value existed falls back to the
  // parent's stored input.
  const recorded = <T extends object, K extends keyof T, V>(
    record: T,
    key: K,
    fallback: () => V,
  ): T[K] | V => (key in record ? record[key] : fallback())
  const input = {
    provider: (parentInput.provider ??
      stored.profiles.code.provider) as AgentLoopInput['provider'],
    ...(parentInput.model !== undefined ? { model: parentInput.model } : {}),
    ...(parentInput.effort !== undefined ? { effort: parentInput.effort } : {}),
    context: stored.contextMode,
    maxIterations: stored.maxIterations,
    // The requested settings, for the report's profile rows; the worker
    // uses the resolved ones in `repairOf`.
    ...(parentInput.profiles
      ? { profiles: parentInput.profiles as AgentLoopInput['profiles'] }
      : {}),
    target: {
      kind: 'repo' as const,
      repoPath: t.repoPath,
      baseRef: commit,
      task: t.task,
      spec: t.spec,
      dispositions,
      inputFiles: {
        task: storedFiles.task ?? null,
        spec: storedFiles.spec ?? null,
        dispositions: dispositionsRef,
      },
      issue: t.issue,
      checkCommand: t.checkCommand,
      setupCommand: t.setupCommand,
      publish: t.publish,
      commit: recorded(
        t,
        'commit',
        () => parentInput.target?.commit ?? DEFAULT_COMMIT_SETTINGS,
      ),
      baselineCheck: recorded(
        stored,
        'baselineCheck',
        () => parentInput.target?.baselineCheck ?? false,
      ),
    },
    autoApprove: stored.autoApprove,
    checkTimeoutMs: t.checkTimeoutMs,
    agentTimeoutMs: stored.agentTimeoutMs,
    codexPath: recorded(
      stored,
      'codexPath',
      () => parentInput.codexPath ?? null,
    ),
    ...(fakeScenario !== undefined
      ? { fakeScenario: fakeScenario as AgentLoopInput['fakeScenario'] }
      : {}),
    repairOf: {
      runId: parent.id,
      candidateCommit: commit,
      candidateBranch: branch,
      findings: files.findings.content,
      findingsFile: files.findings.ref,
      profiles: {
        code: stored.profiles.code,
        correctness: stored.profiles.correctness,
        'edge-cases': stored.profiles['edge-cases'],
        repair: stored.repair ?? null,
        // Recorded like the parent's; the worker never runs it for a
        // repair run.
        triage: stored.triage ?? null,
      },
    },
  } satisfies AgentLoopInput
  const idempotencyKey = [
    `repair-of-${parent.id}`,
    `findings-${sha256Of(files.findings.content)}`,
    `dispositions-${dispositions ? sha256Of(dispositions) : 'none'}`,
  ].join('-')
  return { input, idempotencyKey }
}

/** The reads `startableRepair` makes. */
export interface RepairSource {
  getRun(id: string): Promise<RepairParent | null>
  storage: {
    getCompletedStep(
      runId: string,
      name: string,
    ): Promise<{ output: unknown } | null>
  }
}

/**
 * Read a parent run, refuse it unless it may be repaired and its candidate
 * branch is unmoved, and build the child's input. Nothing is triggered.
 */
export async function startableRepair(
  durably: RepairSource,
  parentId: string,
  files: RepairFiles,
  /** Demo and test only: the fake provider's behavior for the child. */
  fakeScenario?: unknown,
): Promise<ReturnType<typeof buildRepairInput>> {
  const parent = await durably.getRun(parentId)
  if (!parent) throw new Error(`no run ${parentId}`)
  const setup = (await durably.storage.getCompletedStep(parentId, 'setup'))
    ?.output
  const built = buildRepairInput(parent, setup, files, fakeScenario)
  const { target, repairOf } = built.input
  await assertCandidateUnmoved(
    target.repoPath,
    target.baseRef,
    repairOf.candidateBranch,
  )
  return built
}
