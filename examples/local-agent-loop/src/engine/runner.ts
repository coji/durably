/** Common execution, recovery and measurement path for every LLM call. */
import { createHash, randomUUID } from 'node:crypto'
import {
  appendFile,
  mkdir,
  open,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'

import type { JsonValue, StepAttemptContext } from '@coji/durably'

import { MAX_TIMEOUT_MS, timerDelay } from './child.js'
import {
  estimateCostBreakdown,
  estimateCostBreakdownByModel,
} from './pricing.js'
import {
  boundedDenials,
  NOT_SENT,
  type AgentLog,
  type AgentProvider,
  type AgentResult,
  type AgentRole,
  type AgentTimeout,
  type AttemptMeasurement,
  type ProviderName,
  type ReviewCallSettings,
  type SessionHandling,
  type SpecWriteAccess,
} from './providers/types.js'
import type { SessionRef } from './types.js'
import { mergeUsage, type TokenUsage } from './usage.js'
import { resolveVersions } from './versions.js'

export interface AgentCallSpec {
  provider: AgentProvider
  providerName: ProviderName
  prompt: string
  workdir: string
  /** Trusted files outside `workdir` a read-only role may read. */
  readableFiles?: string[]
  /** A configured review's settings; see `AgentCallOptions.review`. */
  review?: ReviewCallSettings
  /** A spec writer's access; see `AgentCallOptions.specWrite`. */
  specWrite?: SpecWriteAccess
  /** A spec reviewer's name; see `AgentCallOptions.specReviewer`. */
  specReviewer?: string
  /** The call's total limit, from its start. */
  timeoutMs: number
  /**
   * The longest the call may go without any sign of the agent at work:
   * activity, output or partial usage. Absent: no such limit, as on a run
   * set up before it existed.
   */
  idleTimeoutMs?: number
  requestedModel: string | null
  requestedEffort: string | null
  effectiveModel: string | null
  effectiveEffort: string | null
  role: AgentRole
  stage: string
  iteration: number
  /** A review call's round, from 1; see `AgentCallOptions.reviewRound`. */
  reviewRound?: number
  operationKey?: string
  checkpointsDir?: string
  /**
   * Where the run keeps its agent logs. A call that is sent writes its
   * output to a file of its attempt's own here; absent, nothing is written.
   */
  agentLogsDir?: string
  session?: SessionRef | null
  requireSession?: boolean
  /**
   * A repair call's session handling, saved with the first measurement,
   * before anything is sent, and again on every recovery.
   */
  sessionHandling?: SessionHandling
  /** Why the call treats the session as `sessionHandling` says. */
  sessionReason?: string
  configVersion?: string | null
  /**
   * Return an explicit refusal from the provider (`rejectionReason`) as the
   * call's outcome instead of throwing `RejectedInvocationError`. Only the
   * preflight call asks for it: a refused preflight is an answer about the
   * settings, not a stop of its own. Either way the refusal is saved as a
   * completed checkpoint and never resent. Without it, an error after any
   * agent activity on the call is never read as a refusal.
   */
  acceptRejection?: boolean
  /**
   * Return a call the factory's own timer stopped (`timedOut`) as the call's
   * outcome instead of throwing `AgentTimeoutError`. Only the code stage
   * asks for it: it seals what the call left in the worktree. Either way the
   * stop is saved as a completed checkpoint and never resent.
   */
  acceptTimeout?: boolean
  /**
   * A signal that ends the call because its result is no longer wanted,
   * such as a review whose candidate failed verification. Unlike a cancel
   * or a lost lease, the call is settled: a completed checkpoint records it
   * as `cancelled` with `reason`, the partial usage already reported stays
   * on the measurement, and a replay reads it back without calling again.
   */
  supersede?: { signal: AbortSignal; reason: SupersedeReason }
}

/** Why a call's result was no longer wanted; see `AgentCallSpec.supersede`. */
export type SupersedeReason = 'superseded-by-verify'

export interface AgentCallOutcome {
  text: string
  sessionId: string | null
  invocationId: string
  recovered: boolean
  measurement: AttemptMeasurement
  /** The provider's refusal, when `acceptRejection` settled one; else null. */
  rejection: string | null
  /** Tool calls the provider refused during the call; empty when none. */
  permissionDenials: string[]
  /** The concrete model the provider reported running; null when none. */
  observedModel: string | null
  /** Why the call was ended early by `supersede`; null when it was not. */
  cancelled: SupersedeReason | null
  /** Which of the factory's limits stopped the call; null when none did. */
  timedOut: AgentTimeout | null
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
  /** Null only for a call the provider refused; see `rejection`. */
  result: AgentResult | null
  /** Why the provider refused the call outright; absent otherwise. */
  rejection?: string
  /** Why the call was ended by `supersede`; absent otherwise. */
  cancelled?: SupersedeReason
  /** The factory's limit that stopped the call; absent otherwise. */
  timedOut?: AgentTimeout
  invocationStartedAt: string
  invocationCompletedAt: string
}

/** Prefix of every `RejectedInvocationError` message; the failure table matches it. */
export const REJECTED_INVOCATION_MESSAGE = 'rejected-invocation'

/** How a rejection error names the refusal; the failure table reads it back. */
export const REFUSAL_MARKER = ' was refused: '

/**
 * The provider explicitly refused a call after preflight, such as a revoked
 * login or a spent quota. The refusal is saved as the call's completed
 * checkpoint, so the call is settled: nothing is resent, and a replay throws
 * this again with the same reason.
 */
export class RejectedInvocationError extends Error {
  constructor(
    readonly rejection: string,
    call: {
      role: string
      providerName: string
      effectiveModel: string | null
    },
  ) {
    super(
      `${REJECTED_INVOCATION_MESSAGE}: the ${call.role} call (${call.providerName} ${call.effectiveModel ?? 'provider-default'})${REFUSAL_MARKER}${rejection}`,
    )
    this.name = 'RejectedInvocationError'
  }
}

/** Prefix of every `AgentTimeoutError` message; the failure table matches it. */
export const AGENT_TIMEOUT_MESSAGE = 'agent-timeout'

/**
 * The factory's own timer stopped a call: it ran past its total limit, or
 * went silent past its idle limit. The stop is saved as the call's completed
 * checkpoint, so the call is settled: nothing is resent, and a replay throws
 * this again with the same limit.
 */
export class AgentTimeoutError extends Error {
  constructor(
    readonly timedOut: AgentTimeout,
    call: { role: string },
  ) {
    super(
      `${AGENT_TIMEOUT_MESSAGE}: the ${call.role} call was stopped at its ${timedOut.kind} limit of ${timedOut.limitMs} ms`,
    )
    this.name = 'AgentTimeoutError'
  }
}

/**
 * How much later than the runner's own limit the provider's copy of it
 * fires, so the runner's timer always stops the call first and the stop is
 * read as the factory's.
 */
export const PROVIDER_TIMEOUT_MARGIN_MS = 60_000

/** Prefix of every `UncertainInvocationError` message; the failure table matches it. */
export const UNCERTAIN_INVOCATION_MESSAGE = 'uncertain external invocation'

export class UncertainInvocationError extends Error {
  constructor(operationKey: string, invocationId: string) {
    super(
      `${UNCERTAIN_INVOCATION_MESSAGE}: ${operationKey} (${invocationId}); ` +
        'no completed checkpoint is available, so the prompt was not resent',
    )
    this.name = 'UncertainInvocationError'
  }
}

export function checkpointPaths(root: string, operationKey: string) {
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

/**
 * An empty agent log for one attempt. A file that cannot be made is
 * recorded with the reason, and the call goes on without it.
 */
async function createAgentLog(
  dir: string,
  attemptId: string,
): Promise<AgentLog> {
  const path = join(dir, `${attemptId}.log`)
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(path, '', { flag: 'wx' })
    return { path }
  } catch (error) {
    return { path, writeError: (error as Error).message }
  }
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
  const breakdown = next.usageByModel
    ? estimateCostBreakdownByModel(next.usageByModel)
    : estimateCostBreakdown(next.reportedModel, next.usage)
  next.costUsdEstimate = breakdown?.totalUsd ?? null
  next.costBasis = next.usage ? 'api-equivalent-estimate' : null
  next.costMeters = breakdown?.meters ?? null
  next.costCacheAware = breakdown?.cacheAware ?? null
  await attempt.setMetadata(next as unknown as JsonValue)
  return next
}

export async function runAgentCall(
  signal: AbortSignal,
  attempt: StepAttemptContext,
  spec: AgentCallSpec,
): Promise<AgentCallOutcome> {
  const startedAt = Date.now()
  // The provider launches its pinned CLI, so the version on record is of
  // that same file.
  const versions = await resolveVersions(
    spec.providerName,
    spec.provider.cliPath,
  )
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
    ...(spec.sessionHandling ? { sessionHandling: spec.sessionHandling } : {}),
    ...(spec.sessionReason ? { sessionReason: spec.sessionReason } : {}),
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
    costMeters: null,
    costCacheAware: null,
    configVersion: spec.configVersion ?? null,
    result: saved ? 'checkpoint-recovered' : 'started',
    error: null,
    interruptionReason: null,
  }
  await attempt.setMetadata(measurement as unknown as JsonValue)

  // Partial usage snapshots are advisory and arrive while the call is still
  // running. They are written one at a time and stop once the terminal write
  // begins, so a late snapshot can never overwrite the final measurement, and
  // a failed snapshot write can never reject into an unhandled rejection.
  let finalized = false
  let partialWrites: Promise<void> = Promise.resolve()
  // The agent's output is appended the same way: in the order it arrives,
  // and not after the terminal write begins. A failed append is kept as the
  // log's `writeError`, recorded by the terminal write.
  let agentLog: AgentLog | null = null
  let logWrites: Promise<void> = Promise.resolve()
  const settleMeasurement = async (): Promise<void> => {
    finalized = true
    await partialWrites
    await logWrites
    if (agentLog?.writeError)
      measurement = { ...measurement, agentLog: { ...agentLog } }
  }

  const finish = async (
    result: AgentResult,
    recovered: boolean,
    checkpoint?: CompletedCheckpoint,
  ): Promise<AgentCallOutcome> => {
    if (checkpoint) invocationId = checkpoint.invocationId
    await settleMeasurement()
    const sessionId = result.session?.id ?? spec.session?.nativeId ?? null
    if (spec.requireSession && !sessionId)
      throw new Error(
        `${spec.providerName} did not report a native session id for context reuse`,
      )
    // Kept from the result itself, so a call read back from its completed
    // checkpoint records the same denials as the call that wrote it.
    const denials = boundedDenials(result.permissionDenials ?? [])
    measurement = await writeMeasurement(attempt, measurement, {
      reportedModel: result.reportedModel,
      reportedEffort: result.reportedEffort,
      invocationId,
      sessionId,
      ...(denials ? { permissionDenials: denials } : {}),
      usagePatch: result.usage,
      ...(result.usageByModel ? { usageByModel: result.usageByModel } : {}),
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
      rejection: null,
      permissionDenials: result.permissionDenials ?? [],
      observedModel: result.observedModel ?? null,
      cancelled: null,
      timedOut: null,
    }
  }

  /**
   * A refused call: settled, with nothing to read and nothing to resend.
   * Only preflight takes it as an answer; every other caller gets
   * `RejectedInvocationError`, first time and on replay alike.
   */
  const finishRejected = async (
    rejection: string,
    checkpoint: CompletedCheckpoint,
    recovered: boolean,
  ): Promise<AgentCallOutcome> => {
    invocationId = checkpoint.invocationId
    await settleMeasurement()
    measurement = await writeMeasurement(attempt, measurement, {
      invocationId,
      elapsedMs:
        Date.parse(checkpoint.invocationCompletedAt) -
        Date.parse(checkpoint.invocationStartedAt),
      invocationStartedAt: checkpoint.invocationStartedAt,
      invocationCompletedAt: checkpoint.invocationCompletedAt,
      recovered,
      result: 'rejected',
      error: rejection,
    })
    if (!spec.acceptRejection)
      throw new RejectedInvocationError(rejection, spec)
    return {
      text: '',
      sessionId: null,
      invocationId,
      recovered,
      measurement,
      rejection,
      permissionDenials: [],
      observedModel: null,
      cancelled: null,
      timedOut: null,
    }
  }

  /**
   * A call ended by `supersede`: settled like a refusal, with the partial
   * usage it reported kept. Nothing is read from it and nothing is resent.
   */
  const finishCancelled = async (
    reason: SupersedeReason,
    checkpoint: CompletedCheckpoint,
    recovered: boolean,
  ): Promise<AgentCallOutcome> => {
    invocationId = checkpoint.invocationId
    await settleMeasurement()
    measurement = await writeMeasurement(attempt, measurement, {
      invocationId,
      elapsedMs:
        Date.parse(checkpoint.invocationCompletedAt) -
        Date.parse(checkpoint.invocationStartedAt),
      invocationStartedAt: checkpoint.invocationStartedAt,
      invocationCompletedAt: checkpoint.invocationCompletedAt,
      recovered,
      result: 'cancelled',
      error: null,
      interruptionReason: reason,
    })
    return {
      text: '',
      sessionId: null,
      invocationId,
      recovered,
      measurement,
      rejection: null,
      permissionDenials: [],
      observedModel: null,
      cancelled: reason,
      timedOut: null,
    }
  }
  /**
   * A call the factory's own timer stopped: settled like a cancelled one,
   * with the partial usage it reported kept. Only the code stage takes it as
   * an outcome; every other caller gets `AgentTimeoutError`, first time and
   * on replay alike.
   */
  const finishTimedOut = async (
    timedOut: AgentTimeout,
    checkpoint: CompletedCheckpoint,
    recovered: boolean,
  ): Promise<AgentCallOutcome> => {
    invocationId = checkpoint.invocationId
    await settleMeasurement()
    measurement = await writeMeasurement(attempt, measurement, {
      invocationId,
      elapsedMs:
        Date.parse(checkpoint.invocationCompletedAt) -
        Date.parse(checkpoint.invocationStartedAt),
      invocationStartedAt: checkpoint.invocationStartedAt,
      invocationCompletedAt: checkpoint.invocationCompletedAt,
      recovered,
      result: 'timed-out',
      error: null,
      interruptionReason: 'timeout',
      timedOut,
    })
    if (!spec.acceptTimeout) throw new AgentTimeoutError(timedOut, spec)
    return {
      text: '',
      sessionId: null,
      invocationId,
      recovered,
      measurement,
      rejection: null,
      permissionDenials: [],
      observedModel: null,
      cancelled: null,
      timedOut,
    }
  }
  const settled = (
    checkpoint: CompletedCheckpoint,
    recovered: boolean,
  ): Promise<AgentCallOutcome> => {
    if (checkpoint.timedOut)
      return finishTimedOut(checkpoint.timedOut, checkpoint, recovered)
    if (typeof checkpoint.cancelled === 'string')
      return finishCancelled(checkpoint.cancelled, checkpoint, recovered)
    if (typeof checkpoint.rejection === 'string')
      return finishRejected(checkpoint.rejection, checkpoint, recovered)
    if (!checkpoint.result)
      throw new Error('operation checkpoint has neither a result nor a refusal')
    return finish(checkpoint.result, recovered, checkpoint)
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
    if (saved.result) assertResolvedSettings(saved.result)
    return settled(saved, true)
  }
  if (existingStart)
    throw new UncertainInvocationError(operationKey, invocationId)
  // Superseded before anything was sent: there is no call to settle, and
  // nothing was spent. Recorded as `not-sent`, which no usage sum counts.
  if (spec.supersede?.signal.aborted) {
    measurement = await writeMeasurement(attempt, measurement, {
      result: NOT_SENT,
      interruptionReason: spec.supersede.reason,
    })
    return {
      text: '',
      sessionId: null,
      invocationId,
      recovered: false,
      measurement,
      rejection: null,
      permissionDenials: [],
      observedModel: null,
      cancelled: spec.supersede.reason,
      timedOut: null,
    }
  }

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
      if (raced) return settled(raced, true)
      const start = await readJson<StartedCheckpoint>(paths.started)
      throw new UncertainInvocationError(
        operationKey,
        start?.invocationId ?? invocationId,
      )
    }
    throw error
  }
  // Made and recorded before anything is sent, so the file is on record
  // before its first line. A replay or a call never sent returns above and
  // makes none.
  agentLog = spec.agentLogsDir
    ? await createAgentLog(spec.agentLogsDir, attempt.id)
    : null
  measurement = await writeMeasurement(attempt, measurement, {
    invocationStartedAt: startRecord.invocationStartedAt,
    ...(agentLog ? { agentLog: { ...agentLog } } : {}),
  })
  const log = agentLog

  // Two limits stop the call through one controller: the total, from the
  // start, and the idle one, restarted by every sign of the agent at work.
  // The first to fire is recorded; once the call has ended, neither fires
  // and no late notice restarts the idle one.
  const timeout = new AbortController()
  let fired: AgentTimeout | null = null
  let ended = false
  const stop = (kind: AgentTimeout['kind'], limitMs: number) => {
    if (ended || fired) return
    fired = { kind, limitMs }
    timeout.abort(new Error(`agent call ${kind} timeout`))
  }
  const timer = setTimeout(
    () => stop('total', spec.timeoutMs),
    timerDelay(spec.timeoutMs),
  )
  const idleMs = spec.idleTimeoutMs
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  const heartbeat = () => {
    if (ended || fired || idleMs === undefined) return
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => stop('idle', idleMs), timerDelay(idleMs))
  }
  heartbeat()
  const endTimers = () => {
    ended = true
    clearTimeout(timer)
    if (idleTimer) clearTimeout(idleTimer)
  }
  const onOutput = (chunk: string) => {
    heartbeat()
    if (finalized || !log || log.writeError) return
    logWrites = logWrites
      .then(() => appendFile(log.path, chunk, 'utf8'))
      .catch((error: unknown) => {
        log.writeError ??= (error as Error).message
      })
  }
  const supersede = spec.supersede ?? null
  const linked = AbortSignal.any([
    signal,
    timeout.signal,
    ...(supersede ? [supersede.signal] : []),
  ])
  // Whether the agent was seen at work on this call; see `onActivity`.
  let active = false
  try {
    const result = await spec.provider.call({
      prompt: spec.prompt,
      workdir: spec.workdir,
      ...(spec.readableFiles ? { readableFiles: spec.readableFiles } : {}),
      ...(spec.review ? { review: spec.review } : {}),
      ...(spec.specWrite ? { specWrite: spec.specWrite } : {}),
      ...(spec.specReviewer ? { specReviewer: spec.specReviewer } : {}),
      // The provider's own copy of the limit fires later than the runner's,
      // so a stop at the limit is always the runner's and read as one.
      timeoutMs: timerDelay(
        Math.min(spec.timeoutMs + PROVIDER_TIMEOUT_MARGIN_MS, MAX_TIMEOUT_MS),
      ),
      requestedModel: spec.effectiveModel,
      requestedEffort: spec.effectiveEffort,
      role: spec.role,
      reviewRound: spec.reviewRound,
      sessionId: spec.session?.nativeId ?? null,
      signal: linked,
      onActivity: () => {
        active = true
        heartbeat()
      },
      onOutput,
      onPartialUsage: (usage) => {
        active = true
        heartbeat()
        partialWrites = partialWrites
          .then(async () => {
            if (finalized) return
            measurement = await writeMeasurement(attempt, measurement, {
              usagePatch: { ...usage, usageSource: 'provider-partial' },
              elapsedMs: Date.now() - startedAt,
            })
          })
          .catch(() => {
            // Losing one progress snapshot must not fail the call or crash the
            // worker; the terminal write reports the provider's final usage.
          })
      },
    })
    endTimers()
    // Record the result before validating it. The call has already been made
    // and, on a subscription or an API key, already been paid for. Throwing
    // first would leave a start-only checkpoint, and every later resume would
    // stop at `uncertain external invocation` with the paid result
    // unreachable — the exact loss this checkpoint pair exists to prevent.
    // A validation failure still fails the run, now with a reason that says
    // what went wrong and replays to the same reason.
    const completed: CompletedCheckpoint = {
      ...startRecord,
      status: 'completed',
      result,
      invocationCompletedAt: new Date().toISOString(),
    }
    await writeJsonAtomic(paths.completed, completed, attempt.id)
    if (
      spec.requireSession &&
      !(result.session?.id ?? spec.session?.nativeId ?? null)
    ) {
      throw new Error(
        `${spec.providerName} did not report a native session id for context reuse`,
      )
    }
    assertResolvedSettings(result)
    // Pass the checkpoint so the attempt records the completion time that was
    // persisted, not a second `now` taken after the atomic write. A replay
    // reads the checkpoint's value, and the two must agree.
    return finish(result, false, completed)
  } catch (error) {
    endTimers()
    // Stopped by the factory's own timer, and not by a cancel, a lost lease
    // or supersede: the outcome is known, so it is settled with the usage it
    // had reported, and a replay neither resends it nor reads it as
    // uncertain. A provider's own timeout error is not this.
    const factoryTimeout = fired as AgentTimeout | null
    if (
      factoryTimeout &&
      !signal.aborted &&
      !(supersede?.signal.aborted ?? false)
    ) {
      const stopped: CompletedCheckpoint = {
        ...startRecord,
        status: 'completed',
        result: null,
        timedOut: factoryTimeout,
        invocationCompletedAt: new Date().toISOString(),
      }
      await writeJsonAtomic(paths.completed, stopped, attempt.id)
      return finishTimedOut(factoryTimeout, stopped, false)
    }
    // Ended because its result is no longer wanted, and not by a cancel, a
    // lost lease or the timeout: settled as cancelled, with the usage it had
    // reported, so a replay neither resends it nor reads it as uncertain.
    if (
      supersede?.signal.aborted &&
      !signal.aborted &&
      !timeout.signal.aborted
    ) {
      const cancelled: CompletedCheckpoint = {
        ...startRecord,
        status: 'completed',
        result: null,
        cancelled: supersede.reason,
        invocationCompletedAt: new Date().toISOString(),
      }
      await writeJsonAtomic(paths.completed, cancelled, attempt.id)
      return finishCancelled(supersede.reason, cancelled, false)
    }
    // An explicit refusal was not acted on, so it is recorded as the call's
    // completed answer: a replay reads it back and nothing is sent again. A
    // cancel or a timeout is never a refusal, whatever its message says, and
    // neither is an error the provider does not recognise as one. Outside
    // preflight, an error that follows any agent activity (text, a tool
    // call, usage) is not one either: the agent may already have acted, so
    // the outcome stays uncertain. Preflight asks for a reply and nothing
    // else, so its refusal is read as before.
    const rejection =
      !signal.aborted &&
      !timeout.signal.aborted &&
      (spec.acceptRejection === true || !active)
        ? spec.provider.rejectionReason(error)
        : null
    if (rejection !== null) {
      const refused: CompletedCheckpoint = {
        ...startRecord,
        status: 'completed',
        result: null,
        rejection,
        invocationCompletedAt: new Date().toISOString(),
      }
      await writeJsonAtomic(paths.completed, refused, attempt.id)
      return finishRejected(rejection, refused, false)
    }
    const message = error instanceof Error ? error.message : String(error)
    await settleMeasurement()
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
    endTimers()
  }
}
