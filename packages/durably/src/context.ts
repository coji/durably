import { serializeJsonValue, type JsonValue } from './attempts'
import {
  CancelledError,
  ConflictError,
  getErrorMessage,
  LeaseLostError,
} from './errors'
import type { EventEmitter } from './events'
import type { StepAttemptContext, StepContext } from './job'
import type { Run, Store } from './storage'

const LEASE_LOST = 'lease-lost'

/**
 * Create a step context for executing a run
 */
export function createStepContext(
  run: Run,
  jobName: string,
  leaseGeneration: number,
  storage: Store,
  eventEmitter: EventEmitter,
): {
  step: StepContext
  abortLeaseOwnership(): void
  preserveFailedParallelSteps(): boolean
  dispose: () => void
} {
  let stepIndex = run.currentStepIndex
  const activeStepNames = new Set<string>()
  const stepParents = new Map<string, string | null>()
  let ambiguousLogScope = false
  let preserveFailedParallelSteps = false

  const controller = new AbortController()

  function abortForLeaseLoss() {
    if (!controller.signal.aborted) {
      controller.abort(LEASE_LOST)
    }
  }

  function throwIfAborted(): void {
    if (!controller.signal.aborted) {
      return
    }

    if (controller.signal.reason === LEASE_LOST) {
      throw new LeaseLostError(run.id)
    }

    throw new CancelledError(run.id)
  }

  /** When persistStep returns null, check DB to distinguish cancel from lease loss */
  async function throwForRefusedStep(
    stepName: string,
    stepIndex: number,
  ): Promise<never> {
    const latestRun = await storage.getRun(run.id)
    if (latestRun?.status === 'cancelled') {
      eventEmitter.emit({
        type: 'step:cancel',
        runId: run.id,
        jobName,
        stepName,
        stepIndex,
        labels: run.labels,
      })
      throw new CancelledError(run.id)
    }
    abortForLeaseLoss()
    throw new LeaseLostError(run.id)
  }

  async function throwForRefusedMetadata(attemptId: string): Promise<never> {
    const latestRun = await storage.getRun(run.id)
    if (latestRun?.status === 'cancelled') {
      throw new CancelledError(run.id)
    }
    const latestAttempt = await storage.getStepAttempt(attemptId)
    if (
      latestRun?.status === 'leased' &&
      latestRun.leaseGeneration === leaseGeneration &&
      latestRun.leaseExpiresAt !== null &&
      Date.parse(latestRun.leaseExpiresAt) > Date.now() &&
      latestAttempt?.status !== 'started'
    ) {
      throw new ConflictError(`Step attempt is already finalized: ${attemptId}`)
    }
    abortForLeaseLoss()
    throw new LeaseLostError(run.id)
  }

  const unsubscribe = eventEmitter.on('run:cancel', (event) => {
    if (event.runId === run.id) {
      controller.abort()
    }
  })

  function writeLog(
    level: 'info' | 'warn' | 'error',
    message: string,
    data: unknown,
    stepName: string | null,
  ): void {
    eventEmitter.emit({
      type: 'log:write',
      runId: run.id,
      jobName,
      labels: run.labels,
      stepName,
      level,
      message,
      data,
    })
  }

  function stepLogger(name: string): StepContext['log'] {
    return {
      info(message, data) {
        writeLog('info', message, data, name)
      },
      warn(message, data) {
        writeLog('warn', message, data, name)
      },
      error(message, data) {
        writeLog('error', message, data, name)
      },
    }
  }

  function nestedStepName(): string | null {
    const names = [...activeStepNames]
    const innermost = names.at(-1)
    if (!innermost) return null
    let parent = stepParents.get(innermost) ?? null
    for (let index = names.length - 2; index >= 0; index--) {
      if (names[index] !== parent) return null
      parent = stepParents.get(names[index]) ?? null
    }
    return innermost
  }

  function implicitStepName(): string | null {
    return ambiguousLogScope ? null : nestedStepName()
  }

  const step: StepContext = {
    get runId(): string {
      return run.id
    },

    get signal(): AbortSignal {
      return controller.signal
    },

    isAborted(): boolean {
      return controller.signal.aborted
    },

    throwIfAborted(): void {
      throwIfAborted()
    },

    async run<T>(
      name: string,
      fn: (signal: AbortSignal, attempt: StepAttemptContext) => T | Promise<T>,
      options?: { metadata?: JsonValue },
    ): Promise<T> {
      // Capture the caller before the first await. A nested step may start
      // later, after the parent callback has yielded for the durable lookup.
      const parentStepName = implicitStepName()
      // Fast path: check in-memory signal first (set by run:cancel event)
      throwIfAborted()

      // Slow path: DB check for cases where event wasn't received
      // (e.g., run cancelled while worker was down, then resumed)
      const currentRun = await storage.getRun(run.id)
      if (currentRun?.status === 'cancelled') {
        controller.abort()
        throwIfAborted()
      }

      if (
        currentRun &&
        ((currentRun.status === 'leased' &&
          currentRun.leaseGeneration !== leaseGeneration) ||
          currentRun.status === 'completed' ||
          currentRun.status === 'failed')
      ) {
        abortForLeaseLoss()
        throwIfAborted()
      }

      // Check cancellation before replaying cached steps
      throwIfAborted()

      // Check if step was already completed
      const existingStep = await storage.getCompletedStep(run.id, name)
      if (existingStep) {
        stepIndex = Math.max(stepIndex, existingStep.index + 1)
        return existingStep.output as T
      }

      const initialMetadata =
        options && 'metadata' in options
          ? JSON.parse(serializeJsonValue(options.metadata))
          : undefined
      const attemptIndex = stepIndex++
      const startedAttempt = await storage.beginStepAttempt(
        run.id,
        leaseGeneration,
        {
          name,
          index: attemptIndex,
          ...(options && 'metadata' in options
            ? { metadata: initialMetadata }
            : {}),
        },
      )
      if (!startedAttempt) {
        return await throwForRefusedStep(name, attemptIndex)
      }
      // Cancellation may arrive while the durable start is being written.
      throwIfAborted()

      let currentMetadata = startedAttempt.metadata
      const attempt: StepAttemptContext = {
        id: startedAttempt.id,
        log: stepLogger(name),
        get metadata() {
          return currentMetadata === null
            ? null
            : JSON.parse(JSON.stringify(currentMetadata))
        },
        async setMetadata(value) {
          const snapshot = JSON.parse(serializeJsonValue(value)) as JsonValue
          const updated = await storage.updateStepAttemptMetadata(
            run.id,
            leaseGeneration,
            startedAttempt.id,
            snapshot,
          )
          if (updated === undefined)
            await throwForRefusedMetadata(startedAttempt.id)
          currentMetadata = updated as JsonValue
        },
      }

      // A nested chain has an unambiguous innermost callback. Independent
      // callbacks remain unscoped once their lifetimes overlap.
      stepParents.set(name, parentStepName)
      activeStepNames.add(name)
      if (activeStepNames.size > 1 && !nestedStepName()) {
        ambiguousLogScope = true
      }

      // The attempt start is durable before the callback or event is visible.
      const startedAt = startedAttempt.startedAt
      const startTime = Date.now()

      // Emit step:start event
      eventEmitter.emit({
        type: 'step:start',
        runId: run.id,
        jobName,
        stepName: name,
        stepIndex: attemptIndex,
        labels: run.labels,
      })

      try {
        let result: T
        try {
          // Only callback errors produce failed step and attempt records.
          result = await fn(controller.signal, attempt)
          throwIfAborted()
        } catch (error) {
          // If lease was already lost, don't attempt to write step data —
          // we no longer own this run and must not pollute the new owner's state.
          if (error instanceof LeaseLostError) {
            throw error
          }

          // Check if signal was aborted due to lease loss (not cancellation).
          // fn() may have thrown a different error while the lease was lost.
          const isLeaseLost =
            controller.signal.aborted && controller.signal.reason === LEASE_LOST
          if (isLeaseLost) {
            throw new LeaseLostError(run.id)
          }

          const isCancelled = controller.signal.aborted
          const errorMessage = getErrorMessage(error)

          // Persist failed/cancelled step record with lease guard.
          // The guard checks both status='leased' and lease_generation,
          // so this returns null if the run was cancelled or the lease was lost.
          const savedStep = await storage.persistStep(run.id, leaseGeneration, {
            name,
            index: attemptIndex,
            status: isCancelled ? 'cancelled' : 'failed',
            error: errorMessage,
            startedAt,
            attemptId: startedAttempt.id,
          })

          if (!savedStep) {
            await throwForRefusedStep(name, attemptIndex)
          }

          // If we reach here, savedStep is truthy — the run is still leased.
          // Cancellation is handled above (persistStep returns null for cancelled runs).
          eventEmitter.emit({
            type: 'step:fail',
            error: errorMessage,
            runId: run.id,
            jobName,
            stepName: name,
            stepIndex: attemptIndex,
            labels: run.labels,
          })

          throw error
        }

        // A checkpoint write error leaves the attempt unresolved. It must not
        // be reclassified as a callback failure.
        const savedStep = await storage.persistStep(run.id, leaseGeneration, {
          name,
          index: attemptIndex,
          status: 'completed',
          output: result,
          startedAt,
          attemptId: startedAttempt.id,
        })

        if (!savedStep) {
          await throwForRefusedStep(name, attemptIndex)
        }

        // Emit step:complete event
        eventEmitter.emit({
          type: 'step:complete',
          runId: run.id,
          jobName,
          stepName: name,
          stepIndex: attemptIndex,
          output: result,
          duration: Date.now() - startTime,
          labels: run.labels,
        })

        return result
      } finally {
        activeStepNames.delete(name)
        stepParents.delete(name)
        if (activeStepNames.size === 0) ambiguousLogScope = false
      }
    },

    async all(branches) {
      const entries = Object.entries(branches)
      if (entries.length === 0) return {} as never

      const settled = await Promise.allSettled(
        entries.map(([name, fn]) => step.run(name, fn)),
      )
      const rejected = settled.flatMap((result, index) =>
        result.status === 'rejected'
          ? [{ name: entries[index][0], reason: result.reason as unknown }]
          : [],
      )
      // A sibling may lose the lease or be cancelled after another branch
      // fails. Preserve the run lifecycle outcome instead of failing an
      // expired or cancelled run with the earlier ordinary error.
      const leaseLoss = rejected.find(
        ({ reason }) => reason instanceof LeaseLostError,
      )
      if (leaseLoss) throw leaseLoss.reason
      const cancellation = rejected.find(
        ({ reason }) => reason instanceof CancelledError,
      )
      if (cancellation) throw cancellation.reason

      if (
        rejected.length > 0 &&
        settled.some((result) => result.status === 'fulfilled')
      ) {
        // The failed run has no aggregate output. Retain successful sibling
        // checkpoints so callers can inspect their results after failure.
        preserveFailedParallelSteps = true
      }

      if (rejected.length > 1) {
        // run:fail names the lowest-index failed checkpoint. Choose its error
        // too, because asynchronous setup can assign indexes out of branch
        // declaration order.
        const byName = new Map(
          rejected.map(({ name, reason }) => [name, reason]),
        )
        const attempts = await storage.getStepAttempts(run.id)
        const firstFailed = attempts
          .filter(
            (saved) =>
              saved.leaseGeneration === leaseGeneration &&
              saved.status === 'failed' &&
              saved.interruptionReason === null &&
              byName.has(saved.stepName),
          )
          .sort((a, b) => a.stepIndex - b.stepIndex)[0]
        if (firstFailed) throw byName.get(firstFailed.stepName)
      }
      if (rejected.length > 0) throw rejected[0].reason

      return Object.fromEntries(
        entries.map(([name], index) => [
          name,
          (settled[index] as PromiseFulfilledResult<unknown>).value,
        ]),
      ) as never
    },

    progress(current: number, total?: number, message?: string): void {
      const progressData = { current, total, message }
      // Fire and forget - don't await
      storage.updateProgress(run.id, leaseGeneration, progressData)
      // Emit progress event
      eventEmitter.emit({
        type: 'run:progress',
        runId: run.id,
        jobName,
        progress: progressData,
        labels: run.labels,
      })
    },

    log: {
      info(message: string, data?: unknown): void {
        writeLog('info', message, data, implicitStepName())
      },

      warn(message: string, data?: unknown): void {
        writeLog('warn', message, data, implicitStepName())
      },

      error(message: string, data?: unknown): void {
        writeLog('error', message, data, implicitStepName())
      },
    },
  }

  return {
    step,
    abortLeaseOwnership: abortForLeaseLoss,
    preserveFailedParallelSteps: () => preserveFailedParallelSteps,
    dispose: unsubscribe,
  }
}
