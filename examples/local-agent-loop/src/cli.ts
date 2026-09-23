#!/usr/bin/env tsx
/** CLI: worker | trigger | status | waits | approve | reject | report | compare */
import { existsSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Run } from '@coji/durably'
import { z } from 'zod'

import {
  createAgentDurably,
  dbPath,
  legacyDbWarning,
  type AgentLoopDurably,
} from './durably.js'
import { buildReport } from './engine/build-report.js'
import { killOwnedChildren, runChild } from './engine/child.js'
import { compareReports, comparisonToMarkdown } from './engine/compare.js'
import {
  classifyRun,
  DEMO,
  retryText,
  uncertainCheckpoints,
  type FailureClassification,
} from './engine/failure-reasons.js'
import { repoRoot } from './engine/git.js'
import { parseProviderName } from './engine/providers/index.js'
import {
  reportToJson,
  reportToMarkdown,
  type LoopReport,
} from './engine/report.js'
import {
  assertSingleMode,
  fixProfile,
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
      })
      .strict()
      .optional(),
  })
  .strict()

type FactoryConfig = z.infer<typeof factoryConfigSchema>
type RoleConfig = z.infer<typeof roleConfigSchema>

/**
 * Load the repository's config: `--config <path>` when given, otherwise
 * `factory.json` at the repository root if there is one. Relative paths are
 * taken from the directory the command runs in.
 */
async function loadConfig(
  root: string,
  explicit: string | undefined,
): Promise<FactoryConfig | null> {
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
  return parsed.data
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
function resolveProfiles(
  a: Record<string, string>,
  config: FactoryConfig | null,
): Record<ProfileRole, FixedProfile> {
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
  const profiles = {
    code: fix(config?.profiles?.code),
    correctness: fix(config?.profiles?.review?.correctness),
    'edge-cases': fix(config?.profiles?.review?.['edge-cases']),
  }
  assertSingleMode(profiles)
  return profiles
}

/**
 * Build the job's target from the flags and the repository's config.
 *
 * A check command is required for a repository target and is recorded before
 * the agent starts, so nothing the agent edits can change what grading runs.
 * A flag value is argv split on whitespace, not a shell line; a config value
 * is already argv. Flags win over the config.
 */
async function resolveTarget(a: Record<string, string>) {
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
    return { target: { kind: 'subject' as const }, config: null }
  }
  const repoPath = isAbsolute(repo) ? repo : join(process.cwd(), repo)
  const config = await loadConfig(await repoRoot(repoPath), a['config'])
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
    },
    config,
  }
}

async function emit(text: string, out: string | undefined): Promise<void> {
  if (out) {
    const here = dirname(fileURLToPath(import.meta.url))
    // `join` does not reset on an absolute segment, so without this an
    // absolute --out lands under the example directory instead.
    const dest = isAbsolute(out) ? out : join(here, '..', out)
    await mkdir(dirname(dest), { recursive: true })
    await writeFile(dest, text)
    console.log(`wrote ${dest}`)
  } else {
    console.log(text)
  }
}

function args(): Record<string, string> {
  const out: Record<string, string> = {}
  const raw = process.argv.slice(3)
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i]
    if (!t) continue
    if (t.startsWith('--')) {
      const key = t.slice(2)
      const next = raw[i + 1]
      if (next && !next.startsWith('--')) {
        out[key] = next
        i++
      } else {
        out[key] = 'true'
      }
    }
  }
  return out
}

/** Quote for a POSIX shell, so a printed command pastes safely. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

interface Diagnosis {
  /** False for a run a human already decided, shown only for its cleanup. */
  needsAttention: boolean
  reason: string
  next: string[]
  /** Set only for a stopped run. */
  failure?: FailureClassification
  /** A non-forcing worktree removal, for a finished repo run's worktree. */
  cleanup: string | null
}

/**
 * Say why a run is where it is and what to do next. Open runs are described
 * from their status, lease and approval wait; stopped runs from the failure
 * table. Nothing here runs a command or changes the run.
 */
async function diagnose(
  durably: AgentLoopDurably,
  run: Run,
  now: number,
): Promise<Diagnosis> {
  const setup = (await durably.storage.getCompletedStep(run.id, 'setup'))
    ?.output as {
    target?: { kind?: string; repoPath?: string; workdir?: string }
    checkpointsDir?: string
  } | null
  const terminal = ['completed', 'failed', 'cancelled'].includes(run.status)
  const target = setup?.target
  // Only the worktree the setup step recorded, and only when it is still
  // there: a subject run has none, and a run that failed before setup
  // finished has no record to trust.
  const cleanup =
    terminal &&
    target?.kind === 'repo' &&
    target.repoPath &&
    target.workdir &&
    existsSync(target.workdir)
      ? `git -C ${shellQuote(target.repoPath)} worktree remove ${shellQuote(target.workdir)}`
      : null
  const show = `${DEMO} status --run ${run.id}`
  const worker = `${DEMO} worker`
  if (run.status === 'pending')
    return {
      needsAttention: true,
      reason: 'queued; no worker has picked it up yet',
      next: [`${worker}  # if none is running`, show],
      cleanup,
    }
  if (run.status === 'leased') {
    const expires = run.leaseExpiresAt ? Date.parse(run.leaseExpiresAt) : NaN
    if (Number.isFinite(expires) && expires < now) {
      const reason = `lease expired at ${run.leaseExpiresAt}; the worker holding it stopped or lost contact`
      // A reclaimed run refuses an agent call that started without a
      // completion, so it will stop there rather than resume past it.
      const uncertain = uncertainCheckpoints(
        setup?.checkpointsDir ?? null,
        await durably.getStepAttempts(run.id),
      )
      if (uncertain.length > 0)
        return {
          needsAttention: true,
          reason: `${reason}; an agent call it started has no completed checkpoint`,
          next: [
            `${worker}  # the reclaimed run stops at that call for a human to check`,
            show,
          ],
          cleanup,
        }
      return {
        needsAttention: true,
        reason,
        next: [
          `${worker}  # a worker reclaims the run and resumes it from its checkpoints`,
          show,
        ],
        cleanup,
      }
    }
    return {
      needsAttention: true,
      reason: `a worker is running it (lease held until ${run.leaseExpiresAt ?? 'unknown'})`,
      next: [show],
      cleanup,
    }
  }
  if (run.status === 'waiting') {
    const waits = await durably.getWaits(run.id)
    const wait = waits.find((w) => w.id === run.waitingOnWaitId)
    const candidateId = (
      wait?.metadata as { candidateId?: unknown } | null | undefined
    )?.candidateId
    if (wait && typeof candidateId === 'string') {
      // Approved or rejected, but no worker has picked the run up yet.
      if (wait.status === 'resolved') {
        const decision = (wait.payload as { decision?: unknown } | null)
          ?.decision
        return {
          needsAttention: true,
          reason: `the decision on candidate ${candidateId} is recorded (${typeof decision === 'string' ? decision : wait.outcome}); a worker resumes the run`,
          next: [`${worker}  # if none is running`, show],
          cleanup,
        }
      }
      if (wait.status === 'pending')
        return {
          needsAttention: true,
          reason: `waiting for human approval of candidate ${candidateId}`,
          next: [
            `${DEMO} report --run ${run.id}  # read the reviews first`,
            `${DEMO} approve --run ${run.id} --wait ${wait.id}`,
            `${DEMO} reject --run ${run.id} --wait ${wait.id}`,
          ],
          cleanup,
        }
    }
    return {
      needsAttention: true,
      reason: 'waiting on an input that is not a candidate approval',
      next: [`${DEMO} waits --run ${run.id}`],
      cleanup,
    }
  }
  const failure = await classifyRun(durably, run)
  if (failure)
    return {
      needsAttention: true,
      reason: `${failure.kind}: ${failure.reason}`,
      next: failure.next,
      failure,
      // The worktree is evidence a human has to inspect first.
      cleanup: failure.kind === 'uncertain-invocation' ? null : cleanup,
    }
  const conclusion = (run.output as { conclusion?: string } | null)?.conclusion
  return {
    needsAttention: false,
    reason: `finished: ${conclusion ?? run.status}`,
    next: [],
    cleanup,
  }
}

function diagnosisLines(run: Run, d: Diagnosis): string[] {
  const lines = [`${run.id}  ${run.status}  (created ${run.createdAt})`]
  lines.push(`  reason:  ${d.reason}`)
  if (d.failure) {
    lines.push(`  retry:   ${retryText(d.failure.retryable)}`)
    lines.push(`  check:   ${d.failure.humanCheck}`)
    for (const detail of d.failure.details) lines.push(`  detail:  ${detail}`)
  }
  d.next.forEach((n, i) =>
    lines.push(`  ${i === 0 ? 'next:' : '     '}    ${n}`),
  )
  if (d.cleanup)
    lines.push(
      `  cleanup: ${d.cleanup}  # keeps the branch; refuses a worktree with changes`,
    )
  return lines
}

function usage(): void {
  console.log(`local-agent-loop — Durably local agent demo
Commands (run from examples/local-agent-loop):
  pnpm demo worker                          start worker (long-running; kill -9 to test resume)
  pnpm demo trigger --provider codex|claude|fake [--context reuse|fresh] [--max-iterations 2] [--model X] [--effort Y]
      bundled sample (default): no further flags
      real repository:  --repo <path> (--issue 234 | --task "..." | --task-file <file>)
                        [--spec-file <file>] [--dispositions-file <file>] [--config <file>]
                        [--check "pnpm validate"] [--setup "pnpm install"] [--base <ref>]
                        [--publish] [--approve auto|manual]
  pnpm demo status                          open and stopped runs: reason and next command
  pnpm demo status --run <id>
  pnpm demo waits --run <id>
  pnpm demo approve --run <id> --wait <waitId>
  pnpm demo reject --run <id> --wait <waitId>
  pnpm demo report --run <id> [--format json|md] [--out <file>]
  pnpm demo compare --runs <id,id,...> [--format json|md] [--out <file>]
Repository config: factory.json at the repository root, or --config <file>:
  { "check": ["pnpm", "validate"], "setup": ["pnpm", "install"], "base": "main",
    "profiles": { "code": { "provider": "codex", "model": "...", "effort": "..." },
                  "review": { "correctness": { ... }, "edge-cases": { ... } } } }
  --check, --setup and --base override the config. A role the config leaves
  out uses --provider/--model/--effort. A field a role leaves out comes from
  --model/--effort when the role uses --provider's provider, and otherwise
  from that provider's preset defaults.
  The config and input files are read once at trigger; the run keeps the
  input file contents, and the report shows each one's SHA-256.
State: database and run data live in ${dirname(dbPath())}
  (worktrees, checkpoints, verification scratch, delivery patches under runs/<id>/).
Model presets (--model selects one; effort defaults from the preset and is
overridden only by --effort — no environment variable participates, so a run's
configuration is readable off the command line that started it):
  codex:  gpt-6-astra (low) | gpt-6-sol (medium) | gpt-6-luna (medium)
          gpt-5.6-sol (low, default) | gpt-5.6-terra (medium) | gpt-5.6-luna (max)
          (gpt-6-sol and gpt-6-luna need an API key; a ChatGPT login is refused)
  claude: claude-fable-5-1 (low) | claude-opus-5-5 (medium) | claude-opus-5 (high)
          claude-sonnet-5 (high, default)
Note: effort is applied (Codex reasoningEffort / Claude effort setting), not
just recorded; unsupported values fail fast. Reports keep the raw requested,
resolved effective, and provider-reported settings separate.
Context defaults to reuse: implementation and repair continue one explicit
native session. Reviews always use independent new sessions.
Env: AGENT_TIMEOUT_MS (default 300000), TEST_TIMEOUT_MS (default 120000),
     FAKE_FAIL_FIRST=0, FAKE_REVIEW_SEQUENCE, FAKE_REVIEW_SLOW_MS
`)
}

const cmd = process.argv[2]
if (!cmd || cmd === '--help' || cmd === '-h') {
  usage()
  process.exit(0)
}

const legacyWarning = legacyDbWarning()
if (legacyWarning) console.error(legacyWarning)

if (cmd === 'worker') {
  const durably = createAgentDurably()
  durably.on('run:leased', (e) =>
    console.log(`[run:leased] ${e.jobName} ${e.runId}`),
  )
  durably.on('run:waiting', (e) => console.log(`[run:waiting] ${e.runId}`))
  durably.on('run:complete', (e) =>
    console.log(`[run:complete] ${e.runId} output=${JSON.stringify(e.output)}`),
  )
  durably.on('run:fail', (e) => console.log(`[run:fail] ${e.runId} ${e.error}`))
  durably.on('step:complete', (e) =>
    console.log(`[step:complete] ${e.stepName} run=${e.runId}`),
  )
  await durably.init()
  console.log('worker running (Ctrl-C to stop; kill -9 <pid> to test resume)')
  const shutdown = async () => {
    // Children lead their own process group, so an interrupt reaches the
    // worker but not the agent CLI it launched.
    killOwnedChildren()
    await durably.stop()
    await durably.db.destroy()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
  await new Promise(() => {})
} else if (cmd === 'trigger') {
  const a = args()
  const context = a['context'] ?? 'reuse'
  if (context !== 'reuse' && context !== 'fresh')
    throw new Error('--context must be reuse|fresh')
  // Math.min/Math.max propagate NaN rather than clamping it, so a non-numeric
  // value would reach the job schema as NaN and surface as a zod stack trace.
  const rawIterations = a['max-iterations'] ?? '2'
  if (!/^[1-3]$/.test(rawIterations))
    throw new Error('--max-iterations must be an integer between 1 and 3')
  const maxIterations = Number(rawIterations)
  // Everything the run depends on is read and resolved here, before it
  // exists: the worker never reads factory.json or an input file again.
  const { target, config } = await resolveTarget(a)
  const profiles = resolveProfiles(a, config)
  const approve = a['approve']
  if (approve !== undefined && approve !== 'auto' && approve !== 'manual')
    throw new Error('--approve must be auto|manual')
  const durably = createAgentDurably()
  await durably.migrate()
  // Only the requested settings go into the run; the worker resolves them
  // again, the same way, so no stored effective value can disagree.
  const requested = (p: FixedProfile) => ({
    provider: p.provider,
    requestedModel: p.requestedModel,
    requestedEffort: p.requestedEffort,
  })
  const run = await durably.jobs.agentLoop.trigger({
    provider: profiles.code.provider,
    profiles: {
      code: requested(profiles.code),
      correctness: requested(profiles.correctness),
      'edge-cases': requested(profiles['edge-cases']),
    },
    target,
    maxIterations,
    model: a['model'],
    effort: a['effort'],
    context,
    ...(approve ? { autoApprove: approve === 'auto' } : {}),
  })
  console.log(
    JSON.stringify(
      {
        runId: run.id,
        status: run.status,
        target: target.kind,
        db: dbPath(),
      },
      null,
      2,
    ),
  )
  await durably.db.destroy()
} else if (cmd === 'status' && !args()['run']) {
  const durably = createAgentDurably()
  await durably.migrate()
  const now = Date.now()
  const open: string[][] = []
  const leftovers: string[][] = []
  for (const run of await durably.getRuns({
    jobName: durably.jobs.agentLoop.name,
  })) {
    const d = await diagnose(durably, run, now)
    if (d.needsAttention) open.push(diagnosisLines(run, d))
    else if (d.cleanup) leftovers.push(diagnosisLines(run, d))
  }
  const out: string[] = []
  if (open.length === 0)
    out.push(
      'No runs need attention: nothing is pending, running, waiting or stopped.',
    )
  else {
    out.push(`${open.length} run(s) need attention:`)
    for (const lines of open) out.push('', ...lines)
  }
  if (leftovers.length > 0) {
    out.push('', 'Finished runs whose worktree is still on disk:')
    for (const lines of leftovers) out.push('', ...lines)
  }
  out.push('', `database: ${dbPath()}`)
  console.log(out.join('\n'))
  await durably.db.destroy()
} else if (cmd === 'status') {
  const runId = args()['run'] as string
  const durably = createAgentDurably()
  await durably.migrate()
  const run = await durably.getRun(runId)
  const attempts = await durably.getStepAttempts(runId)
  const waits = await durably.getWaits(runId)
  console.log(
    JSON.stringify(
      {
        // Why the run is where it is, and the next command to run.
        diagnosis: run ? await diagnose(durably, run, Date.now()) : null,
        // Where the work ended up. The sealed candidate names the branch and
        // commit a repository run leaves behind, whatever its conclusion.
        delivery:
          (run?.output as { delivery?: unknown } | null)?.delivery ?? null,
        candidate:
          (run?.output as { candidate?: unknown } | null)?.candidate ?? null,
        run,
        attempts: attempts.map((x) => ({
          id: x.id,
          stepName: x.stepName,
          stepIndex: x.stepIndex,
          leaseGeneration: x.leaseGeneration,
          status: x.status,
          metadata: x.metadata,
          interruptionReason: x.interruptionReason,
        })),
        waits,
      },
      null,
      2,
    ),
  )
  await durably.db.destroy()
} else if (cmd === 'waits') {
  const a = args()
  const runId = a['run']
  if (!runId) throw new Error('--run <id> required')
  const durably = createAgentDurably()
  await durably.migrate()
  console.log(JSON.stringify(await durably.getWaits(runId), null, 2))
  await durably.db.destroy()
} else if (cmd === 'approve' || cmd === 'reject') {
  const a = args()
  const runId = a['run']
  const waitId = a['wait']
  if (!runId || !waitId) throw new Error('--run <id> --wait <waitId> required')
  const durably = createAgentDurably()
  await durably.migrate()
  const pending = await durably.getWaits(runId)
  const target = pending.find((w) => w.id === waitId)?.metadata as {
    candidateId?: string
    sourceHash?: string
    reviews?: unknown
    reviewRounds?: number
  } | null
  if (!target?.candidateId)
    throw new Error('wait metadata has no candidateId; refusing unbound signal')
  console.log(
    `binding approval to candidate ${target.candidateId} (${target.sourceHash?.slice(0, 12) ?? 'unknown hash'}).`,
  )
  const receipt = await durably.signal(
    waitId,
    {
      candidateId: target.candidateId,
      decision: cmd === 'approve' ? 'approved' : 'rejected',
    },
    { signalId: `local-${cmd}-${Date.now()}` },
  )
  console.log(JSON.stringify(receipt, null, 2))
  await durably.db.destroy()
} else if (cmd === 'report') {
  const a = args()
  const runId = a['run']
  if (!runId) throw new Error('--run <id> required')
  const format = a['format'] ?? 'md'
  const durably = createAgentDurably()
  await durably.migrate()
  const report = await buildReport(durably, runId)
  const text =
    format === 'json' ? reportToJson(report) : reportToMarkdown(report)
  await emit(text, a['out'])
  await durably.db.destroy()
} else if (cmd === 'compare') {
  const a = args()
  const runIds = (a['runs'] ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
  if (runIds.length === 0)
    throw new Error('--runs <id,id,...> required (comma-separated run ids)')
  const format = a['format'] ?? 'md'
  const durably = createAgentDurably()
  await durably.migrate()
  const reports: LoopReport[] = []
  for (const runId of runIds) reports.push(await buildReport(durably, runId))
  const comparison = compareReports(reports)
  const text =
    format === 'json'
      ? JSON.stringify(comparison, null, 2)
      : comparisonToMarkdown(comparison)
  await emit(text, a['out'])
  await durably.db.destroy()
} else {
  usage()
  process.exit(1)
}
