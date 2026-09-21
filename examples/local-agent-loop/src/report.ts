/**
 * Report regeneration from persisted Durably data (run + attempts + waits).
 *
 * - `realLlmCallCount` (a real CLI was invoked) and `fullLoopVerified`
 *   (real CLI + terminal success + approval) are reported separately — one
 *   usage row never implies a verified loop.
 * - Usage aggregates dedupe by attempt id; replayed steps add no new
 *   consumption. Confirmed sums and missing legs are shown separately.
 * - Timings: per-stage elapsed, stage total, whole-run elapsed, and human
 *   `inputWaitMs` vs requeue `executionSlotWaitMs` per wait. Unknown end
 *   times render `unknown`, never a fabricated zero.
 */
import type { StepAttempt } from '@coji/durably'

import { PRICE_BASIS, estimateCostUsd } from './pricing.js'
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
  elapsedMs: number | null
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
  const base = stepName.split(':')[0] ?? stepName
  if (base === 'review-a' || base === 'review-b') return 'review'
  if (base === 'prepare-workdir') return 'prepare'
  if (base === 'implement' || base === 'test') return base
  if (base === 'review-snapshot') return 'review'
  if (base === 'finalize-report') return 'finalize'
  if (base === 'policy') return 'policy'
  return base
}

/** Sum attempt elapsedMs per stage (latest measurement per attempt id). */
export function stageTimings(attempts: AttemptRow[]): StageTiming[] {
  const byStage = new Map<string, number>()
  const missing = new Set<string>()
  const seen = new Set<string>()
  for (const a of attempts) {
    if (seen.has(a.attemptId)) continue
    seen.add(a.attemptId)
    const ms = a.measurement?.elapsedMs ?? null
    const stage = stageOf(a.stepName)
    if (ms === null) {
      missing.add(stage)
      continue
    }
    byStage.set(stage, (byStage.get(stage) ?? 0) + ms)
  }
  const order = [
    'prepare',
    'implement',
    'test',
    'review',
    'approval',
    'finalize',
    'policy',
  ]
  const stages = [...new Set([...byStage.keys(), ...missing])]
  stages.sort((x, y) => order.indexOf(x) - order.indexOf(y))
  return stages.map((stage) => ({
    stage,
    elapsedMs: byStage.get(stage) ?? null,
  }))
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
    lines.push(`- ${t.stage}: ${fmtMs(t.elapsedMs)}`)
  }
  lines.push(`- stage total: ${fmtMs(r.stageTotalMs)}`)
  lines.push(`- run elapsed: ${fmtMs(r.runElapsedMs)}`)
  lines.push('')
  lines.push('## Attempts (from persisted step attempts)')
  lines.push('')
  lines.push(
    '| step | attempt | leaseGen | status | model(req/rep) | effort(req/rep) | elapsedMs | tokens(in/out/total) | cost(USD api-equiv) | result |',
  )
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|')
  for (const a of r.attempts) {
    const m = a.measurement
    const tokens = m?.usage
      ? `${fmt(m.usage.inputTokens)}/${fmt(m.usage.outputTokens)}/${fmt(m.usage.totalTokens)}`
      : 'unknown/unknown/unknown'
    const model =
      m != null
        ? `${fmt(m.requestedModel ?? m.reportedModel)}/${fmt(m.reportedModel)}`
        : 'unknown/unknown'
    const effort =
      m != null
        ? `${fmt(m.requestedEffort ?? m.reportedEffort)}/${fmt(m.reportedEffort)}`
        : 'unknown/unknown'
    lines.push(
      `| ${a.stepName} | ${a.attemptId.slice(0, 8)} | ${a.leaseGeneration} | ${a.status}${a.interruptionReason ? ` (${a.interruptionReason})` : ''} | ${model} | ${effort} | ${fmt(m?.elapsedMs)} | ${tokens} | ${m?.costUsdEstimate != null ? `${m.costUsdEstimate.toFixed(6)} (${m.costBasis})` : 'unknown'} | ${fmt(m?.result)} |`,
    )
  }
  const agg = aggregateUsage(
    r.attempts.map((a) => ({
      attemptId: a.attemptId,
      usage: a.measurement?.usage ?? null,
    })),
  )
  lines.push('')
  lines.push(
    `- aggregate usage (deduped by attempt): in=${fmt(agg.inputTokens)} cached=${fmt(agg.cachedInputTokens)} out=${fmt(agg.outputTokens)} total=${fmt(agg.totalTokens)}${agg.complete ? '' : ' (PARTIAL — some attempts missing usage)'}`,
  )
  const aggCost = agg.complete
    ? estimateCostUsd(
        r.attempts.find((a) => a.measurement?.reportedModel)?.measurement
          ?.reportedModel ?? null,
        { inputTokens: agg.inputTokens, outputTokens: agg.outputTokens },
      )
    : null
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
