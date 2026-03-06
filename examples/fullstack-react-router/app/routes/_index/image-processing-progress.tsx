/**
 * Image Processing Progress Component
 *
 * Displays progress for the image processing job using the typed Durably client.
 */

import { useActionData } from 'react-router'
import { durably } from '~/lib/durably.hooks'
import type { action } from '../_index'
import { RunProgress } from './run-progress'

export function ImageProcessingProgress() {
  const actionData = useActionData<typeof action>()
  const runId = actionData?.intent === 'image' ? actionData.runId : null

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
  } = durably.processImage.useRun(runId)

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
