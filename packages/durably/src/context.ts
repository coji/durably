import type { EventEmitter } from './events'
import type { JobContext } from './job'
import type { Run, Storage } from './storage'

/**
 * Create a job context for executing a run
 */
export function createJobContext(
  run: Run,
  jobName: string,
  storage: Storage,
  eventEmitter: EventEmitter
): JobContext {
  let stepIndex = run.currentStepIndex

  return {
    get runId(): string {
      return run.id
    },

    async run<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
      // Check if step was already completed
      const existingStep = await storage.getCompletedStep(run.id, name)
      if (existingStep) {
        stepIndex++
        return existingStep.output as T
      }

      // Emit step:start event
      eventEmitter.emit({
        type: 'step:start',
        runId: run.id,
        jobName,
        stepName: name,
        stepIndex,
      })

      const startTime = Date.now()

      try {
        // Execute the step
        const result = await fn()

        // Save step result
        await storage.createStep({
          runId: run.id,
          name,
          index: stepIndex,
          status: 'completed',
          output: result,
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
        })

        return result
      } catch (error) {
        // Save failed step
        const errorMessage = error instanceof Error ? error.message : String(error)

        await storage.createStep({
          runId: run.id,
          name,
          index: stepIndex,
          status: 'failed',
          error: errorMessage,
        })

        // Emit step:fail event
        eventEmitter.emit({
          type: 'step:fail',
          runId: run.id,
          jobName,
          stepName: name,
          stepIndex,
          error: errorMessage,
        })

        throw error
      }
    },

    progress(current: number, total?: number, message?: string): void {
      // Fire and forget - don't await
      storage.updateRun(run.id, {
        progress: { current, total, message },
      })
    },

    log: {
      info(message: string, data?: unknown): void {
        eventEmitter.emit({
          type: 'log:write',
          runId: run.id,
          stepName: null,
          level: 'info',
          message,
          data,
        })
      },

      warn(message: string, data?: unknown): void {
        eventEmitter.emit({
          type: 'log:write',
          runId: run.id,
          stepName: null,
          level: 'warn',
          message,
          data,
        })
      },

      error(message: string, data?: unknown): void {
        eventEmitter.emit({
          type: 'log:write',
          runId: run.id,
          stepName: null,
          level: 'error',
          message,
          data,
        })
      },
    },
  }
}
