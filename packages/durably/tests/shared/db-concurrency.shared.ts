import type { Dialect } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
              winner!.leaseOwner!,
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
              next.leaseOwner!,
              { attempt, drained: true },
              new Date().toISOString(),
            )
          }

          expect(winners.length + drained.length).toBe(3)
        }
      },
    )

    it('does not lease a later same-key run while an active lease exists', async () => {
      const first = await runtimes[0].storage.enqueue({
        jobName: 'same-key-1',
        input: { ordinal: 1 },
        concurrencyKey: 'group-1',
      })
      await runtimes[0].storage.enqueue({
        jobName: 'same-key-2',
        input: { ordinal: 2 },
        concurrencyKey: 'group-1',
      })
      const keyless = await runtimes[0].storage.enqueue({
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
      const first = await runtimes[0].storage.enqueue({
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
            await new Promise((resolve) => setTimeout(resolve, 75))
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

      await runtimeA.jobs.job.trigger(
        { id: '1', concurrencyKey: 'group-1' },
        { concurrencyKey: 'group-1' },
      )
      await runtimeA.jobs.job.trigger(
        { id: '2', concurrencyKey: 'group-1' },
        { concurrencyKey: 'group-1' },
      )

      const firstRound = await Promise.all([
        runtimeA.processOne({ workerId: 'worker-a' }),
        runtimeB.processOne({ workerId: 'worker-b' }),
      ])

      const drained = await runtimeA.processUntilIdle({ workerId: 'worker-a' })
      const runs = await runtimeA.jobs.job.getRuns()

      expect(firstRound.filter(Boolean)).toHaveLength(1)
      expect(drained).toBe(1)
      expect(runs.every((run) => run.status === 'completed')).toBe(true)
      expect(overlapDetected).toBe(false)
      expect(executionOrder).toEqual(['start-1', 'end-1', 'start-2', 'end-2'])

      await Promise.all([runtimeA.db.destroy(), runtimeB.db.destroy()])
    })
  })
}
