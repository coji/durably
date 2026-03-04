/**
 * Full-Stack React Router Example
 *
 * This example demonstrates:
 * - React Router v7 with server-side action
 * - SSE streaming for real-time progress updates
 * - action for Form-based job triggering
 * - useJobRun hook for monitoring jobs via SSE
 */

import { useState } from 'react'
import { durably } from '~/lib/durably.server'
import type { Route } from './+types/_index'
import { Dashboard } from './_index/dashboard'
import { DataSyncForm } from './_index/data-sync-form'
import { DataSyncProgress } from './_index/data-sync-progress'
import { ImageProcessingForm } from './_index/image-processing-form'
import { ImageProcessingProgress } from './_index/image-processing-progress'

export function meta() {
  return [
    { title: 'Durably - Full-Stack React Router' },
    { name: 'description', content: 'Full-stack job processing with SSE' },
  ]
}

// Action: Trigger jobs
export async function action({ request }: Route.ActionArgs) {
  const formData = await request.formData()
  const intent = formData.get('intent') as string

  if (intent === 'image') {
    const filename = formData.get('filename') as string
    const width = Number(formData.get('width'))
    const run = await durably.jobs.processImage.trigger(
      { filename, width },
      { labels: { source: 'server' } },
    )
    return { intent: 'image', runId: run.id }
  }

  if (intent === 'sync') {
    const userId = formData.get('userId') as string
    const run = await durably.jobs.dataSync.trigger({ userId })
    return { intent: 'sync', runId: run.id }
  }

  return null
}

export default function Index() {
  const [activeJob, setActiveJob] = useState<'image' | 'sync'>('image')

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-6xl p-6">
        <header className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900">
            Durably - Full-Stack React Router
          </h1>
          <p className="mt-2 text-gray-600">
            React Router v7 with server action + SSE streaming
          </p>
        </header>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {/* Left: Job Trigger + Progress */}
          <div className="space-y-4">
            {/* Job Selection */}
            <section className="rounded-lg bg-white p-6 shadow">
              <div className="mb-4 flex items-center justify-between">
                <h2 className="text-lg font-semibold">Run Job</h2>
              </div>

              <div className="mb-4 flex border-b border-gray-200">
                <button
                  type="button"
                  onClick={() => setActiveJob('image')}
                  className={`border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
                    activeJob === 'image'
                      ? 'border-blue-600 text-blue-600'
                      : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700'
                  }`}
                >
                  Image Processing
                </button>
                <button
                  type="button"
                  onClick={() => setActiveJob('sync')}
                  className={`border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
                    activeJob === 'sync'
                      ? 'border-blue-600 text-blue-600'
                      : 'border-transparent text-gray-500 hover:border-gray-300 hover:text-gray-700'
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
          <p>Data is stored on the server using SQLite (Turso/libSQL).</p>
          <p className="mt-1">
            Try reloading the page during job execution - progress updates via
            SSE!
          </p>
        </footer>
      </div>
    </div>
  )
}
