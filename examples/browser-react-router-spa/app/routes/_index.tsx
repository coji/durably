/**
 * Browser-Only SPA Example
 *
 * This example demonstrates:
 * - React Router v7 in SPA mode (ssr: false)
 * - SQLite WASM with OPFS for browser-only persistence
 * - DurablyProvider for context and lifecycle management
 * - clientAction for Form-based job triggering (direct trigger in action)
 * - useJob hook with initialRunId for monitoring jobs
 */

import { useState } from 'react'
import { getDurably, sqlocal, triggerJob } from '~/lib/durably'
import { Dashboard } from './_index/dashboard'
import { DataSyncForm } from './_index/data-sync-form'
import { DataSyncProgress } from './_index/data-sync-progress'
import { ImageProcessingForm } from './_index/image-processing-form'
import { ImageProcessingProgress } from './_index/image-processing-progress'

export function meta() {
  return [
    { title: 'Durably - Browser-Only SPA' },
    { name: 'description', content: 'Browser-only job processing with OPFS' },
  ]
}

// clientAction: Trigger jobs directly in SPA mode
export async function clientAction({ request }: { request: Request }) {
  const formData = await request.formData()
  const intent = formData.get('intent') as string

  if (intent === 'image') {
    const filename = formData.get('filename') as string
    const width = Number(formData.get('width'))
    const run = await triggerJob('processImage', { filename, width })
    return { intent: 'image', runId: run.id }
  }

  if (intent === 'sync') {
    const userId = formData.get('userId') as string
    const run = await triggerJob('dataSync', { userId })
    return { intent: 'sync', runId: run.id }
  }

  return null
}

export default function Index() {
  const [activeJob, setActiveJob] = useState<'image' | 'sync'>('image')

  const handleReset = async () => {
    const durably = await getDurably()
    await durably.stop()
    await sqlocal.deleteDatabaseFile()
    location.reload()
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto p-6">
        <header className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900">
            Durably - Browser-Only SPA
          </h1>
          <p className="text-gray-600 mt-2">
            React Router v7 SPA mode with clientAction + Form
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

              <div className="flex gap-2 mb-4">
                <button
                  type="button"
                  onClick={() => setActiveJob('image')}
                  className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                    activeJob === 'image'
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  Image Processing
                </button>
                <button
                  type="button"
                  onClick={() => setActiveJob('sync')}
                  className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                    activeJob === 'sync'
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  Data Sync
                </button>
              </div>

              {activeJob === 'image' ? (
                <ImageProcessingForm />
              ) : (
                <DataSyncForm />
              )}
            </section>

            {/* Progress Display */}
            {activeJob === 'image' ? (
              <ImageProcessingProgress />
            ) : (
              <DataSyncProgress />
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
