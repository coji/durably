/** Common execution, recovery and measurement path for every LLM call. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { JsonValue, StepAttemptContext } from '@coji/durably'

import { estimateCostUsd } from './pricing.js'
import type {
  AgentProvider,
  AgentResult,
  AttemptMeasurement,
  ProviderName,
} from './providers/types.js'
import type { SessionRef } from './types.js'
import { mergeUsage, type TokenUsage } from './usage.js'
import { resolveVersions } from './versions.js'

export interface AgentCallSpec {
  provider: AgentProvider
  providerName: ProviderName
  prompt: string
  workdir: string
  timeoutMs: number
  requestedModel: string | null
  requestedEffort: string | null
  effectiveModel: string | null
  effectiveEffort: string | null
  role: 'implement' | 'repair' | 'review-a' | 'review-b'
  stage: string
  iteration: number
  operationKey?: string
  checkpointsDir?: string
  session?: SessionRef | null
  requireSession?: boolean
}

export interface AgentCallOutcome {
  text: string
  sessionId: string | null
  invocationId: string
  recovered: boolean
  measurement: AttemptMeasurement
}

interface StartedCheckpoint {
  operationKey: string
  invocationId: string
  status: 'started'
  invocationStartedAt: string
}

interface CompletedCheckpoint {
  operationKey: string
  invocationId: string
  status: 'completed'
  result: AgentResult
  invocationStartedAt: string
  invocationCompletedAt: string
}

export class UncertainInvocationError extends Error {
  constructor(operationKey: string, invocationId: string) {
    super(
      `uncertain external invocation: ${operationKey} (${invocationId}); ` +
        'no completed checkpoint is available, so the prompt was not resent',
    )
    this.name = 'UncertainInvocationError'
  }
}

function checkpointPaths(root: string, operationKey: string) {
  const id = createHash('sha256').update(operationKey).digest('hex')
  return {
    started: join(root, `${id}.started.json`),
    completed: join(root, `${id}.completed.json`),
  }
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function writeJsonAtomic(
  path: string,
  value: unknown,
  attemptId: string,
): Promise<void> {
  const temporary = `${path}.${attemptId}.tmp`
  await writeFile(temporary, `${JSON.stringify(value)}\n`, 'utf8')
  await rename(temporary, path)
}

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
  const startedAt = Date.now()
  const versions = await resolveVersions(spec.providerName)
  const operationKey = spec.operationKey ?? `attempt/${attempt.id}`
  const checkpointsDir =
    spec.checkpointsDir ?? join(spec.workdir, '.operation-checkpoints')
  await mkdir(checkpointsDir, { recursive: true })
  const paths = checkpointPaths(checkpointsDir, operationKey)
  const saved = await readJson<CompletedCheckpoint>(paths.completed)
  const existingStart = await readJson<StartedCheckpoint>(paths.started)
  let invocationId =
    saved?.invocationId ?? existingStart?.invocationId ?? randomUUID()

  let measurement: AttemptMeasurement = {
    provider: spec.providerName,
    fake: spec.provider.fake,
    stage: spec.stage,
    role: spec.role,
    iteration: spec.iteration,
    operationKey,
    invocationId,
    sessionId: spec.session?.nativeId ?? null,
    recovered: saved !== null,
    usageScope: 'invocation',
    requestedModel: spec.requestedModel,
    requestedEffort: spec.requestedEffort,
    effectiveModel: spec.effectiveModel,
    effectiveEffort: spec.effectiveEffort,
    reportedModel: null,
    reportedEffort: null,
    invocationStartedAt:
      saved?.invocationStartedAt ?? existingStart?.invocationStartedAt ?? null,
    invocationCompletedAt: saved?.invocationCompletedAt ?? null,
    versions,
    elapsedMs: null,
    usage: null,
    costUsdEstimate: null,
    costBasis: null,
    result: saved ? 'checkpoint-recovered' : 'started',
    error: null,
    interruptionReason: null,
  }
  await attempt.setMetadata(measurement as unknown as JsonValue)

  const finish = async (
    result: AgentResult,
    recovered: boolean,
    checkpoint?: CompletedCheckpoint,
  ): Promise<AgentCallOutcome> => {
    if (checkpoint) invocationId = checkpoint.invocationId
    const sessionId = result.session?.id ?? spec.session?.nativeId ?? null
    if (spec.requireSession && !sessionId)
      throw new Error(
        `${spec.providerName} did not report a native session id for context reuse`,
      )
    measurement = await writeMeasurement(attempt, measurement, {
      reportedModel: result.reportedModel,
      reportedEffort: result.reportedEffort,
      invocationId,
      sessionId,
      usagePatch: result.usage,
      elapsedMs: result.elapsedMs,
      invocationStartedAt:
        checkpoint?.invocationStartedAt ?? measurement.invocationStartedAt,
      invocationCompletedAt:
        checkpoint?.invocationCompletedAt ?? new Date().toISOString(),
      recovered,
      result: recovered ? 'checkpoint-recovered' : `${spec.role}-done`,
      error: null,
    })
    return {
      text: result.text,
      sessionId,
      invocationId,
      recovered,
      measurement,
    }
  }

  const assertResolvedSettings = (result: AgentResult) => {
    if (
      result.resolvedModel !== spec.effectiveModel ||
      result.resolvedEffort !== spec.effectiveEffort
    ) {
      throw new Error(
        `provider resolution drift: expected ${spec.effectiveModel ?? 'null'}/${spec.effectiveEffort ?? 'null'}, got ${result.resolvedModel ?? 'null'}/${result.resolvedEffort ?? 'null'}`,
      )
    }
  }

  if (saved) {
    if (saved.operationKey !== operationKey)
      throw new Error('operation checkpoint key mismatch')
    assertResolvedSettings(saved.result)
    return finish(saved.result, true, saved)
  }
  if (existingStart)
    throw new UncertainInvocationError(operationKey, invocationId)

  const startRecord: StartedCheckpoint = {
    operationKey,
    invocationId,
    status: 'started',
    invocationStartedAt: new Date().toISOString(),
  }
  try {
    const handle = await open(paths.started, 'wx')
    await handle.writeFile(`${JSON.stringify(startRecord)}\n`, 'utf8')
    await handle.close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const raced = await readJson<CompletedCheckpoint>(paths.completed)
      if (raced) return finish(raced.result, true, raced)
      const start = await readJson<StartedCheckpoint>(paths.started)
      throw new UncertainInvocationError(
        operationKey,
        start?.invocationId ?? invocationId,
      )
    }
    throw error
  }
  measurement = await writeMeasurement(attempt, measurement, {
    invocationStartedAt: startRecord.invocationStartedAt,
  })

  const timeout = new AbortController()
  const timer = setTimeout(
    () => timeout.abort(new Error('agent call timeout')),
    spec.timeoutMs,
  )
  const linked = AbortSignal.any([signal, timeout.signal])
  try {
    const result = await spec.provider.call({
      prompt: spec.prompt,
      workdir: spec.workdir,
      timeoutMs: spec.timeoutMs,
      requestedModel: spec.effectiveModel,
      requestedEffort: spec.effectiveEffort,
      role: spec.role,
      sessionId: spec.session?.nativeId ?? null,
      signal: linked,
      onPartialUsage: (usage) => {
        void writeMeasurement(attempt, measurement, {
          usagePatch: { ...usage, usageSource: 'provider-partial' },
          elapsedMs: Date.now() - startedAt,
        }).then((next) => {
          measurement = next
        })
      },
    })
    if (
      spec.requireSession &&
      !(result.session?.id ?? spec.session?.nativeId ?? null)
    ) {
      throw new Error(
        `${spec.providerName} did not report a native session id for context reuse`,
      )
    }
    assertResolvedSettings(result)
    const completed: CompletedCheckpoint = {
      ...startRecord,
      status: 'completed',
      result,
      invocationCompletedAt: new Date().toISOString(),
    }
    await writeJsonAtomic(paths.completed, completed, attempt.id)
    return finish(result, false)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    measurement = await writeMeasurement(attempt, measurement, {
      elapsedMs: Date.now() - startedAt,
      result: 'uncertain',
      error: message.slice(0, 2000),
      interruptionReason: signal.aborted
        ? 'cancelled-or-lease-lost'
        : timeout.signal.aborted || /timed? out|timeout/i.test(message)
          ? 'timeout'
          : null,
    })
    throw error
  } finally {
    clearTimeout(timer)
  }
}
