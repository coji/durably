/**
 * Image Processing Form Component
 *
 * Form for triggering image processing jobs.
 */

import { useState } from 'react'

interface ImageProcessingFormProps {
  onSubmit: (data: { filename: string; width: number }) => void
  isSubmitting: boolean
  runId: string | null
}

export function ImageProcessingForm({
  onSubmit,
  isSubmitting,
  runId,
}: ImageProcessingFormProps) {
  const [filename, setFilename] = useState('photo.jpg')
  const [width, setWidth] = useState(800)

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    onSubmit({ filename, width })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label
          htmlFor="filename"
          className="mb-1 block text-sm font-medium text-gray-700"
        >
          Filename
        </label>
        <input
          id="filename"
          value={filename}
          onChange={(e) => setFilename(e.target.value)}
          className="w-full rounded-md border border-gray-300 px-3 py-2 focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
        />
      </div>
      <div>
        <label
          htmlFor="width"
          className="mb-1 block text-sm font-medium text-gray-700"
        >
          Width
        </label>
        <input
          id="width"
          type="number"
          value={width}
          onChange={(e) => setWidth(Number(e.target.value))}
          min={100}
          max={4000}
          className="w-full rounded-md border border-gray-300 px-3 py-2 focus:border-blue-500 focus:ring-2 focus:ring-blue-500"
        />
      </div>
      <button
        type="submit"
        disabled={isSubmitting}
        className="rounded-md bg-blue-600 px-4 py-2 font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isSubmitting ? 'Submitting...' : 'Process Image'}
      </button>
      {runId && (
        <div className="text-sm text-gray-500">
          Triggered: <span className="font-mono">{runId.slice(0, 8)}</span>
        </div>
      )}
    </form>
  )
}
