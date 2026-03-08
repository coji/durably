import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDurably, type Durably } from '../../src'
import { createBrowserDialectForName } from '../helpers/browser-dialect'

function nonce() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
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

      const created = await runtimes[0].storage.enqueue({
        jobName: 'stress-job',
        input: { attempt, nonce: nonce() },
      })

      const now = new Date().toISOString()
      const results = await Promise.all(
        runtimes.map((runtime, index) =>
          runtime.storage.claimNext(`worker-${index}`, now, 30_000),
        ),
      )

      const winners = results.filter((run) => run !== null)
      expect(winners).toHaveLength(1)
      expect(winners[0]?.id).toBe(created.id)
    }
  })
})
