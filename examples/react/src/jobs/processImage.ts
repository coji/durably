/**
 * Process Image Job
 *
 * Example job that simulates image processing with multiple steps.
 */

import { defineJob } from '@coji/durably'
import { z } from 'zod'
import { durably } from '../lib/durably'

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const processImage = durably.register(
  defineJob({
    name: 'process-image',
    input: z.object({ filename: z.string(), width: z.number() }),
    output: z.object({ url: z.string(), size: z.number() }),
    run: async (step, payload) => {
      // Download original image
      const fileSize = await step.run('download', async () => {
        await delay(300)
        return Math.floor(Math.random() * 1000000) + 500000 // 500KB-1.5MB
      })

      // Resize to target width
      const resizedSize = await step.run('resize', async () => {
        await delay(400)
        return Math.floor(fileSize * (payload.width / 1920))
      })

      // Upload to CDN
      const url = await step.run('upload', async () => {
        await delay(300)
        return `https://cdn.example.com/${payload.width}/${payload.filename}`
      })

      return { url, size: resizedSize }
    },
  }),
)
