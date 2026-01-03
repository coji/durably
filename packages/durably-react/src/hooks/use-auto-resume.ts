import type { JobHandle } from '@coji/durably'
import { useEffect } from 'react'
import type { RunStatus } from '../types'

export interface UseAutoResumeOptions {
  /**
   * Whether to automatically resume tracking pending/running runs
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
}

export interface UseAutoResumeCallbacks {
  /**
   * Called when a run is found to resume
   */
  onRunFound: (runId: string, status: RunStatus) => void
}

/**
 * Hook that automatically finds and resumes tracking of pending/running runs.
 * Extracted from useJob to separate the auto-resume concern.
 */
export function useAutoResume<
  TName extends string,
  TInput extends Record<string, unknown>,
  TOutput,
>(
  jobHandle: JobHandle<TName, TInput, TOutput> | null,
  options: UseAutoResumeOptions,
  callbacks: UseAutoResumeCallbacks,
): void {
  const enabled = options.enabled !== false
  const skipIfInitialRunId = options.skipIfInitialRunId !== false
  const initialRunId = options.initialRunId

  useEffect(() => {
    if (!jobHandle) return
    if (!enabled) return
    if (skipIfInitialRunId && initialRunId) return

    let cancelled = false

    const findActiveRun = async () => {
      // First check for running runs
      const runningRuns = await jobHandle.getRuns({ status: 'running' })
      if (cancelled) return

      if (runningRuns.length > 0) {
        const run = runningRuns[0]
        callbacks.onRunFound(run.id, run.status as RunStatus)
        return
      }

      // Then check for pending runs
      const pendingRuns = await jobHandle.getRuns({ status: 'pending' })
      if (cancelled) return

      if (pendingRuns.length > 0) {
        const run = pendingRuns[0]
        callbacks.onRunFound(run.id, run.status as RunStatus)
      }
    }

    findActiveRun()

    return () => {
      cancelled = true
    }
  }, [jobHandle, enabled, skipIfInitialRunId, initialRunId, callbacks])
}
