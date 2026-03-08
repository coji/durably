/**
 * RunProgress Component
 *
 * Displays real-time progress and result for jobs.
 */

import type { LogEntry } from '@coji/durably-react'

interface RunProgressProps {
  progress: { current: number; total?: number; message?: string } | null
  output: unknown
  error: string | null
  logs: LogEntry[]
  isPending: boolean
  isLeased: boolean
  isCompleted: boolean
  isFailed: boolean
  isCancelled: boolean
}

export function RunProgress({
  progress,
  output,
  error,
  logs,
  isPending,
  isLeased,
  isCompleted,
  isFailed,
  isCancelled,
}: RunProgressProps) {
  // Don't render anything if no activity
  if (!isPending && !isLeased && !isCompleted && !isFailed && !isCancelled) {
    return null
  }

  return (
    <>
      {/* Pending State */}
      {isPending && (
        <section className="rounded-lg border border-yellow-200 bg-yellow-50 p-4">
          <div className="text-yellow-800">Waiting to start...</div>
        </section>
      )}

      {/* Progress Display */}
      {isLeased && progress && (
        <section className="rounded-lg border border-blue-200 bg-blue-50 p-4">
          <div className="mb-2 flex justify-between text-sm text-blue-800">
            <span>Progress</span>
            <span>
              {progress.current}/{progress.total || '?'}
            </span>
          </div>
          <div className="h-2 w-full rounded-full bg-blue-200">
            <div
              className="h-2 rounded-full bg-blue-600 transition-all duration-200"
              style={{
                width: `${(progress.current / (progress.total || 1)) * 100}%`,
              }}
            />
          </div>
          {progress.message && (
            <div className="mt-2 text-xs text-blue-600">{progress.message}</div>
          )}
        </section>
      )}

      {/* Success Result */}
      {isCompleted && output !== null && output !== undefined && (
        <section className="rounded-lg border border-green-200 bg-green-50 p-4">
          <div className="mb-2 font-medium text-green-800">Completed!</div>
          <pre className="overflow-auto text-sm text-green-700">
            {JSON.stringify(output, null, 2)}
          </pre>
        </section>
      )}

      {/* Error Result */}
      {isFailed && (
        <section className="rounded-lg border border-red-200 bg-red-50 p-4">
          <div className="font-medium text-red-800">Failed</div>
          <div className="mt-1 text-sm text-red-700">{error}</div>
        </section>
      )}

      {/* Cancelled Result */}
      {isCancelled && (
        <section className="rounded-lg border border-gray-200 bg-gray-50 p-4">
          <div className="font-medium text-gray-800">Cancelled</div>
          <div className="mt-1 text-sm text-gray-600">
            The job was cancelled before completion.
          </div>
        </section>
      )}

      {/* Logs */}
      {logs.length > 0 && (
        <section className="rounded-lg bg-white p-4 shadow">
          <h3 className="mb-2 text-sm font-medium text-gray-700">Logs</h3>
          <div className="max-h-32 overflow-auto rounded-md border border-gray-200 bg-gray-50 p-3">
            <ul className="space-y-1">
              {logs.map((log) => (
                <li key={log.id} className="font-mono text-xs">
                  <span
                    className={
                      log.level === 'error'
                        ? 'text-red-600'
                        : log.level === 'warn'
                          ? 'text-yellow-600'
                          : 'text-gray-600'
                    }
                  >
                    [{log.level}]
                  </span>{' '}
                  <span className="text-gray-800">{log.message}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}
    </>
  )
}
