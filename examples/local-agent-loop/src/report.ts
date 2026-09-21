/** Report regeneration from persisted Durably data (run + attempts + waits). */
import type { StepAttempt } from '@coji/durably'

import type { AttemptMeasurement } from './providers/types.js'

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

export interface LoopReport {
  runId: string
  jobName: string
  status: string
  input: unknown
  output: unknown
  fake: boolean
  verifiedByRealLlm: boolean
  attempts: AttemptRow[]
  waits: {
    id: string
    name: string
    outcome: string | null
    createdAt: string
    resolvedAt: string | null
  }[]
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

export function reportToMarkdown(r: LoopReport): string {
  const lines: string[] = []
  lines.push(`# Agent loop report — ${r.runId}`)
  lines.push('')
  lines.push(`- status: ${r.status}`)
  lines.push(
    `- fake mode: ${r.fake ? 'YES (not real-LLM verification)' : 'no'}`,
  )
  lines.push(
    `- verified by real LLM: ${r.verifiedByRealLlm ? 'yes' : 'no (see notes)'}`,
  )
  lines.push(`- output: ${JSON.stringify(r.output)}`)
  lines.push('')
  lines.push('## Attempts (from persisted step attempts)')
  lines.push('')
  lines.push(
    '| step | attempt | leaseGen | status | model | effort | elapsedMs | tokens(in/out/total) | cost(USD api-equiv) | result |',
  )
  lines.push('|---|---|---|---|---|---|---|---|---|---|---|')
  for (const a of r.attempts) {
    const m = a.measurement
    const tokens = m?.usage
      ? `${fmt(m.usage.inputTokens)}/${fmt(m.usage.outputTokens)}/${fmt(m.usage.totalTokens)}`
      : 'unknown/unknown/unknown'
    lines.push(
      `| ${a.stepName} | ${a.attemptId.slice(0, 8)} | ${a.leaseGeneration} | ${a.status}${a.interruptionReason ? ` (${a.interruptionReason})` : ''} | ${fmt(m?.model)} | ${fmt(m?.effort)} | ${fmt(m?.elapsedMs)} | ${tokens} | ${m?.costUsdEstimate != null ? `${m.costUsdEstimate.toFixed(6)} (${m.costBasis})` : 'unknown'} | ${fmt(m?.result)} |`,
    )
  }
  lines.push('')
  lines.push('## Waits')
  lines.push('')
  for (const w of r.waits) {
    lines.push(
      `- ${w.name} (${w.id}): outcome=${fmt(w.outcome)} created=${w.createdAt} resolved=${fmt(w.resolvedAt)}`,
    )
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
