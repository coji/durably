/**
 * Node.js + PostgreSQL Example for Durably
 *
 * This example shows basic usage of Durably with PostgreSQL.
 * Run: DATABASE_URL=postgresql://localhost:5432/durably tsx basic.ts
 */

import { durably } from './lib/durably'

// Subscribe to events
durably.on('run:leased', (event) => {
  console.log(`[run:leased] ${event.jobName}`)
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
  console.log('Durably Node.js + PostgreSQL Example')
  console.log('====================================\n')

  await durably.init()
  console.log('Initialized\n')

  // Trigger job and wait for completion
  const { id, output } = await durably.jobs.processImage.triggerAndWait({
    filename: 'photo.jpg',
  })
  console.log(`\nRun ${id} completed`)
  console.log(`Output: ${JSON.stringify(output)}`)

  // Show stats
  const runs = await durably.getRuns()
  console.log(`\nDatabase Stats:`)
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
