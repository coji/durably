/**
 * Report Generation Progress Component
 *
 * Displays progress for the long-running report generation job.
 */

import { useActionData } from 'react-router'
import { durably } from '~/lib/durably'
import type { action } from '../_index'
import { RunProgress } from './run-progress'

export function ReportProgress() {
  const actionData = useActionData<typeof action>()
  const runId = actionData?.intent === 'report' ? actionData.runId : null

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
  } = durably.generateReport.useRun(runId)

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
