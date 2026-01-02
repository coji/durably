/**
 * Node.js Example for Durably
 *
 * This example shows basic usage of Durably with Turso/libSQL.
 * Same job definition as browser/react examples for comparison.
 */

import { durably } from './lib/durably'

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
