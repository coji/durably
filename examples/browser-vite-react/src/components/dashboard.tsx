/**
 * Dashboard Component
 *
 * Displays run history with real-time updates and pagination.
 * Uses browser-only mode hooks for direct durably access.
 *
 * Demonstrates typed useRuns with generic type parameter for multi-job dashboards.
 */

import { type TypedRun, useDurably, useRuns } from '@coji/durably-react'
import { useState } from 'react'
import type {
  DataSyncInput,
  DataSyncOutput,
  ProcessImageInput,
  ProcessImageOutput,
} from '../jobs'

/** Union type for all job runs in this dashboard */
type DashboardRun =
  | TypedRun<DataSyncInput, DataSyncOutput>
  | TypedRun<ProcessImageInput, ProcessImageOutput>

function LabelChips({ labels }: { labels: Record<string, string> }) {
  const entries = Object.entries(labels)
  if (entries.length === 0) return <span className="text-gray-400">-</span>
  return (
    <div className="flex flex-wrap gap-1">
      {entries.map(([k, v]) => (
        <span
          key={k}
          className="inline-block rounded bg-purple-100 px-1.5 py-0.5 text-xs text-purple-700"
        >
          {k}={v}
        </span>
      ))}
    </div>
  )
}

export function Dashboard() {
  const { durably } = useDurably()
  const { runs, page, hasMore, isLoading, refresh, nextPage, prevPage } =
    useRuns<DashboardRun>({
      pageSize: 6,
    })

  const [selectedRun, setSelectedRun] = useState<DashboardRun | null>(null)
  const [steps, setSteps] = useState<
    { index: number; name: string; status: string }[]
  >([])

  const showDetails = async (runId: string) => {
    if (!durably) return
    const run = await durably.getRun<DashboardRun>(runId)
    if (run) {
      setSelectedRun(run)
      const stepsData = await durably.storage.getSteps(runId)
      setSteps(
        stepsData.map((s, i) => ({ index: i, name: s.name, status: s.status })),
      )
    }
  }

  const handleRetry = async (runId: string) => {
    if (!durably) return
    await durably.retry(runId)
    refresh()
  }

  const handleCancel = async (runId: string) => {
    if (!durably) return
    await durably.cancel(runId)
    refresh()
  }

  const handleDelete = async (runId: string) => {
    if (!durably) return
    await durably.deleteRun(runId)
    setSelectedRun(null)
    refresh()
  }

  const formatDate = (iso: string) => new Date(iso).toLocaleString()

  const statusClasses: Record<string, string> = {
    pending: 'bg-yellow-100 text-yellow-800',
    running: 'bg-blue-100 text-blue-800',
    completed: 'bg-green-100 text-green-800',
    failed: 'bg-red-100 text-red-800',
    cancelled: 'bg-gray-100 text-gray-800',
  }

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900">Run History</h2>
        <div className="flex items-center gap-2">
          {isLoading && (
            <span className="text-xs text-gray-400">Refreshing...</span>
          )}
          <button
            type="button"
            onClick={refresh}
            className="text-sm text-blue-600 hover:text-blue-800"
          >
            ↻ Refresh
          </button>
        </div>
      </div>

      {runs.length === 0 ? (
        <p className="py-8 text-center text-sm text-gray-500">No runs yet</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200">
                  <th className="px-2 py-2 text-left font-medium text-gray-600">
                    ID
                  </th>
                  <th className="px-2 py-2 text-left font-medium text-gray-600">
                    Job
                  </th>
                  <th className="px-2 py-2 text-left font-medium text-gray-600">
                    Status
                  </th>
                  <th className="px-2 py-2 text-left font-medium text-gray-600">
                    Labels
                  </th>
                  <th className="px-2 py-2 text-left font-medium text-gray-600">
                    Steps
                  </th>
                  <th className="px-2 py-2 text-left font-medium text-gray-600">
                    Progress
                  </th>
                  <th className="px-2 py-2 text-left font-medium text-gray-600">
                    Created
                  </th>
                  <th className="px-2 py-2 text-left font-medium text-gray-600">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id} className="border-b border-gray-100">
                    <td className="px-2 py-2 font-mono text-xs text-gray-600">
                      {run.id.slice(0, 8)}...
                    </td>
                    <td className="px-2 py-2">{run.jobName}</td>
                    <td className="px-2 py-2">
                      <span
                        className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${statusClasses[run.status] || 'bg-gray-100 text-gray-800'}`}
                      >
                        {run.status}
                      </span>
                    </td>
                    <td className="px-2 py-2">
                      <LabelChips labels={run.labels} />
                    </td>
                    <td className="px-2 py-2">
                      {run.stepCount > 0 ? (
                        <span className="text-xs text-gray-600">
                          {run.stepCount}
                        </span>
                      ) : (
                        <span className="text-gray-400">-</span>
                      )}
                    </td>
                    <td className="px-2 py-2">
                      {run.progress ? (
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 w-16 rounded bg-gray-200">
                            <div
                              className="h-1.5 rounded bg-blue-600"
                              style={{
                                width: `${run.progress.total ? (run.progress.current / run.progress.total) * 100 : run.progress.current > 0 ? 100 : 0}%`,
                              }}
                            />
                          </div>
                          <span className="text-xs text-gray-500">
                            {run.progress.current}
                            {run.progress.total && `/${run.progress.total}`}
                          </span>
                        </div>
                      ) : (
                        <span className="text-gray-400">-</span>
                      )}
                    </td>
                    <td className="px-2 py-2 text-gray-600">
                      {formatDate(run.createdAt)}
                    </td>
                    <td className="px-2 py-2">
                      <div className="flex gap-1">
                        <button
                          type="button"
                          onClick={() => showDetails(run.id)}
                          className="text-xs text-blue-600 hover:text-blue-800"
                        >
                          View
                        </button>
                        {(run.status === 'failed' ||
                          run.status === 'cancelled') && (
                          <button
                            type="button"
                            onClick={() => handleRetry(run.id)}
                            className="text-xs text-green-600 hover:text-green-800 disabled:cursor-not-allowed disabled:text-gray-400"
                          >
                            Retry
                          </button>
                        )}
                        {(run.status === 'running' ||
                          run.status === 'pending') && (
                          <button
                            type="button"
                            onClick={() => handleCancel(run.id)}
                            className="text-xs text-orange-600 hover:text-orange-800 disabled:cursor-not-allowed disabled:text-gray-400"
                          >
                            Cancel
                          </button>
                        )}
                        {run.status !== 'running' &&
                          run.status !== 'pending' && (
                            <button
                              type="button"
                              onClick={() => handleDelete(run.id)}
                              className="text-xs text-red-600 hover:text-red-800 disabled:cursor-not-allowed disabled:text-gray-400"
                            >
                              Delete
                            </button>
                          )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          <div className="mt-4 flex items-center justify-between border-t border-gray-100 pt-4">
            <button
              type="button"
              onClick={prevPage}
              disabled={page === 0}
              className="text-sm text-blue-600 hover:text-blue-800 disabled:cursor-not-allowed disabled:text-gray-300"
            >
              ← Previous
            </button>
            <span className="text-sm text-gray-500">Page {page + 1}</span>
            <button
              type="button"
              onClick={nextPage}
              disabled={!hasMore}
              className="text-sm text-blue-600 hover:text-blue-800 disabled:cursor-not-allowed disabled:text-gray-300"
            >
              Next →
            </button>
          </div>
        </>
      )}

      {/* Run Details Modal */}
      {selectedRun && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="mx-4 max-h-[80vh] w-full max-w-2xl overflow-y-auto rounded-lg bg-white shadow-xl">
            <div className="p-6">
              <div className="mb-4 flex items-center justify-between">
                <h3 className="text-lg font-semibold">Run Details</h3>
                <button
                  type="button"
                  onClick={() => setSelectedRun(null)}
                  className="text-gray-400 hover:text-gray-600"
                >
                  ✕
                </button>
              </div>

              <div className="space-y-3 text-sm">
                <div>
                  <span className="font-medium text-gray-600">ID:</span>{' '}
                  <span className="font-mono text-gray-800">
                    {selectedRun.id}
                  </span>
                </div>
                <div>
                  <span className="font-medium text-gray-600">Job:</span>{' '}
                  {selectedRun.jobName}
                </div>
                <div>
                  <span className="font-medium text-gray-600">Status:</span>{' '}
                  <span
                    className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${statusClasses[selectedRun.status] || 'bg-gray-100 text-gray-800'}`}
                  >
                    {selectedRun.status}
                  </span>
                </div>
                {Object.keys(selectedRun.labels).length > 0 && (
                  <div>
                    <span className="font-medium text-gray-600">Labels:</span>
                    <div className="mt-1">
                      <LabelChips labels={selectedRun.labels} />
                    </div>
                  </div>
                )}
                <div>
                  <span className="font-medium text-gray-600">Created:</span>{' '}
                  {formatDate(selectedRun.createdAt)}
                </div>

                {selectedRun.progress && (
                  <div>
                    <span className="font-medium text-gray-600">Progress:</span>{' '}
                    {selectedRun.progress.current}
                    {selectedRun.progress.total
                      ? `/${selectedRun.progress.total}`
                      : ''}{' '}
                    {selectedRun.progress.message || ''}
                  </div>
                )}

                {selectedRun.error && (
                  <div>
                    <span className="font-medium text-gray-600">Error:</span>{' '}
                    <span className="text-red-600">{selectedRun.error}</span>
                  </div>
                )}

                {selectedRun.output !== null && (
                  <div>
                    <span className="font-medium text-gray-600">Output:</span>
                    <pre className="mt-1 overflow-auto rounded border bg-gray-50 p-3 text-xs">
                      {JSON.stringify(selectedRun.output, null, 2)}
                    </pre>
                  </div>
                )}

                <div>
                  <span className="font-medium text-gray-600">Input:</span>
                  <pre className="mt-1 overflow-auto rounded border bg-gray-50 p-3 text-xs">
                    {JSON.stringify(selectedRun.input, null, 2)}
                  </pre>
                </div>

                {steps.length > 0 && (
                  <div>
                    <span className="font-medium text-gray-600">Steps:</span>
                    <ul className="mt-1 divide-y divide-gray-100 rounded border">
                      {steps.map((s) => (
                        <li
                          key={s.name}
                          className="flex items-center justify-between p-2"
                        >
                          <span className="text-gray-800">{s.name}</span>
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                              s.status === 'completed'
                                ? 'bg-green-100 text-green-800'
                                : s.status === 'cancelled'
                                  ? 'bg-gray-100 text-gray-800'
                                  : 'bg-red-100 text-red-800'
                            }`}
                          >
                            {s.status}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
