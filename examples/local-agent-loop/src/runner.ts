/**
 * Single common path for every LLM invocation (implement + both reviews).
 *
 * Per-stage code supplies prompt/role/workdir; everything else — timing,
 * AbortSignal wiring, incremental usage persistence (ordered), metadata
 * merge (never wholesale replace), failure preservation, version recording —
 * lives here exactly once.
 */
import type { StepAttemptContext } from '@coji/durably'
import type { JsonValue } from '@coji/durably'

import { estimateCostUsd } from './pricing.js'
import type { AgentProvider, AttemptMeasurement } from './providers/types.js'
import { mergeUsage, type TokenUsage } from './usage.js'
import { resolveVersions } from './versions.js'

export interface AgentCallSpec {
  provider: AgentProvider
  providerName: 'codex' | 'claude' | 'fake'
  prompt: string
  /** Execution dir (live workdir for implement, frozen snapshot for reviews). */
  workdir: string
  timeoutMs: number
  requestedModel: string | null
  requestedEffort: string | null
  role: 'implement' | 'review-a' | 'review-b'
  stage: string
  iteration: number
}

export interface AgentCallOutcome {
  text: string
  measurement: AttemptMeasurement
}

/**
 * Merge a patch into the attempt metadata snapshot. Initial execution
 * conditions (stage, iteration, requested model/effort, versions) are written
 * first and preserved across every later update — a terminal `setMetadata`
 * never wipes them.
 */
export async function writeMeasurement(
  attempt: StepAttemptContext,
  current: AttemptMeasurement,
  patch: Partial<AttemptMeasurement> & { usagePatch?: TokenUsage | null },
): Promise<AttemptMeasurement> {
  const { usagePatch, ...rest } = patch
  const next: AttemptMeasurement = {
    ...current,
    ...rest,
    usage:
      usagePatch !== undefined
        ? mergeUsage(current.usage, usagePatch)
        : current.usage,
  }
  next.costUsdEstimate = estimateCostUsd(next.reportedModel, next.usage)
  next.costBasis = next.usage ? 'api-equivalent-estimate' : null
  await attempt.setMetadata(next as unknown as JsonValue)
  return next
}

export async function runAgentCall(
  signal: AbortSignal,
  attempt: StepAttemptContext,
  spec: AgentCallSpec,
): Promise<AgentCallOutcome> {
  const started = Date.now()
  const versions = await resolveVersions(spec.providerName)
  let measurement: AttemptMeasurement = {
    provider: spec.providerName,
    fake: spec.provider.fake,
    stage: spec.stage,
    iteration: spec.iteration,
    requestedModel: spec.requestedModel,
    requestedEffort: spec.requestedEffort,
    reportedModel: null,
    reportedEffort: null,
    versions,
    elapsedMs: null,
    usage: null,
    costUsdEstimate: null,
    costBasis: null,
    result: 'started',
    error: null,
    interruptionReason: null,
  }
  // Ordered write chain: partial snapshots and the final write are applied
  // strictly in call order, so a failure can never wipe reported usage.
  let chain: Promise<void> = Promise.resolve()
  const enqueueWrite = (
    patch: Partial<AttemptMeasurement> & { usagePatch?: TokenUsage | null },
  ): Promise<AttemptMeasurement> => {
    const next = chain.then(() => writeMeasurement(attempt, measurement, patch))
    chain = next.then(
      () => undefined,
      () => undefined,
    )
    return next.then((updated) => {
      measurement = updated
      return updated
    })
  }
  await enqueueWrite({})

  // Combine the Durably step signal with the per-call timeout. Aborting here
  // propagates into the AI SDK call, which tears down the owned CLI child.
  const timeoutController = new AbortController()
  const timer = setTimeout(
    () => timeoutController.abort(new Error('agent call timeout')),
    spec.timeoutMs,
  )
  const linked = AbortSignal.any([signal, timeoutController.signal])
  const onDurablyAbort = () => timeoutController.abort()
  signal.addEventListener('abort', onDurablyAbort, { once: true })

  try {
    const res = await spec.provider.call({
      prompt: spec.prompt,
      workdir: spec.workdir,
      timeoutMs: spec.timeoutMs,
      requestedModel: spec.requestedModel,
      requestedEffort: spec.requestedEffort,
      role: spec.role,
      signal: linked,
      onPartialUsage: (usage) => {
        void enqueueWrite({
          usagePatch: { ...usage, usageSource: 'provider-partial' },
          elapsedMs: Date.now() - started,
        })
      },
    })
    measurement = await enqueueWrite({
      reportedModel: res.reportedModel,
      reportedEffort: res.reportedEffort,
      usagePatch: res.usage,
      elapsedMs: res.elapsedMs ?? Date.now() - started,
      result: `${spec.role}-done`,
      error: null,
    })
    return { text: res.text, measurement }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const cancelled = signal.aborted
    // Preserve already-reported usage — a failed tail must not wipe it.
    measurement = await enqueueWrite({
      elapsedMs: Date.now() - started,
      result: 'fail',
      error: message.slice(0, 2000),
      interruptionReason: cancelled
        ? 'cancelled-or-lease-lost'
        : message.includes('timed out')
          ? 'timeout'
          : null,
    })
    throw err
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onDurablyAbort)
  }
}
