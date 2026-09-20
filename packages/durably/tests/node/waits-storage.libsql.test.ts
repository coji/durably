import { sql } from 'kysely'
import { expect, it } from 'vitest'
import { createDurably } from '../../src'
import { createNodeDialect } from '../helpers/node-dialect'
import { createWaitStorageTests } from '../shared/waits-storage.shared'

createWaitStorageTests(createNodeDialect)

it('recovers the original resumed claim time after its wait write fails', async () => {
  const durably = createDurably({ dialect: createNodeDialect() })
  try {
    await durably.migrate()
    const store = durably.storage
    const { run } = await store.enqueue({ jobName: 'atomic-resume', input: {} })
    const now = new Date().toISOString()
    const first = (await store.claimNext('first', now, 30_000))!
    const wait = (await store.prepareWait(
      run.id,
      first.leaseGeneration,
      'approval',
    ))!
    await store.signalWait(wait.id, true, { signalId: 'approved' })
    expect(await store.suspendRun(run.id, first.leaseGeneration, wait.id)).toBe(
      true,
    )

    await sql`CREATE TRIGGER fail_first_resume BEFORE UPDATE OF first_resumed_at ON durably_waits BEGIN SELECT RAISE(ABORT, 'timestamp write failed'); END`.execute(
      durably.db,
    )
    const originalClaimTime = new Date().toISOString()
    await expect(
      store.claimNext('failed-claim', originalClaimTime, 30_000),
    ).rejects.toThrow('timestamp write failed')
    expect((await store.getRun(run.id))?.status).toBe('leased')
    expect((await store.getWait(wait.id))?.firstResumedAt).toBeNull()

    await sql`DROP TRIGGER fail_first_resume`.execute(durably.db)
    expect(
      (
        await store.claimNext(
          'recovered',
          new Date(Date.parse(originalClaimTime) + 30_001).toISOString(),
          30_000,
        )
      )?.id,
    ).toBe(run.id)
    expect((await store.getWait(wait.id))?.firstResumedAt).toBe(
      originalClaimTime,
    )
  } finally {
    await durably.db.destroy()
  }
})

it('serializes wait result reads and expiry sweeps with other libsql writes', async () => {
  const durably = createDurably({ dialect: createNodeDialect() })
  try {
    await durably.migrate()
    const store = durably.storage
    const first = await store.enqueue({ jobName: 'contention', input: {} })
    const firstLease = (await store.claimNext(
      'first',
      new Date().toISOString(),
      30_000,
    ))!
    const firstWait = (await store.prepareWait(
      first.run.id,
      firstLease.leaseGeneration,
      'no-deadline',
    ))!

    const second = await store.enqueue({ jobName: 'contention', input: {} })
    const secondLease = (await store.claimNext(
      'second',
      new Date().toISOString(),
      30_000,
    ))!
    const secondWait = (await store.prepareWait(
      second.run.id,
      secondLease.leaseGeneration,
      'due',
      undefined,
      1,
    ))!
    await store.suspendRun(
      second.run.id,
      secondLease.leaseGeneration,
      secondWait.id,
    )
    await new Promise((resolve) => setTimeout(resolve, 10))

    await Promise.all([
      ...Array.from({ length: 5 }, () =>
        store.getWaitResultForRun(
          first.run.id,
          firstLease.leaseGeneration,
          firstWait.id,
        ),
      ),
      ...Array.from({ length: 5 }, () => store.expireDueWaits()),
      ...Array.from({ length: 5 }, (_, i) =>
        store.enqueue({ jobName: 'contention', input: { i } }),
      ),
    ])
    expect((await store.getWait(secondWait.id))?.outcome).toBe('timeout')
  } finally {
    await durably.db.destroy()
  }
})
