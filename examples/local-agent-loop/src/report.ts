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

import { PRICE_BASIS } from './pricing.js'
import type { AttemptMeasurement } from './providers/types.js'
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
  /** Wall-clock interval spanning parallel branches. */
  wallElapsedMs?: number | null
  /**
   * False when any attempt in the stage lacks elapsedMs: the sum covers only
   * known attempts and must not be presented as a complete stage total.
   */
  complete: boolean
}

export interface LoopReport {
  runId: string
  jobName: string
  status: string
  input: unknown
  output: unknown
  fake: boolean
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
    if (m && typeof m === 'object' && 'provider' in (m as object)) {
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

function stageOf(stepName: string): string {
  const parts = stepName.split(':')
  if (parts[0] === 'stage' && parts[2]) return parts[2]
  if (parts[0] === 'decision') return 'policy'
  const base = stepName.split(':')[0] ?? stepName
  return base
}

/** Sum once per invocation while retaining its original execution interval. */
export function stageTimings(attempts: AttemptRow[]): StageTiming[] {
  const selected = new Map<string, AttemptRow>()
  for (const attempt of attempts) {
    const key = attempt.measurement?.invocationId ?? attempt.attemptId
    const previous = selected.get(key)
    const isCompletedInvocation =
      attempt.measurement?.result === 'checkpoint-recovered' ||
      (attempt.measurement?.result?.endsWith('-done') ?? false)
    const previousCompleted =
      previous?.measurement?.result === 'checkpoint-recovered' ||
      (previous?.measurement?.result?.endsWith('-done') ?? false)
    if (!previous || (isCompletedInvocation && !previousCompleted))
      selected.set(key, attempt)
  }
  const byStage = new Map<string, number>()
  const bounds = new Map<string, { start: number; end: number }>()
  const incomplete = new Set<string>()
  const seen = new Set<string>()
  for (const a of selected.values()) {
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
      const current = bounds.get(stage)
      bounds.set(stage, {
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
  const order = [
    'setup',
    'policy',
    'code',
    'verify',
    'review',
    'approve',
    'finish',
    'stop',
  ]
  const stages = [...new Set([...byStage.keys(), ...incomplete])]
  stages.sort((x, y) => order.indexOf(x) - order.indexOf(y))
  return stages.map((stage) => ({
    stage,
    elapsedMs: byStage.get(stage) ?? null,
    wallElapsedMs: bounds.has(stage)
      ? (bounds.get(stage)?.end ?? 0) - (bounds.get(stage)?.start ?? 0)
      : null,
    complete: !incomplete.has(stage),
  }))
}

/** Stage total across stages; unknown when any stage timing is partial. */
export function totalStageMs(timings: StageTiming[]): number | null {
  if (timings.some((t) => !t.complete)) return null
  return timings.reduce((sum, t) => sum + (t.elapsedMs ?? 0), 0)
}

/**
 * Only implement/review branches invoke an LLM: every other step (local
 * grading, prepare, policy, snapshots) is out of usage scope, so its null
 * usage never marks the aggregate incomplete.
 */
export function attemptExpectsUsage(stepName: string): boolean {
  return (
    stepName.endsWith(':agent') ||
    stepName.endsWith(':correctness') ||
    stepName.endsWith(':edge-cases')
  )
}

/** Sum the already-priced invocations without applying one model to another. */
function aggregateInvocationCost(
  attempts: AttemptRow[],
  usageComplete: boolean,
): number | null {
  if (!usageComplete) return null
  const costs = new Map<string, number | null>()
  for (const attempt of attempts) {
    if (!attemptExpectsUsage(attempt.stepName)) continue
    const key = attempt.measurement?.invocationId ?? attempt.attemptId
    const cost = attempt.measurement?.costUsdEstimate ?? null
    const previous = costs.get(key)
    if (!costs.has(key) || (previous === null && cost !== null))
      costs.set(key, cost)
  }
  if ([...costs.values()].some((cost) => cost === null)) return null
  return [...costs.values()].reduce<number>((sum, cost) => sum + (cost ?? 0), 0)
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
    `- aggregate cost: ${aggCost != null ? `${aggCost.toFixed(6)} USD (${PRICE_BASIS.basis}; ${PRICE_BASIS.source}; checked ${PRICE_BASIS.checkedAt})` : 'unknown'}`,
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
