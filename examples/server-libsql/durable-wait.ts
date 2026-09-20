/** Run with: pnpm --filter example-server-libsql exec tsx durable-wait.ts */
import { createDurably, defineJob } from '@coji/durably'
import { LibsqlDialect } from '@libsql/kysely-libsql'
import { z } from 'zod'

const approval = defineJob({
  name: 'durable-wait-example',
  input: z.object({ changeId: z.string() }),
  output: z.object({ approved: z.boolean() }),
  run: async (step, input) => {
    const wait = await step.prepareWait('approval:1', {
      metadata: { changeId: input.changeId },
    })
    await step.run('request-approval:1', () => {
      // Send this ID to your application after validating the target change.
      // Real external requests should use an application idempotency key.
      console.log(`Approval address: ${wait.id}`)
      return null
    })
    const result = await step.waitFor(wait)
    const decision = z.object({ approved: z.boolean() }).parse(result.payload)
    return decision
  },
})
const background = defineJob({
  name: 'background-example',
  input: z.object({}),
  output: z.object({ done: z.boolean() }),
  run: async (step) => step.run('work', () => ({ done: true })),
})

// File storage preserves the wait across destroying/recreating the runtime.
const openRuntime = () =>
  createDurably({
    dialect: new LibsqlDialect({ url: 'file:durable-wait-example.db' }),
    jobs: { approval, background },
  })
let durably = openRuntime()
// Migrate only: init() would start a background worker and race these manual stages.
await durably.migrate()
try {
  const first = await durably.jobs.approval.trigger({ changeId: 'change-123' })
  await durably.processUntilIdle()
  console.log('Suspended:', (await durably.getRun(first.id))?.status)

  const second = await durably.jobs.background.trigger({})
  await durably.processUntilIdle()
  console.log('Other work:', (await durably.getRun(second.id))?.status)

  await durably.db.destroy()
  durably = openRuntime()
  // Restore schema without starting a background worker.
  await durably.migrate()
  const waits = await durably.getWaits(first.id)
  const wait = waits.find((item) => item.name === 'approval:1')
  if (!wait) throw new Error('Persisted approval wait not found')
  // A local UI or outbound poller can make this same direct call.
  await durably.signal(wait.id, { approved: true }, { signalId: 'decision-1' })
  // Retrying an uncertain delivery returns the original receipt.
  await durably.signal(wait.id, { approved: true }, { signalId: 'decision-1' })
  await durably.processUntilIdle()
  console.log('Same run resumed:', first.id, await durably.getRun(first.id))
} finally {
  await durably.db.destroy()
}
