import { CancelledError } from './errors'
import type { EventEmitter } from './events'
import type { StepContext } from './job'
import type { Run, Storage } from './storage'

/**
 * Create a step context for executing a run
 */
export function createStepContext(
  run: Run,
  jobName: string,
  storage: Storage,
  eventEmitter: EventEmitter,
): { step: StepContext; dispose: () => void } {
  let stepIndex = run.currentStepIndex
  let currentStepName: string | null = null

  const controller = new AbortController()

  const unsubscribe = eventEmitter.on('run:cancel', (event) => {
    if (event.runId === run.id) {
      controller.abort()
    }
  })

  const step: StepContext = {
    get runId(): string {
      return run.id
    },

    async run<T>(
      name: string,
      fn: (signal: AbortSignal) => T | Promise<T>,
    ): Promise<T> {
      // Fast path: check in-memory signal first (set by run:cancel event)
      if (controller.signal.aborted) {
        throw new CancelledError(run.id)
      }

      // Slow path: DB check for cases where event wasn't received
      // (e.g., run cancelled while worker was down, then resumed)
      const currentRun = await storage.getRun(run.id)
      if (currentRun?.status === 'cancelled') {
        controller.abort()
        throw new CancelledError(run.id)
      }

      // Check cancellation before replaying cached steps
      if (controller.signal.aborted) {
        throw new CancelledError(run.id)
      }

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

        // Save step result
        await storage.createStep({
          runId: run.id,
          name,
          index: stepIndex,
          status: 'completed',
          output: result,
          startedAt,
        })

        // Update run's current step index
        stepIndex++
        await storage.updateRun(run.id, { currentStepIndex: stepIndex })

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
        const errorMessage =
          error instanceof Error ? error.message : String(error)

        await storage.createStep({
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
          throw new CancelledError(run.id)
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
      storage.updateRun(run.id, { progress: progressData })
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

  return { step, dispose: unsubscribe }
}
