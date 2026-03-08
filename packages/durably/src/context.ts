import { CancelledError, getErrorMessage, LeaseLostError } from './errors'
import type { EventEmitter } from './events'
import type { StepContext } from './job'
import type { Run, Storage } from './storage'

/**
 * Create a step context for executing a run
 */
export function createStepContext(
  run: Run,
  jobName: string,
  workerId: string,
  storage: Storage,
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
      controller.abort('lease-lost')
    }
  }

  function throwIfAborted(): void {
    if (!controller.signal.aborted) {
      return
    }

    if (controller.signal.reason === 'lease-lost') {
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
      const currentRun = await storage.queue.getRun(run.id)
      if (currentRun?.status === 'cancelled') {
        controller.abort()
        throwIfAborted()
      }

      if (
        currentRun &&
        ((currentRun.status === 'leased' &&
          currentRun.leaseOwner !== workerId) ||
          currentRun.status === 'completed' ||
          currentRun.status === 'failed')
      ) {
        abortForLeaseLoss()
        throwIfAborted()
      }

      // Check cancellation before replaying cached steps
      throwIfAborted()

      // Check if step was already completed
      const existingStep = await storage.checkpoint.getCompletedStep(
        run.id,
        name,
      )
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

        // Save step result
        await storage.checkpoint.createStep({
          runId: run.id,
          name,
          index: stepIndex,
          status: 'completed',
          output: result,
          startedAt,
        })

        // Update run's current step index
        stepIndex++
        await storage.checkpoint.advanceRunStepIndex(run.id, stepIndex)

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
        const isCancelled = controller.signal.aborted
        const errorMessage = getErrorMessage(error)

        await storage.checkpoint.createStep({
          runId: run.id,
          name,
          index: stepIndex,
          status: isCancelled ? 'cancelled' : 'failed',
          error: errorMessage,
          startedAt,
        })

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
      storage.checkpoint.updateProgress(run.id, progressData)
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
