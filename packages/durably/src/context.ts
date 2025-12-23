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
): StepContext {
  let stepIndex = run.currentStepIndex
  let currentStepName: string | null = null

  return {
    get runId(): string {
      return run.id
    },

    async run<T>(name: string, fn: () => T | Promise<T>): Promise<T> {
      // Check if run was cancelled before executing this step
      const currentRun = await storage.getRun(run.id)
      if (currentRun?.status === 'cancelled') {
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
      })

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
        })

        return result
      } catch (error) {
        // Save failed step
        const errorMessage =
          error instanceof Error ? error.message : String(error)

        await storage.createStep({
          runId: run.id,
          name,
          index: stepIndex,
          status: 'failed',
          error: errorMessage,
          startedAt,
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
      })
    },

    log: {
      info(message: string, data?: unknown): void {
        eventEmitter.emit({
          type: 'log:write',
          runId: run.id,
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
          stepName: currentStepName,
          level: 'error',
          message,
          data,
        })
      },
    },
  }
}
