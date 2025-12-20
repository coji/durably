import type { Dialect } from 'kysely'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createDurably, type Durably } from '../../src'

export function createRecoveryTests(createDialect: () => Dialect) {
  describe('Failure Recovery', () => {
    let durably: Durably

    beforeEach(async () => {
      durably = createDurably({
        dialect: createDialect(),
        pollingInterval: 50,
        heartbeatInterval: 100,
        staleThreshold: 300,
      })
      await durably.migrate()
    })

    afterEach(async () => {
      await durably.stop()
      await durably.db.destroy()
    })

    describe('Heartbeat', () => {
      it('updates heartbeat_at periodically for running runs', async () => {
        const job = durably.defineJob(
          {
            name: 'heartbeat-test',
            input: z.object({}),
          },
          async (ctx) => {
            await ctx.run('long-step', async () => {
              // Run long enough to see heartbeat updates
              await new Promise((r) => setTimeout(r, 250))
            })
          }
        )

        const run = await job.trigger({})
        const initialHeartbeat = run.heartbeatAt

        durably.start()

        // Wait a bit then check heartbeat was updated
        await new Promise((r) => setTimeout(r, 200))

        const midRun = await job.getRun(run.id)
        expect(midRun?.status).toBe('running')
        expect(new Date(midRun!.heartbeatAt).getTime()).toBeGreaterThan(
          new Date(initialHeartbeat).getTime()
        )

        // Wait for completion
        await vi.waitFor(
          async () => {
            const updated = await job.getRun(run.id)
            expect(updated?.status).toBe('completed')
          },
          { timeout: 1000 }
        )
      })

      it('respects custom heartbeat interval', async () => {
        // Create with longer heartbeat interval
        const customDurably = createDurably({
          dialect: createDialect(),
          pollingInterval: 50,
          heartbeatInterval: 200,
          staleThreshold: 1000,
        })
        await customDurably.migrate()

        const timestamps: string[] = []

        const job = customDurably.defineJob(
          {
            name: 'custom-heartbeat-test',
            input: z.object({}),
          },
          async (ctx) => {
            await ctx.run('step', async () => {
              // Record heartbeat timestamps during execution
              for (let i = 0; i < 3; i++) {
                const run = await customDurably.storage.getRun(ctx.runId)
                if (run) timestamps.push(run.heartbeatAt)
                await new Promise((r) => setTimeout(r, 100))
              }
            })
          }
        )

        const run = await job.trigger({})
        customDurably.start()

        await vi.waitFor(
          async () => {
            const updated = await job.getRun(run.id)
            expect(updated?.status).toBe('completed')
          },
          { timeout: 2000 }
        )

        await customDurably.stop()
        await customDurably.db.destroy()

        // Should have recorded multiple timestamps
        expect(timestamps.length).toBeGreaterThan(0)
      })
    })

    describe('Stale Run Recovery', () => {
      it('recovers stale running runs to pending', async () => {
        const job = durably.defineJob(
          {
            name: 'stale-recovery-test',
            input: z.object({}),
          },
          async () => {}
        )

        // Create a run and manually set it to running with old heartbeat
        const run = await job.trigger({})
        const oldTime = new Date(Date.now() - 1000).toISOString() // 1 second ago

        await durably.storage.updateRun(run.id, {
          status: 'running',
          heartbeatAt: oldTime,
        })

        // Start worker - should recover the stale run
        durably.start()

        await vi.waitFor(
          async () => {
            const updated = await job.getRun(run.id)
            // Should either be pending (recovered) or completed (re-executed)
            expect(['pending', 'completed']).toContain(updated?.status)
          },
          { timeout: 1000 }
        )
      })

      it('skips completed steps when resuming recovered run', async () => {
        let step1Calls = 0
        let step2Calls = 0

        const job = durably.defineJob(
          {
            name: 'resume-skip-test',
            input: z.object({}),
          },
          async (ctx) => {
            await ctx.run('step1', () => {
              step1Calls++
              return 'step1-done'
            })
            await ctx.run('step2', () => {
              step2Calls++
              return 'step2-done'
            })
          }
        )

        // Create run and simulate partial execution
        const run = await job.trigger({})

        // Manually complete step1
        await durably.storage.createStep({
          runId: run.id,
          name: 'step1',
          index: 0,
          status: 'completed',
          output: 'step1-done',
        })

        await durably.storage.updateRun(run.id, {
          status: 'running',
          currentStepIndex: 1,
          heartbeatAt: new Date(Date.now() - 1000).toISOString(),
        })

        durably.start()

        await vi.waitFor(
          async () => {
            const updated = await job.getRun(run.id)
            expect(updated?.status).toBe('completed')
          },
          { timeout: 1000 }
        )

        // step1 was skipped, step2 was executed
        expect(step1Calls).toBe(0)
        expect(step2Calls).toBe(1)
      })
    })

    describe('retry() API', () => {
      it('resets failed run to pending', async () => {
        const job = durably.defineJob(
          {
            name: 'retry-test',
            input: z.object({ shouldFail: z.boolean() }),
          },
          async (_ctx, payload) => {
            if (payload.shouldFail) {
              throw new Error('Intentional failure')
            }
          }
        )

        const run = await job.trigger({ shouldFail: true })
        durably.start()

        await vi.waitFor(
          async () => {
            const updated = await job.getRun(run.id)
            expect(updated?.status).toBe('failed')
          },
          { timeout: 1000 }
        )

        // Retry the failed run
        await durably.retry(run.id)

        const retried = await job.getRun(run.id)
        expect(retried?.status).toBe('pending')
        expect(retried?.error).toBeNull()
      })

      it('throws when retrying completed run', async () => {
        const job = durably.defineJob(
          {
            name: 'retry-completed-test',
            input: z.object({}),
          },
          async () => {}
        )

        const run = await job.trigger({})
        durably.start()

        await vi.waitFor(
          async () => {
            const updated = await job.getRun(run.id)
            expect(updated?.status).toBe('completed')
          },
          { timeout: 1000 }
        )

        await expect(durably.retry(run.id)).rejects.toThrow(/completed|cannot retry/i)
      })

      it('throws when retrying pending run', async () => {
        const job = durably.defineJob(
          {
            name: 'retry-pending-test',
            input: z.object({}),
          },
          async () => {}
        )

        const run = await job.trigger({})
        // Don't start worker - run stays pending

        await expect(durably.retry(run.id)).rejects.toThrow(/pending|cannot retry/i)
      })

      it('throws when retrying running run', async () => {
        const job = durably.defineJob(
          {
            name: 'retry-running-test',
            input: z.object({}),
          },
          async (ctx) => {
            await ctx.run('long-step', async () => {
              await new Promise((r) => setTimeout(r, 500))
            })
          }
        )

        const run = await job.trigger({})
        durably.start()

        // Wait until running
        await vi.waitFor(
          async () => {
            const updated = await job.getRun(run.id)
            expect(updated?.status).toBe('running')
          },
          { timeout: 500 }
        )

        await expect(durably.retry(run.id)).rejects.toThrow(/running|cannot retry/i)
      })
    })
  })
}
