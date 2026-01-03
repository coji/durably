/**
 * Data Sync Job
 *
 * Simulates syncing data with a remote server.
 */

import { defineJob } from '@coji/durably'
import { z } from 'zod'

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

export const dataSyncJob = defineJob({
  name: 'data-sync',
  input: z.object({ userId: z.string() }),
  output: z.object({ synced: z.number(), failed: z.number() }),
  run: async (step, payload) => {
    step.log.info(`Starting sync for user: ${payload.userId}`)

    const items = await step.run('fetch-local', async () => {
      step.progress(1, 4, 'Fetching local data...')
      await delay(300)
      return Array.from({ length: 10 }, (_, i) => ({
        id: `item-${i}`,
        data: `Data for ${payload.userId}`,
      }))
    })

    let synced = 0
    let failed = 0

    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      const success = await step.run(`sync-item-${item.id}`, async () => {
        step.progress(2 + Math.floor(i / 5), 4, `Syncing item ${i + 1}...`)
        await delay(100)
        return Math.random() > 0.1 // 90% success rate
      })

      if (success) {
        synced++
      } else {
        failed++
        step.log.warn(`Failed to sync item: ${item.id}`)
      }
    }

    await step.run('finalize', async () => {
      step.progress(4, 4, 'Finalizing...')
      await delay(200)
    })

    step.log.info(`Sync complete: ${synced} synced, ${failed} failed`)

    return { synced, failed }
  },
})
