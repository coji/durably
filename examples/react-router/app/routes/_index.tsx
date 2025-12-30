/**
 * Home Page - CSV Import Demo
 *
 * Demonstrates Durably with React Router v7:
 * - action: Trigger job via Form submit
 * - RunProgress: useJobRun for real-time progress via SSE
 * - Dashboard: useRuns with SSE for real-time updates and pagination
 */

import { Form, useActionData, useNavigation } from 'react-router'
import { registeredJobs } from '~/lib/durably.server'
import type { Route } from './+types/_index'
import { Dashboard } from './_index/dashboard'
import { RunProgress } from './_index/run-progress'

export function meta() {
  return [
    { title: 'Durably + React Router Example' },
    { name: 'description', content: 'Full-stack job processing with SSE' },
  ]
}

// Generate dummy CSV data
function generateDummyRows(count: number) {
  const names = [
    'Alice',
    'Bob',
    'Charlie',
    'Diana',
    'Eve',
    'Frank',
    'Grace',
    'Henry',
  ]
  const domains = ['example.com', 'test.org', 'demo.net']

  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    name: names[i % names.length],
    email: `${names[i % names.length].toLowerCase()}${i}@${
      domains[i % domains.length]
    }`,
    amount: Math.floor(Math.random() * 1000) + 10,
  }))
}

// Action: Trigger job from Form submit
export async function action({ request }: Route.ActionArgs) {
  const formData = await request.formData()
  const filename = formData.get('filename') as string
  const rowCount = Number(formData.get('rowCount') ?? 10)

  // Generate dummy CSV rows
  const rows = generateDummyRows(rowCount)

  const run = await registeredJobs.importCsv.trigger({ filename, rows })
  return { runId: run.id }
}

export default function Home() {
  const actionData = useActionData<typeof action>()
  const navigation = useNavigation()
  const isSubmitting = navigation.state === 'submitting'

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-6xl mx-auto p-6">
        <header className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900">
            Durably + React Router
          </h1>
          <p className="text-gray-600 mt-2">
            Full-stack job processing with Form actions and SSE
          </p>
        </header>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Left: Trigger Form + Progress */}
          <div className="space-y-4">
            {/* Trigger Form */}
            <section className="bg-white rounded-lg shadow p-6">
              <h2 className="text-lg font-semibold mb-4">Start CSV Import</h2>
              <Form method="post" className="space-y-4">
                <div>
                  <label
                    htmlFor="filename"
                    className="block text-sm font-medium text-gray-700 mb-1"
                  >
                    Filename
                  </label>
                  <input
                    id="filename"
                    name="filename"
                    defaultValue="data.csv"
                    className="border border-gray-300 rounded-md px-3 py-2 w-full focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <div>
                  <label
                    htmlFor="rowCount"
                    className="block text-sm font-medium text-gray-700 mb-1"
                  >
                    Row Count
                  </label>
                  <input
                    id="rowCount"
                    name="rowCount"
                    type="number"
                    defaultValue={100}
                    min={1}
                    max={1000}
                    className="border border-gray-300 rounded-md px-3 py-2 w-full focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="bg-blue-600 hover:bg-blue-700 text-white font-medium px-4 py-2 rounded-md disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {isSubmitting ? 'Submitting...' : 'Start Import'}
                </button>
                {actionData?.runId && (
                  <div className="text-sm text-gray-500">
                    Triggered:{' '}
                    <span className="font-mono">{actionData.runId}</span>
                  </div>
                )}
              </Form>
            </section>

            {/* Run Progress */}
            <RunProgress runId={actionData?.runId ?? null} />
          </div>

          {/* Right: Dashboard with Real-time SSE Updates */}
          <Dashboard />
        </div>
      </div>
    </div>
  )
}
