/**
 * Data Sync Progress Component
 *
 * Displays progress for the data sync job using the typed Durably client.
 */

import { useActionData } from 'react-router'
import { durably } from '~/lib/durably'
import type { action } from '../_index'
import { RunProgress } from './run-progress'

export function DataSyncProgress() {
  const actionData = useActionData<typeof action>()
  const runId = actionData?.intent === 'sync' ? actionData.runId : null
  const userId = actionData?.intent === 'sync' ? actionData.userId : null

  const {
    progress,
    output,
    error,
    logs,
    isPending,
    isLeased,
    isCompleted,
    isFailed,
    isCancelled,
  } = durably.dataSync.useJob({
    initialRunId: runId ?? undefined,
    scope: userId ? { labels: { userId } } : undefined,
  })

  return (
    <RunProgress
      progress={progress}
      output={output}
      error={error ?? null}
      logs={logs}
      isPending={isPending}
      isLeased={isLeased}
      isCompleted={isCompleted}
      isFailed={isFailed}
      isCancelled={isCancelled}
    />
  )
}
