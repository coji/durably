/**
 * RunProgress Component
 *
 * Displays real-time progress and result for jobs.
 */

import type { LogEntry } from '@coji/durably-react/client'

interface RunProgressProps {
  progress: { current: number; total?: number; message?: string } | null
  output: unknown
  error: string | null
  logs: LogEntry[]
  isPending: boolean
  isRunning: boolean
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
  isRunning,
  isCompleted,
  isFailed,
  isCancelled,
}: RunProgressProps) {
  // Don't render anything if no activity
  if (!isPending && !isRunning && !isCompleted && !isFailed && !isCancelled) {
    return null
  }

  return (
    <>
      {/* Pending State */}
      {isPending && (
        <section className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
          <div className="text-yellow-800">Waiting to start...</div>
        </section>
      )}

      {/* Progress Display */}
      {isRunning && progress && (
        <section className="bg-blue-50 border border-blue-200 rounded-lg p-4">
          <div className="flex justify-between text-sm text-blue-800 mb-2">
            <span>Progress</span>
            <span>
              {progress.current}/{progress.total || '?'}
            </span>
          </div>
          <div className="w-full bg-blue-200 rounded-full h-2">
            <div
              className="bg-blue-600 h-2 rounded-full transition-all duration-200"
              style={{
                width: `${(progress.current / (progress.total || 1)) * 100}%`,
              }}
            />
          </div>
          {progress.message && (
            <div className="text-xs text-blue-600 mt-2">{progress.message}</div>
          )}
        </section>
      )}

      {/* Success Result */}
      {isCompleted && output !== null && output !== undefined && (
        <section className="bg-green-50 border border-green-200 rounded-lg p-4">
          <div className="text-green-800 font-medium mb-2">Completed!</div>
          <pre className="text-green-700 text-sm overflow-auto">
            {JSON.stringify(output, null, 2)}
          </pre>
        </section>
      )}

      {/* Error Result */}
      {isFailed && (
        <section className="bg-red-50 border border-red-200 rounded-lg p-4">
          <div className="text-red-800 font-medium">Failed</div>
          <div className="text-red-700 text-sm mt-1">{error}</div>
        </section>
      )}

      {/* Cancelled Result */}
      {isCancelled && (
        <section className="bg-gray-50 border border-gray-200 rounded-lg p-4">
          <div className="text-gray-800 font-medium">Cancelled</div>
          <div className="text-gray-600 text-sm mt-1">
            The job was cancelled before completion.
          </div>
        </section>
      )}

      {/* Logs */}
      {logs.length > 0 && (
        <section className="bg-white rounded-lg shadow p-4">
          <h3 className="text-sm font-medium text-gray-700 mb-2">Logs</h3>
          <div className="bg-gray-50 border border-gray-200 rounded-md p-3 max-h-32 overflow-auto">
            <ul className="space-y-1">
              {logs.map((log) => (
                <li key={log.id} className="text-xs font-mono">
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
