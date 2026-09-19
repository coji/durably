import type {
  JobDefinition,
  JobHandle,
  TriggerOptions,
  TriggerResult,
} from '@coji/durably'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useDurably } from '../context'
import { useStableValue } from '../shared/use-stable-value'
import type { LogEntry, Progress, RunStatus } from '../types'
import { useAutoResume } from './use-auto-resume'
import { useJobSubscription } from './use-job-subscription'

export interface UseJobOptions<
  TLabels extends Record<string, string> = Record<string, string>,
> {
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
  /**
   * Optional scope to filter active runs and events by labels
   */
  scope?: { labels: TLabels }
  /**
   * Options passed to trigger() and triggerAndWait()
   */
  triggerOptions?: TriggerOptions<TLabels>
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
   * Whether a run is currently leased (being executed by a worker)
   */
  isLeased: boolean
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
   * Whether the run reached a terminal status (completed, failed, or cancelled)
   */
  isTerminal: boolean
  /**
   * Whether the run is pending or leased (actively queued or executing)
   */
  isActive: boolean
  /**
   * Whether initial scoped active-run resolution is currently in progress
   */
  isResolving: boolean
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
  TLabels extends Record<string, string> = Record<string, string>,
>(
  jobDefinition: JobDefinition<TName, TInput, TOutput>,
  options?: UseJobOptions<TLabels>,
): UseJobResult<TInput, TOutput> {
  const { durably } = useDurably()

  const stableScope = useStableValue(options?.scope)
  const stableTriggerOptions = useStableValue(options?.triggerOptions)
  const initialRunId = options?.initialRunId
  const autoResume = options?.autoResume !== false
  const followLatest = options?.followLatest !== false

  const [jobHandle, setJobHandle] = useState<JobHandle<
    TName,
    TInput,
    TOutput,
    TLabels
  > | null>(null)

  const resolutionEpochRef = useRef(0)
  const lookupEpochRef = useRef(0)
  const prevScopeRef = useRef(stableScope)
  const [isResolving, setIsResolving] = useState(autoResume && !initialRunId)

  useEffect(() => {
    if (!autoResume || initialRunId) setIsResolving(false)
  }, [autoResume, initialRunId])

  const handleFollow = useCallback((_runId: string) => {
    resolutionEpochRef.current++
    setIsResolving(false)
  }, [])

  // Use the extracted job subscription hook
  const subscription = useJobSubscription<TOutput>(
    durably,
    jobDefinition.name,
    {
      followLatest,
      scope: stableScope,
      onFollow: handleFollow,
    },
  )

  // Scope change handling
  useEffect(() => {
    if (prevScopeRef.current !== stableScope) {
      prevScopeRef.current = stableScope
      resolutionEpochRef.current++
      if (!initialRunId) {
        subscription.reset()
        if (autoResume) {
          setIsResolving(true)
        } else {
          setIsResolving(false)
        }
      }
    }
  }, [stableScope, initialRunId, autoResume, subscription.reset])

  // Register job
  useEffect(() => {
    if (!durably) return

    const d = durably.register({
      _job: jobDefinition,
    })
    const registeredHandle = d.jobs._job as JobHandle<
      TName,
      TInput,
      TOutput,
      TLabels
    >
    setJobHandle(registeredHandle)
  }, [durably, jobDefinition])

  // Handle initialRunId
  useEffect(() => {
    if (!initialRunId) return
    setIsResolving(false)
    const epoch = ++resolutionEpochRef.current
    subscription.setCurrentRunId(initialRunId)

    if (jobHandle) {
      jobHandle
        .getRun(initialRunId)
        .then((run) => {
          if (run && resolutionEpochRef.current === epoch) {
            subscription.hydrateRun(
              run.id,
              run.status as RunStatus,
              run.output as TOutput,
              run.error,
            )
          }
        })
        .catch(() => {
          // Status hydration is best effort; the event subscription remains active.
        })
    }
  }, [
    initialRunId,
    jobHandle,
    subscription.setCurrentRunId,
    subscription.hydrateRun,
  ])

  // Auto-resume callbacks
  const autoResumeCallbacks = useMemo(() => {
    return {
      onStart: () => {
        lookupEpochRef.current = resolutionEpochRef.current
        setIsResolving(true)
      },
      onRunFound: async (run: {
        id: string
        status: RunStatus
        output?: unknown
        error?: string | null
      }) => {
        if (resolutionEpochRef.current !== lookupEpochRef.current) return
        subscription.hydrateRun(
          run.id,
          run.status,
          run.output as TOutput,
          run.error ?? null,
        )
        const revalidated = await jobHandle?.getRun(run.id)
        if (
          !revalidated ||
          resolutionEpochRef.current !== lookupEpochRef.current
        ) {
          return
        }
        subscription.revalidateRun(
          revalidated.id,
          run.status,
          revalidated.status as RunStatus,
          revalidated.output as TOutput,
          revalidated.error,
        )
      },
      onSettled: () => {
        if (resolutionEpochRef.current !== lookupEpochRef.current) return
        setIsResolving(false)
      },
    }
  }, [jobHandle, subscription.hydrateRun, subscription.revalidateRun])

  // Use the extracted auto-resume hook
  useAutoResume(
    jobHandle,
    {
      enabled: autoResume,
      initialRunId,
      scope: stableScope,
    },
    autoResumeCallbacks,
  )

  const trackTriggeredRun = useCallback(
    async (run: TriggerResult<TOutput, TLabels>, epoch: number) => {
      if (!jobHandle || resolutionEpochRef.current !== epoch) return
      subscription.hydrateRun(
        run.id,
        run.status as RunStatus,
        run.output as TOutput,
        run.error,
      )

      // Terminal events before hydration could not be applied. Re-read after
      // installing the run ID, while leaving newer events or scopes in control.
      const revalidated = await jobHandle.getRun(run.id)
      if (!revalidated || resolutionEpochRef.current !== epoch) return
      subscription.revalidateRun(
        run.id,
        run.status as RunStatus,
        revalidated.status as RunStatus,
        revalidated.output as TOutput,
        revalidated.error,
      )
    },
    [jobHandle, subscription.hydrateRun, subscription.revalidateRun],
  )

  const trigger = useCallback(
    async (input: TInput): Promise<{ runId: string }> => {
      if (!jobHandle) {
        throw new Error('Job not ready')
      }

      const epoch = ++resolutionEpochRef.current
      setIsResolving(false)

      // Reset state before triggering
      subscription.reset()

      const run = await jobHandle.trigger(input, stableTriggerOptions)
      await trackTriggeredRun(run, epoch)

      return { runId: run.id }
    },
    [jobHandle, stableTriggerOptions, subscription.reset, trackTriggeredRun],
  )

  const triggerAndWait = useCallback(
    async (input: TInput): Promise<{ runId: string; output: TOutput }> => {
      if (!jobHandle || !durably) {
        throw new Error('Job not ready')
      }

      const epoch = ++resolutionEpochRef.current
      setIsResolving(false)

      // Reset state before triggering
      subscription.reset()

      const run = await jobHandle.trigger(input, stableTriggerOptions)
      await trackTriggeredRun(run, epoch)

      if (run.status === 'completed') {
        return { runId: run.id, output: run.output as TOutput }
      }
      if (run.status === 'failed') {
        throw new Error(run.error || 'Job failed')
      }
      if (run.status === 'cancelled') {
        throw new Error('Job cancelled')
      }

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
    [
      durably,
      jobHandle,
      stableTriggerOptions,
      subscription.reset,
      trackTriggeredRun,
    ],
  )

  const reset = useCallback(() => {
    resolutionEpochRef.current++
    subscription.reset()
  }, [subscription.reset])

  return {
    trigger,
    triggerAndWait,
    status: subscription.status,
    output: subscription.output,
    error: subscription.error,
    logs: subscription.logs,
    progress: subscription.progress,
    isLeased: subscription.status === 'leased',
    isPending: subscription.status === 'pending',
    isCompleted: subscription.status === 'completed',
    isFailed: subscription.status === 'failed',
    isCancelled: subscription.status === 'cancelled',
    isTerminal:
      subscription.status === 'completed' ||
      subscription.status === 'failed' ||
      subscription.status === 'cancelled',
    isActive:
      subscription.status === 'pending' || subscription.status === 'leased',
    isResolving,
    currentRunId: subscription.currentRunId,
    reset,
  }
}
