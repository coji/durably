import { z } from 'zod'
import { createDurably, defineJob } from '../../src'
import { createNodeDialectForFile } from '../helpers/node-dialect'

const dbFile = process.argv[2]
if (!dbFile) throw new Error('Missing database file')
const job = defineJob({
  name: 'crash-recovery-attempt',
  input: z.object({}),
  run: async (step) => {
    await step.run(
      'external-call',
      async (_signal, attempt) => {
        await attempt.setMetadata({ usage: 4 })
        process.send?.({ attemptId: attempt.id })
        await new Promise<never>(() => {})
      },
      { metadata: { provider: 'fixture' } },
    )
  },
})
const runtime = createDurably({
  dialect: createNodeDialectForFile(dbFile),
  leaseMs: 200,
  leaseRenewIntervalMs: 10_000,
  jobs: { job },
})
await runtime.migrate()
await runtime.processOne({ workerId: 'crash-child' })
