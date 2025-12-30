/**
 * RunProgress Component
 *
 * Displays real-time progress and result via SSE subscription.
 */

import { useJobRun } from '@coji/durably-react/client'
import type { ImportCsvOutput } from '~/jobs'

interface RunProgressProps {
  runId: string | null
}

export function RunProgress({ runId }: RunProgressProps) {
  const run = useJobRun<ImportCsvOutput>({
    api: '/api/durably',
    runId,
  })

  // Don't render anything if no run
  if (!runId) return null

  return (
    <>
      {/* Pending State */}
      {run.isPending && (
        <section className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
          <div className="text-yellow-800">Waiting to start...</div>
        </section>
      )}

      {/* Progress Display */}
      {run.isRunning && run.progress && (
        <section className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="flex justify-between text-sm text-blue-800 mb-2">
            <span>Progress</span>
            <span>
              {run.progress.current}/{run.progress.total}
            </span>
          </div>
          <div className="w-full bg-blue-200 rounded-full h-2">
            <div
              className="bg-blue-600 h-2 rounded-full transition-all duration-200"
              style={{
                width: `${
                  (run.progress.current / (run.progress.total || 1)) * 100
                }%`,
              }}
            />
          </div>
          <div className="text-xs text-blue-600 mt-2">
            {run.progress.message}
          </div>
        </section>
      )}

      {/* Success Result */}
      {run.isCompleted && run.output && (
        <section className="bg-green-50 border border-green-200 rounded-lg p-4">
          <div className="text-green-800 font-medium">Import Completed!</div>
          <div className="text-green-700 text-sm mt-1">
            Imported: {run.output.imported} rows, Failed: {run.output.failed}{' '}
            rows
          </div>
        </section>
      )}

      {/* Error Result */}
      {run.isFailed && (
        <section className="bg-red-50 border border-red-200 rounded-lg p-4">
          <div className="text-red-800 font-medium">Import Failed</div>
          <div className="text-red-700 text-sm mt-1">{run.error}</div>
        </section>
      )}
    </>
  )
}
