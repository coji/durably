/**
 * Image Processing Progress Component
 *
 * Displays progress for the image processing job.
 */

import { useJob } from '@coji/durably-react/spa'
import { processImageJob } from '../jobs'
import { RunProgress } from './run-progress'

interface ImageProcessingProgressProps {
  runId?: string
}

export function ImageProcessingProgress({
  runId,
}: ImageProcessingProgressProps) {
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
  } = useJob(processImageJob, { initialRunId: runId })

  return (
    <RunProgress
      progress={progress}
      output={output}
      error={error}
      logs={logs}
      isPending={isPending}
      isLeased={isLeased}
      isCompleted={isCompleted}
      isFailed={isFailed}
      isCancelled={isCancelled}
    />
  )
}
