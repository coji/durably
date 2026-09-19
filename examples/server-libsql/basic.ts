/**
 * Node.js Example for Durably
 *
 * This example shows basic usage of Durably with Turso/libSQL,
 * including trailing run coalescing with `coalesce: 'queue'`.
 */

import { durably } from './lib/durably'

// Subscribe to events
durably.on('run:trigger', (event) => {
  console.log(`[run:trigger] ${event.jobName} runId=${event.runId}`)
})

durably.on('run:coalesced', (event) => {
  console.log(
    `[run:coalesced] ${event.runId} skipped input=${JSON.stringify(event.skippedInput)}`,
  )
})

durably.on('run:leased', (event) => {
  console.log(`[run:leased] ${event.jobName} runId=${event.runId}`)
})

durably.on('step:complete', (event) => {
  console.log(`[step:complete] ${event.stepName}`)
})

durably.on('step:cancel', (event) => {
  console.log(`[step:cancel] ${event.stepName}`)
})

durably.on('run:complete', (event) => {
  console.log(
    `[run:complete] output=${JSON.stringify(event.output)} duration=${event.duration}ms`,
  )
})

durably.on('run:fail', (event) => {
  console.log(`[run:fail] ${event.error}`)
})

console.log('Durably Node.js Example')
console.log('=======================\n')

await durably.init()
console.log('Initialized\n')

try {
  // --- Trailing Queued Run Execution Demo ---
  // Demonstrates one-trailing-run coalescing with coalesce: 'queue'.
  // 1. First run is triggered and leased.
  // 2. While leased, a second run with coalesce: 'queue' creates exactly one trailing pending run.
  // 3. Further triggers while leased + pending coexist return the trailing run with disposition 'coalesced'.
  // 4. Note: Idempotency keys take precedence over concurrency conflict resolution (returning 'idempotent').
  console.log('--- Coalesce Queue Demo ---')
  const leasedRunIds = new Set<string>()
  let notifyLease: (() => void) | undefined
  const stopObservingLeases = durably.on('run:leased', (event) => {
    leasedRunIds.add(event.runId)
    notifyLease?.()
  })
  const run1 = await durably.jobs.processImage.trigger(
    { filename: 'photo1.jpg' },
    { concurrencyKey: 'gallery-sync' },
  )
  console.log(
    `Run 1 triggered (${run1.id}): disposition='${run1.disposition}' (first pending run)`,
  )

  // The listener was installed before triggering, so even a fast lease is observed.
  console.log('Waiting for Run 1 to be leased by the worker...')
  while (!leasedRunIds.has(run1.id)) {
    await new Promise<void>((resolve) => {
      notifyLease = resolve
    })
  }
  stopObservingLeases()
  console.log('Run 1 is now actively leased!\n')

  // Queue a second distinct run with the same concurrencyKey behind the leased run
  const run2 = await durably.jobs.processImage.trigger(
    { filename: 'photo2.jpg' },
    { concurrencyKey: 'gallery-sync', coalesce: 'queue' },
  )
  console.log(
    `Run 2 queued (${run2.id}): disposition='${run2.disposition}' (trailing pending run created)`,
  )

  // A third trigger with the same concurrencyKey coalesces onto the existing trailing pending run.
  // Durably limits queueing to at most one trailing pending run; further inputs are not persisted.
  const run3 = await durably.jobs.processImage.trigger(
    { filename: 'photo3.jpg' },
    { concurrencyKey: 'gallery-sync', coalesce: 'queue' },
  )
  console.log(
    `Run 3 queued (${run3.id}): disposition='${run3.disposition}' (reused trailing run ${run2.id})`,
  )

  // Wait for the trailing run to be executed after Run 1 completes
  console.log('\nWaiting for trailing Run 2 to complete...')
  const trailingResult = await durably.waitForRun(run2.id)
  console.log(
    `Trailing run completed: output=${JSON.stringify(trailingResult.output)}\n`,
  )

  // Parallel review job demo
  const reviews = await durably.jobs.parallelReview.triggerAndWait({
    changeId: 'example-change',
  })
  console.log(`Parallel reviews: ${JSON.stringify(reviews.output)}`)

  // Show stats
  const runs = await durably.storage.getRuns()
  console.log(`\nDatabase Stats:`)
  console.log(`  Pending: ${runs.filter((r) => r.status === 'pending').length}`)
  console.log(`  Leased: ${runs.filter((r) => r.status === 'leased').length}`)
  console.log(
    `  Completed: ${runs.filter((r) => r.status === 'completed').length}`,
  )
  console.log(`  Failed: ${runs.filter((r) => r.status === 'failed').length}`)
} finally {
  await durably.stop()
  await durably.db.destroy()
}

console.log('\nDone!')
