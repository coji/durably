import type { JobDefinition, JobHandle } from '@coji/durably'
import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useDurably } from '../context'
import type { LogEntry, Progress, RunStatus } from '../types'
import { useAutoResume } from './use-auto-resume'
import { useJobSubscription } from './use-job-subscription'

export interface UseJobOptions {
  /**
   * Initial Run ID to subscribe to (for reconnection scenarios)
   */
  initialRunId?: string
  /**
   * Automatically resume tracking any pending or running job on initialization.
   * If a pending or running run exists for this job, the hook will subscribe to it.
   * @default true
   */
  autoResume?: boolean
  /**
   * Automatically switch to tracking the latest running job when a new run starts.
   * When true, the hook will update to track any new run for this job as soon as it starts running.
   * When false, the hook will only track the run that was triggered or explicitly set.
   * @default true
   */
  followLatest?: boolean
}

export interface UseJobResult<TInput, TOutput> {
  /**
   * Trigger the job with the given input
   */
  trigger: (input: TInput) => Promise<{ runId: string }>
  /**
   * Trigger and wait for completion
   */
  triggerAndWait: (input: TInput) => Promise<{ runId: string; output: TOutput }>
  /**
   * Current run status
   */
  status: RunStatus | null
  /**
   * Output from completed run
   */
  output: TOutput | null
  /**
   * Error message from failed run
   */
  error: string | null
  /**
   * Logs collected during execution
   */
  logs: LogEntry[]
  /**
   * Current progress
   */
  progress: Progress | null
  /**
   * Whether a run is currently running
   */
  isRunning: boolean
  /**
   * Whether a run is pending
   */
  isPending: boolean
  /**
   * Whether the run completed successfully
   */
  isCompleted: boolean
  /**
   * Whether the run failed
   */
  isFailed: boolean
  /**
   * Whether the run was cancelled
   */
  isCancelled: boolean
  /**
   * Current run ID
   */
  currentRunId: string | null
  /**
   * Reset all state
   */
  reset: () => void
}

export function useJob<
  TName extends string,
  TInput extends Record<string, unknown>,
  // biome-ignore lint/suspicious/noConfusingVoidType: TOutput can be void for jobs without return value
  TOutput extends Record<string, unknown> | void,
>(
  jobDefinition: JobDefinition<TName, TInput, TOutput>,
  options?: UseJobOptions,
): UseJobResult<TInput, TOutput> {
  const { durably } = useDurably()

  const jobHandleRef = useRef<JobHandle<TName, TInput, TOutput> | null>(null)

  // Register job
  useEffect(() => {
    if (!durably) return

    const d = durably.register({
      _job: jobDefinition,
    })
    jobHandleRef.current = d.jobs._job
  }, [durably, jobDefinition])

  // Use the extracted job subscription hook
  const subscription = useJobSubscription<TOutput>(
    durably,
    jobDefinition.name,
    {
      followLatest: options?.followLatest,
    },
  )

  // Auto-resume callbacks - stable reference
  const autoResumeCallbacks = useMemo(
    () => ({
      onRunFound: (runId: string, _status: RunStatus) => {
        subscription.setCurrentRunId(runId)
      },
    }),
    [subscription.setCurrentRunId],
  )

  // Use the extracted auto-resume hook
  useAutoResume(
    jobHandleRef.current,
    {
      enabled: options?.autoResume,
      initialRunId: options?.initialRunId,
    },
    autoResumeCallbacks,
  )

  // Handle initialRunId - set it and fetch current state
  useEffect(() => {
    if (!durably || !options?.initialRunId) return

    const jobHandle = jobHandleRef.current
    if (!jobHandle) return

    subscription.setCurrentRunId(options.initialRunId)

    // Fetch initial state for the run
    jobHandle.getRun(options.initialRunId).then((run) => {
      if (run) {
        // State will be updated via subscription events or we could
        // dispatch initial state here if needed
      }
    })
  }, [durably, options?.initialRunId, subscription.setCurrentRunId])

  const trigger = useCallback(
    async (input: TInput): Promise<{ runId: string }> => {
      const jobHandle = jobHandleRef.current
      if (!jobHandle) {
        throw new Error('Job not ready')
      }

      // Reset state before triggering
      subscription.reset()

      const run = await jobHandle.trigger(input)
      subscription.setCurrentRunId(run.id)

      return { runId: run.id }
    },
    [subscription],
  )

  const triggerAndWait = useCallback(
    async (input: TInput): Promise<{ runId: string; output: TOutput }> => {
      const jobHandle = jobHandleRef.current
      if (!jobHandle || !durably) {
        throw new Error('Job not ready')
      }

      // Reset state before triggering
      subscription.reset()

      const run = await jobHandle.trigger(input)
      subscription.setCurrentRunId(run.id)

      // Wait for completion by polling
      return new Promise((resolve, reject) => {
        const checkCompletion = async () => {
          const updatedRun = await jobHandle.getRun(run.id)
          if (!updatedRun) {
            reject(new Error('Run not found'))
            return
          }

          if (updatedRun.status === 'completed') {
            resolve({ runId: run.id, output: updatedRun.output as TOutput })
          } else if (updatedRun.status === 'failed') {
            reject(new Error(updatedRun.error ?? 'Job failed'))
          } else if (updatedRun.status === 'cancelled') {
            reject(new Error('Job cancelled'))
          } else {
            // Still running, check again
            setTimeout(checkCompletion, 50)
          }
        }
        checkCompletion()
      })
    },
    [durably, subscription],
  )

  return {
    trigger,
    triggerAndWait,
    status: subscription.status,
    output: subscription.output,
    error: subscription.error,
    logs: subscription.logs,
    progress: subscription.progress,
    isRunning: subscription.status === 'running',
    isPending: subscription.status === 'pending',
    isCompleted: subscription.status === 'completed',
    isFailed: subscription.status === 'failed',
    isCancelled: subscription.status === 'cancelled',
    currentRunId: subscription.currentRunId,
    reset: subscription.reset,
  }
}
