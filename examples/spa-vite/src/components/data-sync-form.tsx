/**
 * Data Sync Form Component
 *
 * Form for triggering data sync jobs.
 */

import { useState } from 'react'

interface DataSyncFormProps {
  onSubmit: (data: { userId: string }) => void
  isSubmitting: boolean
  runId: string | null
}

export function DataSyncForm({
  onSubmit,
  isSubmitting,
  runId,
}: DataSyncFormProps) {
  const [userId, setUserId] = useState('user_123')

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onSubmit({ userId })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label
          htmlFor="userId"
          className="mb-1 block text-sm font-medium text-gray-700"
        >
          User ID
        </label>
        <input
          id="userId"
          value={userId}
          onChange={(e) => setUserId(e.target.value)}
          className="w-full rounded-md border border-gray-300 px-3 py-2 focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
        />
      </div>
      <button
        type="submit"
        disabled={isSubmitting}
        className="rounded-md bg-blue-600 px-4 py-2 font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isSubmitting ? 'Submitting...' : 'Start Sync'}
      </button>
      {runId && (
        <div className="text-sm text-gray-500">
          Triggered: <span className="font-mono">{runId.slice(0, 8)}</span>
        </div>
      )}
    </form>
  )
}
