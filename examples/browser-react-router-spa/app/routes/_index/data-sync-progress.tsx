/**
 * Data Sync Progress Component
 *
 * Displays progress for the data sync job using initialRunId.
 */

import { useJob } from '@coji/durably-react'
import { useActionData } from 'react-router'
import { dataSyncJob } from '~/lib/jobs'
import type { clientAction } from '../_index'
import { RunProgress } from './run-progress'

export function DataSyncProgress() {
  const actionData = useActionData<typeof clientAction>()
  const runId = actionData?.intent === 'sync' ? actionData.runId : undefined

  const {
    progress,
    output,
    error,
    logs,
    isPending,
    isRunning,
    isCompleted,
    isFailed,
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
    />
  )
}
