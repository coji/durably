/**
 * Image Processing Form Component
 *
 * Form for triggering image processing jobs via clientAction.
 */

import { Form, useActionData, useNavigation } from 'react-router'
import type { clientAction } from '../_index'

export function ImageProcessingForm() {
  const actionData = useActionData<typeof clientAction>()
  const navigation = useNavigation()
  const isSubmitting = navigation.state === 'submitting'
  const runId = actionData?.intent === 'image' ? actionData.runId : null

  return (
    <Form method="post" className="space-y-4">
      <input type="hidden" name="intent" value="image" />
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
          defaultValue="photo.jpg"
          className="border border-gray-300 rounded-md px-3 py-2 w-full focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        />
      </div>
      <div>
        <label
          htmlFor="width"
          className="block text-sm font-medium text-gray-700 mb-1"
        >
          Width
        </label>
        <input
          id="width"
          name="width"
          type="number"
          defaultValue={800}
          min={100}
          max={4000}
          className="border border-gray-300 rounded-md px-3 py-2 w-full focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
        />
      </div>
      <button
        type="submit"
        disabled={isSubmitting}
        className="bg-blue-600 hover:bg-blue-700 text-white font-medium px-4 py-2 rounded-md disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
      >
        {isSubmitting ? 'Submitting...' : 'Process Image'}
      </button>
      {runId && (
        <div className="text-sm text-gray-500">
          Triggered: <span className="font-mono">{runId.slice(0, 8)}</span>
        </div>
      )}
    </Form>
  )
}
