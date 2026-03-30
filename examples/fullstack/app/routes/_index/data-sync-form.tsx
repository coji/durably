/**
 * Data Sync Form Component
 *
 * Form for triggering data sync jobs via server action.
 */

import { Form, useActionData, useNavigation } from 'react-router'
import type { action } from '../_index'

export function DataSyncForm() {
  const actionData = useActionData<typeof action>()
  const navigation = useNavigation()
  const isSubmitting = navigation.state === 'submitting'
  const runId = actionData?.intent === 'sync' ? actionData.runId : null

  return (
    <Form method="post" className="space-y-4">
      <input type="hidden" name="intent" value="sync" />
      <div>
        <label
          htmlFor="userId"
          className="mb-1 block text-sm font-medium text-gray-700"
        >
          User ID
        </label>
        <input
          id="userId"
          name="userId"
          defaultValue="user_123"
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
    </Form>
  )
}
