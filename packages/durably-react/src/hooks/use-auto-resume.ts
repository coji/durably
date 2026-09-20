import type { JobHandle, Run } from '@coji/durably'
import { useEffect } from 'react'

type JobRun<TOutput, TLabels extends Record<string, string>> = Omit<
  Run<TLabels>,
  'output'
> & { output: TOutput | null }

export interface UseAutoResumeOptions<
  TLabels extends Record<string, string> = Record<string, string>,
> {
  /**
   * Whether to automatically resume tracking pending/running/waiting runs
   * @default true
   */
  enabled?: boolean
  /**
   * Skip auto-resume if an initial run ID is provided
   */
  skipIfInitialRunId?: boolean
  /**
   * Initial run ID (if provided, auto-resume is skipped)
   */
  initialRunId?: string
  /**
   * Optional scope to filter active runs by labels
   */
  scope?: { labels: TLabels }
}

export interface UseAutoResumeCallbacks<
  TOutput = unknown,
  TLabels extends Record<string, string> = Record<string, string>,
> {
  /** Called when a lookup starts. */
  onStart?: () => void
  /**
   * Called when an active run is found
   */
  onRunFound: (run: JobRun<TOutput, TLabels>) => void | Promise<void>
  /**
   * Called when auto-resume lookup settles (found, not found, or error)
   */
  onSettled?: () => void
  /**
   * Called if auto-resume lookup encounters an error
   */
  onError?: (error: unknown) => void
}

/**
 * Hook that automatically finds and resumes tracking of pending/running/waiting runs.
 * Extracted from useJob to separate the auto-resume concern.
 */
export function useAutoResume<
  TName extends string,
  TInput extends Record<string, unknown>,
  TOutput,
  TLabels extends Record<string, string> = Record<string, string>,
>(
  jobHandle: JobHandle<TName, TInput, TOutput, TLabels> | null,
  options: UseAutoResumeOptions<TLabels>,
  callbacks: UseAutoResumeCallbacks<TOutput, TLabels>,
): void {
  const enabled = options.enabled !== false
  const skipIfInitialRunId = options.skipIfInitialRunId !== false
  const initialRunId = options.initialRunId
  const scopeLabels = options.scope?.labels

  useEffect(() => {
    if (!jobHandle) return
    if (!enabled) return
    if (skipIfInitialRunId && initialRunId) return

    let cancelled = false
    callbacks.onStart?.()

    const findActiveRun = async () => {
      try {
        // First check for leased runs
        const leasedRuns = await jobHandle.getRuns({
          status: 'leased',
          labels: scopeLabels,
          limit: 1,
        })
        if (cancelled) return

        if (leasedRuns.length > 0) {
          const run = leasedRuns[0]
          await callbacks.onRunFound(run)
          return
        }

        // Then check for pending runs
        const pendingRuns = await jobHandle.getRuns({
          status: 'pending',
          labels: scopeLabels,
          limit: 1,
        })
        if (cancelled) return

        if (pendingRuns.length > 0) {
          const run = pendingRuns[0]
          await callbacks.onRunFound(run)
          return
        }
        // Then check for waiting runs
        const waitingRuns = await jobHandle.getRuns({
          status: 'waiting',
          labels: scopeLabels,
          limit: 1,
        })
        if (cancelled) return

        if (waitingRuns.length > 0) {
          const run = waitingRuns[0]
          await callbacks.onRunFound(run)
          return
        }
      } catch (err) {
        callbacks.onError?.(err)
      } finally {
        if (!cancelled) {
          callbacks.onSettled?.()
        }
      }
    }

    findActiveRun()

    return () => {
      cancelled = true
    }
  }, [
    jobHandle,
    enabled,
    skipIfInitialRunId,
    initialRunId,
    scopeLabels,
    callbacks,
  ])
}
