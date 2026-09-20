import { stdin, stdout } from 'node:process'
import { createInterface } from 'node:readline/promises'

/** Run with: pnpm --filter example-server-libsql exec tsx human-input.ts */
import { createDurably, createDurablyHandler, defineJob } from '@coji/durably'
import { LibsqlDialect } from '@libsql/kysely-libsql'
import { z } from 'zod'

const approval = defineJob({
  name: 'local-human-approval',
  input: z.object({ request: z.string() }),
  output: z.boolean(),
  run: async (step, input) => {
    const wait = await step.prepareWait('decision', {
      metadata: { request: input.request },
    })
    const result = await step.waitFor(wait)
    return result.type === 'signal' ? z.boolean().parse(result.payload) : false
  },
})

const durably = createDurably({
  dialect: new LibsqlDialect({ url: 'file:human-input-example.db' }),
  jobs: { approval },
})
const prompt = createInterface({ input: stdin, output: stdout })
// Keep processing under explicit control so the prompt can observe the wait.
await durably.migrate()
try {
  const run = await durably.jobs.approval.trigger(
    { request: 'Publish this change?' },
    { labels: { owner: 'local-user' } },
  )
  await durably.processUntilIdle()
  const handler = createDurablyHandler(durably, {
    auth: {
      authenticate: () => ({ user: 'local-user' }),
      onRunAccess: (ctx, item) => {
        if (item.labels.owner !== ctx.user)
          throw new Response('Forbidden', { status: 403 })
      },
      onSignal: (_ctx, _run, _wait, signal) => {
        if (typeof signal.payload !== 'boolean')
          throw new Response('Decision must be a boolean', { status: 400 })
      },
    },
  })
  const base = 'http://localhost/api/durably'
  const waits = await handler.handle(
    new Request(`${base}/waits?runId=${run.id}`),
    '/api/durably',
  )
  if (!waits.ok) throw new Error(await waits.text())
  const [wait] = (await waits.json()) as { id: string }[]
  if (!wait) throw new Error('Approval wait was not prepared')
  const answer = await prompt.question('Publish this change? [y/N] ')
  const signal = await handler.handle(
    new Request(`${base}/signal?runId=${run.id}&waitId=${wait.id}`, {
      method: 'POST',
      body: JSON.stringify({
        signalId: 'local-decision-1',
        payload: answer.trim().toLowerCase() === 'y',
      }),
    }),
    '/api/durably',
  )
  if (!signal.ok) throw new Error(await signal.text())
  await durably.processUntilIdle()
  console.log('Approval result:', (await durably.getRun(run.id))?.output)
} finally {
  prompt.close()
  await durably.db.destroy()
}
