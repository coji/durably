/** Run with: pnpm --filter example-server-libsql exec tsx durable-wait.ts */
import { createDurably, defineJob } from '@coji/durably'
import { LibsqlDialect } from '@libsql/kysely-libsql'
import { z } from 'zod'

const approval = defineJob({
  name: 'durable-wait-example',
  input: z.object({
    changeId: z.string(),
    timeoutMs: z.number().int().positive(),
  }),
  output: z.object({ approved: z.boolean() }),
  run: async (step, input) => {
    const wait = await step.prepareWait('approval:1', {
      metadata: { changeId: input.changeId },
      timeoutMs: input.timeoutMs,
    })
    await step.run('request-approval:1', () => {
      // Send this ID to your application after validating the target change.
      // Real external requests should use an application idempotency key.
      console.log(`Approval address: ${wait.id}`)
      return null
    })
    const result = await step.waitFor(wait)
    if (result.type === 'timeout') {
      console.log(`Approval expired for ${input.changeId}`)
      return { approved: false }
    }
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
  const first = await durably.jobs.approval.trigger({
    changeId: 'change-123',
    timeoutMs: 60_000,
  })
  const expiring = await durably.jobs.approval.trigger({
    changeId: 'change-456',
    timeoutMs: 1_000,
  })
  await durably.processUntilIdle()
  console.log('Suspended:', (await durably.getRun(first.id))?.status)
  console.log('Will expire:', (await durably.getRun(expiring.id))?.status)

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
  console.log('Signal wait timing:', await durably.getWait(wait.id))

  // The other wait's fixed deadline survives runtime recreation without a signal.
  await new Promise((resolve) => setTimeout(resolve, 1_100))
  await durably.processUntilIdle()
  console.log('Timed-out run:', expiring.id, await durably.getRun(expiring.id))
  console.log('Timeout wait timing:', await durably.getWaits(expiring.id))
} finally {
  await durably.db.destroy()
}
