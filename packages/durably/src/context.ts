import { CancelledError, getErrorMessage, LeaseLostError } from './errors'
import type { EventEmitter } from './events'
import type { StepContext } from './job'
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
  dispose: () => void
} {
  let stepIndex = run.currentStepIndex
  let currentStepName: string | null = null

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

  const unsubscribe = eventEmitter.on('run:cancel', (event) => {
    if (event.runId === run.id) {
      controller.abort()
    }
  })

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
      fn: (signal: AbortSignal) => T | Promise<T>,
    ): Promise<T> {
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
        stepIndex++
        return existingStep.output as T
      }

      // Track current step for log attribution
      currentStepName = name

      // Record step start time
      const startedAt = new Date().toISOString()
      const startTime = Date.now()

      // Emit step:start event
      eventEmitter.emit({
        type: 'step:start',
        runId: run.id,
        jobName,
        stepName: name,
        stepIndex,
        labels: run.labels,
      })

      try {
        // Execute the step with the abort signal
        const result = await fn(controller.signal)
        throwIfAborted()

        // Persist step result atomically with lease generation guard.
        // If the lease was reclaimed by another worker, this returns null.
        const savedStep = await storage.persistStep(run.id, leaseGeneration, {
          name,
          index: stepIndex,
          status: 'completed',
          output: result,
          startedAt,
        })

        if (!savedStep) {
          abortForLeaseLoss()
          throwIfAborted()
        }

        stepIndex++

        // Emit step:complete event
        eventEmitter.emit({
          type: 'step:complete',
          runId: run.id,
          jobName,
          stepName: name,
          stepIndex: stepIndex - 1,
          output: result,
          duration: Date.now() - startTime,
          labels: run.labels,
        })

        return result
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

        // Persist failed/cancelled step record with generation guard.
        // For cancellation: the generation still matches (cancelRun doesn't
        // change it), so the guard passes. For normal errors: the guard
        // prevents stale writes if the lease was reclaimed.
        const savedStep = await storage.persistStep(run.id, leaseGeneration, {
          name,
          index: stepIndex,
          status: isCancelled ? 'cancelled' : 'failed',
          error: errorMessage,
          startedAt,
        })

        if (!savedStep) {
          // Lease was lost during this window
          abortForLeaseLoss()
          throw new LeaseLostError(run.id)
        }

        eventEmitter.emit({
          ...(isCancelled
            ? { type: 'step:cancel' as const }
            : { type: 'step:fail' as const, error: errorMessage }),
          runId: run.id,
          jobName,
          stepName: name,
          stepIndex,
          labels: run.labels,
        })

        if (isCancelled) {
          throwIfAborted()
        }
        throw error
      } finally {
        // Clear current step after execution
        currentStepName = null
      }
    },

    progress(current: number, total?: number, message?: string): void {
      const progressData = { current, total, message }
      // Fire and forget - don't await
      storage.updateProgress(run.id, progressData)
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
        eventEmitter.emit({
          type: 'log:write',
          runId: run.id,
          jobName,
          labels: run.labels,
          stepName: currentStepName,
          level: 'info',
          message,
          data,
        })
      },

      warn(message: string, data?: unknown): void {
        eventEmitter.emit({
          type: 'log:write',
          runId: run.id,
          jobName,
          labels: run.labels,
          stepName: currentStepName,
          level: 'warn',
          message,
          data,
        })
      },

      error(message: string, data?: unknown): void {
        eventEmitter.emit({
          type: 'log:write',
          runId: run.id,
          jobName,
          labels: run.labels,
          stepName: currentStepName,
          level: 'error',
          message,
          data,
        })
      },
    },
  }

  return {
    step,
    abortLeaseOwnership: abortForLeaseLoss,
    dispose: unsubscribe,
  }
}
