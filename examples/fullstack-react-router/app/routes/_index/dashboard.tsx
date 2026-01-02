/**
 * Dashboard Component
 *
 * Displays run history with real-time updates via SSE and pagination.
 * First page auto-subscribes to SSE for instant updates.
 */

import { useRunActions, useRuns } from '@coji/durably-react/client'

export function Dashboard() {
  const { runs, isLoading, error, page, hasMore, nextPage, prevPage, refresh } =
    useRuns({
      api: '/api/durably',
      jobName: 'import-csv',
      pageSize: 6,
    })

  const {
    cancel,
    retry,
    isLoading: isActioning,
  } = useRunActions({
    api: '/api/durably',
  })

  const handleCancel = async (runId: string) => {
    await cancel(runId)
    refresh()
  }

  const handleRetry = async (runId: string) => {
    await retry(runId)
    refresh()
  }

  return (
    <section className="bg-white rounded-lg shadow p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">Dashboard</h2>
        {isLoading && (
          <span className="text-xs text-gray-400">Refreshing...</span>
        )}
      </div>

      {error && <div className="text-red-600 text-sm mb-4">Error: {error}</div>}

      {runs.length === 0 ? (
        <p className="text-gray-500 text-sm">No runs yet</p>
      ) : (
        <>
          <ul className="divide-y divide-gray-100">
            {runs.map((r) => (
              <li key={r.id} className="py-3 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div>
                    <span className="font-mono text-sm text-gray-600">
                      {r.id.slice(0, 8)}
                    </span>
                    <span className="text-gray-400 mx-2">-</span>
                    <span className="text-sm text-gray-500">
                      {new Date(r.createdAt).toLocaleString()}
                    </span>
                  </div>
                  {r.progress && (
                    <div className="flex items-center gap-2">
                      <div className="w-20 bg-gray-200 rounded h-1.5">
                        <div
                          className="bg-blue-600 h-1.5 rounded"
                          style={{
                            width: `${(r.progress.current / (r.progress.total || r.progress.current)) * 100}%`,
                          }}
                        />
                      </div>
                      <span className="text-xs text-gray-500">
                        {r.progress.current}
                        {r.progress.total && `/${r.progress.total}`}
                      </span>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {(r.status === 'pending' || r.status === 'running') && (
                    <button
                      type="button"
                      onClick={() => handleCancel(r.id)}
                      disabled={isActioning}
                      className="text-xs text-red-600 hover:text-red-800 disabled:text-gray-400 disabled:cursor-not-allowed"
                    >
                      Cancel
                    </button>
                  )}
                  {(r.status === 'failed' || r.status === 'cancelled') && (
                    <button
                      type="button"
                      onClick={() => handleRetry(r.id)}
                      disabled={isActioning}
                      className="text-xs text-blue-600 hover:text-blue-800 disabled:text-gray-400 disabled:cursor-not-allowed"
                    >
                      Retry
                    </button>
                  )}
                  <span
                    className={`text-sm font-medium px-2 py-1 rounded ${
                      r.status === 'completed'
                        ? 'bg-green-100 text-green-800'
                        : r.status === 'failed'
                          ? 'bg-red-100 text-red-800'
                          : r.status === 'running'
                            ? 'bg-blue-100 text-blue-800'
                            : 'bg-gray-100 text-gray-800'
                    }`}
                  >
                    {r.status}
                  </span>
                </div>
              </li>
            ))}
          </ul>

          {/* Pagination */}
          <div className="flex items-center justify-between mt-4 pt-4 border-t border-gray-100">
            <button
              type="button"
              onClick={prevPage}
              disabled={page === 0}
              className="text-sm text-blue-600 hover:text-blue-800 disabled:text-gray-300 disabled:cursor-not-allowed"
            >
              ← Previous
            </button>
            <span className="text-sm text-gray-500">Page {page + 1}</span>
            <button
              type="button"
              onClick={nextPage}
              disabled={!hasMore}
              className="text-sm text-blue-600 hover:text-blue-800 disabled:text-gray-300 disabled:cursor-not-allowed"
            >
              Next →
            </button>
          </div>
        </>
      )}
    </section>
  )
}
