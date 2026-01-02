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
  input: z.object({ filename: z.string(), width: z.number() }),
  output: z.object({ url: z.string(), size: z.number() }),
  run: async (step, payload) => {
    step.log.info(`Starting image processing: ${payload.filename}`)

    // Download original image
    const fileSize = await step.run('download', async () => {
      step.progress(1, 3, 'Downloading...')
      await delay(300)
      return Math.floor(Math.random() * 1000000) + 500000 // 500KB-1.5MB
    })

    step.log.info(`Downloaded: ${fileSize} bytes`)

    // Resize to target width
    const resizedSize = await step.run('resize', async () => {
      step.progress(2, 3, 'Resizing...')
      await delay(400)
      return Math.floor(fileSize * (payload.width / 1920))
    })

    step.log.info(`Resized to: ${resizedSize} bytes`)

    // Upload to CDN
    const url = await step.run('upload', async () => {
      step.progress(3, 3, 'Uploading...')
      await delay(300)
      return `https://cdn.example.com/${payload.width}/${payload.filename}`
    })

    step.log.info(`Uploaded to: ${url}`)

    return { url, size: resizedSize }
  },
})
