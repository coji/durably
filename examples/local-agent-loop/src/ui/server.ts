/**
 * `demo ui`: a web UI over the factory's database (ADR-0027).
 *
 * - Listens on 127.0.0.1 only. The API answers only to a loopback Host
 *   header, so a page on another origin cannot read runs through DNS
 *   rebinding.
 * - Opens the fixed state root's existing database lazily: until a worker or
 *   `trigger` creates it, every view is empty and nothing is created. It is
 *   migrated before the first write, as the CLI does; `init()` is never
 *   called, so no worker starts and the worker lock is never taken.
 * - Every number comes from `buildReport` / `compareReports` / `trendOf`,
 *   every reason and command from `diagnose`, and the task list from
 *   `groupTasks`: the same code the CLI prints from.
 * - Writes are `POST /api/runs/<id>/<action>`, each calling the function
 *   its `demo` subcommand calls (`actions.ts`). A write needs the token this
 *   process made at start and put in the page, and an Origin naming this
 *   server; anything else is refused before the action runs. Reads never
 *   write.
 * - `GET /api/runs/<id>/logs/<attemptId>` reads a part of one attempt's
 *   agent log, or its check's stdout or stderr, from a path the attempt
 *   recorded, and only inside the run's own directory.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { open, realpath } from 'node:fs/promises'
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join, resolve, sep } from 'node:path'
import type { Duplex } from 'node:stream'
import { fileURLToPath } from 'node:url'

import type { Run } from '@coji/durably'

import {
  archivedRunIds,
  archiveRun,
  decideRun,
  retriggerRun,
  reviseSpec,
  unarchiveRun,
} from '../actions.js'
import {
  createAgentDurably,
  dbPath,
  defaultStateRoot,
  type AgentLoopDurably,
} from '../durably.js'
import {
  asReportCandidate,
  asReportReview,
  asSpecReview,
  buildReport,
  repairChildren,
  repairChildrenByParent,
  repairParentId,
  reusedBaselineOf,
  taskRunInput,
  type ReportSource,
} from '../engine/build-report.js'
import {
  compareReports,
  trendOf,
  trendRunIds,
  type Comparison,
  type Trend,
} from '../engine/compare.js'
import {
  checkLogFiles,
  classifyRun,
  DEMO,
  type CheckLogFile,
} from '../engine/failure-reasons.js'
import { formatCount } from '../engine/format.js'
import {
  NOT_SENT,
  type AgentLog,
  type AgentTimeout,
  type VerificationLog,
} from '../engine/providers/types.js'
import {
  liveElapsed,
  stageOf,
  toAttemptRow,
  usageOf,
  type AttemptRow,
  type LiveElapsed,
  type LoopReport,
  type ReportCandidate,
  type ReportReview,
  type ReportReviewRound,
  type ReportSealedCandidate,
  type ReviewHighlights,
  type UsageTotals,
  type WaitRow,
} from '../engine/report.js'
import {
  archivable,
  currentWorktree,
  diagnose,
  diagnoseRun,
  groupTasks,
  needsHuman,
  taskRunIds,
  type Diagnosis,
  type DiagnosisKind,
  type Task,
  type TaskRun,
} from '../engine/status.js'
import { TERMINAL_STATUSES } from '../engine/terminal.js'
import { runRootOf } from '../factory/layout.js'
import { BASELINE_STEP } from '../factory/types.js'
import { COMMON, PIPELINE_WORDS, RUN_NAME, TRACE_WORDS } from './glossary.js'
import { lensName, roleName, stageName, stepPartName } from './labels.js'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** A linked run by its name, for the links between repair runs. */
export interface RunRef {
  id: string
  /** From the stored input; see `runName`. */
  name: string
}

/**
 * One run of the task a detail page's run belongs to, with what its link
 * shows: its place in the task, its state, and when it started.
 */
export interface LineageRun extends TaskRun {
  status: string
  conclusion: string | null
  createdAt: string
}

/** One row of the run list. */
export interface RunRow {
  id: string
  status: string
  createdAt: string
  /** From the stored input; see `runName`. */
  name: string
  diagnosis: Diagnosis
  /** A lease-expired run left an agent call without a completion. */
  uncertainCall: boolean
  /** Approval, a stop, or an unknown wait: a person decides next. */
  needsHuman: boolean
  /** A person archived the stopped run (`demo archive`). */
  archived: boolean
  /**
   * `demo unarchive` for an archived run, `demo archive` for a stopped one
   * that is not; null for any other run.
   */
  archiveCommand: string | null
  /**
   * The wait a decision on this run answers: set only while it waits on a
   * candidate approval or a blocked spec. Sent back with the decision, never
   * shown.
   */
  waitId: string | null
  /** Provisional, as of the response's `now`; null for a finished run. */
  live: LiveElapsed | null
  /** The report's review highlights, only for a run waiting on approval. */
  reviewHighlights: ReviewHighlights | null
  conclusion: string | null
  /** The report's settled lead time; null while the run is open. */
  leadTimeMs: number | null
  costUsd: number | null
  pipeline: Pipeline
}

export interface RunsResponse {
  db: string
  /** False until a worker or `trigger` creates the database. */
  exists: boolean
  now: string
  /** Newest first. */
  runs: RunRow[]
  /**
   * The runs as tasks, in the order the list shows them, from `groupTasks`:
   * what `demo status --format json` prints as its `tasks`.
   */
  tasks: Task[]
}

export interface RunDetailResponse {
  now: string
  /** From the stored input; see `runName`. */
  name: string
  createdAt: string
  diagnosis: Diagnosis
  uncertainCall: boolean
  needsHuman: boolean
  /** A person archived the stopped run (`demo archive`). */
  archived: boolean
  /** As on `RunRow`. */
  archiveCommand: string | null
  /** As on `RunRow`. */
  waitId: string | null
  live: LiveElapsed | null
  pipeline: Pipeline
  /**
   * Every run of this run's task, oldest first, this run among them; empty
   * when it has no parent or repairs.
   */
  lineage: LineageRun[]
  /**
   * The check logs a stop's details name, each looked up on disk; empty
   * when the stop names none.
   */
  checkLogs: CheckLogFile[]
  /**
   * The run whose passing baseline check this run reused, named as other
   * run links are; null when the baseline check ran here or has not
   * reached it.
   */
  baselineSource: RunRef | null
  /** The run as a span tree on one time axis, as of `now`. */
  trace: Trace
  /** Exactly what `report --run <id> --format json` prints. */
  report: LoopReport
}

/**
 * Tasks whose newest run finished in the last 30 days, by week and the first
 * run's code model and effort, fake tasks left out: what `compare --trend
 * --format json` prints.
 */
export type TrendResponse = Trend

export interface CompareResponse {
  /** Finished runs, newest first, in the order given to `compareReports`. */
  runIds: string[]
  comparison: Comparison
}

/** The heading for the bundled sample, whose task never varies. */
export const SUBJECT_RUN_NAME = RUN_NAME.subject

const NAME_MAX = 80

/**
 * A person-readable name for a run, from its stored input only: the issue
 * number and title when the run came from an issue, else the task's first
 * non-empty line (a leading Markdown heading mark dropped), else the bundled
 * sample's fixed name. Truncated to 80 characters.
 */
export function runName(input: unknown): string {
  const target = (
    input as {
      target?: {
        kind?: string
        task?: string
        issue?: { number?: number; title?: string } | null
      }
    } | null
  )?.target
  if (target?.kind !== 'repo') return SUBJECT_RUN_NAME
  const issue = target.issue
  const line =
    issue?.number != null
      ? `#${issue.number} ${issue.title?.trim() ?? ''}`.trim()
      : ((target.task ?? '')
          .split('\n')
          .map((l) => l.trim().replace(/^#+\s*/, ''))
          .find((l) => l.length > 0) ?? '')
  if (line.length === 0) return RUN_NAME.unnamed
  return line.length > NAME_MAX ? `${line.slice(0, NAME_MAX - 1)}…` : line
}

// ---------------------------------------------------------------- pipeline

/**
 * Where a stage stands in a run: `running` / `waiting` / `current` is the
 * stage the run is at now (a worker on it, a person to decide, or neither);
 * `stopped` is where a run that did not finish ended; `auto` is an approval
 * the run's settings gave without a wait, on a run that went on to finish.
 */
export type PipelineState =
  | 'done'
  | 'auto'
  | 'running'
  | 'waiting'
  | 'current'
  | 'stopped'
  | 'not-reached'

export interface PipelineStage {
  stage: string
  state: PipelineState
  /** Times the stage was entered; above 1 for a repair loop. */
  count: number
}

export interface Pipeline {
  stages: PipelineStage[]
  /** The whole stepper in one sentence, for screen readers. */
  label: string
}

const PIPELINE_ORDER = [
  'setup',
  'spec-check',
  'baseline',
  'preflight',
  'triage',
  'code',
  'verify',
  'review',
  'approve',
  'finish',
]

/**
 * A run with spec stages checks its roles first, then writes and reviews
 * the spec and chooses its check from it, before the baseline.
 */
const SPEC_PIPELINE_ORDER = [
  'setup',
  'preflight',
  'spec',
  'spec-review',
  'spec-check',
  'baseline',
  'triage',
  'code',
  'verify',
  'review',
  'approve',
  'finish',
]

/** The stage a stored step or wait shows under in the stepper. */
function pipelineStageOf(name: string): string {
  const stage = stageOf(name)
  // A person's decision on a blocked spec belongs to its review.
  return stage === 'spec-wait' ? 'spec-review' : stage
}

export interface PipelineInput {
  status: string
  diagnosisKind: DiagnosisKind
  live: Pick<LiveElapsed, 'stage'> | null
  report: Pick<LoopReport, 'attempts' | 'waits' | 'stageVisits' | 'roleUsage'>
}

/** Whether a run has spec stages: a spec role, step or wait of its own. */
function hasSpecStages(
  report: Pick<LoopReport, 'attempts' | 'waits' | 'roleUsage'>,
): boolean {
  return (
    report.roleUsage.some((r) => r.role === 'spec-author') ||
    report.attempts.some((a) =>
      SPEC_STAGE_NAMES.includes(stageOf(a.stepName)),
    ) ||
    report.waits.some((w) => stageOf(w.name) === 'spec-wait')
  )
}

const SPEC_STAGE_NAMES = ['spec', 'spec-review']

/** Stored step or wait name to the stage it belongs to, dated by its start. */
function pipelineEvents(
  attempts: Pick<AttemptRow, 'stepName' | 'startedAt'>[],
  waits: Pick<WaitRow, 'name' | 'createdAt'>[],
): { stage: string; at: number }[] {
  return [
    ...attempts.map((a) => ({
      stage: pipelineStageOf(a.stepName),
      at: Date.parse(a.startedAt),
    })),
    ...waits.map((w) => ({
      stage: pipelineStageOf(w.name),
      at: Date.parse(w.createdAt),
    })),
  ].filter((e) => SPEC_PIPELINE_ORDER.includes(e.stage))
}

/** Stages that run at most once and appear only on a run that reached them. */
const OPTIONAL_ONCE = ['baseline', 'preflight', 'spec-check']
/** Stages that run at most once per run. */
const ONCE_STAGES = ['setup', 'triage', ...OPTIONAL_ONCE]

/**
 * The fixed stage order with each stage's visit count and state, from the
 * report's stored attempts, waits and visit counts. Triage appears only
 * when the run has a triage step or profile; the baseline check and
 * preflight only once the run has entered them. A stop is shown on the stage
 * the run stopped after, not as a stage of its own.
 */
export function derivePipeline(input: PipelineInput): Pipeline {
  const { report } = input
  const approvals = report.waits.filter((w) => stageOf(w.name) === 'approve')
  const specWaits = report.waits.filter((w) => stageOf(w.name) === 'spec-wait')
  const counts = new Map<string, number>()
  for (const v of report.stageVisits) counts.set(v.stage, v.visits)
  // Approval is a wait, not a step, so it has no attempts to count.
  counts.set('approve', new Set(approvals.map((w) => w.name)).size)
  for (const once of ONCE_STAGES)
    counts.set(
      once,
      report.attempts.some((a) => stageOf(a.stepName) === once) ? 1 : 0,
    )
  // The spec is written once and then once per fix; it is reviewed once per
  // round.
  const specSteps = new Set(
    report.attempts
      .map((a) => a.stepName)
      .filter((n) => n === 'spec:author' || n.startsWith('spec:fix:')),
  )
  counts.set('spec', specSteps.size)
  counts.set(
    'spec-review',
    new Set(
      report.attempts
        .filter((a) => stageOf(a.stepName) === 'spec-review')
        .map((a) => a.stepName.split(':')[1]),
    ).size,
  )
  const hasTriage =
    (counts.get('triage') ?? 0) > 0 ||
    report.roleUsage.some((r) => r.role === 'triage')
  const order = (
    hasSpecStages(report) ? SPEC_PIPELINE_ORDER : PIPELINE_ORDER
  ).filter(
    (s) =>
      (s !== 'triage' || hasTriage) &&
      (!OPTIONAL_ONCE.includes(s) || (counts.get(s) ?? 0) > 0),
  )

  const events = pipelineEvents(report.attempts, [
    ...approvals,
    ...specWaits,
  ]).sort((x, y) => x.at - y.at)
  const last = events.at(-1)?.stage ?? null
  const terminal = TERMINAL_STATUSES.includes(input.status)
  let at: string | null
  let atState: PipelineState
  if (terminal) {
    const finished =
      input.status === 'completed' && (counts.get('finish') ?? 0) > 0
    at = finished ? null : (last ?? 'setup')
    atState = 'stopped'
  } else {
    const live = input.live?.stage
    at = live && order.includes(live) ? live : (last ?? 'setup')
    atState =
      input.diagnosisKind === 'running'
        ? 'running'
        : needsHuman(input.diagnosisKind)
          ? 'waiting'
          : 'current'
  }
  // Only an auto-approving run reaches finish without an approval wait; a
  // rejection needs the wait too.
  const autoApproved =
    (counts.get('finish') ?? 0) > 0 && (counts.get('approve') ?? 0) === 0
  const stages = order.map((stage) => {
    const count = counts.get(stage) ?? 0
    const state: PipelineState =
      stage === at
        ? atState
        : count > 0
          ? 'done'
          : stage === 'approve' && autoApproved
            ? 'auto'
            : 'not-reached'
    return { stage, state, count }
  })

  const parts = stages
    .filter((s) => s.count > 1)
    .map((s) => PIPELINE_WORDS.visits(stageName(s.stage), formatCount(s.count)))
  // Stages the run passed by without entering them.
  const reached = stages.map((s) => s.state !== 'not-reached').lastIndexOf(true)
  const skipped = stages
    .slice(0, reached)
    .filter((s) => s.state === 'not-reached')
    .map((s) => stageName(s.stage))
  if (skipped.length > 0) parts.push(PIPELINE_WORDS.skipped(skipped))
  if (autoApproved) parts.push(PIPELINE_WORDS.autoApproved)
  const name = at === null ? '' : stageName(at)
  if (at === null) parts.push(PIPELINE_WORDS.finished)
  else if (atState === 'stopped') parts.push(PIPELINE_WORDS.stoppedAt(name))
  else if (atState === 'running') parts.push(PIPELINE_WORDS.runningAt(name))
  else if (atState === 'waiting') parts.push(PIPELINE_WORDS.waitingAt(name))
  else parts.push(PIPELINE_WORDS.at(name))
  return { stages, label: PIPELINE_WORDS.sentence(parts) }
}

// ---------------------------------------------------------------- trace

/**
 * A row's state, always shown in words beside its glyph. `interrupted` is an
 * attempt a worker lost or gave up; `lost` is an open run's unfinished
 * attempt that no live lease holds, so it is not running and its end is
 * unknown; `idle` is an open run between steps.
 */
export type TraceState =
  | 'done'
  | 'running'
  | 'waiting'
  | 'failed'
  | 'interrupted'
  | 'lost'
  | 'idle'

/**
 * The operation checkpoint as the attempt recorded it: `recovered` reused a
 * completed call without sending it again; `uncertain` has only a start.
 */
export type TraceCheckpoint =
  | 'completed'
  | 'recovered'
  | 'uncertain'
  | 'running'

export interface TraceProfile {
  provider: string | null
  /** The model and effort the call ran with; null is the provider default. */
  model: string | null
  effort: string | null
  /** What the provider itself reported; null when it reported nothing. */
  reportedModel: string | null
}

export interface TraceNode {
  /** Stable across refreshes, so expansion and selection survive a poll. */
  id: string
  kind: 'run' | 'iteration' | 'entry' | 'attempt'
  /** `1回目`, `実装`, `正しさのレビュー`, `試行 2`, … */
  label: string
  /** The stage of an entry or attempt; null for the run and iterations. */
  stage: string | null
  /** Which pass through code the row belongs to; null before the first. */
  iteration: number | null
  state: TraceState
  /** Still running or waiting: the row ends at `now`. */
  open: boolean
  /** Milliseconds from the trace's start; null when unknown. */
  startMs: number | null
  endMs: number | null
  startedAt: string | null
  endedAt: string | null
  /** Wall time; provisional while open, null when unknown. */
  durationMs: number | null
  /** Step attempts under the row. */
  attempts: number
  /** An attempt's lease generation: which worker lease ran it. */
  leaseGeneration: number | null
  interruptionReason: string | null
  /** The factory's limit that stopped an agent call; null when none did. */
  timedOut: AgentTimeout | null
  profile: TraceProfile | null
  /** Same sums as the report's stage usage; null when no LLM call is under the row. */
  usage: UsageTotals | null
  checkpoint: TraceCheckpoint | null
  /** A review's verdict, when a stored step output or the report still has it. */
  review: ReportReview | null
  /** The candidate a code entry sealed, when still stored. */
  candidate: ReportCandidate | null
  /**
   * A verification row's full check output: the attempt's own, or the
   * entry's latest attempt's. Null on every other row.
   */
  verificationLog: VerificationLog | null
  /**
   * The attempt whose log the row shows: an attempt row's own, or the
   * entry's latest attempt that recorded one. After a retry, the entry
   * shows the retry's log and each attempt row its own. Null when none did.
   */
  logAttemptId: string | null
  /** That attempt's agent output, when it sent an LLM call. */
  agentLog: AgentLog | null
  wait: Pick<WaitRow, 'outcome' | 'inputWaitMs' | 'executionSlotWaitMs'> | null
  children: TraceNode[]
}

export interface Trace {
  /** The run's creation: every row's `startMs` counts from here. */
  startedAt: string
  /** To the last known end, or to `now` while the run is open. */
  spanMs: number
  open: boolean
  root: TraceNode
}

export interface TraceInput {
  run: {
    status: string
    createdAt: string
    startedAt: string | null
    completedAt: string | null
    leaseGeneration: number
  }
  /** The request's diagnosis: only `running` has a live lease. */
  diagnosisKind: DiagnosisKind
  conclusion: string | null
  attempts: AttemptRow[]
  waits: Pick<
    WaitRow,
    | 'id'
    | 'name'
    | 'outcome'
    | 'createdAt'
    | 'resolvedAt'
    | 'inputWaitMs'
    | 'executionSlotWaitMs'
  >[]
  /**
   * The report's last review round and last sealed candidate. The candidate
   * is shown only on the code entry whose own candidate step completed.
   */
  reviews: ReportReview[]
  candidate: ReportCandidate | null
  /**
   * The report's review rounds and sealed candidates. A row whose sequence
   * is here shows the report's value; the step outputs below only fill in
   * for a report that does not carry them.
   */
  reviewRounds?: ReportReviewRound[]
  /** The report's spec review rounds; `lens` is the reviewer's name. */
  specRounds?: ReportReviewRound[]
  candidates?: ReportSealedCandidate[]
  /** Outputs of the run's completed steps, by step name. */
  stepOutputs: Record<string, unknown>
  now: number
}

/** The stage entry a stored step or wait name belongs to. */
function entryOf(name: string): {
  key: string
  stage: string
  label: string
  lens: string | null
  seq: number | null
} | null {
  // Once-per-run stages; every preflight step, the free check and each
  // minimal call, is one entry.
  const once = stageOf(name)
  if (ONCE_STAGES.includes(once))
    return {
      key: once,
      stage: once,
      label: stageName(once),
      lens: null,
      seq: null,
    }
  const spec = specEntryOf(name)
  if (spec) return spec
  const [kind, s, stage, sub] = name.split(':')
  if (kind !== 'stage' || !s || !stage) return null
  const seq = Number(s)
  if (!Number.isInteger(seq)) return null
  if (stage === 'review') {
    if (sub !== 'correctness' && sub !== 'edge-cases') return null
    return {
      key: `review:${sub}#${seq}`,
      stage,
      label: lensName(sub),
      lens: sub,
      seq,
    }
  }
  return {
    key: `${stage}#${seq}`,
    stage,
    label: stageName(stage),
    lens: null,
    seq,
  }
}

/**
 * A spec step or wait's entry: the author, each fix, each reviewer of each
 * round, the confirmation, and each wait for a person's decision. They come
 * before any code, so they sit under the run, in the order they began.
 */
function specEntryOf(name: string): {
  key: string
  stage: string
  label: string
  lens: string | null
  seq: number | null
} | null {
  const [kind, a, b] = name.split(':')
  const entry = (
    key: string,
    stage: string,
    label: string,
    lens = null as string | null,
  ) => ({
    key,
    stage,
    label,
    lens,
    seq: null,
  })
  if (name === 'spec:author')
    return entry(name, 'spec', roleName('spec-author'))
  if (name === 'spec:final') return entry(name, 'spec', TRACE_WORDS.specFinal)
  if (kind === 'spec' && a === 'fix' && b)
    return entry(
      `spec:fix#${b}`,
      'spec',
      TRACE_WORDS.numbered(roleName('spec-fix'), b),
    )
  if (kind === 'spec-review' && a && b)
    return entry(
      `spec-review:${b}#${a}`,
      'spec-review',
      TRACE_WORDS.numbered(roleName(`spec-review:${b}`), a),
      b,
    )
  if (kind === 'spec-wait' && a)
    return entry(
      `spec-wait#${a}`,
      'spec-wait',
      TRACE_WORDS.numbered(stageName('spec-wait'), a),
    )
  return null
}

function checkpointOf(a: AttemptRow, open: boolean): TraceCheckpoint | null {
  const result = a.measurement?.result ?? null
  // Superseded before it was sent: no checkpoint was ever written.
  if (result === null || result === NOT_SENT) return null
  if (result === 'checkpoint-recovered') return 'recovered'
  // A review a failed check ended is settled by its completed checkpoint.
  if (
    result.endsWith('-done') ||
    result === 'pass' ||
    result === 'fail' ||
    result === 'cancelled' ||
    result === 'timed-out'
  )
    return 'completed'
  return open ? 'running' : 'uncertain'
}

function profileOf(attempts: AttemptRow[]): TraceProfile | null {
  const m = [...attempts]
    .reverse()
    .find((a) => a.measurement?.usageScope != null)?.measurement
  return m
    ? {
        provider: m.provider,
        model: m.effectiveModel,
        effort: m.effectiveEffort,
        reportedModel: m.reportedModel,
      }
    : null
}

/**
 * Whether an attempt may still be running, and so writing its log: it has
 * not finished, it belongs to the run's current lease generation, and the
 * diagnosis says that lease is live. An attempt a cancel or a lost lease
 * left `started` is not open.
 */
export function attemptOpen(
  a: Pick<AttemptRow, 'completedAt' | 'status' | 'leaseGeneration'>,
  run: { leaseGeneration: number },
  leaseLive: boolean,
): boolean {
  return (
    leaseLive &&
    a.completedAt === null &&
    a.status === 'started' &&
    a.leaseGeneration === run.leaseGeneration
  )
}

const hasLog = (a: AttemptRow) =>
  Boolean(a.measurement?.agentLog || a.measurement?.verificationLog)

/** A row's log: the attempt that recorded it and its agent log, if any. */
function logOf(
  a: AttemptRow | undefined,
): Pick<TraceNode, 'logAttemptId' | 'agentLog'> {
  return a && hasLog(a)
    ? { logAttemptId: a.attemptId, agentLog: a.measurement?.agentLog ?? null }
    : { logAttemptId: null, agentLog: null }
}

const iso = (ms: number | null) =>
  ms === null ? null : new Date(ms).toISOString()

/**
 * The run as a span tree: run → iteration (one per entry into code) → stage
 * entry → the entry's attempts, listed only when a step was retried. Stage
 * entries before the first code entry (setup, triage) sit under the run.
 * Only the current lease generation of a run the diagnosis calls `running`
 * can still be running; any other missing end stays unknown rather than
 * being drawn to `now`.
 * Each row's usage is `usageOf` its attempts, the report's own sum.
 */
export function deriveTrace(input: TraceInput): Trace {
  const { run, now } = input
  const terminal = TERMINAL_STATUSES.includes(run.status)
  // `diagnose` decides whether the lease is live; it is not decided twice.
  const leaseLive = input.diagnosisKind === 'running'
  const created = Date.parse(run.createdAt)
  const firstStart = Math.min(
    ...input.attempts
      .map((a) => Date.parse(a.startedAt))
      .filter(Number.isFinite),
    ...input.waits.map((w) => Date.parse(w.createdAt)).filter(Number.isFinite),
  )
  const origin = Number.isFinite(created)
    ? Math.min(created, firstStart)
    : firstStart
  const rel = (ms: number | null) =>
    ms === null || !Number.isFinite(origin) ? null : ms - origin
  const failedRun =
    run.status === 'failed' ||
    input.conclusion === 'verification-failed' ||
    input.conclusion === 'review-cap-reached'

  type Timed = {
    start: number | null
    end: number | null
    open: boolean
  }
  const node = (
    base: Pick<
      TraceNode,
      'id' | 'kind' | 'label' | 'stage' | 'iteration' | 'state'
    > &
      Timed &
      Partial<TraceNode>,
  ): TraceNode => {
    const end = base.open ? Math.max(now, base.start ?? now) : base.end
    return {
      attempts: 0,
      leaseGeneration: null,
      interruptionReason: null,
      timedOut: null,
      profile: null,
      usage: null,
      checkpoint: null,
      review: null,
      candidate: null,
      verificationLog: null,
      logAttemptId: null,
      agentLog: null,
      wait: null,
      children: [],
      ...base,
      startMs: rel(base.start),
      endMs: rel(end),
      startedAt: iso(base.start),
      endedAt: base.open ? null : iso(base.end),
      durationMs:
        base.start === null || end === null
          ? null
          : Math.max(0, end - base.start),
    }
  }
  const time = (s: string | null) => {
    const ms = s ? Date.parse(s) : NaN
    return Number.isFinite(ms) ? ms : null
  }

  // Attempts and waits grouped by stage entry, in the order entries began.
  interface Entry {
    key: string
    stage: string
    label: string
    lens: string | null
    seq: number | null
    attempts: AttemptRow[]
    wait: TraceInput['waits'][number] | null
    start: number
  }
  const entries = new Map<string, Entry>()
  const add = (name: string, at: number, fill: (e: Entry) => void) => {
    const where = entryOf(name)
    if (!where || !Number.isFinite(at)) return
    const entry = entries.get(where.key) ?? {
      ...where,
      attempts: [],
      wait: null,
      start: at,
    }
    entry.start = Math.min(entry.start, at)
    fill(entry)
    entries.set(where.key, entry)
  }
  for (const a of input.attempts)
    add(a.stepName, Date.parse(a.startedAt), (e) => e.attempts.push(a))
  for (const w of input.waits)
    if (stageOf(w.name) === 'approve' || stageOf(w.name) === 'spec-wait')
      add(w.name, Date.parse(w.createdAt), (e) => (e.wait = w))
  const ordered = [...entries.values()].sort(
    (x, y) => (x.seq ?? -1) - (y.seq ?? -1) || x.start - y.start,
  )

  const lastReviewSeq = Math.max(
    -1,
    ...ordered.filter((e) => e.stage === 'review').map((e) => e.seq ?? -1),
  )
  const lastCodeSeq = Math.max(
    -1,
    ...ordered.filter((e) => e.stage === 'code').map((e) => e.seq ?? -1),
  )

  let iteration = 0
  const iterations: { n: number; rows: TraceNode[] }[] = []
  const before: TraceNode[] = []
  for (const e of ordered) {
    if (e.stage === 'code') {
      iteration++
      iterations.push({ n: iteration, rows: [] })
    }
    const at = iteration > 0 ? iteration : null
    const row = e.wait ? waitRow(e, at) : attemptRow(e, at)
    ;(iterations.at(-1)?.rows ?? before).push(row)
  }

  function waitRow(e: Entry, at: number | null): TraceNode {
    const w = e.wait
    if (!w) throw new Error('not a wait')
    const open = !terminal && w.resolvedAt === null
    return node({
      id: `entry:${e.key}`,
      kind: 'entry',
      label: e.label,
      stage: e.stage,
      iteration: at,
      state: open
        ? 'waiting'
        : w.outcome === 'timeout'
          ? 'failed'
          : w.resolvedAt === null
            ? 'interrupted'
            : 'done',
      start: time(w.createdAt),
      end: time(w.resolvedAt),
      open,
      wait: {
        outcome: w.outcome,
        inputWaitMs: w.inputWaitMs,
        executionSlotWaitMs: w.executionSlotWaitMs,
      },
    })
  }

  function attemptRow(e: Entry, at: number | null): TraceNode {
    const sorted = [...e.attempts].sort(
      (x, y) => Date.parse(x.startedAt) - Date.parse(y.startedAt),
    )
    const unfinished = (a: AttemptRow) =>
      a.completedAt === null && a.status === 'started'
    const isOpen = (a: AttemptRow) => attemptOpen(a, run, leaseLive)
    const stateOf = (a: AttemptRow): TraceState =>
      isOpen(a)
        ? 'running'
        : !terminal && unfinished(a)
          ? 'lost'
          : a.status === 'failed' && !a.interruptionReason
            ? 'failed'
            : a.measurement?.result === 'fail'
              ? 'failed'
              : a.status === 'completed'
                ? 'done'
                : 'interrupted'
    // The latest attempt of each step decides the entry.
    const latest = new Map<string, AttemptRow>()
    for (const a of sorted) latest.set(a.stepName, a)
    const finals = [...latest.values()]
    const states = finals.map(stateOf)
    const state: TraceState =
      (['running', 'failed', 'lost', 'interrupted'] as const).find((x) =>
        states.includes(x),
      ) ?? 'done'
    const open = states.includes('running')
    const ends = finals.map((a) => time(a.completedAt))
    const known = sorted
      .map((a) => time(a.completedAt))
      .filter((v): v is number => v !== null)
    // `stage:<n>:<stage>:<part>`, or `preflight:call:<i>`.
    const suffix = (a: AttemptRow) => {
      const parts = a.stepName.split(':')
      return parts[0] === 'stage' ? parts[3] : parts[1]
    }
    const multiStep = latest.size > 1
    const retried = sorted.length > latest.size
    const counters = new Map<string, number>()
    const children = retried
      ? sorted.map((a) => {
          const n = (counters.get(a.stepName) ?? 0) + 1
          counters.set(a.stepName, n)
          const aOpen = isOpen(a)
          const part = suffix(a)
          return node({
            id: `attempt:${a.attemptId}`,
            kind: 'attempt',
            label: TRACE_WORDS.attempt(
              n,
              multiStep && part ? stepPartName(part) : undefined,
            ),
            stage: e.stage,
            iteration: at,
            state: stateOf(a),
            start: time(a.startedAt),
            end: time(a.completedAt),
            open: aOpen,
            attempts: 1,
            leaseGeneration: a.leaseGeneration,
            interruptionReason: a.interruptionReason,
            timedOut: a.measurement?.timedOut ?? null,
            profile: profileOf([a]),
            usage: usageOf([a]),
            checkpoint: checkpointOf(a, aOpen),
            verificationLog: a.measurement?.verificationLog ?? null,
            ...logOf(a),
          })
        })
      : []
    const checked = [...sorted].reverse().find((a) => a.measurement)
    const lens = e.lens
    const reviewStep =
      e.seq === null || lens === null ? null : `stage:${e.seq}:review:${lens}`
    // The report's last verdicts belong to the last entry only once it is
    // done: an entry still at work has decided nothing yet.
    const lastDone = state === 'done'
    // A spec reviewer's verdict: its round's in the report, or its step's.
    const specRound = e.stage === 'spec-review' ? e.key.split('#')[1] : null
    const specReview =
      specRound && lens
        ? (input.specRounds
            ?.find((r) => String(r.round) === specRound)
            ?.reviews.find((r) => r.lens === lens) ??
          asSpecReview(input.stepOutputs[`spec-review:${specRound}:${lens}`]))
        : null
    const review =
      e.stage === 'spec-review'
        ? specReview
        : e.stage !== 'review'
          ? null
          : (input.reviewRounds
              ?.find((r) => r.sequence === e.seq)
              ?.reviews.find((r) => r.lens === lens) ??
            asReportReview(reviewStep ? input.stepOutputs[reviewStep] : null) ??
            (lastDone && e.seq === lastReviewSeq
              ? (input.reviews.find((r) => r.lens === lens) ?? null)
              : null))
    // Only the candidate this entry's own candidate step sealed: between its
    // agent step and that step, the entry has sealed nothing yet.
    const candidateStep = `stage:${e.seq}:code:candidate`
    const sealed = sorted.some(
      (a) => a.stepName === candidateStep && a.status === 'completed',
    )
    const candidate =
      e.stage !== 'code' || !sealed
        ? null
        : (input.candidates?.find((c) => c.sequence === e.seq) ??
          asReportCandidate(input.stepOutputs[candidateStep]) ??
          (e.seq === lastCodeSeq ? input.candidate : null))
    // The entry shows the log of the latest attempt of a step that records
    // one. A retry that replayed a checkpoint recorded none, so the entry
    // then has none rather than an older attempt's.
    const logSteps = new Set(sorted.filter(hasLog).map((a) => a.stepName))
    const logged = [...sorted].reverse().find((a) => logSteps.has(a.stepName))
    return node({
      id: `entry:${e.key}`,
      kind: 'entry',
      label: e.label,
      stage: e.stage,
      iteration: at,
      state,
      start: time(sorted[0]?.startedAt ?? null),
      end: ends.includes(null) ? null : Math.max(...known),
      open,
      attempts: sorted.length,
      interruptionReason:
        finals.find((a) => a.interruptionReason)?.interruptionReason ?? null,
      timedOut:
        finals.find((a) => a.measurement?.timedOut)?.measurement?.timedOut ??
        null,
      profile: profileOf(sorted),
      usage: usageOf(sorted),
      checkpoint: checked ? checkpointOf(checked, isOpen(checked)) : null,
      review,
      candidate,
      verificationLog: logged?.measurement?.verificationLog ?? null,
      ...logOf(logged),
      children,
    })
  }

  /** A parent spans its children; its end is unknown when the last one's is. */
  const span = (rows: TraceNode[]): Timed => {
    const open = rows.some((r) => r.open)
    const starts = rows.map((r) => r.startedAt).map(time)
    const known = starts.filter((v): v is number => v !== null)
    const last = [...rows]
      .sort((x, y) => (x.startMs ?? 0) - (y.startMs ?? 0))
      .at(-1)
    const ends = rows
      .map((r) => time(r.endedAt))
      .filter((v): v is number => v !== null)
    return {
      start: known.length > 0 ? Math.min(...known) : null,
      end:
        last?.endedAt == null || ends.length === 0 ? null : Math.max(...ends),
      open,
    }
  }

  const iterationRows = iterations.map(({ n, rows }, i) => {
    const states = rows.map((r) => r.state)
    const last = i === iterations.length - 1
    return node({
      id: `iteration:${n}`,
      kind: 'iteration',
      label: COMMON.nth(n),
      stage: null,
      iteration: n,
      state: states.includes('running')
        ? 'running'
        : states.includes('waiting')
          ? 'waiting'
          : states.includes('lost')
            ? 'lost'
            : last && failedRun && states.includes('failed')
              ? 'failed'
              : last && !terminal
                ? 'idle'
                : 'done',
      ...span(rows),
      attempts: rows.reduce((s, r) => s + r.attempts, 0),
      usage: usageOf(
        input.attempts.filter((a) => {
          const where = entryOf(a.stepName)
          return (
            where !== null && rows.some((r) => r.id === `entry:${where.key}`)
          )
        }),
      ),
      children: rows,
    })
  })

  const top = [...before, ...iterationRows]
  const topStates = top.map((r) => r.state)
  const root = node({
    id: 'run',
    kind: 'run',
    label: TRACE_WORDS.run,
    stage: null,
    iteration: null,
    state: terminal
      ? failedRun
        ? 'failed'
        : run.status === 'cancelled'
          ? 'interrupted'
          : 'done'
      : topStates.includes('running')
        ? 'running'
        : topStates.includes('waiting')
          ? 'waiting'
          : topStates.includes('lost')
            ? 'lost'
            : 'idle',
    start: Number.isFinite(origin) ? origin : null,
    end: terminal ? (time(run.completedAt) ?? span(top).end) : null,
    open: !terminal,
    attempts: input.attempts.length,
    usage: usageOf(input.attempts),
    children: top,
  })
  const ends = [root.endMs ?? 0, ...top.map((r) => r.endMs ?? r.startMs ?? 0)]
  return {
    startedAt: iso(Number.isFinite(origin) ? origin : now) ?? '',
    spanMs: Math.max(1, ...ends),
    open: !terminal,
    root,
  }
}

/** A database that exists but has no tables yet reads as `empty`. */
function orEmpty<T>(read: Promise<T>, empty: T): Promise<T> {
  return read.catch((error: unknown) => {
    if (/no such table/.test((error as Error)?.message ?? '')) return empty
    throw error
  })
}

async function allRuns(durably: AgentLoopDurably): Promise<Run[]> {
  const runs = await durably.getRuns({ jobName: durably.jobs.agentLoop.name })
  return runs.sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt))
}

type RunFilter = Parameters<ReportSource['getRuns']>[0]
const runsKey = (filter: RunFilter) => `runs:${JSON.stringify(filter ?? {})}`

/**
 * One request's reads, each made once however many readers ask for it: the
 * report, the diagnosis and the trace read the same run's steps and attempts.
 * `known` runs are already read.
 */
export function readOnce(db: ReportSource, known: Run[] = []): ReportSource {
  const memo = new Map<string, Promise<unknown>>()
  for (const run of known) memo.set(`run:${run.id}`, Promise.resolve(run))
  const once = <T>(key: string, read: () => Promise<T>): Promise<T> => {
    let hit = memo.get(key) as Promise<T> | undefined
    if (!hit) memo.set(key, (hit = read()))
    return hit
  }
  return {
    getRun: ((id: string) =>
      once(`run:${id}`, () => db.getRun(id))) as ReportSource['getRun'],
    getStepAttempts: (id) =>
      once(`attempts:${id}`, () => db.getStepAttempts(id)),
    getWaits: (id) => once(`waits:${id}`, () => db.getWaits(id)),
    getRuns: ((filter?: RunFilter) =>
      once(runsKey(filter), () =>
        db.getRuns(filter),
      )) as ReportSource['getRuns'],
    storage: {
      getSteps: (id) => once(`steps:${id}`, () => db.storage.getSteps(id)),
      getCompletedStep: (id, name) =>
        once(`step:${id}:${name}`, () => db.storage.getCompletedStep(id, name)),
    },
  }
}

/**
 * Reports by run. A finished run's row never changes again, so its report is
 * built once and reused while the row is unchanged. Only three fields read
 * files that can still change: a failed or cancelled run's `failure` reads
 * checkpoint files, so a reused report gets it classified again; a reused
 * baseline cites another run's log, so it is worked out again from the
 * stored step to say whether that log is still there; and the worktree is
 * looked for again, since an archive or a prune removes it.
 * Its repair children can also be added after it finished, so a reused
 * report always gets them again: from `children` when the caller worked them
 * out from the runs it read, otherwise with one label query. Open runs are
 * built on every call. `fresh` says the report's failure was worked out by
 * this call.
 */
export function finishedReportCache(build = buildReport) {
  const finished = new Map<string, { updatedAt: string; report: LoopReport }>()
  return {
    async get(
      src: ReportSource,
      run: Pick<
        Run,
        'id' | 'jobName' | 'status' | 'updatedAt' | 'input' | 'output' | 'error'
      >,
      children?: string[],
    ): Promise<{ report: LoopReport; fresh: boolean }> {
      const hit = finished.get(run.id)
      if (hit?.updatedAt === run.updatedAt) {
        const lineage = {
          parent: hit.report.lineage?.parent ?? null,
          children: children ?? (await repairChildren(src, run)),
        }
        const baseline = hit.report.baseline?.reusedFrom
          ? (reusedBaselineOf(
              (await src.storage.getCompletedStep(run.id, BASELINE_STEP))
                ?.output,
            ) ?? hit.report.baseline)
          : hit.report.baseline
        // Whether the worktree is still there is a fact about the disk: an
        // archive or `demo prune --apply` removes it without touching the
        // run's row.
        const worktree = currentWorktree(hit.report.worktree)
        const cached = { ...hit.report, lineage, baseline, worktree }
        if (run.status === 'completed') return { report: cached, fresh: false }
        const failure = await classifyRun(src, run)
        return { report: { ...cached, failure }, fresh: true }
      }
      const report = await build(src, run.id, children ? { children } : {})
      if (TERMINAL_STATUSES.includes(run.status))
        finished.set(run.id, { updatedAt: run.updatedAt, report })
      return { report, fresh: true }
    },
    /** Drop the reports of runs no longer listed, such as deleted ones. */
    keep(runs: Pick<Run, 'id'>[]) {
      const ids = new Set(runs.map((r) => r.id))
      for (const id of finished.keys()) if (!ids.has(id)) finished.delete(id)
    },
  }
}

/**
 * The reports of `runs`, for a view that lists many. Each run's repair
 * children come from `all`, the job's runs this request already read, grouped
 * once, so no report makes its own child query and the view's reads do not
 * grow with the square of the history.
 */
export async function listedReports<R extends Run>(
  cache: ReturnType<typeof finishedReportCache>,
  src: ReportSource,
  runs: R[],
  all: Run[],
): Promise<{ run: R; report: LoopReport; fresh: boolean }[]> {
  const children = repairChildrenByParent(all)
  return Promise.all(
    runs.map(async (run) => ({
      run,
      ...(await cache.get(src, run, children.get(run.id) ?? [])),
    })),
  )
}

/** A run named from its stored input, or `fallback` when its row is gone. */
async function runRef(
  src: ReportSource,
  id: string,
  fallback: string,
): Promise<RunRef> {
  const run = await src.getRun(id)
  return { id, name: run ? runName(run.input) : fallback }
}

/**
 * The run whose passing baseline check this run reused, named the same way
 * as repair lineage links. Falls back to a generic label only when that
 * run's row no longer exists.
 */
async function baselineSourceOf(
  src: ReportSource,
  baseline: LoopReport['baseline'],
): Promise<RunRef | null> {
  const runId = baseline?.reusedFrom?.runId
  return runId ? runRef(src, runId, RUN_NAME.previous) : null
}

/** What both the list row and the detail page read for one run. */
async function inspect(
  src: ReportSource,
  run: Run,
  now: number,
  report: LoopReport,
  /** The report's failure was worked out in this request, so it is current. */
  fresh: boolean,
  archived: ReadonlySet<string>,
) {
  const { diagnosis, uncertainCall } = await diagnoseRun(
    src,
    run,
    now,
    fresh ? { failure: report.failure } : undefined,
    undefined,
    archived.has(run.id),
  )
  const live = liveElapsed(run, report.attempts, now)
  const decides =
    diagnosis.kind === 'approval' || diagnosis.kind === 'spec-approval'
  const shelved = archived.has(run.id) && archivable(diagnosis.kind)
  return {
    name: runName(run.input),
    createdAt: run.createdAt,
    diagnosis,
    uncertainCall,
    needsHuman: needsHuman(diagnosis.kind),
    archived: shelved,
    archiveCommand: shelved
      ? `${DEMO} unarchive --run ${run.id}`
      : archivable(diagnosis.kind)
        ? `${DEMO} archive --run ${run.id}`
        : null,
    waitId: decides ? (run.waitingOnWaitId ?? null) : null,
    live,
    pipeline: derivePipeline({
      status: run.status,
      diagnosisKind: diagnosis.kind,
      live,
      report,
    }),
    report,
  }
}

function runRow(
  run: Run,
  { report, ...seen }: Awaited<ReturnType<typeof inspect>>,
): RunRow {
  return {
    id: run.id,
    status: run.status,
    ...seen,
    reviewHighlights:
      seen.diagnosis.kind === 'approval' ? report.reviewHighlights : null,
    conclusion: report.summary.conclusion,
    leadTimeMs: report.summary.leadTimeMs,
    costUsd: report.summary.costUsd,
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** The most of a log one request reads. */
export const LOG_READ_MAX = 64 * 1024

/** Which of an attempt's logs a read asks for; `agent` when unnamed. */
export const LOG_FILES = ['agent', 'stdout', 'stderr'] as const
export type LogFile = (typeof LOG_FILES)[number]

/** The status a recorded log file that is gone answers with. */
export const LOG_MISSING_STATUS = 410

/**
 * One read of a log. `nextOffset` is `from` plus the bytes `chunk` holds;
 * `done` says nothing more will come: the attempt has ended and the read
 * reached the end of the file.
 */
export interface LogChunk {
  chunk: string
  nextOffset: number
  done: boolean
}

/**
 * How many leading bytes of `bytes` are whole UTF-8 characters: a
 * character cut off at the end is left for the next read.
 */
export function wholeUtf8Length(bytes: Uint8Array): number {
  for (let i = bytes.length - 1; i >= Math.max(0, bytes.length - 4); i--) {
    const b = bytes[i] ?? 0
    if ((b & 0xc0) === 0x80) continue
    const size = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1
    return i + size <= bytes.length ? bytes.length : i
  }
  return bytes.length
}

/**
 * Up to `LOG_READ_MAX` bytes of the log at `path` from byte `from`. The path
 * must be in `runRoot` as recorded and once its links are resolved. Once
 * the attempt has `ended`, a read that reaches the end of the file returns
 * every byte, a cut-off character included, so the log can end.
 */
export async function readLogChunk(
  runRoot: string,
  path: string,
  from: number,
  ended: boolean,
): Promise<LogChunk> {
  const outside = () => new HttpError(403, 'the log is outside the run')
  const root = resolve(runRoot)
  const recorded = resolve(path)
  if (!recorded.startsWith(root + sep)) throw outside()
  const gone = (error: unknown) =>
    (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? new HttpError(LOG_MISSING_STATUS, `the log file is missing: ${path}`)
      : error
  let handle: Awaited<ReturnType<typeof open>>
  try {
    const real = await realpath(recorded)
    if (!real.startsWith((await realpath(root)) + sep)) throw outside()
    handle = await open(real, 'r')
  } catch (error) {
    throw gone(error)
  }
  try {
    const { size } = await handle.stat()
    const buffer = Buffer.alloc(
      Math.max(0, Math.min(LOG_READ_MAX, size - from)),
    )
    const { bytesRead } =
      buffer.length > 0
        ? await handle.read(buffer, 0, buffer.length, from)
        : { bytesRead: 0 }
    const read = buffer.subarray(0, bytesRead)
    const last = ended && from + bytesRead >= size
    const kept = last ? bytesRead : wholeUtf8Length(read)
    return {
      chunk: read.subarray(0, kept).toString('utf8'),
      nextOffset: from + kept,
      done: last,
    }
  } finally {
    await handle.close()
  }
}

/** A `from` query value: a non-negative safe integer, 0 when absent. */
function offsetOf(raw: string | null): number {
  const from = raw === null ? 0 : /^\d+$/.test(raw) ? Number(raw) : NaN
  if (!Number.isSafeInteger(from))
    throw new HttpError(400, 'from must be a non-negative integer byte offset')
  return from
}

/** What a write calls, by the last segment of its path. */
const ACTIONS = [
  'approve',
  'reject',
  'spec-revise',
  'retrigger',
  'archive',
  'unarchive',
] as const
type Action = (typeof ACTIONS)[number]

/**
 * A write's path: `/api/runs/<id>/<action>`; null for any other path. The
 * ID stays encoded, so telling a write from a read never throws; it is
 * decoded with `idOf` once the request has passed its checks.
 */
export function actionPath(
  pathname: string,
): { rawId: string; action: Action } | null {
  const match = /^\/api\/runs\/([^/]+)\/([a-z-]+)$/.exec(pathname)
  const action = ACTIONS.find((a) => a === match?.[2])
  return match?.[1] && action ? { rawId: match[1], action } : null
}

/** An ID from its path segment; a malformed escape is the request's fault. */
function idOf(raw: string): string {
  try {
    return decodeURIComponent(raw)
  } catch {
    throw new HttpError(400, 'malformed id in the path')
  }
}

/** The API, without a listening socket. */
function createUiApi() {
  const stateRoot = defaultStateRoot()
  let durably: AgentLoopDurably | null = null
  // Opened on first use after the file appears, then kept. Nothing is
  // created before a worker or `trigger` creates the database.
  const source = () =>
    (durably ??= existsSync(dbPath(stateRoot))
      ? createAgentDurably({ stateRoot })
      : null)
  let migrated: Promise<void> | null = null

  const reports = finishedReportCache()

  async function runs(): Promise<RunsResponse> {
    const now = Date.now()
    const base = {
      db: dbPath(stateRoot),
      now: new Date(now).toISOString(),
    }
    const db = source()
    if (!db) return { ...base, exists: false, runs: [], tasks: [] }
    const all = await orEmpty(allRuns(db), [])
    reports.keep(all)
    const src = readOnce(db, all)
    const archived = archivedRunIds(stateRoot)
    const built = await listedReports(reports, src, all, all)
    const rows = await Promise.all(
      built.map(async ({ run, report, fresh }) =>
        runRow(run, await inspect(src, run, now, report, fresh, archived)),
      ),
    )
    const tasks = groupTasks(
      built.map(({ run, report }, i) => ({
        ...taskRunInput(run, rows[i]?.diagnosis.kind ?? 'finished', report),
        archived: archived.has(run.id),
      })),
    )
    return { ...base, exists: true, runs: rows, tasks }
  }

  async function run(id: string): Promise<RunDetailResponse> {
    const now = Date.now()
    const db = source()
    const found = db ? await orEmpty(db.getRun(id), null) : null
    if (!db || !found) throw new HttpError(404, `no run ${id}`)
    const src = readOnce(db, [found])
    const archived = archivedRunIds(stateRoot)
    const { report, fresh } = await reports.get(src, found)
    const [seen, steps, baselineSource, lineage] = await Promise.all([
      inspect(src, found, now, report, fresh, archived),
      src.storage.getSteps(id),
      baselineSourceOf(src, report.baseline),
      lineageOf(db, found, now, archived),
    ])
    const stepOutputs: Record<string, unknown> = {}
    for (const s of steps)
      if (s.status === 'completed') stepOutputs[s.name] = s.output
    return {
      now: new Date(now).toISOString(),
      ...seen,
      lineage,
      checkLogs: checkLogFiles(seen.diagnosis.failure?.details ?? []),
      baselineSource,
      trace: deriveTrace({
        run: found,
        diagnosisKind: seen.diagnosis.kind,
        conclusion: report.summary.conclusion,
        attempts: report.attempts,
        waits: report.waits,
        reviews: report.reviews,
        candidate: report.candidate,
        reviewRounds: report.reviewRounds,
        specRounds: report.specRounds,
        candidates: report.candidates,
        stepOutputs,
        now,
      }),
    }
  }

  /**
   * The task `run` belongs to, from every run of the job: each member
   * diagnosed and grouped as the list groups it, so both number the
   * repairs and mark a replaced run the same way.
   */
  async function lineageOf(
    db: AgentLoopDurably,
    run: Run,
    now: number,
    archived: ReadonlySet<string>,
  ): Promise<LineageRun[]> {
    const all = await orEmpty(allRuns(db), [run])
    const ids = new Set(
      taskRunIds(
        all.map((r) => ({ id: r.id, parentId: repairParentId(r) })),
        run.id,
      ),
    )
    const members = all.filter((r) => ids.has(r.id))
    if (members.length <= 1) return []
    const src = readOnce(db, members)
    const children = repairChildrenByParent(all)
    const read = await Promise.all(
      members.map(async (m) => {
        const { report, fresh } = await reports.get(
          src,
          m,
          children.get(m.id) ?? [],
        )
        const { diagnosis } = await diagnoseRun(
          src,
          m,
          now,
          fresh ? { failure: report.failure } : undefined,
        )
        return { run: m, report, kind: diagnosis.kind }
      }),
    )
    const [task] = groupTasks(
      read.map(({ run: m, report, kind }) => ({
        ...taskRunInput(m, kind, report),
        archived: archived.has(m.id),
      })),
    )
    const byId = new Map(read.map((x) => [x.run.id, x]))
    return (task?.runs ?? []).flatMap((r) => {
      const hit = byId.get(r.id)
      return hit
        ? [
            {
              ...r,
              status: hit.run.status,
              conclusion: hit.report.summary.conclusion,
              createdAt: hit.run.createdAt,
            },
          ]
        : []
    })
  }

  async function compare(): Promise<CompareResponse> {
    const db = source()
    if (!db) return { runIds: [], comparison: { groups: [] } }
    const all = await orEmpty(allRuns(db), [])
    reports.keep(all)
    const done = all.filter((r) => TERMINAL_STATUSES.includes(r.status))
    const src = readOnce(db, done)
    const built = (await listedReports(reports, src, done, all)).map(
      (r) => r.report,
    )
    return {
      runIds: done.map((r) => r.id),
      comparison: compareReports(built),
    }
  }

  async function trend(): Promise<TrendResponse> {
    const now = Date.now()
    const db = source()
    if (!db) return trendOf([], { now })
    const all = await orEmpty(allRuns(db), [])
    reports.keep(all)
    // Only the runs of the window's tasks get a report, never the whole
    // history.
    const rows = all.map((run) => ({ ...run, parentId: repairParentId(run) }))
    const read = new Set(trendRunIds(rows, { now }))
    const done = rows.filter((r) => read.has(r.id))
    const built = await listedReports(reports, readOnce(db, done), done, all)
    return trendOf(
      built.map(({ run, report }) => ({ ...run, report })),
      { now },
    )
  }

  /**
   * One write, through the function its `demo` subcommand calls. The caller
   * has already checked the method, the Origin and the token.
   */
  async function act(
    runId: string,
    action: Action,
    body: { waitId?: unknown; notes?: unknown },
  ): Promise<unknown> {
    const db = source()
    if (!db) throw new HttpError(404, `no run ${runId}`)
    // A failed migration is not kept, so the next write tries again.
    await (migrated ??= db.migrate().catch((error: unknown) => {
      migrated = null
      throw error
    }))
    const text = (v: unknown) => (typeof v === 'string' ? v : '')
    try {
      switch (action) {
        case 'approve':
        case 'reject':
          return await decideRun(
            db,
            runId,
            text(body.waitId),
            action === 'approve' ? 'approved' : 'rejected',
          )
        case 'spec-revise':
          return await reviseSpec(db, runId, text(body.notes))
        case 'retrigger':
          return await retriggerRun(db, runId)
        case 'archive':
          return await archiveRun(db, runId)
        case 'unarchive':
          return await unarchiveRun(db, runId)
      }
    } catch (error) {
      // The CLI's own words: a refusal is the request's fault, not the
      // server's.
      const message = (error as Error).message
      throw new HttpError(message.startsWith('no run ') ? 404 : 409, message)
    }
  }

  /**
   * Part of one attempt's log. The attempt is looked up among the run's
   * own, and the path is the one it recorded, never one the request names.
   */
  async function log(
    runId: string,
    attemptId: string,
    query: URLSearchParams,
  ): Promise<LogChunk> {
    const from = offsetOf(query.get('from'))
    const file = LOG_FILES.find((f) => f === (query.get('file') ?? 'agent'))
    if (!file) throw new HttpError(400, `file must be ${LOG_FILES.join(', ')}`)
    const db = source()
    const found = db ? await orEmpty(db.getRun(runId), null) : null
    if (!db || !found) throw new HttpError(404, `no run ${runId}`)
    const attempt = (await db.getStepAttempts(runId)).find(
      (a) => a.id === attemptId,
    )
    if (!attempt) throw new HttpError(404, `no attempt ${attemptId}`)
    const row = toAttemptRow(attempt)
    const m = row.measurement
    const path =
      file === 'agent'
        ? m?.agentLog?.path
        : file === 'stdout'
          ? m?.verificationLog?.stdoutPath
          : m?.verificationLog?.stderrPath
    if (!path) throw new HttpError(404, `no ${file} log recorded`)
    return readLogChunk(
      runRootOf(stateRoot, runId),
      path,
      from,
      !attemptOpen(
        row,
        found,
        (await diagnose(db, found, Date.now())).kind === 'running',
      ),
    )
  }

  async function handle(url: URL): Promise<unknown> {
    const { pathname } = url
    if (pathname === '/api/runs') return runs()
    if (pathname === '/api/compare') return compare()
    if (pathname === '/api/trend') return trend()
    const match = /^\/api\/runs\/([^/]+)$/.exec(pathname)
    if (match?.[1]) return run(idOf(match[1]))
    const logs = /^\/api\/runs\/([^/]+)\/logs\/([^/]+)$/.exec(pathname)
    if (logs?.[1] && logs[2])
      return log(idOf(logs[1]), idOf(logs[2]), url.searchParams)
    throw new HttpError(404, `no such endpoint: ${pathname}`)
  }

  return {
    handle,
    act,
    async close() {
      await durably?.db.destroy()
    },
  }
}

export interface UiServerOptions {
  port: number
}

export interface UiServer {
  url: string
  close(): Promise<void>
}

/** The header a write carries the page's token in. */
export const TOKEN_HEADER = 'x-loop-ui-token'

/** Where the served page carries the token: filled in on every request. */
const TOKEN_META = /<meta name="loop-ui-token" content="[^"]*" \/>/

/** A write's JSON body is at most this long; notes-file allows 256 KiB. */
const MAX_BODY_BYTES = 512 * 1024

function sameToken(given: string | string[] | undefined, token: string) {
  if (typeof given !== 'string') return false
  const a = Buffer.from(given)
  const b = Buffer.from(token)
  return a.length === b.length && timingSafeEqual(a, b)
}

async function readJson(
  req: IncomingMessage,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length
    if (size > MAX_BODY_BYTES)
      throw new HttpError(413, 'request body too large')
    chunks.push(chunk)
  }
  if (size === 0) return {}
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (body && typeof body === 'object' && !Array.isArray(body))
      return body as Record<string, unknown>
  } catch {
    // Answered below.
  }
  throw new HttpError(400, 'the body must be a JSON object')
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/** Start the loopback server; resolves once it is listening. */
export async function startUiServer(
  options: UiServerOptions,
): Promise<UiServer> {
  const host = '127.0.0.1'
  const api = createUiApi()
  // A fresh token per start, only ever sent inside the page. With CORS off,
  // a page of any other origin, another localhost port included, can
  // neither read it nor send this server's Origin.
  const token = randomBytes(32).toString('hex')
  let port = options.port
  const onRequest = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${host}`)
    if (!url.pathname.startsWith('/api/')) return vite.middlewares(req, res)
    const hostHeader = req.headers.host ?? ''
    if (hostHeader !== `${host}:${port}` && hostHeader !== `localhost:${port}`)
      return sendJson(res, 403, { error: 'loopback host only' })
    try {
      const write = actionPath(url.pathname)
      if (!write) {
        if (req.method !== 'GET' && req.method !== 'HEAD')
          return sendJson(res, 405, { error: 'reads answer GET and HEAD only' })
        return sendJson(res, 200, await api.handle(url))
      }
      if (req.method !== 'POST')
        return sendJson(res, 405, { error: 'an action needs POST' })
      // The Origin must be this server's own, as the Host names it.
      if (req.headers.origin !== `http://${hostHeader}`)
        return sendJson(res, 403, { error: 'this server origin only' })
      if (!sameToken(req.headers[TOKEN_HEADER], token))
        return sendJson(res, 403, { error: 'missing or wrong page token' })
      const body = await readJson(req)
      const runId = idOf(write.rawId)
      sendJson(res, 200, await api.act(runId, write.action, body))
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500
      sendJson(res, status, { error: (error as Error).message })
    }
  }
  // Nothing a request does may reject past here: an unhandled rejection
  // would end the process.
  const server = createServer(
    (req, res) =>
      void onRequest(req, res).catch((error: unknown) => {
        if (res.headersSent) return void res.destroy()
        sendJson(res, 500, { error: (error as Error).message })
      }),
  )
  // `closeAllConnections` does not reach a socket upgraded to a WebSocket,
  // such as the live-reload socket of an open tab, so those are tracked and
  // destroyed on close; otherwise Ctrl-C waits until the tab is closed.
  const upgraded = new Set<Duplex>()
  server.on('upgrade', (_req, socket: Duplex) => {
    upgraded.add(socket)
    socket.once('close', () => upgraded.delete(socket))
  })
  // Vite's live-reload socket shares this server, so it stays on loopback.
  const vite = await (
    await import('vite')
  ).createServer({
    configFile: join(packageRoot, 'vite.config.ts'),
    appType: 'spa',
    logLevel: 'warn',
    // No CORS: another localhost origin must not read the page's token.
    server: { cors: false, middlewareMode: true, hmr: { server } },
    plugins: [
      {
        name: 'loop-ui-token',
        transformIndexHtml: (html) =>
          html.replace(
            TOKEN_META,
            `<meta name="loop-ui-token" content="${token}" />`,
          ),
      },
    ],
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(options.port, host, () => {
        server.off('error', reject)
        resolve()
      })
    })
  } catch (error) {
    await vite.close()
    throw error
  }
  port = (server.address() as AddressInfo).port
  return {
    url: `http://${host}:${port}/`,
    async close() {
      const closed = new Promise<void>((resolve) =>
        server.close(() => resolve()),
      )
      server.closeAllConnections()
      for (const socket of upgraded) socket.destroy()
      await vite.close()
      await closed
      await api.close()
    },
  }
}
