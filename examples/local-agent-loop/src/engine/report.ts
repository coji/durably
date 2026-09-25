/**
 * Report regeneration from persisted Durably data (run + attempts + waits).
 *
 * - `realLlmCallCount` (a real CLI was invoked) and `fullLoopVerified`
 *   (real CLI + terminal success + approval) are reported separately — one
 *   usage row never implies a verified loop.
 * - Usage aggregates dedupe by invocation id; recovery attempts add no new
 *   consumption. Confirmed sums and missing legs are shown separately.
 * - Timings: per-stage elapsed, stage total, whole-run elapsed, and human
 *   `inputWaitMs` vs requeue `executionSlotWaitMs` per wait. Unknown end
 *   times render `unknown`, never a fabricated zero; stages with missing
 *   attempts render PARTIAL and poison the stage total to unknown.
 */
import type { StepAttempt } from '@coji/durably'

import { retryText, type FailureClassification } from './failure-reasons.js'
import { PRICE_BASIS } from './pricing.js'
import type { AttemptMeasurement } from './providers/types.js'
import { TERMINAL_STATUSES } from './terminal.js'
import { aggregateUsage } from './usage.js'

export interface AttemptRow {
  stepName: string
  stepIndex: number
  attemptId: string
  leaseGeneration: number
  status: string
  startedAt: string
  completedAt: string | null
  interruptionReason: string | null
  measurement: AttemptMeasurement | null
}

export interface WaitRow {
  id: string
  name: string
  outcome: string | null
  createdAt: string
  suspendedAt: string | null
  resolvedAt: string | null
  /** Human/external input wait (suspend -> resolve). Null when unknown. */
  inputWaitMs: number | null
  /** Requeue wait (resolve -> first resumed lease). Null when unknown. */
  executionSlotWaitMs: number | null
}

export interface StageTiming {
  stage: string
  /** Sum of measured work in the stage. */
  elapsedMs: number | null
  /**
   * Sum of each visit's wall-clock interval. Within one visit the interval
   * spans parallel branches; separate visits are summed rather than spanned,
   * so time spent in other stages between two visits is never counted here.
   */
  wallElapsedMs?: number | null
  /**
   * False when any attempt in the stage lacks elapsedMs: the sum covers only
   * known attempts and must not be presented as a complete stage total.
   */
  complete: boolean
}

/** Token and cost sums over a group of deduped LLM invocations. */
export interface UsageTotals {
  /** LLM invocations that completed (deduped). */
  invocations: number
  inputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
  /** Sum of stored per-invocation estimates; null when any is unpriced. */
  costUsd: number | null
  /** False when any usage-expecting invocation lacks usage or a priced leg. */
  complete: boolean
  /**
   * False when `costUsd` is not the whole cost: some invocation had no usage
   * or no price (an unpriced model). Token counts can be complete while this
   * is false.
   */
  costComplete: boolean
}

/** Token and cost consumption of one stage, counted once per invocation. */
export interface StageUsage extends UsageTotals {
  stage: string
}

/**
 * How many times a stage was entered. A second visit is rework: the stage
 * ran again because a later stage sent the candidate back (Mastra Factory's
 * `reworked` outcome, derived here from step names instead of a board).
 */
export interface StageVisits {
  stage: string
  visits: number
  reworked: number
}

/** A role's requested settings, as fixed when the run was triggered. */
export interface RoleProfileRow {
  role: string
  provider: string | null
  requestedModel: string | null
  requestedEffort: string | null
}

/**
 * Token and cost consumption of one role (code, correctness, edge-cases),
 * counted once per invocation. Unlike `StageUsage`, the two reviewers are
 * separate rows, because they may run on different providers or models.
 */
export interface RoleUsage extends RoleProfileRow, UsageTotals {}

/** An input file the run was given, with the SHA-256 of the stored content. */
export interface ReportInputFile {
  path: string
  sha256: string
}

export interface ReportInputs {
  task: ReportInputFile | null
  spec: ReportInputFile | null
  dispositions: ReportInputFile | null
}

/**
 * A repository candidate's size against the base commit, and where its full
 * diff and changed-file list were written when it was sealed.
 */
export interface ReportCandidateChanges {
  files: number
  additions: number
  deletions: number
  diffPath: string
  changedFilesPath: string
}

/** The last sealed candidate: where a repository run left its work. */
export interface ReportCandidate {
  id: string
  branch: string | null
  commit: string | null
  /** Null for a candidate that records no size, such as the bundled sample's. */
  changes?: ReportCandidateChanges | null
}

/** One sealed candidate, in sealing order. */
export interface ReportSealedCandidate extends ReportCandidate {
  /** Which pass through code sealed it, from 1. */
  iteration: number
  /** The stage sequence of the code entry that sealed it. */
  sequence: number
}

/**
 * One reviewer's verdict. A finished run carries the last round in its
 * output; a run waiting for approval has it only in the approval wait.
 */
export interface ReportReview {
  lens: string
  decision: string
  notes: string
}

/**
 * One finished review round, from the stored review step outputs. A round
 * the run stopped in part way lists only the verdicts that completed.
 */
export interface ReportReviewRound {
  /** From 1, in the order the rounds ran. */
  round: number
  /** The stage sequence of the review entry. */
  sequence: number
  /** The candidate the round reviewed; null when it is not stored. */
  candidate: ReportCandidate | null
  reviews: ReportReview[]
}

/** What the run delivered, as recorded in its output. */
export interface ReportDelivery {
  kind: string
  location: string
  summary: string
  branch: string | null
  commit: string | null
}

/**
 * The shadow-triage judgment recorded for a run. `unknown` means triage ran
 * without a usable answer; a report with no triage at all carries null.
 */
export const TRIAGE_JUDGMENTS = ['routine', 'probe', 'unknown'] as const

export interface ReportTriage {
  judgment: (typeof TRIAGE_JUDGMENTS)[number]
  reason: string
}

/** One row per run, the unit that cross-run comparisons operate on. */
export interface RunSummary {
  /** Terminal completed run whose candidate was approved. */
  success: boolean
  conclusion: string | null
  /** Trigger to terminal state; null while the run is still open. */
  leadTimeMs: number | null
  /** Sum of measured stage work; null when any stage is partial. */
  workMs: number | null
  /** Human/external input wait across all waits; null when unknown. */
  humanWaitMs: number | null
  /** humanWaitMs / leadTimeMs; null when either is unknown. */
  humanWaitRatio: number | null
  llmInvocations: number
  totalTokens: number | null
  costUsd: number | null
  /** costUsd when the run succeeded, else null: what one success cost. */
  costPerSuccessUsd: number | null
  /** Times the code stage ran after the first implementation. */
  repairs: number
  reviewRounds: number
}

export interface LoopReport {
  runId: string
  jobName: string
  status: string
  input: unknown
  output: unknown
  fake: boolean
  /** Shared by runs with identical provider/model/effort/context settings. */
  configVersion: string | null
  summary: RunSummary
  triage: ReportTriage | null
  stageUsage: StageUsage[]
  /**
   * Per-role requested settings and usage: code, correctness, edge-cases, and
   * triage when the run has a triage profile.
   */
  roleUsage: RoleUsage[]
  /** SHA-256 of each input file's content, as stored in the run. */
  inputs: ReportInputs
  /** Last sealed candidate, whatever the conclusion; null before one exists. */
  candidate: ReportCandidate | null
  /** Every sealed candidate with its size, oldest first. */
  candidates: ReportSealedCandidate[]
  /** Last review round; empty before a review round has finished. */
  reviews: ReportReview[]
  /** Every review round with both verdicts and notes, oldest first. */
  reviewRounds: ReportReviewRound[]
  /** Branch, commit and location of the delivery; null when none was made. */
  delivery: ReportDelivery | null
  /** Why the run stopped and what to do next; null when it did not stop. */
  failure: FailureClassification | null
  stageVisits: StageVisits[]
  /** Real (non-fake) CLI invocations observed in attempts. */
  realLlmCallCount: number
  /**
   * True only when: non-fake run + terminal completed status + approved
   * conclusion with passing tests. A failed or incomplete run is never
   * presented as verified, no matter how many usage rows exist.
   */
  fullLoopVerified: boolean
  attempts: AttemptRow[]
  waits: WaitRow[]
  stageTimings: StageTiming[]
  stageTotalMs: number | null
  runElapsedMs: number | null
  versions: Record<string, string | null>
  priceBasis: typeof PRICE_BASIS
  notes: string[]
}

export function toAttemptRow(a: StepAttempt): AttemptRow {
  let measurement: AttemptMeasurement | null = null
  try {
    const m = a.metadata as unknown
    // Key on fields only a measurement has. Several steps put a `provider`
    // in their metadata for context — `setup` among them — and treating one
    // of those as a measurement renders a phantom row of `unknown`s beside
    // the real invocations.
    if (
      m &&
      typeof m === 'object' &&
      'invocationId' in (m as object) &&
      'usageScope' in (m as object)
    ) {
      measurement = m as AttemptMeasurement
    }
  } catch {
    measurement = null
  }
  return {
    stepName: a.stepName,
    stepIndex: a.stepIndex,
    attemptId: a.id,
    leaseGeneration: a.leaseGeneration,
    status: a.status,
    startedAt: a.startedAt,
    completedAt: a.completedAt,
    interruptionReason: a.interruptionReason,
    measurement,
  }
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return 'unknown'
  if (typeof v === 'number') return String(v)
  return String(v)
}

function fmtMs(v: number | null): string {
  return v === null ? 'unknown' : `${v}ms`
}

function fmtUsd(v: number | null): string {
  return v === null ? 'unknown' : v.toFixed(6)
}

function fmtChanges(c: ReportCandidateChanges | null | undefined): string {
  return c
    ? `${c.files} files, +${c.additions} / -${c.deletions} lines`
    : 'not recorded'
}

const STAGE_ORDER = [
  'setup',
  'triage',
  'policy',
  'code',
  'verify',
  'review',
  'approve',
  'finish',
  'stop',
]

export function stageOf(stepName: string): string {
  const parts = stepName.split(':')
  if (parts[0] === 'stage' && parts[2]) return parts[2]
  if (parts[0] === 'decision') return 'policy'
  const base = stepName.split(':')[0] ?? stepName
  return base
}

/**
 * Sequence number distinguishing repeat entries into the same stage.
 * `stage:<sequence>:<name>:...` and `decision:<sequence>` carry one; steps
 * that run once per run (setup) do not.
 */
function sequenceOf(stepName: string): string | null {
  const parts = stepName.split(':')
  if ((parts[0] === 'stage' || parts[0] === 'decision') && parts[1])
    return parts[1]
  return null
}

function sortStages<T extends { stage: string }>(rows: T[]): T[] {
  return [...rows].sort(
    (x, y) => STAGE_ORDER.indexOf(x.stage) - STAGE_ORDER.indexOf(y.stage),
  )
}

/**
 * Keep one row per invocation, preferring the attempt that completed it.
 * Recovery attempts re-read the same invocation and must not add tokens.
 */
function dedupeByInvocation(attempts: AttemptRow[]): AttemptRow[] {
  const selected = new Map<string, AttemptRow>()
  const completed = (a: AttemptRow | undefined) =>
    a?.measurement?.result === 'checkpoint-recovered' ||
    (a?.measurement?.result?.endsWith('-done') ?? false)
  for (const attempt of attempts) {
    const key = attempt.measurement?.invocationId ?? attempt.attemptId
    const previous = selected.get(key)
    if (!previous || (completed(attempt) && !completed(previous)))
      selected.set(key, attempt)
  }
  return [...selected.values()]
}

/** Sum one group of already-deduped LLM invocations. */
function usageTotals(list: AttemptRow[]): UsageTotals {
  const agg = aggregateUsage(
    list.map((a) => ({
      attemptId: a.measurement?.invocationId ?? a.attemptId,
      usage: a.measurement?.usage ?? null,
      expectsUsage: true,
    })),
  )
  const costs = list.map((a) => a.measurement?.costUsdEstimate ?? null)
  const costUsd =
    agg.complete && costs.every((c) => c !== null)
      ? costs.reduce<number>((sum, c) => sum + (c ?? 0), 0)
      : null
  return {
    invocations: list.length,
    inputTokens: agg.inputTokens,
    cacheReadTokens: agg.cacheReadTokens,
    cacheWriteTokens: agg.cacheWriteTokens,
    outputTokens: agg.outputTokens,
    totalTokens: agg.totalTokens,
    costUsd,
    complete: agg.complete,
    costComplete: costUsd !== null,
  }
}

/**
 * Token and cost sums over any group of attempts, with the same dedupe and
 * scope rules as `stageUsage`; null when none of them invokes an LLM. The
 * web UI's trace rows use it, so a row never sums usage another way.
 */
export function usageOf(attempts: AttemptRow[]): UsageTotals | null {
  const list = dedupeByInvocation(attempts).filter((a) =>
    attemptExpectsUsage(a.stepName),
  )
  return list.length === 0 ? null : usageTotals(list)
}

/** Per-stage token and cost sums, one count per invocation. */
export function stageUsage(attempts: AttemptRow[]): StageUsage[] {
  const byStage = new Map<string, AttemptRow[]>()
  for (const a of dedupeByInvocation(attempts)) {
    if (!attemptExpectsUsage(a.stepName)) continue
    const stage = stageOf(a.stepName)
    byStage.set(stage, [...(byStage.get(stage) ?? []), a])
  }
  const rows: StageUsage[] = []
  for (const [stage, list] of byStage)
    rows.push({ stage, ...usageTotals(list) })
  return sortStages(rows)
}

/** The role an LLM step ran as, from its step name. */
function roleOf(stepName: string): string | null {
  if (stepName === 'triage') return 'triage'
  if (stepName.endsWith(':agent')) return 'code'
  if (stepName.endsWith(':correctness')) return 'correctness'
  if (stepName.endsWith(':edge-cases')) return 'edge-cases'
  return null
}

/**
 * Per-role token and cost sums, one count per invocation. Every profile gets
 * a row even when the role never ran, so a report always shows what each
 * role was configured to use.
 */
export function roleUsage(
  attempts: AttemptRow[],
  profiles: RoleProfileRow[],
): RoleUsage[] {
  const byRole = new Map<string, AttemptRow[]>()
  for (const a of dedupeByInvocation(attempts)) {
    const role = roleOf(a.stepName)
    if (role === null) continue
    byRole.set(role, [...(byRole.get(role) ?? []), a])
  }
  return profiles.map((profile) => ({
    ...profile,
    ...usageTotals(byRole.get(profile.role) ?? []),
  }))
}

/**
 * Count distinct entries into each stage from `stage:<sequence>:<stage>`
 * step names. Setup and policy steps carry no sequence and are skipped.
 */
export function stageVisits(attempts: AttemptRow[]): StageVisits[] {
  const sequences = new Map<string, Set<string>>()
  for (const a of attempts) {
    const parts = a.stepName.split(':')
    if (parts[0] !== 'stage' || !parts[1] || !parts[2]) continue
    const set = sequences.get(parts[2]) ?? new Set<string>()
    set.add(parts[1])
    sequences.set(parts[2], set)
  }
  return sortStages(
    [...sequences].map(([stage, set]) => ({
      stage,
      visits: set.size,
      reworked: Math.max(0, set.size - 1),
    })),
  )
}

export interface SummaryInput {
  status: string
  output: unknown
  runElapsedMs: number | null
  stageTotalMs: number | null
  waits: WaitRow[]
  attempts: AttemptRow[]
  stageUsage: StageUsage[]
  stageVisits: StageVisits[]
}

/** Fold a run into the one-row summary used for cross-run comparison. */
export function summarizeRun(input: SummaryInput): RunSummary {
  const output = input.output as {
    approved?: boolean
    conclusion?: string
    reviewRounds?: number
  } | null
  const success =
    input.status === 'completed' &&
    output?.approved === true &&
    output?.conclusion === 'approved'
  const usageRows = input.stageUsage
  const allComplete = usageRows.every((r) => r.complete)
  const sumLeg = (pick: (r: StageUsage) => number | null): number | null => {
    const known = usageRows.map(pick).filter((v): v is number => v !== null)
    return known.length === usageRows.length && usageRows.length > 0
      ? known.reduce((s, v) => s + v, 0)
      : null
  }
  const costUsd = allComplete ? sumLeg((r) => r.costUsd) : null
  const humanWaits = input.waits.map((w) => w.inputWaitMs)
  const humanWaitMs =
    humanWaits.length > 0 && humanWaits.every((v) => v !== null)
      ? humanWaits.reduce<number>((s, v) => s + (v ?? 0), 0)
      : humanWaits.length === 0
        ? 0
        : null
  const leadTimeMs = input.runElapsedMs
  return {
    success,
    conclusion: output?.conclusion ?? null,
    leadTimeMs,
    workMs: input.stageTotalMs,
    humanWaitMs,
    humanWaitRatio:
      humanWaitMs !== null && leadTimeMs !== null && leadTimeMs > 0
        ? humanWaitMs / leadTimeMs
        : null,
    llmInvocations: usageRows.reduce((s, r) => s + r.invocations, 0),
    totalTokens: sumLeg((r) => r.totalTokens),
    costUsd,
    costPerSuccessUsd: success ? costUsd : null,
    repairs: input.stageVisits.find((v) => v.stage === 'code')?.reworked ?? 0,
    reviewRounds:
      typeof output?.reviewRounds === 'number'
        ? output.reviewRounds
        : (input.stageVisits.find((v) => v.stage === 'review')?.visits ?? 0),
  }
}

/** Sum once per invocation while retaining its original execution interval. */
export function stageTimings(attempts: AttemptRow[]): StageTiming[] {
  const byStage = new Map<string, number>()
  // Bounds are per visit, never per stage: a stage entered twice would
  // otherwise report one span from its first start to its last end, swallowing
  // every stage that ran in between.
  const visitBounds = new Map<
    string,
    { stage: string; start: number; end: number }
  >()
  const incomplete = new Set<string>()
  const seen = new Set<string>()
  for (const a of dedupeByInvocation(attempts)) {
    if (seen.has(a.attemptId)) continue
    seen.add(a.attemptId)
    const stage = stageOf(a.measurement?.stage ?? a.stepName)
    const start = Date.parse(a.measurement?.invocationStartedAt ?? a.startedAt)
    const end = Date.parse(
      a.measurement?.invocationCompletedAt ?? a.completedAt ?? '',
    )
    const ms =
      a.measurement?.elapsedMs ??
      (Number.isFinite(start) && Number.isFinite(end)
        ? Math.max(0, end - start)
        : null)
    if (Number.isFinite(start) && Number.isFinite(end)) {
      const key = `${stage}#${sequenceOf(a.stepName) ?? 'once'}`
      const current = visitBounds.get(key)
      visitBounds.set(key, {
        stage,
        start: current ? Math.min(current.start, start) : start,
        end: current ? Math.max(current.end, end) : end,
      })
    }
    if (ms === null) {
      incomplete.add(stage)
      continue
    }
    byStage.set(stage, (byStage.get(stage) ?? 0) + ms)
  }
  const wallByStage = new Map<string, number>()
  for (const visit of visitBounds.values()) {
    wallByStage.set(
      visit.stage,
      (wallByStage.get(visit.stage) ?? 0) +
        Math.max(0, visit.end - visit.start),
    )
  }
  const stages = [...new Set([...byStage.keys(), ...incomplete])]
  return sortStages(
    stages.map((stage) => ({
      stage,
      elapsedMs: byStage.get(stage) ?? null,
      wallElapsedMs: wallByStage.get(stage) ?? null,
      complete: !incomplete.has(stage),
    })),
  )
}

/** Stage total across stages; unknown when any stage timing is partial. */
export function totalStageMs(timings: StageTiming[]): number | null {
  if (timings.some((t) => !t.complete)) return null
  return timings.reduce((sum, t) => sum + (t.elapsedMs ?? 0), 0)
}

/**
 * Provisional elapsed times of an open run, as of `now`. Never part of the
 * report: `runElapsedMs` and `stageTimings` stay the settled values, and
 * anything shown from here has to say it is still running.
 */
export interface LiveElapsed {
  /** From the first lease (or creation, before one) to `now`. */
  runMs: number
  /** Stage of the latest attempt not yet completed; null between steps. */
  stage: string | null
  stepName: string | null
  /** From that attempt's start to `now`. */
  stageMs: number | null
}

/**
 * Provisional elapsed times for an open run; null for a finished one. Only
 * attempts of the current lease generation count, so an attempt a lost
 * worker left open is not taken for the step running now.
 */
export function liveElapsed(
  run: {
    status: string
    createdAt: string
    startedAt: string | null
    leaseGeneration: number
  },
  attempts: Pick<
    AttemptRow,
    'stepName' | 'startedAt' | 'completedAt' | 'status' | 'leaseGeneration'
  >[],
  now: number,
): LiveElapsed | null {
  if (TERMINAL_STATUSES.includes(run.status)) return null
  const since = (iso: string) => Math.max(0, now - Date.parse(iso))
  const open = attempts
    .filter(
      (a) =>
        a.status === 'started' &&
        a.completedAt === null &&
        a.leaseGeneration === run.leaseGeneration,
    )
    .sort((x, y) => Date.parse(y.startedAt) - Date.parse(x.startedAt))[0]
  return {
    runMs: since(run.startedAt ?? run.createdAt),
    stage: open ? stageOf(open.stepName) : null,
    stepName: open?.stepName ?? null,
    stageMs: open ? since(open.startedAt) : null,
  }
}

/**
 * Only triage and implement/review branches invoke an LLM: every other step
 * (local grading, prepare, policy, snapshots) is out of usage scope, so its
 * null usage never marks the aggregate incomplete.
 */
export function attemptExpectsUsage(stepName: string): boolean {
  return roleOf(stepName) !== null
}

/** Sum the already-priced invocations without applying one model to another. */
function aggregateInvocationCost(
  attempts: AttemptRow[],
  usageComplete: boolean,
): number | null {
  if (!usageComplete) return null
  // Same dedupe rule as `stageUsage`, so the aggregate line and the per-stage
  // costs can never be derived two different ways and disagree.
  const costs = dedupeByInvocation(
    attempts.filter((a) => attemptExpectsUsage(a.stepName)),
  ).map((a) => a.measurement?.costUsdEstimate ?? null)
  if (costs.some((cost) => cost === null)) return null
  return costs.reduce<number>((sum, cost) => sum + (cost ?? 0), 0)
}

export function reportToMarkdown(r: LoopReport): string {
  const lines: string[] = []
  lines.push(`# Agent loop report — ${r.runId}`)
  lines.push('')
  lines.push(`- status: ${r.status}`)
  lines.push(
    `- fake mode: ${r.fake ? 'YES (not real-LLM verification)' : 'no'}`,
  )
  lines.push(`- real LLM calls observed: ${r.realLlmCallCount}`)
  lines.push(
    `- full loop verified: ${r.fullLoopVerified ? 'yes (real CLI, terminal success, approved)' : 'no (see notes)'}`,
  )
  lines.push(`- output: ${JSON.stringify(r.output)}`)
  lines.push(`- config version: ${fmt(r.configVersion)}`)
  lines.push('')
  lines.push('## Triage (shadow mode: recorded, never used to route)')
  lines.push('')
  if (r.triage) {
    lines.push(`- judgment: ${r.triage.judgment}`)
    lines.push(`- reason: ${r.triage.reason}`)
  } else {
    lines.push('- none (no triage profile, or triage has not run yet)')
  }
  lines.push('')
  lines.push('## Inputs (SHA-256 of stored content)')
  lines.push('')
  for (const [name, file] of Object.entries(r.inputs)) {
    lines.push(
      `- ${name}: ${file ? `${file.sha256} (${file.path})` : 'not given'}`,
    )
  }
  lines.push('')
  lines.push('## Candidate')
  lines.push('')
  if (r.candidate) {
    lines.push(`- id: ${r.candidate.id}`)
    lines.push(`- branch: ${fmt(r.candidate.branch)}`)
    lines.push(`- commit: ${fmt(r.candidate.commit)}`)
    lines.push(`- changes: ${fmtChanges(r.candidate.changes)}`)
  } else {
    lines.push('- none')
  }
  lines.push('')
  lines.push('## Candidates (every sealed candidate, oldest first)')
  lines.push('')
  if (r.candidates.length > 0) {
    for (const c of r.candidates) {
      lines.push(
        `- iteration ${c.iteration}: ${c.id} — ${fmtChanges(c.changes)}`,
      )
      if (c.changes) {
        lines.push(`  - diff: ${c.changes.diffPath}`)
        lines.push(`  - changed files: ${c.changes.changedFilesPath}`)
      }
    }
  } else {
    lines.push('- none')
  }
  lines.push('')
  lines.push('## Reviews')
  lines.push('')
  if (r.reviews.length > 0) {
    for (const review of r.reviews)
      lines.push(`- ${review.lens}: ${review.decision} — ${review.notes}`)
  } else {
    lines.push('- none (no review round has finished)')
  }
  lines.push('')
  lines.push('## Review rounds')
  lines.push('')
  if (r.reviewRounds.length > 0) {
    for (const round of r.reviewRounds) {
      lines.push(
        `- round ${round.round}: ${round.candidate?.id ?? 'candidate unknown'}`,
      )
      for (const review of round.reviews)
        lines.push(`  - ${review.lens}: ${review.decision} — ${review.notes}`)
    }
  } else {
    lines.push('- none')
  }
  lines.push('')
  const graded = r.attempts.filter((a) => a.measurement?.verificationLog)
  lines.push('## Verification logs (full check output per attempt)')
  lines.push('')
  if (graded.length > 0) {
    for (const a of graded) {
      const log = a.measurement?.verificationLog
      if (!log) continue
      lines.push(
        `- ${a.stepName} (${a.attemptId.slice(0, 8)}): exit code ${log.exitCode ?? 'null'}${a.measurement?.result === 'checkpoint-recovered' ? ', recovered from checkpoint' : ''}`,
      )
      lines.push(`  - stdout: ${log.stdoutPath}`)
      lines.push(`  - stderr: ${log.stderrPath}`)
    }
  } else {
    lines.push('- none')
  }
  lines.push('')
  lines.push('## Delivery')
  lines.push('')
  if (r.delivery) {
    lines.push(`- kind: ${r.delivery.kind}`)
    lines.push(`- location: ${r.delivery.location}`)
    lines.push(`- branch: ${fmt(r.delivery.branch)}`)
    lines.push(`- commit: ${fmt(r.delivery.commit)}`)
    lines.push(`- summary: ${r.delivery.summary}`)
  } else {
    lines.push('- none')
  }
  lines.push('')
  lines.push('## Stop reason')
  lines.push('')
  if (r.failure) {
    lines.push(`- kind: ${r.failure.kind}`)
    lines.push(`- reason: ${r.failure.reason}`)
    lines.push(`- retry: ${retryText(r.failure.retryable)}`)
    lines.push(`- human check: ${r.failure.humanCheck}`)
    for (const d of r.failure.details) lines.push(`- ${d}`)
    for (const n of r.failure.next) lines.push(`- next: ${n}`)
  } else {
    lines.push('- none (the run did not stop on a failure)')
  }
  lines.push('')
  lines.push('## Summary (one row per run)')
  lines.push('')
  const s = r.summary
  lines.push(`- success: ${s.success ? 'yes' : 'no'} (${fmt(s.conclusion)})`)
  lines.push(`- lead time (trigger -> terminal): ${fmtMs(s.leadTimeMs)}`)
  lines.push(`- work (stage total): ${fmtMs(s.workMs)}`)
  lines.push(
    `- human wait: ${fmtMs(s.humanWaitMs)}${s.humanWaitRatio !== null ? ` (${(s.humanWaitRatio * 100).toFixed(1)}% of lead time)` : ''}`,
  )
  lines.push(`- llm invocations: ${s.llmInvocations}`)
  lines.push(`- total tokens: ${fmt(s.totalTokens)}`)
  lines.push(`- cost (USD api-equiv): ${fmtUsd(s.costUsd)}`)
  lines.push(`- cost per success: ${fmtUsd(s.costPerSuccessUsd)}`)
  lines.push(`- repairs: ${s.repairs}, review rounds: ${s.reviewRounds}`)
  lines.push('')
  lines.push('## Stage usage (deduped by invocation)')
  lines.push('')
  lines.push(
    '| stage | visits | reworked | invocations | in | cache-read | cache-write | out | total | cost(USD) |',
  )
  lines.push('|---|---|---|---|---|---|---|---|---|---|')
  const visits = new Map(r.stageVisits.map((v) => [v.stage, v]))
  for (const u of r.stageUsage) {
    const v = visits.get(u.stage)
    lines.push(
      `| ${u.stage} | ${v?.visits ?? 'n/a'} | ${v?.reworked ?? 'n/a'} | ${u.invocations} | ${fmt(u.inputTokens)} | ${fmt(u.cacheReadTokens)} | ${fmt(u.cacheWriteTokens)} | ${fmt(u.outputTokens)} | ${fmt(u.totalTokens)} | ${fmtUsd(u.costUsd)}${u.complete ? '' : ' (PARTIAL)'} |`,
    )
  }
  for (const v of r.stageVisits) {
    if (r.stageUsage.some((u) => u.stage === v.stage)) continue
    lines.push(
      `| ${v.stage} | ${v.visits} | ${v.reworked} | 0 | - | - | - | - | - | - |`,
    )
  }
  lines.push('')
  lines.push('## Role usage (deduped by invocation)')
  lines.push('')
  lines.push(
    '| role | provider | model(requested) | effort(requested) | invocations | in | cache-read | cache-write | out | total | cost(USD) | usage | cost |',
  )
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|')
  for (const u of r.roleUsage) {
    lines.push(
      `| ${u.role} | ${fmt(u.provider)} | ${u.requestedModel ?? '(default)'} | ${u.requestedEffort ?? '(default)'} | ${u.invocations} | ${fmt(u.inputTokens)} | ${fmt(u.cacheReadTokens)} | ${fmt(u.cacheWriteTokens)} | ${fmt(u.outputTokens)} | ${fmt(u.totalTokens)} | ${fmtUsd(u.costUsd)} | ${u.complete ? 'complete' : 'PARTIAL'} | ${u.costComplete ? 'complete' : 'PARTIAL'} |`,
    )
  }
  lines.push('')
  lines.push('## Timing')
  lines.push('')
  for (const t of r.stageTimings) {
    lines.push(
      `- ${t.stage}: work=${fmtMs(t.elapsedMs)}, wall=${fmtMs(t.wallElapsedMs ?? null)}${t.complete ? '' : ' (PARTIAL — some attempts missing elapsedMs)'}`,
    )
  }
  lines.push(`- stage total: ${fmtMs(r.stageTotalMs)}`)
  lines.push(`- run elapsed: ${fmtMs(r.runElapsedMs)}`)
  lines.push('')
  lines.push('## Attempts (from persisted step attempts)')
  lines.push('')
  lines.push(
    '| step | invocation | status | model(requested/effective/reported) | effort(requested/effective/reported) | elapsedMs | tokens(in/cache-read/cache-write/out/total) | cost(USD api-equiv) | result |',
  )
  lines.push('|---|---|---|---|---|---|---|---|---|')
  for (const a of r.attempts) {
    const m = a.measurement
    const tokens = m?.usage
      ? `${fmt(m.usage.inputTokens)}/${fmt(m.usage.cacheReadTokens)}/${fmt(m.usage.cacheWriteTokens)}/${fmt(m.usage.outputTokens)}/${fmt(m.usage.totalTokens)}`
      : 'unknown/unknown/unknown/unknown/unknown'
    const model =
      m != null
        ? `${fmt(m.requestedModel)}/${fmt(m.effectiveModel)}/${fmt(m.reportedModel)}`
        : 'unknown/unknown/unknown'
    const effort =
      m != null
        ? `${fmt(m.requestedEffort)}/${fmt(m.effectiveEffort)}/${fmt(m.reportedEffort)}`
        : 'unknown/unknown/unknown'
    lines.push(
      `| ${a.stepName} | ${m?.invocationId?.slice(0, 8) ?? 'n/a'} | ${a.status}${a.interruptionReason ? ` (${a.interruptionReason})` : ''} | ${model} | ${effort} | ${fmt(m?.elapsedMs)} | ${tokens} | ${m?.costUsdEstimate != null ? `${m.costUsdEstimate.toFixed(6)} (${m.costBasis})` : 'unknown'} | ${fmt(m?.result)} |`,
    )
  }
  const agg = aggregateUsage(
    r.attempts.map((a) => ({
      attemptId: a.measurement?.invocationId ?? a.attemptId,
      usage: a.measurement?.usage ?? null,
      expectsUsage: attemptExpectsUsage(a.stepName),
    })),
  )
  lines.push('')
  lines.push(
    `- aggregate usage (deduped by invocation): in=${fmt(agg.inputTokens)} cache-read=${fmt(agg.cacheReadTokens)} cache-write=${fmt(agg.cacheWriteTokens)} out=${fmt(agg.outputTokens)} total=${fmt(agg.totalTokens)}${agg.complete ? '' : ' (PARTIAL — some invocations missing usage)'}`,
  )
  lines.push(`- missing usage invocations: ${agg.missingAttempts.length}`)
  const aggCost = aggregateInvocationCost(r.attempts, agg.complete)
  lines.push(
    `- aggregate cost (stored per-invocation estimates): ${aggCost != null ? `${aggCost.toFixed(6)} USD` : 'unknown'}`,
  )
  lines.push('')
  lines.push('## Waits')
  lines.push('')
  for (const w of r.waits) {
    lines.push(
      `- ${w.name} (${w.id}): outcome=${fmt(w.outcome)} created=${w.createdAt} suspended=${fmt(w.suspendedAt)} resolved=${fmt(w.resolvedAt)} inputWait=${fmtMs(w.inputWaitMs)} executionSlotWait=${fmtMs(w.executionSlotWaitMs)}`,
    )
  }
  const versions = Object.entries(r.versions)
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${k}=${v}`)
  if (versions.length > 0) {
    lines.push('')
    lines.push('## Versions')
    lines.push('')
    for (const v of versions) lines.push(`- ${v}`)
  }
  if (r.notes.length > 0) {
    lines.push('')
    lines.push('## Notes')
    lines.push('')
    for (const n of r.notes) lines.push(`- ${n}`)
  }
  lines.push('')
  return lines.join('\n')
}

export function reportToJson(r: LoopReport): string {
  return JSON.stringify(r, null, 2)
}
