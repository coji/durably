import { createStepContext } from './context'
import { CancelledError, LeaseLostError, getErrorMessage } from './errors'
import type { EventEmitter } from './events'
import type { RegisteredJob } from './job'
import type { Run, Store } from './storage'

/**
 * Outcome of a single run execution in the internal runtime kernel.
 * Distinct from trigger Disposition in job.ts.
 */
export type RuntimeExecutionResult =
  | { kind: 'completed' }
  | { kind: 'failed' }
  | { kind: 'lease-lost' }
  | { kind: 'cancelled' }

export interface RuntimeConfig {
  leaseMs: number
  leaseRenewIntervalMs: number
  preserveSteps: boolean
}

export interface RuntimeClock {
  now(): number
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>
  clearTimeout(id: ReturnType<typeof setTimeout>): void
  setInterval(callback: () => void, ms: number): ReturnType<typeof setInterval>
  clearInterval(id: ReturnType<typeof setInterval>): void
}

export interface RuntimeEnvironment<
  TLabels extends Record<string, string> = Record<string, string>,
> {
  storage: Store<TLabels>
  eventEmitter: EventEmitter
  clock: RuntimeClock
}

function isoNow(clock: RuntimeClock): string {
  return new Date(clock.now()).toISOString()
}

/**
 * Execute a leased run using the given job definition.
 * Caller must resolve the job; unknown jobs are handled outside this function.
 */
export async function executeRun<
  TLabels extends Record<string, string> = Record<string, string>,
>(
  run: Run<TLabels>,
  job: RegisteredJob<unknown, unknown>,
  config: RuntimeConfig,
  environment: RuntimeEnvironment<TLabels>,
): Promise<RuntimeExecutionResult> {
  const { storage, eventEmitter, clock } = environment

  const { step, abortLeaseOwnership, dispose } = createStepContext(
    run,
    run.jobName,
    run.leaseGeneration,
    storage,
    eventEmitter,
  )
  let leaseDeadlineTimer: ReturnType<RuntimeClock['setTimeout']> | null = null

  const scheduleLeaseDeadline = (leaseExpiresAt: string | null) => {
    if (leaseDeadlineTimer) {
      clock.clearTimeout(leaseDeadlineTimer)
      leaseDeadlineTimer = null
    }

    if (!leaseExpiresAt) {
      return
    }

    const delay = Math.max(0, Date.parse(leaseExpiresAt) - clock.now())
    leaseDeadlineTimer = clock.setTimeout(() => {
      abortLeaseOwnership()
    }, delay)
  }

  scheduleLeaseDeadline(run.leaseExpiresAt)

  const leaseTimer = clock.setInterval(() => {
    const now = isoNow(clock)
    storage
      .renewLease(run.id, run.leaseGeneration, now, config.leaseMs)
      .then((renewed) => {
        if (!renewed) {
          abortLeaseOwnership()
          eventEmitter.emit({
            type: 'worker:error',
            error: `Lease renewal lost ownership for run ${run.id}`,
            context: 'lease-renewal',
            runId: run.id,
          })
          return
        }

        const renewedLeaseExpiresAt = new Date(
          Date.parse(now) + config.leaseMs,
        ).toISOString()

        scheduleLeaseDeadline(renewedLeaseExpiresAt)

        eventEmitter.emit({
          type: 'run:lease-renewed',
          runId: run.id,
          jobName: run.jobName,
          leaseOwner: run.leaseOwner ?? '',
          leaseExpiresAt: renewedLeaseExpiresAt,
          labels: run.labels,
        })
      })
      .catch((error: unknown) => {
        eventEmitter.emit({
          type: 'worker:error',
          error: getErrorMessage(error),
          context: 'lease-renewal',
          runId: run.id,
        })
      })
  }, config.leaseRenewIntervalMs)

  const started = clock.now()
  let reachedTerminalState = false

  try {
    eventEmitter.emit({
      type: 'run:leased',
      runId: run.id,
      jobName: run.jobName,
      input: run.input,
      leaseOwner: run.leaseOwner ?? '',
      leaseExpiresAt: run.leaseExpiresAt ?? isoNow(clock),
      labels: run.labels,
    })
    const output = await job.fn(step, run.input)

    if (job.outputSchema) {
      const parseResult = job.outputSchema.safeParse(output)
      if (!parseResult.success) {
        throw new Error(`Invalid output: ${parseResult.error.message}`)
      }
    }

    const completedAt = isoNow(clock)
    const completed = await storage.completeRun(
      run.id,
      run.leaseGeneration,
      output,
      completedAt,
    )

    if (completed) {
      reachedTerminalState = true
      eventEmitter.emit({
        type: 'run:complete',
        runId: run.id,
        jobName: run.jobName,
        output,
        duration: clock.now() - started,
        labels: run.labels,
      })
      return { kind: 'completed' }
    }

    eventEmitter.emit({
      type: 'worker:error',
      error: `Lease lost before completing run ${run.id}`,
      context: 'run-completion',
    })
    return { kind: 'lease-lost' }
  } catch (error) {
    if (error instanceof LeaseLostError) {
      return { kind: 'lease-lost' }
    }
    if (error instanceof CancelledError) {
      return { kind: 'cancelled' }
    }

    const errorMessage = getErrorMessage(error)
    const completedAt = isoNow(clock)
    const failed = await storage.failRun(
      run.id,
      run.leaseGeneration,
      errorMessage,
      completedAt,
    )

    if (failed) {
      reachedTerminalState = true
      const steps = await storage.getSteps(run.id)
      const failedStep = steps.find((entry) => entry.status === 'failed')
      eventEmitter.emit({
        type: 'run:fail',
        runId: run.id,
        jobName: run.jobName,
        error: errorMessage,
        failedStepName: failedStep?.name ?? 'unknown',
        labels: run.labels,
      })
      return { kind: 'failed' }
    }

    eventEmitter.emit({
      type: 'worker:error',
      error: `Lease lost before recording failure for run ${run.id}`,
      context: 'run-failure',
    })
    return { kind: 'lease-lost' }
  } finally {
    clock.clearInterval(leaseTimer)
    if (leaseDeadlineTimer) {
      clock.clearTimeout(leaseDeadlineTimer)
    }
    dispose()
    if (!config.preserveSteps && reachedTerminalState) {
      await storage.deleteSteps(run.id)
    }
  }
}
