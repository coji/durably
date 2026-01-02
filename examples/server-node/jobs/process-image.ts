/**
 * Process Image Job
 *
 * Simulates image processing with multiple steps.
 */

import { defineJob } from '@coji/durably'
import { z } from 'zod'

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const processImageJob = defineJob({
  name: 'process-image',
  input: z.object({ filename: z.string() }),
  output: z.object({ url: z.string() }),
  run: async (step, payload) => {
    // Step 1: Download
    const data = await step.run('download', async () => {
      await delay(500)
      return { size: 1024000 }
    })

    // Step 2: Resize
    await step.run('resize', async () => {
      await delay(500)
      return { width: 800, height: 600, size: data.size / 2 }
    })

    // Step 3: Upload
    const uploaded = await step.run('upload', async () => {
      await delay(500)
      return { url: `https://cdn.example.com/${payload.filename}` }
    })

    return { url: uploaded.url }
  },
})
