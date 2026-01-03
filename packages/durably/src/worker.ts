import { prettifyError } from 'zod'
import { createStepContext } from './context'
import { CancelledError, getErrorMessage } from './errors'
import type { EventEmitter } from './events'
import type { JobRegistry } from './job'
import type { Storage } from './storage'

/**
 * Worker configuration
 */
export interface WorkerConfig {
  pollingInterval: number
  heartbeatInterval: number
  staleThreshold: number
}

/**
 * Worker state
 */
export interface Worker {
  /**
   * Start the worker polling loop
   */
  start(): void

  /**
   * Stop the worker after current run completes
   */
  stop(): Promise<void>

  /**
   * Check if worker is running
   */
  readonly isRunning: boolean
}

/**
 * Create a worker instance
 */
export function createWorker(
  config: WorkerConfig,
  storage: Storage,
  eventEmitter: EventEmitter,
  jobRegistry: JobRegistry,
): Worker {
  let running = false
  let currentRunPromise: Promise<void> | null = null
  let pollingTimeout: ReturnType<typeof setTimeout> | null = null
  let stopResolver: (() => void) | null = null
  let heartbeatInterval: ReturnType<typeof setInterval> | null = null
  let currentRunId: string | null = null

  /**
   * Recover stale runs by resetting them to pending
   */
  async function recoverStaleRuns(): Promise<void> {
    const staleThreshold = new Date(
      Date.now() - config.staleThreshold,
    ).toISOString()
    const runningRuns = await storage.getRuns({ status: 'running' })

    for (const run of runningRuns) {
      if (run.heartbeatAt < staleThreshold) {
        // This run is stale - reset to pending
        await storage.updateRun(run.id, {
          status: 'pending',
        })
      }
    }
  }

  /**
   * Update heartbeat for current run
   */
  async function updateHeartbeat(): Promise<void> {
    if (currentRunId) {
      await storage.updateRun(currentRunId, {
        heartbeatAt: new Date().toISOString(),
      })
    }
  }

  /**
   * Handle successful run completion
   */
  async function handleRunSuccess(
    runId: string,
    jobName: string,
    output: unknown,
    startTime: number,
  ): Promise<void> {
    // Check if run was cancelled during execution - don't overwrite cancelled status
    const currentRun = await storage.getRun(runId)
    if (currentRun?.status === 'cancelled') {
      return
    }

    await storage.updateRun(runId, {
      status: 'completed',
      output,
    })

    eventEmitter.emit({
      type: 'run:complete',
      runId,
      jobName,
      output,
      duration: Date.now() - startTime,
    })
  }

  /**
   * Handle failed run
   */
  async function handleRunFailure(
    runId: string,
    jobName: string,
    error: unknown,
  ): Promise<void> {
    // If the error is CancelledError, don't treat it as a failure
    // The run status is already 'cancelled'
    if (error instanceof CancelledError) {
      return
    }

    // Check if run was cancelled during execution - don't overwrite cancelled status
    const currentRun = await storage.getRun(runId)
    if (currentRun?.status === 'cancelled') {
      return
    }

    const errorMessage = getErrorMessage(error)

    // Get the failed step name if available
    const steps = await storage.getSteps(runId)
    const failedStep = steps.find((s) => s.status === 'failed')

    await storage.updateRun(runId, {
      status: 'failed',
      error: errorMessage,
    })

    eventEmitter.emit({
      type: 'run:fail',
      runId,
      jobName,
      error: errorMessage,
      failedStepName: failedStep?.name ?? 'unknown',
    })
  }

  /**
   * Execute a run with heartbeat management
   */
  async function executeRun(
    run: Awaited<ReturnType<typeof storage.getRun>> & { id: string },
    job: NonNullable<ReturnType<typeof jobRegistry.get>>,
  ): Promise<void> {
    // Track current run for heartbeat updates
    currentRunId = run.id

    // Start heartbeat interval
    // Errors are emitted as events but don't stop execution
    heartbeatInterval = setInterval(() => {
      updateHeartbeat().catch((error) => {
        eventEmitter.emit({
          type: 'worker:error',
          error: getErrorMessage(error),
          context: 'heartbeat',
          runId: run.id,
        })
      })
    }, config.heartbeatInterval)

    // Emit run:start event
    eventEmitter.emit({
      type: 'run:start',
      runId: run.id,
      jobName: run.jobName,
      payload: run.payload,
    })

    const startTime = Date.now()

    try {
      // Create step context and execute job
      const step = createStepContext(run, run.jobName, storage, eventEmitter)
      const output = await job.fn(step, run.payload)

      // Validate output if schema exists
      if (job.outputSchema) {
        const parseResult = job.outputSchema.safeParse(output)
        if (!parseResult.success) {
          throw new Error(`Invalid output: ${prettifyError(parseResult.error)}`)
        }
      }

      await handleRunSuccess(run.id, run.jobName, output, startTime)
    } catch (error) {
      await handleRunFailure(run.id, run.jobName, error)
    } finally {
      // Stop heartbeat interval
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval)
        heartbeatInterval = null
      }
      currentRunId = null
    }
  }

  async function processNextRun(): Promise<boolean> {
    // Get running runs to exclude their concurrency keys
    const runningRuns = await storage.getRuns({ status: 'running' })
    const excludeConcurrencyKeys = runningRuns
      .filter(
        (r): r is typeof r & { concurrencyKey: string } =>
          r.concurrencyKey !== null,
      )
      .map((r) => r.concurrencyKey)

    // Get next pending run
    const run = await storage.getNextPendingRun(excludeConcurrencyKeys)
    if (!run) {
      return false
    }

    // Get the job definition
    const job = jobRegistry.get(run.jobName)
    if (!job) {
      // Unknown job - mark as failed
      await storage.updateRun(run.id, {
        status: 'failed',
        error: `Unknown job: ${run.jobName}`,
      })
      return true
    }

    // Transition to running
    await storage.updateRun(run.id, {
      status: 'running',
      heartbeatAt: new Date().toISOString(),
    })

    await executeRun(run, job)

    return true
  }

  async function poll(): Promise<void> {
    if (!running) {
      return
    }

    const doWork = async () => {
      // Recover stale runs before processing
      await recoverStaleRuns()
      await processNextRun()
    }

    try {
      currentRunPromise = doWork()
      await currentRunPromise
    } finally {
      currentRunPromise = null
    }

    if (running) {
      pollingTimeout = setTimeout(() => poll(), config.pollingInterval)
    } else if (stopResolver) {
      stopResolver()
      stopResolver = null
    }
  }

  return {
    get isRunning(): boolean {
      return running
    },

    start(): void {
      if (running) {
        return
      }
      running = true
      poll()
    },

    async stop(): Promise<void> {
      if (!running) {
        return
      }

      running = false

      if (pollingTimeout) {
        clearTimeout(pollingTimeout)
        pollingTimeout = null
      }

      if (heartbeatInterval) {
        clearInterval(heartbeatInterval)
        heartbeatInterval = null
      }

      if (currentRunPromise) {
        // Wait for current run to complete
        return new Promise<void>((resolve) => {
          stopResolver = resolve
        })
      }
    },
  }
}
