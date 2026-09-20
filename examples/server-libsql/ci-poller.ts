/** Run with: pnpm --filter example-server-libsql exec tsx ci-poller.ts */
import { createDurably, createDurablyHandler, defineJob } from '@coji/durably'
import { LibsqlDialect } from '@libsql/kysely-libsql'
import { z } from 'zod'

const ciResult = z.object({ commit: z.string(), passed: z.boolean() })
// Mock external CI state. A real process restart reads this from the CI provider.
const launchedChecks = new Map<string, string>()
let downstreamStarts = 0

const release = defineJob({
  name: 'ci-poller-release',
  input: z.object({ commit: z.string() }),
  output: z.string(),
  run: async (step, { commit }) => {
    const wait = await step.prepareWait('ci', { metadata: { commit } })
    await step.run('start-ci', () => {
      // The application uses a stable external idempotency key for this check.
      launchedChecks.set(wait.id, commit)
      return null
    })
    const result = await step.waitFor(wait)
    if (result.type === 'timeout') return 'timed out'
    const decision = ciResult.parse(result.payload)
    if (decision.commit !== commit || !decision.passed)
      return 'CI did not pass for this commit'
    return step.run('release', () => {
      downstreamStarts++
      return `released ${commit}`
    })
  },
})

const background = defineJob({
  name: 'ci-poller-background',
  input: z.object({}),
  output: z.string(),
  run: (step) => step.run('background', () => 'other work completed'),
})

const openRuntime = () =>
  createDurably({
    dialect: new LibsqlDialect({ url: 'file:ci-poller-example.db' }),
    maxConcurrentRuns: 1,
    jobs: { release, background },
  })

let durably = openRuntime()
// Manual processing makes the single worker slot and restart stages observable.
await durably.migrate()
try {
  const a = await durably.jobs.release.trigger(
    { commit: 'current-commit' },
    { labels: { tenant: 'local' } },
  )
  await durably.processUntilIdle()
  if ((await durably.getRun(a.id))?.status !== 'waiting')
    throw new Error('A did not suspend')

  const b = await durably.jobs.background.trigger({})
  await durably.processUntilIdle()
  if ((await durably.getRun(b.id))?.status !== 'completed')
    throw new Error('B did not use the released worker slot')

  // Restart the worker/runtime. The wait and its target commit remain in SQLite.
  await durably.db.destroy()
  durably = openRuntime()
  await durably.migrate()
  const handler = createDurablyHandler(durably, {
    auth: {
      authenticate: (request) => {
        if (request.headers.get('Authorization') !== 'Bearer local-example')
          throw new Response('Unauthorized', { status: 401 })
        return { tenant: 'local' }
      },
      onRunAccess: (ctx, run) => {
        if (run.labels.tenant !== ctx.tenant)
          throw new Response('Forbidden', { status: 403 })
      },
      onSignal: (_ctx, run, wait, signal) => {
        const result = ciResult.safeParse(signal.payload)
        if (
          !result.success ||
          result.data.commit !== (wait.metadata as { commit: string }).commit ||
          result.data.commit !== (run.input as { commit: string }).commit
        )
          throw new Response('CI result does not match the target commit', {
            status: 400,
          })
      },
    },
  })

  // This function represents a separate outbound poller. Replace queryCi with
  // your CI provider's authenticated read API and handler.handle with fetch.
  const request = (path: string, init?: RequestInit) =>
    handler.handle(
      new Request(`http://localhost/api/durably${path}`, {
        ...init,
        headers: { Authorization: 'Bearer local-example', ...init?.headers },
      }),
      '/api/durably',
    )
  const waitsResponse = await request(`/waits?runId=${a.id}`)
  if (!waitsResponse.ok) throw new Error(await waitsResponse.text())
  const waits = (await waitsResponse.json()) as {
    id: string
    metadata: { commit: string }
  }[]
  const [wait] = waits
  if (!wait || launchedChecks.get(wait.id) !== wait.metadata.commit)
    throw new Error('CI check and persisted wait disagree')

  const deliver = async (result: {
    checkId: string
    commit: string
    passed: boolean
  }) => {
    const response = await request(`/signal?runId=${a.id}&waitId=${wait.id}`, {
      method: 'POST',
      body: JSON.stringify({
        signalId: result.checkId,
        payload: { commit: result.commit, passed: result.passed },
      }),
    })
    if (!response.ok) throw new Error(await response.text())
    return (await response.json()).disposition as string
  }

  // Mock successive outbound provider reads. A real poller awaits each
  // authenticated query before starting another, and stops on a final result.
  const providerReplies = [
    { state: 'pending' as const },
    {
      state: 'complete' as const,
      checkId: 'old-check',
      commit: 'old-commit',
      passed: true,
    },
    {
      state: 'complete' as const,
      checkId: 'check-123',
      commit: 'current-commit',
      passed: true,
    },
  ]
  const queryCi = async (attempt: number) => providerReplies[attempt]
  let staleSkipped = false
  let acceptedResult: (typeof providerReplies)[number] | undefined
  for (let attempt = 0; attempt < providerReplies.length; attempt++) {
    const result = await queryCi(attempt)
    if (!result || result.state === 'pending') continue
    if (result.commit !== wait.metadata.commit) {
      staleSkipped = true
      continue
    }
    if ((await deliver(result)) !== 'accepted')
      throw new Error('CI result was not accepted')
    acceptedResult = result
    break
  }
  if (!staleSkipped || !acceptedResult || acceptedResult.state !== 'complete')
    throw new Error(
      'Poller did not skip stale CI and accept the current result',
    )
  if ((await deliver(acceptedResult)) !== 'duplicate')
    throw new Error('Redelivery was not idempotent')

  await durably.processUntilIdle()
  if (
    (await durably.getRun(a.id))?.status !== 'completed' ||
    downstreamStarts !== 1
  )
    throw new Error('A did not resume exactly once')
  console.log(
    'A resumed after restart; B ran while A waited; stale CI was ignored',
  )
} finally {
  await durably.db.destroy()
}
