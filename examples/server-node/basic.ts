/**
 * Node.js Example for Durably
 *
 * This example shows basic usage of Durably with Turso/libSQL.
 * Same job definition as browser/react examples for comparison.
 */

import { createDurably, defineJob } from '@coji/durably'
import { LibsqlDialect } from '@libsql/kysely-libsql'
import { z } from 'zod'

// Turso の場合は環境変数から URL と authToken を取得
// ローカル開発では file:local.db を使用
const dialect = new LibsqlDialect({
  url: process.env.TURSO_DATABASE_URL ?? 'file:local.db',
  authToken: process.env.TURSO_AUTH_TOKEN,
})

// Create durably instance with chained register()
const durably = createDurably({
  dialect,
  pollingInterval: 100,
  heartbeatInterval: 500,
  staleThreshold: 3000,
}).register({
  processImage: defineJob({
    name: 'process-image',
    input: z.object({ filename: z.string() }),
    output: z.object({ url: z.string() }),
    run: async (step, payload) => {
      // Step 1: Download
      const data = await step.run('download', async () => {
        await new Promise((r) => setTimeout(r, 500))
        return { size: 1024000 }
      })

      // Step 2: Resize
      await step.run('resize', async () => {
        await new Promise((r) => setTimeout(r, 500))
        return { width: 800, height: 600, size: data.size / 2 }
      })

      // Step 3: Upload
      const uploaded = await step.run('upload', async () => {
        await new Promise((r) => setTimeout(r, 500))
        return { url: `https://cdn.example.com/${payload.filename}` }
      })

      return { url: uploaded.url }
    },
  }),
})

// Subscribe to events
durably.on('run:start', (event) => {
  console.log(`[run:start] ${event.jobName}`)
})

durably.on('step:complete', (event) => {
  console.log(`[step:complete] ${event.stepName}`)
})

durably.on('run:complete', (event) => {
  console.log(
    `[run:complete] output=${JSON.stringify(event.output)} duration=${event.duration}ms`,
  )
})

durably.on('run:fail', (event) => {
  console.log(`[run:fail] ${event.error}`)
})

// Main
async function main() {
  console.log('Durably Node.js Example')
  console.log('=======================\n')

  await durably.migrate()
  console.log('Migration completed')

  durably.start()
  console.log('Worker started\n')

  // Trigger job and wait for completion
  const { id, output } = await durably.jobs.processImage.triggerAndWait({
    filename: 'photo.jpg',
  })
  console.log(`\nRun ${id} completed`)
  console.log(`Output: ${JSON.stringify(output)}`)

  // Show stats
  const runs = await durably.storage.getRuns()
  console.log(`\nDatabase Stats:`)
  console.log(`  Pending: ${runs.filter((r) => r.status === 'pending').length}`)
  console.log(`  Running: ${runs.filter((r) => r.status === 'running').length}`)
  console.log(
    `  Completed: ${runs.filter((r) => r.status === 'completed').length}`,
  )
  console.log(`  Failed: ${runs.filter((r) => r.status === 'failed').length}`)

  // Cleanup
  await durably.stop()
  await durably.db.destroy()
  console.log('\nDone!')
}

main().catch(console.error)
