/**
 * Browser-Only Vite React Example
 *
 * This example demonstrates:
 * - SQLite WASM with OPFS for browser-only persistence
 * - DurablyProvider for context and lifecycle management
 * - useJob hook for job triggering and monitoring
 * - Tailwind CSS for styling
 */

import { DurablyProvider } from '@coji/durably-react'
import { useState } from 'react'
import {
  Dashboard,
  DataSyncForm,
  DataSyncProgress,
  ImageProcessingForm,
  ImageProcessingProgress,
} from './components'
import { sqlocal } from './lib/database'
import { durably } from './lib/durably'

function AppContent() {
  const [activeJob, setActiveJob] = useState<'image' | 'sync'>('image')
  const [imageRunId, setImageRunId] = useState<string | null>(null)
  const [syncRunId, setSyncRunId] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleImageSubmit = async (data: {
    filename: string
    width: number
  }) => {
    setIsSubmitting(true)
    try {
      const run = await durably.jobs.processImage.trigger(data)
      setImageRunId(run.id)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleSyncSubmit = async (data: { userId: string }) => {
    setIsSubmitting(true)
    try {
      const run = await durably.jobs.dataSync.trigger(data)
      setSyncRunId(run.id)
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleReset = async () => {
    await durably.stop()
    await sqlocal.deleteDatabaseFile()
    location.reload()
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto p-6">
        <header className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900">
            Durably - Browser-Only Vite React
          </h1>
          <p className="text-gray-600 mt-2">
            Pure React with Vite and Tailwind CSS
          </p>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Left: Job Trigger + Progress */}
          <div className="space-y-4">
            {/* Job Selection */}
            <section className="bg-white rounded-lg shadow p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold">Run Job</h2>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => location.reload()}
                    className="text-sm text-gray-600 hover:text-gray-800"
                  >
                    Reload
                  </button>
                  <button
                    type="button"
                    onClick={handleReset}
                    className="text-sm text-red-600 hover:text-red-800"
                  >
                    Reset DB
                  </button>
                </div>
              </div>

              <div className="flex border-b border-gray-200 mb-4">
                <button
                  type="button"
                  onClick={() => setActiveJob('image')}
                  className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                    activeJob === 'image'
                      ? 'border-blue-600 text-blue-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  Image Processing
                </button>
                <button
                  type="button"
                  onClick={() => setActiveJob('sync')}
                  className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                    activeJob === 'sync'
                      ? 'border-blue-600 text-blue-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }`}
                >
                  Data Sync
                </button>
              </div>

              {activeJob === 'image' ? (
                <ImageProcessingForm
                  onSubmit={handleImageSubmit}
                  isSubmitting={isSubmitting}
                  runId={imageRunId}
                />
              ) : (
                <DataSyncForm
                  onSubmit={handleSyncSubmit}
                  isSubmitting={isSubmitting}
                  runId={syncRunId}
                />
              )}
            </section>

            {/* Progress Display */}
            {activeJob === 'image' ? (
              <ImageProcessingProgress runId={imageRunId ?? undefined} />
            ) : (
              <DataSyncProgress runId={syncRunId ?? undefined} />
            )}
          </div>

          {/* Right: Dashboard */}
          <Dashboard />
        </div>

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

function Loading() {
  return (
    <div className="flex justify-center items-center min-h-screen text-gray-600">
      Loading...
    </div>
  )
}

export function App() {
  return (
    <DurablyProvider durably={durably} fallback={<Loading />}>
      <AppContent />
    </DurablyProvider>
  )
}
