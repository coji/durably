/**
 * Data Sync Progress Component
 *
 * Displays progress for the data sync job using useJobRun.
 */

import { useJobRun } from '@coji/durably-react/client'
import { useActionData } from 'react-router'
import type { action } from '../_index'
import { RunProgress } from './run-progress'

export function DataSyncProgress() {
  const actionData = useActionData<typeof action>()
  const runId = actionData?.intent === 'sync' ? actionData.runId : null

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
  } = useJobRun({
    api: '/api/durably',
    runId,
  })

  return (
    <RunProgress
      progress={progress}
      output={output}
      error={error ?? null}
      logs={logs}
      isPending={isPending}
      isRunning={isRunning}
      isCompleted={isCompleted}
      isFailed={isFailed}
      isCancelled={isCancelled}
    />
  )
}
