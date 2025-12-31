/**
 * Browser-Only SPA Example
 *
 * This example demonstrates:
 * - React Router v7 in SPA mode (ssr: false)
 * - SQLite WASM with OPFS for browser-only persistence
 * - DurablyProvider for context and lifecycle management
 * - useJob hook for triggering and monitoring jobs
 */

import { useDurably, useJob, type LogEntry } from '@coji/durably-react'
import { useState } from 'react'
import { Link } from 'react-router'
import { SQLocalKysely } from 'sqlocal/kysely'
import { dataSyncJob, processImageJob } from '~/lib/jobs'
import { Dashboard } from './_index/dashboard'

// Same database as root.tsx - for reset functionality
const sqlocal = new SQLocalKysely('example.sqlite3')

export default function Index() {
  const [activeTab, setActiveTab] = useState<'image' | 'sync'>('image')
  const { durably } = useDurably()

  const handleReset = async () => {
    if (durably) {
      await durably.stop()
    }
    await sqlocal.deleteDatabaseFile()
    location.reload()
  }

  return (
    <div className="min-h-screen p-6">
      <div className="max-w-4xl mx-auto">
        <header className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900 mb-2">
            Durably - Browser-Only SPA
          </h1>
          <p className="text-gray-600 mb-4">
            React Router v7 SPA mode with SQLite WASM + OPFS
          </p>
          <div className="flex gap-4 text-sm">
            <Link
              to="https://github.com/coji/durably"
              className="text-blue-600 hover:underline"
            >
              GitHub
            </Link>
            <span className="text-gray-300">|</span>
            <Link
              to="https://github.com/coji/durably/tree/main/examples/browser-react-router-spa"
              className="text-blue-600 hover:underline"
            >
              Source Code
            </Link>
          </div>
        </header>

        <div className="bg-white rounded-lg shadow-sm border border-gray-200 p-6 mb-6">
          <div className="flex gap-2 mb-6">
            <button
              type="button"
              onClick={() => setActiveTab('image')}
              className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                activeTab === 'image'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              Image Processing
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('sync')}
              className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                activeTab === 'sync'
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              Data Sync
            </button>
            <div className="flex-1" />
            <button
              type="button"
              onClick={() => location.reload()}
              className="px-4 py-2 rounded-md text-sm font-medium bg-gray-100 text-gray-700 hover:bg-gray-200"
            >
              Reload Page
            </button>
            <button
              type="button"
              onClick={handleReset}
              className="px-4 py-2 rounded-md text-sm font-medium bg-red-100 text-red-700 hover:bg-red-200"
            >
              Reset Database
            </button>
          </div>

          {activeTab === 'image' ? <ImageProcessingPanel /> : <DataSyncPanel />}
        </div>

        <Dashboard />

        <footer className="mt-8 text-center text-sm text-gray-500">
          <p>
            All data is stored locally in your browser using SQLite WASM with
            OPFS.
          </p>
          <p className="mt-1">
            Try reloading the page during job execution - it will resume
            automatically!
          </p>
        </footer>
      </div>
    </div>
  )
}

function ImageProcessingPanel() {
  const {
    trigger,
    output,
    error,
    progress,
    logs,
    isReady,
    isPending,
    isRunning,
    isCompleted,
    isFailed,
  } = useJob(processImageJob)

  const handleRun = async () => {
    await trigger({ filename: 'photo.jpg', width: 800 })
  }

  return (
    <JobPanel
      title="Process Image"
      description="Simulates downloading, resizing, and uploading an image."
      onRun={handleRun}
      isReady={isReady}
      isPending={isPending}
      isRunning={isRunning}
      isCompleted={isCompleted}
      isFailed={isFailed}
      progress={progress}
      output={output}
      error={error}
      logs={logs}
    />
  )
}

function DataSyncPanel() {
  const {
    trigger,
    output,
    error,
    progress,
    logs,
    isReady,
    isPending,
    isRunning,
    isCompleted,
    isFailed,
  } = useJob(dataSyncJob)

  const handleRun = async () => {
    await trigger({ userId: 'user_123' })
  }

  return (
    <JobPanel
      title="Data Sync"
      description="Simulates syncing local data with a remote server."
      onRun={handleRun}
      isReady={isReady}
      isPending={isPending}
      isRunning={isRunning}
      isCompleted={isCompleted}
      isFailed={isFailed}
      progress={progress}
      output={output}
      error={error}
      logs={logs}
    />
  )
}

interface JobPanelProps {
  title: string
  description: string
  onRun: () => void
  isReady: boolean
  isPending: boolean
  isRunning: boolean
  isCompleted: boolean
  isFailed: boolean
  progress: { current: number; total?: number; message?: string } | null
  output: unknown
  error: string | null
  logs: LogEntry[]
}

function JobPanel({
  title,
  description,
  onRun,
  isReady,
  isPending,
  isRunning,
  isCompleted,
  isFailed,
  progress,
  output,
  error,
  logs,
}: JobPanelProps) {
  const statusText = isRunning
    ? 'Running...'
    : isCompleted
      ? '✓ Completed'
      : isFailed
        ? '✗ Failed'
        : isPending
          ? 'Pending...'
          : isReady
            ? 'Ready'
            : 'Initializing...'

  const statusColor = isCompleted
    ? 'text-green-600'
    : isFailed
      ? 'text-red-600'
      : isRunning
        ? 'text-blue-600'
        : 'text-gray-600'

  return (
    <div>
      <div className="flex items-start justify-between mb-4">
        <div>
          <h2 className="text-xl font-semibold text-gray-900">{title}</h2>
          <p className="text-sm text-gray-600">{description}</p>
        </div>
        <button
          type="button"
          onClick={onRun}
          disabled={!isReady || isRunning}
          className="px-6 py-2 bg-blue-600 text-white rounded-md font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          Run Job
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <div className="mb-4">
            <span className="text-sm text-gray-500">Status: </span>
            <span className={`font-medium ${statusColor}`}>{statusText}</span>
          </div>

          {progress && (
            <div className="mb-4">
              <div className="flex justify-between text-sm mb-1">
                <span className="text-gray-600">{progress.message}</span>
                <span className="text-gray-500">
                  {progress.current}
                  {progress.total ? `/${progress.total}` : ''}
                </span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div
                  className="bg-blue-600 h-2 rounded-full transition-all"
                  style={{
                    width: `${progress.total ? (progress.current / progress.total) * 100 : 0}%`,
                  }}
                />
              </div>
            </div>
          )}

          {output !== null && output !== undefined && (
            <div className="bg-green-50 border border-green-200 rounded-md p-4">
              <h3 className="text-sm font-medium text-green-800 mb-2">
                Output
              </h3>
              <pre className="text-sm text-green-700 overflow-auto">
                {JSON.stringify(output, null, 2)}
              </pre>
            </div>
          )}

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-md p-4">
              <h3 className="text-sm font-medium text-red-800 mb-2">Error</h3>
              <pre className="text-sm text-red-700">{error}</pre>
            </div>
          )}
        </div>

        <div>
          {logs.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-gray-700 mb-2">Logs</h3>
              <div className="bg-gray-50 border border-gray-200 rounded-md p-3 max-h-48 overflow-auto">
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
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
