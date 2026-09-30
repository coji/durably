#!/usr/bin/env tsx
/** CLI: worker | trigger | repair | status | wait | waits | approve | reject | spec-revise | retrigger | archive | unarchive | prune | report | compare | ui | seed */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Run } from '@coji/durably'

import {
  applyPrune,
  archivedRunIds,
  archiveRun,
  decideRun,
  planPrune,
  retriggerableRun,
  retriggerRun,
  reviseSpec,
  unarchiveRun,
} from './actions.js'
import { isSpecWait } from './approval.js'
import {
  acquireWorkerLock,
  createAgentDurably,
  dbPath,
  LEASE_MS,
  legacyDbWarning,
  probeWorkerLock,
  sweepReviewSnapshots,
  type AgentLoopDurably,
} from './durably.js'
import {
  buildReport,
  recordedTriage,
  repairChildren,
  repairChildrenByParent,
  taskRunInput,
} from './engine/build-report.js'
import { killOwnedChildren, MAX_TIMEOUT_MS } from './engine/child.js'
import {
  compareReports,
  comparisonToMarkdown,
  parseTrendDays,
  inTrendWindow,
  trendOf,
  trendToMarkdown,
} from './engine/compare.js'
import { DEMO } from './engine/failure-reasons.js'
import { formatCost, formatDuration } from './engine/format.js'
import {
  reportToJson,
  reportToMarkdown,
  type LoopReport,
} from './engine/report.js'
import {
  diagnose,
  diagnoseRun,
  diagnosisLines,
  groupTasks,
  lastLeaseRenewal,
  needsAttention,
  type Diagnosis,
  type Task,
} from './engine/status.js'
import { deliverySchema } from './factory/events.js'
import { timeoutMsSchema } from './factory/job.js'
import {
  buildTriggerInput,
  readNotesFile,
  readRepairFiles,
  reloadTriggerInput,
  startableRepair,
} from './trigger-input.js'

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

/** A size on disk for a person: bytes, KiB, MiB or GiB. */
function formatBytes(bytes: number): string {
  const units = ['bytes', 'KiB', 'MiB', 'GiB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return unit === 0 ? `${bytes} bytes` : `${value.toFixed(1)} ${units[unit]}`
}

/** A cleanup's warnings, one line each, on stderr. */
function printWarnings(warnings: string[]): void {
  for (const warning of warnings) console.error(`warning: ${warning}`)
}

/** A recorded delivery with the squashed branch and commit always named. */
function withSquashedFields(delivery: unknown): unknown {
  const parsed = deliverySchema.safeParse(delivery)
  return parsed.success ? parsed.data : delivery
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

/**
 * Whether a worker runs on this state root, from its lock rather than its
 * note: a killed worker's note stays behind. The pid and start time are the
 * lock holder's own, shown only while it holds the lock.
 */
function workerStatus() {
  const { running, holder, unknownReason } = probeWorkerLock()
  return {
    /** Null when the lock could not be read. */
    running,
    pid: running ? (holder?.pid ?? null) : null,
    startedAt: running ? (holder?.startedAt ?? null) : null,
    /** The command that starts one; null unless none is known to run. */
    start: running === false ? `${DEMO} worker` : null,
    /** Why `running` is unknown; null otherwise. */
    unknownReason,
  }
}

type WorkerStatus = ReturnType<typeof workerStatus>

function workerLine(w: WorkerStatus): string {
  if (w.running === null) return `worker: unknown (${w.unknownReason})`
  if (!w.running) return `worker: not running; start one with ${w.start}`
  return `worker: running (pid ${w.pid ?? 'unknown'}, started ${w.startedAt ?? 'unknown'})`
}

/** How often `wait` reads the stored run. */
const WAIT_POLL_MS = 1000
/** How long `wait` goes on without a worker before giving up, by default. */
const DEFAULT_WORKER_TIMEOUT_MS = 10000

/** A positive integer of milliseconds, or undefined when the flag is absent. */
function timeoutFlag(
  a: Record<string, string>,
  name: string,
): number | undefined {
  const raw = a[name]
  if (raw === undefined) return undefined
  const v = /^\d+$/.test(raw) ? Number(raw) : Number.NaN
  if (!timeoutMsSchema.safeParse(v).success)
    throw new Error(
      `--${name} must be an integer number of milliseconds between 1 and ${MAX_TIMEOUT_MS}`,
    )
  return v
}

/** `wait` exit codes. A command error (bad flag, unknown run) exits 1. */
const WAIT_EXIT = {
  delivered: 0,
  human: 2,
  failed: 3,
  cancelled: 4,
  timeout: 5,
  noWorker: 6,
} as const

type WaitStop = { exit: number; reason: string }
type StoredRun = NonNullable<Awaited<ReturnType<AgentLoopDurably['getRun']>>>

/**
 * Whether the run itself has stopped: ended, or waiting on an input nobody
 * has given yet. Only the run's own status and the wait it names count; a
 * `status` inside its output or progress does not. A decided wait the
 * worker has yet to resume is not a stop.
 */
async function runStop(
  durably: AgentLoopDurably,
  runId: string,
): Promise<{ run: StoredRun; stop: WaitStop | null }> {
  const run = await durably.getRun(runId)
  if (!run) throw new Error(`no run ${runId}`)
  return { run, stop: await stopOf(durably, run) }
}

async function stopOf(
  durably: AgentLoopDurably,
  run: StoredRun,
): Promise<WaitStop | null> {
  if (run.status === 'completed') {
    const output = run.output as {
      approved?: unknown
      conclusion?: unknown
      delivery?: unknown
    } | null
    const delivered =
      output?.approved === true &&
      output.conclusion === 'approved' &&
      output.delivery != null
    return delivered
      ? {
          exit: WAIT_EXIT.delivered,
          reason: 'completed: approved and delivered',
        }
      : {
          exit: WAIT_EXIT.failed,
          reason: `completed without an approved delivery (${String(output?.conclusion ?? 'no conclusion')})`,
        }
  }
  if (run.status === 'failed')
    return {
      exit: WAIT_EXIT.failed,
      reason: `failed: ${run.error ?? 'no error recorded'}`,
    }
  if (run.status === 'cancelled')
    return { exit: WAIT_EXIT.cancelled, reason: 'cancelled' }
  if (run.status === 'waiting' && run.waitingOnWaitId) {
    const wait = await durably.getWait(run.waitingOnWaitId)
    if (wait?.status === 'pending') {
      const approval =
        typeof (wait.metadata as { candidateId?: unknown } | null)
          ?.candidateId === 'string'
      return {
        exit: WAIT_EXIT.human,
        reason: approval
          ? `waiting for a human decision on approval wait ${wait.id}`
          : isSpecWait(wait.metadata)
            ? `waiting for a human decision on the blocked spec, wait ${wait.id}`
            : `waiting on durable wait ${wait.id} (${wait.name}), which nobody has resolved`,
      }
    }
  }
  return null
}

/**
 * Read the stored run every WAIT_POLL_MS until it stops, the time runs out,
 * or no worker has been seen for `workerTimeoutMs`. Only the database is
 * read: a worker in another process sends no events here. The loop awaits
 * each read before sleeping, so reads never overlap, and leaves no timer
 * behind. The report is built once, after the result is decided.
 */
async function waitCommand(
  durably: AgentLoopDurably,
  runId: string,
  options: {
    timeoutMs: number | undefined
    workerTimeoutMs: number | null
    json: boolean
  },
): Promise<number> {
  const started = Date.now()
  let workerMissingSince: number | null = null
  let stop: WaitStop
  // The run and worker the summary shows: the reads that decided the exit.
  let run: StoredRun
  let worker: WorkerStatus | null = null
  for (;;) {
    const seen = await runStop(durably, runId)
    if (seen.stop) {
      // Read once more before deciding: the stop must still hold.
      const again = await runStop(durably, runId)
      if (again.stop) {
        run = again.run
        stop = again.stop
        break
      }
    }
    const now = Date.now()
    worker = workerStatus()
    // Only a lock seen free counts as no worker; an unreadable one does not.
    if (worker.running !== false) workerMissingSince = null
    else workerMissingSince ??= now
    let limit: WaitStop | null = null
    if (options.timeoutMs !== undefined && now - started >= options.timeoutMs)
      limit = {
        exit: WAIT_EXIT.timeout,
        reason: `--timeout of ${options.timeoutMs} ms reached; the run has not stopped`,
      }
    else if (
      options.workerTimeoutMs !== null &&
      workerMissingSince !== null &&
      now - workerMissingSince >= options.workerTimeoutMs
    )
      limit = {
        exit: WAIT_EXIT.noWorker,
        reason: `no worker has been running for ${now - workerMissingSince} ms, so the run cannot move`,
      }
    if (limit) {
      // A stop the run reached meanwhile wins over giving up.
      const last = await runStop(durably, runId)
      run = last.run
      stop = last.stop ?? limit
      break
    }
    const remaining =
      options.timeoutMs === undefined
        ? WAIT_POLL_MS
        : Math.max(1, options.timeoutMs - (now - started))
    // sleep-ok(poll): one tick of the loop that re-reads the stored run
    await new Promise((r) => setTimeout(r, Math.min(WAIT_POLL_MS, remaining)))
  }

  const now = Date.now()
  // Exit 6 was decided by the probe above; keep that one. Otherwise the
  // worker did not decide the exit, so look now if nobody has yet.
  if (stop.exit !== WAIT_EXIT.noWorker || !worker) worker = workerStatus()
  const diagnosis = await diagnose(durably, run, now, worker)
  const report = await buildReport(durably, runId)
  const again = `${DEMO} wait --run ${runId}`
  const next =
    stop.exit === WAIT_EXIT.noWorker
      ? [`${DEMO} worker`, again]
      : stop.exit === WAIT_EXIT.timeout
        ? [...diagnosis.next, again]
        : diagnosis.next
  const summary = {
    runId,
    status: run.status,
    exitCode: stop.exit,
    conclusion: report.summary.conclusion,
    stopReason: stop.reason,
    /** Where the run stands, as `status` says it. */
    diagnosis: diagnosis.reason,
    next,
    worker,
    // Derived from the run's lease; null without a lease in force.
    lastLeaseRenewedAt: lastLeaseRenewal(run, now, LEASE_MS),
    // A stage with an unmeasured attempt has no total: null, not the sum
    // of what was measured.
    stageTimings: report.stageTimings.map((t) => ({
      stage: t.stage,
      elapsedMs: t.complete ? t.elapsedMs : null,
      wallElapsedMs: t.complete ? (t.wallElapsedMs ?? null) : null,
      complete: t.complete,
    })),
    stageTotalMs: report.stageTotalMs,
    runElapsedMs: report.runElapsedMs,
  }
  if (options.json) {
    console.log(JSON.stringify(summary, null, 2))
    return stop.exit
  }
  const ms = (v: number | null) => (v === null ? 'unknown' : `${v} ms`)
  const lines = [
    `run:        ${runId}`,
    `status:     ${run.status}`,
    `conclusion: ${summary.conclusion ?? 'none'}`,
    `stopped:    ${stop.reason} (exit ${stop.exit})`,
    `diagnosis:  ${diagnosis.reason}`,
    workerLine(worker),
    `last lease renewal: ${summary.lastLeaseRenewedAt ?? 'none recorded'}`,
    'timing:',
    ...summary.stageTimings.map(
      (t) =>
        `  ${t.stage}: work=${ms(t.elapsedMs)}, wall=${ms(t.wallElapsedMs)}${t.complete ? '' : ' (partly unmeasured)'}`,
    ),
    `  stage total: ${ms(summary.stageTotalMs)}`,
    `  run elapsed: ${ms(summary.runElapsedMs)}`,
  ]
  next.forEach((n, i) =>
    lines.push(`${i === 0 ? 'next:' : '     '}       ${n}`),
  )
  console.log(lines.join('\n'))
  return stop.exit
}

function usage(): void {
  console.log(`local-agent-loop — Durably local agent demo
Commands (run from examples/local-agent-loop):
  pnpm demo worker                          start worker (long-running; kill -9 to test resume)
                                            one per state root: a second one is refused
  pnpm demo trigger --provider codex|claude|fake [--context reuse|fresh] [--max-iterations 2] [--model X] [--effort Y]
      bundled sample (default): no further flags
      real repository:  --repo <path> (--issue 234 | --task "..." | --task-file <file>)
                        [--spec-file <file>] [--dispositions-file <file>] [--config <file>]
                        [--check "pnpm validate"] [--setup "pnpm install"] [--base <ref>]
                        [--publish] [--approve auto|manual]
  pnpm demo repair --run <id> --findings-file <file> [--dispositions-file <file>]
                                            new run that repairs an approved, delivered repository
                                            run's candidate from outside findings (see below)
  pnpm demo status [--format text|json]     tasks that wait on a person, stopped unresolved or
                                            run now: a first run and its repair runs are one task,
                                            shown by its representative run's reason and next command
  pnpm demo status --run <id>
  pnpm demo wait --run <id> [--timeout <ms>] [--worker-timeout <ms> | --no-worker-timeout] [--format json]
                                            until the run ends or waits on a person; exit 0 approved
                                            and delivered, 2 waits on a person, 3 failed or not
                                            delivered, 4 cancelled, 5 --timeout, 6 no worker for
                                            --worker-timeout (default 10000), 1 command error
  pnpm demo waits --run <id>
  pnpm demo approve --run <id> --wait <waitId>
  pnpm demo reject --run <id> --wait <waitId>
                                            also a spec the spec reviewers still block after
                                            the last round: approve goes on with it as it is,
                                            reject stops the run before any implementation
  pnpm demo spec-revise --run <id> --notes-file <file>
                                            fix the blocked spec once more with the notes,
                                            then review it once more
  pnpm demo retrigger --run <id>            new run with the stored input (only for stops safe to repeat)
  pnpm demo retrigger --run <id> --reload-config
                                            the stored task and inputs, settings read again from
                                            the run's factory.json (once per version of the file)
  pnpm demo archive --run <id> [--delete-branch]
                                            take a stopped run out of the runs that need a person;
                                            the run itself is not changed. A repository run's
                                            worktree and review snapshots are removed (again, when
                                            already archived); --delete-branch also deletes its
                                            recorded factory branch and squashed branch
  pnpm demo unarchive --run <id>            put an archived run back where it was; a removed
                                            worktree is not made again
  pnpm demo prune [--apply] [--delete-branches]
                                            worktrees of repository runs that were approved and
                                            delivered, or archived, with their sizes and total;
                                            nothing is removed without --apply. --delete-branches
                                            also lists and deletes the recorded branches of
                                            archived runs, never of delivered ones
  pnpm demo report --run <id> [--format json|md] [--out <file>]
  pnpm demo compare --runs <id,id,...> [--format json|md] [--out <file>]
  pnpm demo compare --trend [--days 30] [--include-fake] [--format json|md] [--out <file>]
                                            finished runs of the last --days days by week (Monday,
                                            local time) and code model/effort; fake runs left out
  pnpm demo ui [--port 4380]                web UI on 127.0.0.1: runs, reports, comparison, and the
                                            approve, reject, spec-revise, retrigger and archive
                                            above, without --reload-config
  pnpm demo seed [--home <dir>] [--latency 20000-90000]
                                            demo data on the fake provider in a throwaway HOME
Repository config: factory.json at the repository root, or --config <file>:
  { "check": ["pnpm", "validate"], "setup": ["pnpm", "install"], "base": "main",
    "baselineCheck": false, "baselineReuse": { "maxAgeMs": 3600000 },
    "codexPath": "<file>",
    "checkTimeoutMs": 900000, "agentTimeoutMs": 1800000,
    "commit": { "authorName": "...", "authorEmail": "...",
                "messageTemplate": "...", "publishSquashed": false },
    "profiles": { "code": { "provider": "codex", "model": "...", "effort": "..." },
                  "review": { "correctness": { ... }, "edge-cases": { ... } },
                  "repair": { ... }, "triage": { ... } },
    "spec": { "template": "<file>", "reviewTemplate": "<file>", "maxRounds": 3,
              "author": { ... }, "fix": { ... },
              "review": { "<name>": { ..., "command": "...", "context": "...", "output": "..." } },
              "checkFromSpec": ["node", "scripts/check-from-spec.mjs"] } }
  --check, --setup and --base override the config. A role the config leaves
  out uses --provider/--model/--effort. A field a role leaves out comes from
  --model/--effort when the role uses --provider's provider, and otherwise
  from that provider's preset defaults. "triage" is optional: when present,
  one read-only call records a routine or probe judgment before the code
  stage (shadow mode; it changes nothing about the run), with the task and
  spec sizes the report and compare set beside it. "repair" is optional:
  without it, repair runs on the "code" profile. A field "repair" leaves out
  comes from the resolved "code" profile, not from the flags (on another
  provider, from that provider's defaults). With a different provider,
  model or effort, every repair starts a new session on it and is sent the
  task, the spec and the repair notes.
  "baselineCheck": true runs "check" once on the base commit before any
  agent call and stops the run (baseline-check-failed) when it fails.
  "baselineReuse" (with "baselineCheck") uses another run's passing baseline
  of at most maxAgeMs ms in this state database instead of running "check",
  when the repository, base commit, check, setup, checkTimeoutMs, Node.js
  version, platform, architecture and check executable all match. Setup and
  the clean-worktree checks still run.
  "spec" (repository runs without --spec-file): after setup and preflight,
  "author" writes the run's spec file (runs/<id>/spec/spec.md, outside the
  worktree) from the task and "template"; every named reviewer reviews it
  side by side, following "reviewTemplate"; a blocker is fixed by "fix" (the
  author's settings when absent) and reviewed again, up to "maxRounds"
  rounds (default 3). A spec still blocked then waits for approve, reject or
  spec-revise. Author and fix read the repository and write the spec file
  only; reviewers are read-only, and a reviewer command may use {effort}
  and {base}. Templates are read once at trigger, relative to the config.
  "checkFromSpec" runs once on the run's fixed spec (from the spec stages or
  --spec-file), with the spec's path as its last argument, in the worktree,
  within checkTimeoutMs, and must print {"check": ["..."], "notes"?: "..."};
  that check then replaces "check" and --check for the baseline and every
  verification. A failure stops the run as spec-check-failed.
  "codexPath" names the Codex CLI to launch, relative to the config file;
  without it, the bundled CLI first, then codex on PATH.
  "commit" sets the author (name and email) of every factory commit and a
  message template in which {iteration}, {runId} and {task} (the task's first
  line) are replaced; each field is optional and none may be empty. Without
  them, iteration commits are by durably-factory <durably-factory@localhost>
  with "factory iteration <n>", and the squashed commit says
  "factory run <runId>". An approved repository run leaves two branches:
  factory/<runId> (factory/issue-<n>-<runId> for an issue) with one commit per
  iteration, and factory/<runId>-squashed with the approved tree as a single
  commit on the base, whose {iteration} is the one that sealed it. --publish
  pushes and opens the draft pull request from the first, or from the
  squashed branch when "publishSquashed" is true; without --publish neither
  is pushed.
  repair starts a child run from a parent run that completed approved and
  delivered its last candidate, whose candidate branch still points at that
  commit. The child works on factory/<childRunId> cut from that commit, with
  the parent's stored task, spec, issue, profiles, check, setup, timeouts,
  codexPath, commit and publish settings and max iterations; factory.json
  and the environment are not read, and any other flag is refused. Its setup
  checks the candidate branch again and stops as candidate-moved, before
  creating anything, if the branch moved since. It skips
  triage, starts with a repair in a new session, and the inherited max
  iterations count its own repairs only. The findings file is stored as untrusted input for
  the repairer and both reviewers; --dispositions-file replaces the parent's
  dispositions (inherited otherwise). The same parent, findings and
  dispositions return the same child run.
  Timeouts are positive integer milliseconds, at most 2147483647; without them, the trigger's
  TEST_TIMEOUT_MS / AGENT_TIMEOUT_MS, then the target's default.
  Before the first agent call, every role's provider, model and effort is
  checked once (preflight): free where the provider can tell (Codex model
  list), otherwise one minimal call, recorded with its usage.
  The config and input files are read once at trigger; the run keeps the
  input file contents and the resolved timeouts and codexPath, and the
  report shows each input file's SHA-256.
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
native session, unless "repair" names a different profile, which starts a
new session for each repair. Context fresh starts a new session for every
implementation and repair. Reviews always use independent new sessions.
A call the provider explicitly refuses after preflight stops the run as
rejected-invocation (safe to retry): fix the setting and retrigger with
--reload-config, or fix the login and retrigger without it.
Env (read at trigger and stored in the run, never by the worker):
     AGENT_TIMEOUT_MS (default 300000, repository 1800000),
     TEST_TIMEOUT_MS (default 120000, repository 900000)
Env (fake provider, read by the worker):
     FAKE_FAIL_FIRST=0, FAKE_REVIEW_SEQUENCE, FAKE_REVIEW_SLOW_MS, FAKE_TRIAGE,
     FAKE_LATENCY_MS=<min>-<max>, FAKE_USAGE=realistic
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
  // One worker per state root. The lock is the operating system's, so it
  // ends with this process however the process ends.
  const lock = acquireWorkerLock()
  if (!lock.acquired) {
    const who = lock.holder
    console.error(
      who
        ? `another worker already runs on ${dirname(dbPath())}: pid ${who.pid}, started ${who.startedAt} from ${who.checkout}. Stop it first (kill ${who.pid}); two workers would pick up each other's runs.`
        : `another worker already runs on ${dirname(dbPath())}; it has not recorded its pid yet. Stop it first.`,
    )
    process.exit(1)
  }
  // Every way out, a failed init or a shutdown, passes through 'exit'.
  process.on('exit', lock.release)
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
  // Runs that ended while no worker could clean up after them.
  const swept = await sweepReviewSnapshots(durably)
  if (swept.length > 0)
    console.log(`[sweep] removed review snapshots of ${swept.join(', ')}`)
  console.log(
    `worker running, pid ${process.pid} (Ctrl-C to stop; kill -9 <pid> to test resume)`,
  )
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
  const input = await buildTriggerInput(args())
  const durably = createAgentDurably()
  await durably.migrate()
  const run = await durably.jobs.agentLoop.trigger(input)
  console.log(
    JSON.stringify(
      {
        runId: run.id,
        status: run.status,
        target: input.target.kind,
        db: dbPath(),
        // Without a worker the run stays pending; `start` says how to start one.
        worker: workerStatus(),
      },
      null,
      2,
    ),
  )
  await durably.db.destroy()
} else if (cmd === 'repair') {
  const a = args()
  const runId = a['run']
  if (!runId) throw new Error('--run <id> required')
  // Read before the database is opened: a bad file starts nothing.
  const files = await readRepairFiles(a)
  const durably = createAgentDurably()
  await durably.migrate()
  try {
    const { input, idempotencyKey, labels } = await startableRepair(
      durably,
      runId,
      files,
    )
    const run = await durably.jobs.agentLoop.trigger(input, {
      idempotencyKey,
      labels,
    })
    console.log(
      JSON.stringify(
        {
          runId: run.id,
          disposition: run.disposition,
          status: run.status,
          parentRunId: runId,
          baseCommit: input.target.baseRef,
          branch: `factory/${run.id}`,
          db: dbPath(),
        },
        null,
        2,
      ),
    )
  } finally {
    await durably.db.destroy()
  }
} else if (cmd === 'status' && !args()['run']) {
  const format = args()['format'] ?? 'text'
  if (format !== 'text' && format !== 'json')
    throw new Error('--format must be text or json')
  const { readOnce, runName } = await import('./ui/server.js')
  const durably = createAgentDurably()
  await durably.migrate()
  const now = Date.now()
  const worker = workerStatus()
  const runs = await durably.getRuns({ jobName: durably.jobs.agentLoop.name })
  // Each run's report too, so a task's time and cost are the list's. The
  // report and the diagnosis share one read of each run, and the diagnosis
  // takes the report's failure instead of classifying the run again.
  const src = readOnce(durably, runs)
  const children = repairChildrenByParent(runs)
  const archived = archivedRunIds(durably.stateRoot)
  const read: { run: Run; diagnosis: Diagnosis; report: LoopReport }[] = []
  for (const run of runs) {
    const report = await buildReport(src, run.id, {
      children: children.get(run.id) ?? [],
    })
    const { diagnosis } = await diagnoseRun(
      src,
      run,
      now,
      { failure: report.failure },
      worker,
      archived.has(run.id),
    )
    read.push({ run, diagnosis, report })
  }
  const seen = new Map(read.map((r) => [r.run.id, r]))
  const tasks = groupTasks(
    read.map(({ run, diagnosis, report }) => ({
      ...taskRunInput(run, diagnosis.kind, report),
      archived: archived.has(run.id),
    })),
  )
  await durably.db.destroy()
  // A task reads as its representative run's block, then the task it
  // belongs to and its other runs.
  const taskLines = (task: Task): string[] => {
    const rep = seen.get(task.representative)
    const root = seen.get(task.id)
    if (!rep) return []
    const lines = diagnosisLines(rep.run, rep.diagnosis)
    lines.push(
      `  task:    ${runName(root?.run.input)}  (first run ${task.id}, ${task.runs.length} run(s))`,
    )
    if (task.runs.length > 1)
      lines.push(
        `  total:   ${formatDuration(task.total.leadTimeMs, 'en')}, ${formatCost(task.total.costUsd, 'en')}  (lead time and cost over every run; unknown if any run's is)`,
      )
    for (const r of task.runs)
      if (r.id !== task.representative)
        lines.push(
          `  also:    ${r.id}  ${r.parentId ? 'repair' : 'first run'}, ${r.kind}${r.superseded ? ', replaced by a later approved repair' : ''}${r.archived ? ', archived' : ''}`,
        )
    return lines
  }
  const attention = tasks.filter((t) => needsAttention(t.attention))
  const active = tasks.filter((t) => t.attention === 'active')
  const leftovers = read.flatMap(({ run, diagnosis: d }) =>
    d.kind === 'finished' && d.cleanup ? [diagnosisLines(run, d)] : [],
  )
  const out: string[] = []
  if (attention.length === 0 && active.length === 0)
    out.push(
      'No runs need attention: nothing is pending, running, waiting or stopped.',
    )
  if (attention.length > 0) {
    out.push(
      `${attention.length} task(s) wait on a person or stopped unresolved:`,
    )
    for (const task of attention) out.push('', ...taskLines(task))
  }
  if (active.length > 0) {
    if (out.length > 0) out.push('')
    out.push(`${active.length} task(s) with a run pending or running:`)
    for (const task of active) out.push('', ...taskLines(task))
  }
  if (leftovers.length > 0) {
    out.push('', 'Finished runs whose worktree is still on disk:')
    for (const lines of leftovers) out.push('', ...lines)
  }
  // `groupTasks` marks a run archived only when `archivable` allows it.
  const shelved = tasks.flatMap((t) => t.runs.filter((r) => r.archived))
  if (shelved.length > 0) {
    out.push('', `${shelved.length} stopped run(s) archived:`)
    for (const r of shelved)
      out.push(`  ${r.id}  ${DEMO} unarchive --run ${r.id}`)
  }
  out.push('', workerLine(worker), `database: ${dbPath()}`)
  console.log(
    format === 'json'
      ? JSON.stringify({ tasks, worker, database: dbPath() }, null, 2)
      : out.join('\n'),
  )
} else if (cmd === 'status') {
  const runId = args()['run'] as string
  const durably = createAgentDurably()
  await durably.migrate()
  const run = await durably.getRun(runId)
  const attempts = await durably.getStepAttempts(runId)
  const waits = await durably.getWaits(runId)
  const now = Date.now()
  const worker = workerStatus()
  console.log(
    JSON.stringify(
      {
        // Why the run is where it is, and the next command to run.
        diagnosis: run
          ? await diagnose(
              durably,
              run,
              now,
              worker,
              archivedRunIds(durably.stateRoot).has(run.id),
            )
          : null,
        worker,
        // Derived from the run's lease; null without a lease in force.
        lastLeaseRenewedAt: run ? lastLeaseRenewal(run, now, LEASE_MS) : null,
        // Where the work ended up. The sealed candidate names the branch and
        // commit a repository run leaves behind, whatever its conclusion.
        // A delivery recorded before the squashed branch existed shows it
        // as null rather than leaving the field out.
        delivery: withSquashedFields(
          (run?.output as { delivery?: unknown } | null)?.delivery ?? null,
        ),
        candidate:
          (run?.output as { candidate?: unknown } | null)?.candidate ?? null,
        // Null when the run has no triage profile or has not reached it.
        triage: run ? await recordedTriage(durably, run) : null,
        // The run this one repairs from outside findings, and the repair
        // runs started from this one.
        lineage: run
          ? {
              parent:
                (run.input as { repairOf?: { runId?: string } } | null)
                  ?.repairOf?.runId ?? null,
              children: await repairChildren(durably, run),
            }
          : null,
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
} else if (cmd === 'wait') {
  const a = args()
  const runId = a['run']
  if (!runId) throw new Error('--run <id> required')
  // Every flag is checked before the database is opened.
  const timeoutMs = timeoutFlag(a, 'timeout')
  const noWorkerTimeout = a['no-worker-timeout'] === 'true'
  if (noWorkerTimeout && a['worker-timeout'] !== undefined)
    throw new Error(
      '--worker-timeout and --no-worker-timeout exclude each other',
    )
  const workerTimeoutMs = noWorkerTimeout
    ? null
    : (timeoutFlag(a, 'worker-timeout') ?? DEFAULT_WORKER_TIMEOUT_MS)
  const format = a['format'] ?? 'text'
  if (format !== 'text' && format !== 'json')
    throw new Error('--format must be text or json')
  const durably = createAgentDurably()
  let exitCode: number
  try {
    await durably.migrate()
    exitCode = await waitCommand(durably, runId, {
      timeoutMs,
      workerTimeoutMs,
      json: format === 'json',
    })
  } finally {
    await durably.db.destroy()
  }
  process.exit(exitCode)
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
  try {
    const receipt = await decideRun(
      durably,
      runId,
      waitId,
      cmd === 'approve' ? 'approved' : 'rejected',
      (line) => console.log(line),
    )
    console.log(JSON.stringify(receipt, null, 2))
  } finally {
    await durably.db.destroy()
  }
} else if (cmd === 'spec-revise') {
  const a = args()
  const runId = a['run']
  const notesFile = a['notes-file']
  if (!runId || !notesFile)
    throw new Error('--run <id> --notes-file <path> required')
  // Read before the database is opened: a bad file signals nothing.
  const notes = await readNotesFile(notesFile)
  const durably = createAgentDurably()
  await durably.migrate()
  try {
    const receipt = await reviseSpec(durably, runId, notes, (line) =>
      console.log(line),
    )
    console.log(JSON.stringify(receipt, null, 2))
  } finally {
    await durably.db.destroy()
  }
} else if (cmd === 'retrigger') {
  const a = args()
  const runId = a['run']
  if (!runId) throw new Error('--run <id> required')
  const durably = createAgentDurably()
  await durably.migrate()
  if (a['reload-config'] === 'true') {
    const run = await retriggerableRun(durably, runId)
    type Input = Parameters<typeof durably.jobs.agentLoop.trigger>[0]
    // The stored task and inputs, with the settings read again from the
    // current config. One run per config version: pasting the command again
    // without editing the file returns the run it already started.
    const { input, configSha256 } = await reloadTriggerInput(
      run.input as Parameters<typeof reloadTriggerInput>[0],
    )
    const next = await durably.jobs.agentLoop.trigger(input as Input, {
      idempotencyKey: `retrigger-of-${runId}-config-${configSha256 ?? 'none'}`,
    })
    const from = input.configSource?.path ?? 'no config file'
    console.log(
      next.disposition === 'created'
        ? `new run ${next.id} with the input of ${runId} and the settings of ${from}`
        : `already retriggered as ${next.id} with this version of ${from}; nothing new started`,
    )
  } else {
    const next = await retriggerRun(durably, runId)
    console.log(
      next.disposition === 'created'
        ? `new run ${next.runId} with the input of ${runId}`
        : `already retriggered as ${next.runId}; nothing new started`,
    )
  }
  await durably.db.destroy()
} else if (cmd === 'archive') {
  const a = args()
  const runId = a['run']
  if (!runId) throw new Error('--run <id> required')
  const durably = createAgentDurably()
  await durably.migrate()
  try {
    const done = await archiveRun(durably, runId, {
      deleteBranches: a['delete-branch'] === 'true',
    })
    console.log(
      done.changed
        ? `archived ${runId}; status and the web UI no longer list it as needing a person. Undo with ${DEMO} unarchive --run ${runId}`
        : `${runId} is already archived; its state did not change`,
    )
    if (done.worktreeRemoved)
      console.log(
        'removed its worktree; the spec, logs, checkpoints, candidate diffs and delivery record are kept',
      )
    if (done.deletedBranches.length > 0)
      console.log(`deleted branches: ${done.deletedBranches.join(', ')}`)
    printWarnings(done.warnings)
    if (done.warnings.length > 0)
      console.error(`run ${DEMO} archive --run ${runId} again to retry`)
  } finally {
    await durably.db.destroy()
  }
} else if (cmd === 'unarchive') {
  const runId = args()['run']
  if (!runId) throw new Error('--run <id> required')
  const durably = createAgentDurably()
  await durably.migrate()
  try {
    const { changed } = await unarchiveRun(durably, runId)
    console.log(
      changed
        ? `unarchived ${runId}; it is listed where its state puts it again`
        : `${runId} is not archived; nothing changed`,
    )
  } finally {
    await durably.db.destroy()
  }
} else if (cmd === 'prune') {
  const a = args()
  const apply = a['apply'] === 'true'
  const deleteBranches = a['delete-branches'] === 'true'
  const durably = createAgentDurably()
  await durably.migrate()
  try {
    const plan = await planPrune(durably, { deleteBranches })
    const out: string[] = []
    out.push(
      `${plan.worktrees.length} worktree(s) of delivered or archived runs, ${formatBytes(plan.totalBytes)} in total:`,
    )
    for (const w of plan.worktrees)
      out.push(`  ${w.runId}  ${formatBytes(w.bytes)}  ${w.reason}  ${w.path}`)
    if (deleteBranches) {
      out.push(`branches of ${plan.branches.length} archived run(s):`)
      for (const b of plan.branches)
        out.push(`  ${b.runId}  ${b.branches.join(', ')}`)
    }
    if (!apply) {
      out.push(
        `dry run: nothing was removed. Run ${DEMO} prune --apply${deleteBranches ? ' --delete-branches' : ''} to remove ${deleteBranches ? 'them' : 'these worktrees; branches are kept'}.`,
      )
      console.log(out.join('\n'))
    } else {
      const done = await applyPrune(durably, plan)
      out.push(
        `removed ${done.removed.length} worktree(s), ${formatBytes(done.removed.reduce((sum, w) => sum + w.bytes, 0))}; the spec, logs, checkpoints, candidate diffs and delivery records are kept`,
      )
      if (deleteBranches)
        out.push(
          `deleted ${done.deletedBranches.length} branch(es)${done.deletedBranches.length > 0 ? `: ${done.deletedBranches.join(', ')}` : ''}`,
        )
      console.log(out.join('\n'))
      printWarnings(done.warnings)
      if (done.warnings.length > 0) process.exitCode = 1
    }
  } finally {
    await durably.db.destroy()
  }
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
} else if (cmd === 'compare' && args()['trend'] === 'true') {
  const a = args()
  // Every flag is checked before the database is opened.
  if (a['runs'] !== undefined)
    throw new Error('--trend reads every finished run; leave out --runs')
  const days = parseTrendDays(a['days'])
  const includeFake = a['include-fake'] === 'true'
  const format = a['format'] ?? 'md'
  if (format !== 'md' && format !== 'json')
    throw new Error('--format must be md or json')
  const durably = createAgentDurably()
  await durably.migrate()
  const now = Date.now()
  const runs = await durably.getRuns({ jobName: durably.jobs.agentLoop.name })
  const done = runs.filter((r) => inTrendWindow(r, { now, days }))
  const children = repairChildrenByParent(runs)
  const entries = []
  for (const run of done)
    entries.push({
      report: await buildReport(durably, run.id, {
        children: children.get(run.id) ?? [],
      }),
      completedAt: run.completedAt,
    })
  const trend = trendOf(entries, { now, days, includeFake })
  await emit(
    format === 'json' ? JSON.stringify(trend, null, 2) : trendToMarkdown(trend),
    a['out'],
  )
  await durably.db.destroy()
} else if (cmd === 'compare') {
  const a = args()
  const runIds = (a['runs'] ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
  if (runIds.length === 0)
    throw new Error(
      '--runs <id,id,...> required (comma-separated run ids), or --trend',
    )
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
} else if (cmd === 'seed') {
  const { seedCommand } = await import('./demo-seed.js')
  await seedCommand(args())
} else if (cmd === 'ui') {
  const rawPort = args()['port'] ?? '4380'
  // Checked before anything listens: a typo must not silently pick a port.
  if (!/^\d{1,5}$/.test(rawPort) || +rawPort < 1 || +rawPort > 65535)
    throw new Error('--port must be an integer between 1 and 65535')
  const { startUiServer } = await import('./ui/server.js')
  const ui = await startUiServer({ port: Number(rawPort) })
  console.log(`web UI: ${ui.url}`)
  console.log(`database: ${dbPath()}`)
  console.log(
    'actions on the page call the same functions as approve, reject, spec-revise, retrigger and archive; no worker is started',
  )
  console.log('Ctrl-C to stop')
  const shutdown = async () => {
    // Each action is one short write that has settled before it answers,
    // so a close that hangs is safe to cut short.
    setTimeout(() => process.exit(0), 2000).unref()
    await ui.close()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
} else {
  usage()
  process.exit(1)
}
