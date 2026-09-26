/**
 * `demo ui`: a read-only web UI over the factory's database.
 *
 * - Listens on 127.0.0.1 only. The API answers only to a loopback Host
 *   header, so a page on another origin cannot read runs through DNS
 *   rebinding.
 * - Opens the fixed state root's existing database read-only, lazily: until a
 *   worker or `trigger` creates it, every view is empty and nothing is
 *   created. `migrate()` and `init()` are never called.
 * - Every number comes from `buildReport` / `compareReports` and every reason
 *   and command from `diagnose`, the same code the CLI prints from. The API
 *   has no endpoint that runs a command or changes a run.
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import type { Duplex } from 'node:stream'
import { fileURLToPath } from 'node:url'

import type { Run } from '@coji/durably'

import {
  dbPath,
  defaultStateRoot,
  openReadOnlyAgentDurably,
  type AgentLoopDurably,
} from '../durably.js'
import {
  asReportCandidate,
  buildReport,
  repairChildren,
  repairChildrenByParent,
  type ReportSource,
} from '../engine/build-report.js'
import { compareReports, type Comparison } from '../engine/compare.js'
import { classifyRun } from '../engine/failure-reasons.js'
import type { VerificationLog } from '../engine/providers/types.js'
import {
  liveElapsed,
  stageOf,
  usageOf,
  type AttemptRow,
  type LiveElapsed,
  type LoopReport,
  type ReportCandidate,
  type ReportReview,
  type ReportReviewRound,
  type ReportSealedCandidate,
  type ReportTriage,
  type UsageTotals,
  type WaitRow,
} from '../engine/report.js'
import {
  diagnoseRun,
  needsHuman,
  type Diagnosis,
  type DiagnosisKind,
} from '../engine/status.js'
import { TERMINAL_STATUSES } from '../engine/terminal.js'
import { lensName, stageName, stepPartName } from './labels.js'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** A linked run by its name, for the links between repair runs. */
export interface RunRef {
  id: string
  /** From the stored input; see `runName`. */
  name: string
}

/**
 * The run this one repairs from outside findings, and the repair runs
 * started from this one, oldest first.
 */
export interface Relations {
  parent: RunRef | null
  children: RunRef[]
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
  /** Provisional, as of the response's `now`; null for a finished run. */
  live: LiveElapsed | null
  /** Times the code stage was entered (first implementation + repairs). */
  iterations: number
  reviewRounds: number
  conclusion: string | null
  /** The report's settled lead time; null while the run is open. */
  leadTimeMs: number | null
  costUsd: number | null
  triage: ReportTriage['judgment'] | null
  pipeline: Pipeline
  relations: Relations
}

export interface RunsResponse {
  db: string
  /** False until a worker or `trigger` creates the database. */
  exists: boolean
  now: string
  /** Newest first. */
  runs: RunRow[]
}

export interface RunDetailResponse {
  now: string
  /** From the stored input; see `runName`. */
  name: string
  createdAt: string
  diagnosis: Diagnosis
  uncertainCall: boolean
  needsHuman: boolean
  live: LiveElapsed | null
  pipeline: Pipeline
  relations: Relations
  /** The run as a span tree on one time axis, as of `now`. */
  trace: Trace
  /** Exactly what `report --run <id> --format json` prints. */
  report: LoopReport
}

export interface CompareResponse {
  /** Finished runs, newest first, in the order given to `compareReports`. */
  runIds: string[]
  comparison: Comparison
}

/** The heading for the bundled sample, whose task never varies. */
export const SUBJECT_RUN_NAME = '同梱題材: calc の add を直す'

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
  if (line.length === 0) return '名前のないタスク'
  return line.length > NAME_MAX ? `${line.slice(0, NAME_MAX - 1)}…` : line
}

// ---------------------------------------------------------------- pipeline

/**
 * Where a stage stands in a run: `running` / `waiting` / `current` is the
 * stage the run is at now (a worker on it, a person to decide, or neither);
 * `stopped` is where a run that did not finish ended.
 */
export type PipelineState =
  | 'done'
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
  'baseline',
  'preflight',
  'triage',
  'code',
  'verify',
  'review',
  'approve',
  'finish',
]

export interface PipelineInput {
  status: string
  diagnosisKind: DiagnosisKind
  live: Pick<LiveElapsed, 'stage'> | null
  report: Pick<LoopReport, 'attempts' | 'waits' | 'stageVisits' | 'roleUsage'>
}

/** Stored step or wait name to the stage it belongs to, dated by its start. */
function pipelineEvents(
  attempts: Pick<AttemptRow, 'stepName' | 'startedAt'>[],
  waits: Pick<WaitRow, 'name' | 'createdAt'>[],
): { stage: string; at: number }[] {
  return [
    ...attempts.map((a) => ({
      stage: stageOf(a.stepName),
      at: Date.parse(a.startedAt),
    })),
    ...waits.map((w) => ({
      stage: stageOf(w.name),
      at: Date.parse(w.createdAt),
    })),
  ].filter((e) => PIPELINE_ORDER.includes(e.stage))
}

/** Stages that run at most once and appear only on a run that reached them. */
const OPTIONAL_ONCE = ['baseline', 'preflight']
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
  const counts = new Map<string, number>()
  for (const v of report.stageVisits) counts.set(v.stage, v.visits)
  // Approval is a wait, not a step, so it has no attempts to count.
  counts.set('approve', new Set(approvals.map((w) => w.name)).size)
  for (const once of ONCE_STAGES)
    counts.set(
      once,
      report.attempts.some((a) => stageOf(a.stepName) === once) ? 1 : 0,
    )
  const hasTriage =
    (counts.get('triage') ?? 0) > 0 ||
    report.roleUsage.some((r) => r.role === 'triage')
  const order = PIPELINE_ORDER.filter(
    (s) =>
      (s !== 'triage' || hasTriage) &&
      (!OPTIONAL_ONCE.includes(s) || (counts.get(s) ?? 0) > 0),
  )

  const events = pipelineEvents(report.attempts, approvals).sort(
    (x, y) => x.at - y.at,
  )
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
  const stages = order.map((stage) => {
    const count = counts.get(stage) ?? 0
    const state: PipelineState =
      stage === at ? atState : count > 0 ? 'done' : 'not-reached'
    return { stage, state, count }
  })

  const parts = stages
    .filter((s) => s.count > 1)
    .map((s) => `${stageName(s.stage)} ${s.count}回`)
  // Stages the run passed by, such as approval on an auto-approved run.
  const reached = stages.map((s) => s.state !== 'not-reached').lastIndexOf(true)
  const skipped = stages
    .slice(0, reached)
    .filter((s) => s.state === 'not-reached')
    .map((s) => stageName(s.stage))
  if (skipped.length > 0) parts.push(`${skipped.join('と')}は通らず`)
  const name = at === null ? '' : stageName(at)
  if (at === null) parts.push('完了まで終わった')
  else if (atState === 'stopped') parts.push(`${name}で停止`)
  else if (atState === 'running') parts.push(`いまは${name}を実行中`)
  else if (atState === 'waiting') parts.push(`いまは${name}で人待ち`)
  else parts.push(`いまは${name}`)
  return { stages, label: `工程: ${parts.join('、')}` }
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

function checkpointOf(a: AttemptRow, open: boolean): TraceCheckpoint | null {
  const result = a.measurement?.result ?? null
  if (result === null) return null
  if (result === 'checkpoint-recovered') return 'recovered'
  if (result.endsWith('-done') || result === 'pass' || result === 'fail')
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

function asReview(value: unknown): ReportReview | null {
  const v = value as Partial<ReportReview> | null
  return typeof v?.lens === 'string' &&
    typeof v.decision === 'string' &&
    typeof v.notes === 'string'
    ? { lens: v.lens, decision: v.decision, notes: v.notes }
    : null
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
      profile: null,
      usage: null,
      checkpoint: null,
      review: null,
      candidate: null,
      verificationLog: null,
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
    if (stageOf(w.name) === 'approve')
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
    const isOpen = (a: AttemptRow) =>
      leaseLive && unfinished(a) && a.leaseGeneration === run.leaseGeneration
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
            label:
              multiStep && part
                ? `${stepPartName(part)} 試行 ${n}`
                : `試行 ${n}`,
            stage: e.stage,
            iteration: at,
            state: stateOf(a),
            start: time(a.startedAt),
            end: time(a.completedAt),
            open: aOpen,
            attempts: 1,
            leaseGeneration: a.leaseGeneration,
            interruptionReason: a.interruptionReason,
            profile: profileOf([a]),
            usage: usageOf([a]),
            checkpoint: checkpointOf(a, aOpen),
            verificationLog: a.measurement?.verificationLog ?? null,
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
    const review =
      e.stage !== 'review'
        ? null
        : (input.reviewRounds
            ?.find((r) => r.sequence === e.seq)
            ?.reviews.find((r) => r.lens === lens) ??
          asReview(reviewStep ? input.stepOutputs[reviewStep] : null) ??
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
      profile: profileOf(sorted),
      usage: usageOf(sorted),
      checkpoint: checked ? checkpointOf(checked, isOpen(checked)) : null,
      review,
      candidate,
      verificationLog:
        [...sorted].reverse().find((a) => a.measurement?.verificationLog)
          ?.measurement?.verificationLog ?? null,
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
      label: `${n}回目`,
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
    label: '実行全体',
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
 * built once and reused while the row is unchanged. Only a failed or
 * cancelled run's `failure` can still change, because it also reads
 * checkpoint files, so a reused report gets that one field classified again.
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
        if (run.status === 'completed')
          return { report: { ...hit.report, lineage }, fresh: false }
        const failure = await classifyRun(src, run)
        return { report: { ...hit.report, lineage, failure }, fresh: true }
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
export async function listedReports(
  cache: ReturnType<typeof finishedReportCache>,
  src: ReportSource,
  runs: Run[],
  all: Run[],
): Promise<{ run: Run; report: LoopReport; fresh: boolean }[]> {
  const children = repairChildrenByParent(all)
  return Promise.all(
    runs.map(async (run) => ({
      run,
      ...(await cache.get(src, run, children.get(run.id) ?? [])),
    })),
  )
}

/** Name the report's parent and children, from their stored inputs. */
async function relationsOf(
  src: ReportSource,
  lineage: LoopReport['lineage'] | undefined,
): Promise<Relations> {
  const ref = async (id: string): Promise<RunRef> => {
    const run = await src.getRun(id)
    return { id, name: run ? runName(run.input) : '見つからない実行' }
  }
  return {
    parent: lineage?.parent ? await ref(lineage.parent.runId) : null,
    children: await Promise.all((lineage?.children ?? []).map(ref)),
  }
}

/** What both the list row and the detail page read for one run. */
async function inspect(
  src: ReportSource,
  run: Run,
  now: number,
  report: LoopReport,
  /** The report's failure was worked out in this request, so it is current. */
  fresh: boolean,
) {
  const { diagnosis, uncertainCall } = await diagnoseRun(
    src,
    run,
    now,
    fresh ? { failure: report.failure } : undefined,
  )
  const live = liveElapsed(run, report.attempts, now)
  return {
    name: runName(run.input),
    createdAt: run.createdAt,
    diagnosis,
    uncertainCall,
    needsHuman: needsHuman(diagnosis.kind),
    live,
    pipeline: derivePipeline({
      status: run.status,
      diagnosisKind: diagnosis.kind,
      live,
      report,
    }),
    relations: await relationsOf(src, report.lineage),
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
    iterations: report.stageVisits.find((v) => v.stage === 'code')?.visits ?? 0,
    reviewRounds: report.summary.reviewRounds,
    conclusion: report.summary.conclusion,
    leadTimeMs: report.summary.leadTimeMs,
    costUsd: report.summary.costUsd,
    triage: report.triage?.judgment ?? null,
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

/** The read API, without a listening socket. */
function createUiApi() {
  const stateRoot = defaultStateRoot()
  let durably: AgentLoopDurably | null = null
  // Opened on first use after the file appears, then kept.
  const source = () => (durably ??= openReadOnlyAgentDurably({ stateRoot }))

  const reports = finishedReportCache()

  async function runs(): Promise<RunsResponse> {
    const now = Date.now()
    const base = {
      db: dbPath(stateRoot),
      now: new Date(now).toISOString(),
    }
    const db = source()
    if (!db) return { ...base, exists: false, runs: [] }
    const all = await orEmpty(allRuns(db), [])
    reports.keep(all)
    const src = readOnce(db, all)
    const built = await listedReports(reports, src, all, all)
    const rows = await Promise.all(
      built.map(async ({ run, report, fresh }) =>
        runRow(run, await inspect(src, run, now, report, fresh)),
      ),
    )
    return { ...base, exists: true, runs: rows }
  }

  async function run(id: string): Promise<RunDetailResponse> {
    const now = Date.now()
    const db = source()
    const found = db ? await orEmpty(db.getRun(id), null) : null
    if (!db || !found) throw new HttpError(404, `no run ${id}`)
    const src = readOnce(db, [found])
    const { report, fresh } = await reports.get(src, found)
    const [seen, steps] = await Promise.all([
      inspect(src, found, now, report, fresh),
      src.storage.getSteps(id),
    ])
    const stepOutputs: Record<string, unknown> = {}
    for (const s of steps)
      if (s.status === 'completed') stepOutputs[s.name] = s.output
    return {
      now: new Date(now).toISOString(),
      ...seen,
      trace: deriveTrace({
        run: found,
        diagnosisKind: seen.diagnosis.kind,
        conclusion: report.summary.conclusion,
        attempts: report.attempts,
        waits: report.waits,
        reviews: report.reviews,
        candidate: report.candidate,
        reviewRounds: report.reviewRounds,
        candidates: report.candidates,
        stepOutputs,
        now,
      }),
    }
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

  async function handle(pathname: string): Promise<unknown> {
    if (pathname === '/api/runs') return runs()
    if (pathname === '/api/compare') return compare()
    const match = /^\/api\/runs\/([^/]+)$/.exec(pathname)
    if (match?.[1]) return run(decodeURIComponent(match[1]))
    throw new HttpError(404, `no such endpoint: ${pathname}`)
  }

  return {
    handle,
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
  let port = options.port
  const onRequest = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${host}`)
    if (!url.pathname.startsWith('/api/')) return vite.middlewares(req, res)
    const hostHeader = req.headers.host ?? ''
    if (hostHeader !== `${host}:${port}` && hostHeader !== `localhost:${port}`)
      return sendJson(res, 403, { error: 'loopback host only' })
    if (req.method !== 'GET' && req.method !== 'HEAD')
      return sendJson(res, 405, { error: 'read-only API' })
    try {
      sendJson(res, 200, await api.handle(url.pathname))
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500
      sendJson(res, status, { error: (error as Error).message })
    }
  }
  const server = createServer((req, res) => void onRequest(req, res))
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
    server: { middlewareMode: true, hmr: { server } },
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
