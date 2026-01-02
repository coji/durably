/**
 * Image Processing Progress Component
 *
 * Displays progress for the image processing job using initialRunId.
 */

import { useJob } from '@coji/durably-react'
import { useActionData } from 'react-router'
import { processImageJob } from '~/lib/jobs'
import type { clientAction } from '../_index'
import { RunProgress } from './run-progress'

export function ImageProcessingProgress() {
  const actionData = useActionData<typeof clientAction>()
  const runId = actionData?.intent === 'image' ? actionData.runId : undefined

  const {
    progress,
    output,
    error,
    logs,
    isPending,
    isRunning,
    isCompleted,
    isFailed,
  } = useJob(processImageJob, { initialRunId: runId })

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
