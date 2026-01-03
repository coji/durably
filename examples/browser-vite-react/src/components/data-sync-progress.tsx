/**
 * Data Sync Progress Component
 *
 * Displays progress for the data sync job.
 */

import { useJob } from '@coji/durably-react'
import { dataSyncJob } from '../jobs'
import { RunProgress } from './run-progress'

interface DataSyncProgressProps {
  runId?: string
}

export function DataSyncProgress({ runId }: DataSyncProgressProps) {
  const {
    progress,
    output,
    error,
    logs,
    isPending,
    isRunning,
    isCompleted,
    isFailed,
    isCancelled,
  } = useJob(dataSyncJob, { initialRunId: runId })

  return (
    <RunProgress
      progress={progress}
      output={output}
      error={error}
      logs={logs}
      isPending={isPending}
      isRunning={isRunning}
      isCompleted={isCompleted}
      isFailed={isFailed}
      isCancelled={isCancelled}
    />
  )
}
