import { sql, type Dialect } from 'kysely'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { createDurably, defineJob, type Durably } from '../../src'

interface SharedDialectResource {
  createDialect(): Dialect
  setup?(): Promise<void> | void
  cleanup?(): Promise<void> | void
}

export function createDbConcurrencyTests(
  label: string,
  createResource: () => SharedDialectResource,
  options?: {
    skipDirectConcurrentClaimRace?: boolean
  },
) {
  describe(`${label} concurrency key semantics`, () => {
    let resource: SharedDialectResource
    let runtimes: Array<Durably<any, any>>

    beforeEach(async () => {
      resource = createResource()
      await resource.setup?.()
      runtimes = Array.from({ length: 4 }, () =>
        createDurably({ dialect: resource.createDialect() }),
      )

      await runtimes[0].migrate()
      await runtimes[0].db.deleteFrom('durably_logs').execute()
      await runtimes[0].db.deleteFrom('durably_steps').execute()
      await runtimes[0].db.deleteFrom('durably_runs').execute()
    })

    afterEach(async () => {
      if (runtimes) {
        await Promise.all(runtimes.map((runtime) => runtime.db.destroy()))
      }
      await resource.cleanup?.()
    })

    const directConcurrentClaim = options?.skipDirectConcurrentClaimRace
      ? it.skip
      : it

    directConcurrentClaim(
      'leases at most one run per concurrency key across concurrent claimers',
      { timeout: 15_000 },
      async () => {
        for (let attempt = 0; attempt < 25; attempt++) {
          await runtimes[0].db.deleteFrom('durably_logs').execute()
          await runtimes[0].db.deleteFrom('durably_steps').execute()
          await runtimes[0].db.deleteFrom('durably_runs').execute()

          await runtimes[0].storage.enqueue({
            jobName: 'same-key-a',
            input: { attempt, ordinal: 1 },
            concurrencyKey: 'group-1',
          })
          await runtimes[0].storage.enqueue({
            jobName: 'same-key-b',
            input: { attempt, ordinal: 2 },
            concurrencyKey: 'group-1',
          })
          await runtimes[0].storage.enqueue({
            jobName: 'other-key',
            input: { attempt, ordinal: 3 },
            concurrencyKey: 'group-2',
          })

          const now = new Date().toISOString()
          const results = await Promise.all(
            runtimes.map((runtime, index) =>
              runtime.storage.claimNext(`worker-${index}`, now, 30_000),
            ),
          )

          const winners = results.filter((run) => run !== null)
          const groupOneWinners = winners.filter(
            (run) => run?.concurrencyKey === 'group-1',
          )
          const claimedKeys = new Set(
            winners.map((run) => run?.concurrencyKey).filter(Boolean),
          )

          expect(groupOneWinners).toHaveLength(1)
          expect(winners.length).toBe(claimedKeys.size)
          expect(claimedKeys.has('group-1')).toBe(true)

          for (const winner of winners) {
            await runtimes[0].storage.completeRun(
              winner!.id,
              winner!.leaseGeneration,
              { attempt, completed: true },
              new Date().toISOString(),
            )
          }

          const drained: string[] = []
          while (true) {
            const next = await runtimes[0].storage.claimNext(
              'drain-worker',
              new Date().toISOString(),
              30_000,
            )
            if (!next) {
              break
            }
            drained.push(next.id)
            await runtimes[0].storage.completeRun(
              next.id,
              next.leaseGeneration,
              { attempt, drained: true },
              new Date().toISOString(),
            )
          }

          expect(winners.length + drained.length).toBe(3)
        }
      },
    )

    it('does not lease a later same-key run while an active lease exists', async () => {
      const { run: first } = await runtimes[0].storage.enqueue({
        jobName: 'same-key-1',
        input: { ordinal: 1 },
        concurrencyKey: 'group-1',
      })
      await runtimes[0].storage.enqueue({
        jobName: 'same-key-2',
        input: { ordinal: 2 },
        concurrencyKey: 'group-1',
      })
      const { run: keyless } = await runtimes[0].storage.enqueue({
        jobName: 'keyless',
        input: { ordinal: 3 },
      })

      const firstClaim = await runtimes[0].storage.claimNext(
        'worker-a',
        new Date().toISOString(),
        30_000,
      )
      expect(firstClaim?.id).toBe(first.id)

      const secondClaim = await runtimes[1].storage.claimNext(
        'worker-b',
        new Date().toISOString(),
        30_000,
      )
      const thirdClaim = await runtimes[2].storage.claimNext(
        'worker-c',
        new Date().toISOString(),
        30_000,
      )

      expect(secondClaim?.id).toBe(keyless.id)
      expect(thirdClaim).toBeNull()
    })

    it('reclaims the expired lease before leasing another run with the same key', async () => {
      const { run: first } = await runtimes[0].storage.enqueue({
        jobName: 'reclaim-first',
        input: { ordinal: 1 },
        concurrencyKey: 'group-1',
      })
      await runtimes[0].storage.enqueue({
        jobName: 'reclaim-second',
        input: { ordinal: 2 },
        concurrencyKey: 'group-1',
      })

      const firstClaim = await runtimes[0].storage.claimNext(
        'worker-a',
        new Date().toISOString(),
        30_000,
      )
      expect(firstClaim?.id).toBe(first.id)

      await runtimes[1].storage.updateRun(first.id, {
        status: 'leased',
        leaseOwner: 'worker-a',
        leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
      })

      const reclaimed = await runtimes[2].storage.claimNext(
        'worker-b',
        new Date().toISOString(),
        30_000,
      )
      const stillBlocked = await runtimes[3].storage.claimNext(
        'worker-c',
        new Date().toISOString(),
        30_000,
      )

      expect(reclaimed?.id).toBe(first.id)
      expect(reclaimed?.leaseOwner).toBe('worker-b')
      expect(stillBlocked).toBeNull()
    })

    it('does not execute same-key runs concurrently across runtime instances', async () => {
      const activeKeys = new Set<string>()
      const executionOrder: string[] = []
      let overlapDetected = false
      // Hold the first run until the other runtime has tried to claim. A
      // fixed sleep let the first run finish early on a slow machine, and the
      // other runtime then rightly claimed the second run.
      let releaseFirst!: () => void
      const firstHeld = new Promise<void>((resolve) => {
        releaseFirst = resolve
      })

      const concurrencyJob = defineJob({
        name: 'runtime-concurrency',
        input: z.object({
          id: z.string(),
          concurrencyKey: z.string(),
        }),
        run: async (step, input) => {
          if (activeKeys.has(input.concurrencyKey)) {
            overlapDetected = true
          }
          activeKeys.add(input.concurrencyKey)
          executionOrder.push(`start-${input.id}`)
          await step.run('work', async () => {
            if (input.id === '1') await firstHeld
          })
          executionOrder.push(`end-${input.id}`)
          activeKeys.delete(input.concurrencyKey)
        },
      })

      const runtimeA = createDurably({
        dialect: resource.createDialect(),
      }).register({
        job: concurrencyJob,
      })
      const runtimeB = createDurably({
        dialect: resource.createDialect(),
      }).register({
        job: concurrencyJob,
      })

      await runtimeA.migrate()
      await runtimeA.db.deleteFrom('durably_logs').execute()
      await runtimeA.db.deleteFrom('durably_steps').execute()
      await runtimeA.db.deleteFrom('durably_runs').execute()

      const firstRun = await runtimeA.jobs.job.trigger(
        { id: '1', concurrencyKey: 'group-1' },
        { concurrencyKey: 'group-1' },
      )

      const firstProcessing = runtimeA.processOne({ workerId: 'worker-a' })
      try {
        await vi.waitFor(
          async () => {
            const run = await runtimeA.jobs.job.getRun(firstRun.id)
            expect(run?.status).toBe('leased')
          },
          { timeout: 5_000 },
        )

        const secondRun = await runtimeA.jobs.job.trigger(
          { id: '2', concurrencyKey: 'group-1' },
          { concurrencyKey: 'group-1' },
        )

        const firstMid = await runtimeA.jobs.job.getRun(firstRun.id)
        const secondMid = await runtimeA.jobs.job.getRun(secondRun.id)
        expect(firstMid?.status).toBe('leased')
        expect(secondMid?.status).toBe('pending')

        const idleWhileBlocked = await runtimeB.processOne({
          workerId: 'worker-b',
        })
        expect(idleWhileBlocked).toBe(false)

        releaseFirst()
        await firstProcessing

        const drained = await runtimeA.processUntilIdle({
          workerId: 'worker-a',
        })
        const runs = await runtimeA.jobs.job.getRuns()

        expect(drained).toBe(1)
        expect(runs.every((run) => run.status === 'completed')).toBe(true)
        expect(overlapDetected).toBe(false)
        expect(executionOrder).toEqual(['start-1', 'end-1', 'start-2', 'end-2'])
      } finally {
        // A failed assertion above must not leave run 1 held forever.
        releaseFirst()
        await firstProcessing.catch(() => {})
        await Promise.all([runtimeA.db.destroy(), runtimeB.db.destroy()])
      }
    })

    it('concurrent active triggers across separate runtimes produce no duplicate pending work for the same active scope', async () => {
      for (let i = 0; i < 5; i++) {
        await runtimes[0].db.deleteFrom('durably_logs').execute()
        await runtimes[0].db.deleteFrom('durably_steps').execute()
        await runtimes[0].db.deleteFrom('durably_runs').execute()

        const results = await Promise.all(
          runtimes.map((runtime, idx) =>
            runtime.storage.enqueue({
              jobName: 'race-active-job',
              input: { idx },
              concurrencyKey: `active-scope-${i}`,
              coalesce: 'active',
            }),
          ),
        )

        const created = results.filter((r) => r.disposition === 'created')
        const coalesced = results.filter((r) => r.disposition === 'coalesced')

        expect(created).toHaveLength(1)
        expect(coalesced).toHaveLength(runtimes.length - 1)

        for (const c of coalesced) {
          expect(c.run.id).toBe(created[0].run.id)
        }

        const pending = await runtimes[0].storage.getRuns({
          jobName: 'race-active-job',
          status: 'pending',
        })
        expect(pending).toHaveLength(1)
      }
    })

    it('race between active trigger and worker claim produces one reusable active run and no trailing duplicate', async () => {
      for (let i = 0; i < 5; i++) {
        await runtimes[0].db.deleteFrom('durably_logs').execute()
        await runtimes[0].db.deleteFrom('durably_steps').execute()
        await runtimes[0].db.deleteFrom('durably_runs').execute()

        const { run: first } = await runtimes[0].storage.enqueue({
          jobName: 'race-claim-active',
          input: { initial: true },
          concurrencyKey: `claim-race-${i}`,
          coalesce: 'active',
        })

        const now = new Date().toISOString()
        const [claimResult, triggerResult] = await Promise.all([
          runtimes[1].storage.claimNext('worker-race', now, 30_000),
          runtimes[2].storage.enqueue({
            jobName: 'race-claim-active',
            input: { second: true },
            concurrencyKey: `claim-race-${i}`,
            coalesce: 'active',
          }),
        ])

        expect(triggerResult.disposition).toBe('coalesced')
        expect(triggerResult.run.id).toBe(first.id)

        const pending = await runtimes[0].storage.getRuns({
          jobName: 'race-claim-active',
          status: 'pending',
        })
        if (claimResult) {
          expect(pending).toHaveLength(0)
        } else {
          expect(pending).toHaveLength(1)
        }
      }
    })

    it('when predecessor lease has expired, active trigger may create a pending replacement and worker may reclaim predecessor', async () => {
      await runtimes[0].db.deleteFrom('durably_logs').execute()
      await runtimes[0].db.deleteFrom('durably_steps').execute()
      await runtimes[0].db.deleteFrom('durably_runs').execute()

      const { run: first } = await runtimes[0].storage.enqueue({
        jobName: 'expired-lease-job',
        input: { ordinal: 1 },
        concurrencyKey: 'expired-key-1',
      })

      const claimed = await runtimes[0].storage.claimNext(
        'worker-old',
        new Date().toISOString(),
        30_000,
      )
      expect(claimed?.id).toBe(first.id)

      await runtimes[0].storage.updateRun(first.id, {
        status: 'leased',
        leaseOwner: 'worker-old',
        leaseExpiresAt: new Date(Date.now() - 5000).toISOString(),
      })

      const triggerResult = await runtimes[1].storage.enqueue({
        jobName: 'expired-lease-job',
        input: { ordinal: 2 },
        concurrencyKey: 'expired-key-1',
        coalesce: 'active',
      })
      expect(triggerResult.disposition).toBe('created')
      expect(triggerResult.run.id).not.toBe(first.id)
      expect(triggerResult.run.status).toBe('pending')

      const reclaimed = await runtimes[2].storage.claimNext(
        'worker-new',
        new Date().toISOString(),
        30_000,
      )
      expect(reclaimed?.id).toBe(first.id)
    })

    it('concurrent batches using same keys in different orders complete without deadlock', async () => {
      await runtimes[0].db.deleteFrom('durably_logs').execute()
      await runtimes[0].db.deleteFrom('durably_steps').execute()
      await runtimes[0].db.deleteFrom('durably_runs').execute()

      for (let iter = 0; iter < 5; iter++) {
        const batchA = [
          {
            jobName: 'batch-deadlock-job',
            input: { a: 1 },
            concurrencyKey: `key-A-${iter}`,
            coalesce: 'active' as const,
          },
          {
            jobName: 'batch-deadlock-job',
            input: { b: 1 },
            concurrencyKey: `key-B-${iter}`,
            coalesce: 'active' as const,
          },
        ]
        const batchB = [
          {
            jobName: 'batch-deadlock-job',
            input: { b: 2 },
            concurrencyKey: `key-B-${iter}`,
            coalesce: 'active' as const,
          },
          {
            jobName: 'batch-deadlock-job',
            input: { a: 2 },
            concurrencyKey: `key-A-${iter}`,
            coalesce: 'active' as const,
          },
        ]

        const [resultsA, resultsB] = await Promise.all([
          runtimes[0].storage.enqueueMany(batchA),
          runtimes[1].storage.enqueueMany(batchB),
        ])

        expect(resultsA).toHaveLength(2)
        expect(resultsB).toHaveLength(2)
      }
    })

    const postgresMixedBatch = label === 'PostgreSQL' ? it : it.skip
    postgresMixedBatch(
      'mixed skip/active batches with reversed keys do not deadlock',
      { timeout: 15_000 },
      async () => {
        for (let iter = 0; iter < 5; iter++) {
          const keyA = `mixed-A-${iter}`
          const keyB = `mixed-B-${iter}`
          const [first, second] = await Promise.all([
            runtimes[0].storage.enqueueMany([
              {
                jobName: 'mixed-batch-job',
                input: { batch: 1, key: 'B' },
                concurrencyKey: keyB,
                coalesce: 'skip',
              },
              {
                jobName: 'mixed-batch-job',
                input: { batch: 1, key: 'A' },
                concurrencyKey: keyA,
                coalesce: 'active',
              },
            ]),
            runtimes[1].storage.enqueueMany([
              {
                jobName: 'mixed-batch-job',
                input: { batch: 2, key: 'A' },
                concurrencyKey: keyA,
                coalesce: 'skip',
              },
              {
                jobName: 'mixed-batch-job',
                input: { batch: 2, key: 'B' },
                concurrencyKey: keyB,
                coalesce: 'active',
              },
            ]),
          ])
          expect(first).toHaveLength(2)
          expect(second).toHaveLength(2)
          expect(
            [...first, ...second].filter(
              (item) => item.disposition === 'created',
            ),
          ).toHaveLength(2)
        }
      },
    )

    postgresMixedBatch(
      'active and skip-only batches with reversed keys do not deadlock',
      { timeout: 15_000 },
      async () => {
        for (let iter = 0; iter < 10; iter++) {
          const keyA = `asymmetric-A-${iter}`
          const keyB = `asymmetric-B-${iter}`
          const [active, skipOnly] = await Promise.all([
            runtimes[0].storage.enqueueMany([
              {
                jobName: 'asymmetric-batch-job',
                input: { batch: 'active', key: 'A' },
                concurrencyKey: keyA,
                coalesce: 'active',
              },
              {
                jobName: 'asymmetric-batch-job',
                input: { batch: 'active', key: 'B' },
                concurrencyKey: keyB,
                coalesce: 'active',
              },
            ]),
            runtimes[1].storage.enqueueMany([
              {
                jobName: 'asymmetric-batch-job',
                input: { batch: 'skip', key: 'B' },
                concurrencyKey: keyB,
                coalesce: 'skip',
              },
              {
                jobName: 'asymmetric-batch-job',
                input: { batch: 'skip', key: 'A' },
                concurrencyKey: keyA,
                coalesce: 'skip',
              },
            ]),
          ])
          expect(active).toHaveLength(2)
          expect(skipOnly).toHaveLength(2)
          expect(
            [...active, ...skipOnly].filter(
              (item) => item.disposition === 'created',
            ),
          ).toHaveLength(2)
        }
      },
    )

    postgresMixedBatch(
      'hash collisions cannot reverse PostgreSQL batch advisory lock order',
      { timeout: 15_000 },
      async () => {
        const lowFirst = 'key-048049'
        const lowSecond = 'key-385881'
        const highFirst = 'key-009165'
        const highSecond = 'key-305300'
        const hashResult = await sql<{
          low_first: number
          low_second: number
          high_first: number
          high_second: number
        }>`
          SELECT
            hashtext(${lowFirst}) AS low_first,
            hashtext(${lowSecond}) AS low_second,
            hashtext(${highFirst}) AS high_first,
            hashtext(${highSecond}) AS high_second
        `.execute(runtimes[0].db)
        const hashes = hashResult.rows[0]
        expect(hashes.low_first).toBe(hashes.low_second)
        expect(hashes.high_first).toBe(hashes.high_second)
        expect(hashes.low_first).not.toBe(hashes.high_first)

        for (let iter = 0; iter < 10; iter++) {
          const jobName = `collision-batch-job-${iter}`
          const [first, second] = await Promise.all([
            runtimes[0].storage.enqueueMany([
              {
                jobName,
                input: { batch: 1, key: 'low' },
                concurrencyKey: lowFirst,
                coalesce: 'active',
              },
              {
                jobName,
                input: { batch: 1, key: 'high' },
                concurrencyKey: highSecond,
                coalesce: 'active',
              },
            ]),
            runtimes[1].storage.enqueueMany([
              {
                jobName,
                input: { batch: 2, key: 'high' },
                concurrencyKey: highFirst,
                coalesce: 'active',
              },
              {
                jobName,
                input: { batch: 2, key: 'low' },
                concurrencyKey: lowSecond,
                coalesce: 'active',
              },
            ]),
          ])
          expect(first).toHaveLength(2)
          expect(second).toHaveLength(2)
          expect(
            [...first, ...second].every(
              (item) => item.disposition === 'created',
            ),
          ).toBe(true)
        }
      },
    )

    const postgresOnly = label === 'PostgreSQL' ? it : it.skip
    postgresOnly(
      'batch-vs-claim contention skips unavailable keys and leaves them claimable on a later poll',
      { timeout: 15_000 },
      async () => {
        const candidateA = 'batch-claim-a'
        const candidateB = 'batch-claim-b'
        const hashOrder = await sql<{ hash_a: number; hash_b: number }>`
          SELECT hashtext(${candidateA}) AS hash_a, hashtext(${candidateB}) AS hash_b
        `.execute(runtimes[0].db)
        const { hash_a: hashA, hash_b: hashB } = hashOrder.rows[0]
        expect(hashA).not.toBe(hashB)
        const [keyA, keyB] =
          hashA < hashB ? [candidateA, candidateB] : [candidateB, candidateA]
        await runtimes[0].storage.enqueue({
          jobName: 'batch-claim-job',
          input: { key: 'a' },
          concurrencyKey: keyA,
        })
        await runtimes[0].storage.enqueue({
          jobName: 'batch-claim-job',
          input: { key: 'b' },
          concurrencyKey: keyB,
        })

        let releaseKeyB!: () => void
        const holdKeyB = new Promise<void>((resolve) => {
          releaseKeyB = resolve
        })
        let keyBLocked!: () => void
        const keyBReady = new Promise<void>((resolve) => {
          keyBLocked = resolve
        })
        const blocker = runtimes[3].db.transaction().execute(async (trx) => {
          await sql`SELECT pg_advisory_xact_lock(hashtext(${keyB}))`.execute(
            trx,
          )
          keyBLocked()
          await holdKeyB
        })
        await keyBReady

        const batch = runtimes[0].storage.enqueueMany([
          {
            jobName: 'batch-claim-job',
            input: { key: 'a-batch' },
            concurrencyKey: keyA,
            coalesce: 'active',
          },
          {
            jobName: 'batch-claim-job',
            input: { key: 'b-batch' },
            concurrencyKey: keyB,
            coalesce: 'active',
          },
        ])

        // Wait until the batch owns key A and is blocked acquiring key B.
        let batchOwnsKeyA = false
        for (let attempt = 0; attempt < 100 && !batchOwnsKeyA; attempt++) {
          batchOwnsKeyA = await runtimes[2].db
            .transaction()
            .execute(async (trx) => {
              const result = await sql<{ acquired: boolean }>`
              SELECT pg_try_advisory_xact_lock(hashtext(${keyA})) AS acquired
            `.execute(trx)
              return result.rows[0]?.acquired === false
            })
          if (!batchOwnsKeyA)
            await new Promise((resolve) => setTimeout(resolve, 10))
        }
        expect(batchOwnsKeyA).toBe(true)

        const contestedClaim = await Promise.race([
          runtimes[1].storage.claimNext(
            'contested-worker',
            new Date().toISOString(),
            30_000,
          ),
          new Promise<'timed-out'>((resolve) =>
            setTimeout(() => resolve('timed-out'), 2_000),
          ),
        ])
        expect(contestedClaim).toBeNull()

        releaseKeyB()
        await Promise.all([blocker, batch])

        const laterClaim = await runtimes[1].storage.claimNext(
          'later-worker',
          new Date().toISOString(),
          30_000,
        )
        expect(laterClaim).not.toBeNull()
        expect([keyA, keyB]).toContain(laterClaim?.concurrencyKey)
      },
    )
  })
}
