import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDurably, type Durably } from '../../src'
import { createBrowserDialectForName } from '../helpers/browser-dialect'

function nonce() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

async function waitFor(
  fn: () => Promise<boolean>,
  timeoutMs = 500,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return false
}

describe('sqlocal queue stress', () => {
  let runtimes: Array<Durably<any, any>>

  beforeEach(async () => {
    const dbName = `stress-${nonce()}.sqlite3`
    runtimes = Array.from({ length: 4 }, () =>
      createDurably({ dialect: createBrowserDialectForName(dbName) }),
    )

    await Promise.all(runtimes.map((runtime) => runtime.migrate()))
    await runtimes[0].db.deleteFrom('durably_logs').execute()
    await runtimes[0].db.deleteFrom('durably_steps').execute()
    await runtimes[0].db.deleteFrom('durably_runs').execute()
  })

  afterEach(async () => {
    await Promise.all(runtimes.map((runtime) => runtime.db.destroy()))
  })

  it('keeps claim single-winner across separate runtime instances', async () => {
    for (let attempt = 0; attempt < 25; attempt++) {
      await runtimes[0].db.deleteFrom('durably_logs').execute()
      await runtimes[0].db.deleteFrom('durably_steps').execute()
      await runtimes[0].db.deleteFrom('durably_runs').execute()

      const created = await runtimes[0].storage.queue.enqueue({
        jobName: 'stress-job',
        input: { attempt, nonce: nonce() },
      })

      const now = new Date().toISOString()
      const results = await Promise.all(
        runtimes.map((runtime, index) =>
          runtime.storage.queue.claimNext(`worker-${index}`, now, 30_000),
        ),
      )

      const winners = results.filter((run) => run !== null)
      expect(winners).toHaveLength(1)
      expect(winners[0]?.id).toBe(created.id)
    }
  })

  it.skip('rejects stale completion after another runtime reclaims the lease', async () => {
    const created = await runtimes[0].storage.queue.enqueue({
      jobName: 'stress-reclaim',
      input: { nonce: nonce() },
    })

    const firstClaim = await runtimes[0].storage.queue.claimNext(
      'worker-a',
      new Date().toISOString(),
      30_000,
    )
    expect(firstClaim?.id).toBe(created.id)

    await runtimes[1].storage.updateRun(created.id, {
      status: 'leased',
      leaseOwner: 'worker-a',
      leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
    })

    const visibleToOtherRuntime = await waitFor(async () => {
      const run = await runtimes[2].storage.getRun(created.id)
      return !!(
        run &&
        run.leaseExpiresAt &&
        run.leaseExpiresAt < new Date().toISOString()
      )
    })

    expect(visibleToOtherRuntime).toBe(true)

    const reclaimed = await runtimes[2].storage.queue.claimNext(
      'worker-b',
      new Date().toISOString(),
      30_000,
    )

    expect(reclaimed?.id).toBe(created.id)
    expect(reclaimed?.leaseOwner).toBe('worker-b')

    const staleComplete = await runtimes[3].storage.queue.completeRun(
      created.id,
      'worker-a',
      { ok: false },
      new Date().toISOString(),
    )
    const currentComplete = await runtimes[2].storage.queue.completeRun(
      created.id,
      'worker-b',
      { ok: true },
      new Date().toISOString(),
    )

    expect(staleComplete).toBe(false)
    expect(currentComplete).toBe(true)
  })
})
