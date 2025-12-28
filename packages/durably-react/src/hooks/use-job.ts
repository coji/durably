import type { JobDefinition, JobHandle } from '@coji/durably'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useDurably } from '../context'
import type { LogEntry, Progress, RunStatus } from '../types'

export interface UseJobOptions {
  /**
   * Initial Run ID to subscribe to (for reconnection scenarios)
   */
  initialRunId?: string
}

export interface UseJobResult<TInput, TOutput> {
  /**
   * Whether the hook is ready (Durably is initialized)
   */
  isReady: boolean
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
  TOutput extends Record<string, unknown> | void,
>(
  jobDefinition: JobDefinition<TName, TInput, TOutput>,
  options?: UseJobOptions,
): UseJobResult<TInput, TOutput> {
  const { durably, isReady: isDurablyReady } = useDurably()

  const [status, setStatus] = useState<RunStatus | null>(null)
  const [output, setOutput] = useState<TOutput | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [progress, setProgress] = useState<Progress | null>(null)
  const [currentRunId, setCurrentRunId] = useState<string | null>(
    options?.initialRunId ?? null,
  )

  const jobHandleRef = useRef<JobHandle<TName, TInput, TOutput> | null>(null)
  // Use ref to track the latest runId for event filtering
  const currentRunIdRef = useRef<string | null>(currentRunId)
  currentRunIdRef.current = currentRunId

  // Register job and set up event listeners
  useEffect(() => {
    if (!durably || !isDurablyReady) return

    // Register the job
    const jobHandle = durably.register(jobDefinition)
    jobHandleRef.current = jobHandle

    // Subscribe to each event type separately
    const unsubscribes: (() => void)[] = []

    unsubscribes.push(
      durably.on('run:start', (event) => {
        if (event.runId !== currentRunIdRef.current) return
        setStatus('running')
      }),
    )

    unsubscribes.push(
      durably.on('run:complete', (event) => {
        if (event.runId !== currentRunIdRef.current) return
        setStatus('completed')
        setOutput(event.output as TOutput)
      }),
    )

    unsubscribes.push(
      durably.on('run:fail', (event) => {
        if (event.runId !== currentRunIdRef.current) return
        setStatus('failed')
        setError(event.error)
      }),
    )

    unsubscribes.push(
      durably.on('run:progress', (event) => {
        if (event.runId !== currentRunIdRef.current) return
        setProgress(event.progress)
      }),
    )

    unsubscribes.push(
      durably.on('log:write', (event) => {
        if (event.runId !== currentRunIdRef.current) return
        setLogs((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            runId: event.runId,
            stepName: event.stepName,
            level: event.level,
            message: event.message,
            data: event.data,
            timestamp: new Date().toISOString(),
          },
        ])
      }),
    )

    // If we have an initialRunId, fetch its current state
    if (options?.initialRunId && currentRunIdRef.current) {
      jobHandle.getRun(currentRunIdRef.current).then((run) => {
        if (run) {
          setStatus(run.status as RunStatus)
          if (run.status === 'completed' && run.output) {
            setOutput(run.output as TOutput)
          }
          if (run.status === 'failed' && run.error) {
            setError(run.error)
          }
        }
      })
    }

    return () => {
      for (const unsubscribe of unsubscribes) {
        unsubscribe()
      }
    }
  }, [durably, isDurablyReady, jobDefinition, options?.initialRunId])

  // Update state when currentRunId changes (for initialRunId scenario)
  useEffect(() => {
    if (!durably || !currentRunId) return

    const jobHandle = jobHandleRef.current
    if (jobHandle && options?.initialRunId) {
      jobHandle.getRun(currentRunId).then((run) => {
        if (run) {
          setStatus(run.status as RunStatus)
          if (run.status === 'completed' && run.output) {
            setOutput(run.output as TOutput)
          }
          if (run.status === 'failed' && run.error) {
            setError(run.error)
          }
        }
      })
    }
  }, [durably, currentRunId, options?.initialRunId])

  const trigger = useCallback(
    async (input: TInput): Promise<{ runId: string }> => {
      const jobHandle = jobHandleRef.current
      if (!jobHandle) {
        throw new Error('Job not ready')
      }

      // Reset state
      setOutput(null)
      setError(null)
      setLogs([])
      setProgress(null)

      const run = await jobHandle.trigger(input)
      setCurrentRunId(run.id)
      setStatus('pending')

      return { runId: run.id }
    },
    [],
  )

  const triggerAndWait = useCallback(
    async (input: TInput): Promise<{ runId: string; output: TOutput }> => {
      const jobHandle = jobHandleRef.current
      if (!jobHandle || !durably) {
        throw new Error('Job not ready')
      }

      // Reset state
      setOutput(null)
      setError(null)
      setLogs([])
      setProgress(null)

      const run = await jobHandle.trigger(input)
      setCurrentRunId(run.id)
      setStatus('pending')

      // Wait for completion
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
          } else {
            // Still running, check again
            setTimeout(checkCompletion, 50)
          }
        }
        checkCompletion()
      })
    },
    [durably],
  )

  const reset = useCallback(() => {
    setStatus(null)
    setOutput(null)
    setError(null)
    setLogs([])
    setProgress(null)
    setCurrentRunId(null)
  }, [])

  return {
    isReady: isDurablyReady,
    trigger,
    triggerAndWait,
    status,
    output,
    error,
    logs,
    progress,
    isRunning: status === 'running',
    isPending: status === 'pending',
    isCompleted: status === 'completed',
    isFailed: status === 'failed',
    currentRunId,
    reset,
  }
}
