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
          async (context) => {
            await context.run('long-step', async () => {
              // Run long enough to see heartbeat updates
              await new Promise((r) => setTimeout(r, 250))
            })
          },
        )

        const run = await job.trigger({})
        const initialHeartbeat = run.heartbeatAt

        durably.start()

        // Wait a bit then check heartbeat was updated
        await new Promise((r) => setTimeout(r, 200))

        const midRun = await job.getRun(run.id)
        expect(midRun?.status).toBe('running')
        expect(new Date(midRun!.heartbeatAt).getTime()).toBeGreaterThan(
          new Date(initialHeartbeat).getTime(),
        )

        // Wait for completion
        await vi.waitFor(
          async () => {
            const updated = await job.getRun(run.id)
            expect(updated?.status).toBe('completed')
          },
          { timeout: 1000 },
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
          async (context) => {
            await context.run('step', async () => {
              // Record heartbeat timestamps during execution
              for (let i = 0; i < 3; i++) {
                const run = await customDurably.storage.getRun(context.runId)
                if (run) timestamps.push(run.heartbeatAt)
                await new Promise((r) => setTimeout(r, 100))
              }
            })
          },
        )

        const run = await job.trigger({})
        customDurably.start()

        await vi.waitFor(
          async () => {
            const updated = await job.getRun(run.id)
            expect(updated?.status).toBe('completed')
          },
          { timeout: 2000 },
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
          async () => {},
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
          { timeout: 1000 },
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
          async (context) => {
            await context.run('step1', () => {
              step1Calls++
              return 'step1-done'
            })
            await context.run('step2', () => {
              step2Calls++
              return 'step2-done'
            })
          },
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
          startedAt: new Date().toISOString(),
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
          { timeout: 1000 },
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
          async (_context, payload) => {
            if (payload.shouldFail) {
              throw new Error('Intentional failure')
            }
          },
        )

        const run = await job.trigger({ shouldFail: true })
        durably.start()

        await vi.waitFor(
          async () => {
            const updated = await job.getRun(run.id)
            expect(updated?.status).toBe('failed')
          },
          { timeout: 1000 },
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
          async () => {},
        )

        const run = await job.trigger({})
        durably.start()

        await vi.waitFor(
          async () => {
            const updated = await job.getRun(run.id)
            expect(updated?.status).toBe('completed')
          },
          { timeout: 1000 },
        )

        await expect(durably.retry(run.id)).rejects.toThrow(
          /completed|cannot retry/i,
        )
      })

      it('throws when retrying pending run', async () => {
        const job = durably.defineJob(
          {
            name: 'retry-pending-test',
            input: z.object({}),
          },
          async () => {},
        )

        const run = await job.trigger({})
        // Don't start worker - run stays pending

        await expect(durably.retry(run.id)).rejects.toThrow(
          /pending|cannot retry/i,
        )
      })

      it('throws when retrying running run', async () => {
        const job = durably.defineJob(
          {
            name: 'retry-running-test',
            input: z.object({}),
          },
          async (context) => {
            await context.run('long-step', async () => {
              await new Promise((r) => setTimeout(r, 500))
            })
          },
        )

        const run = await job.trigger({})
        durably.start()

        // Wait until running
        await vi.waitFor(
          async () => {
            const updated = await job.getRun(run.id)
            expect(updated?.status).toBe('running')
          },
          { timeout: 500 },
        )

        await expect(durably.retry(run.id)).rejects.toThrow(
          /running|cannot retry/i,
        )
      })
    })

    describe('cancel() API', () => {
      it('cancels pending run', async () => {
        const job = durably.defineJob(
          {
            name: 'cancel-pending-test',
            input: z.object({}),
          },
          async () => {},
        )

        const run = await job.trigger({})
        // Don't start worker - run stays pending

        await durably.cancel(run.id)

        const cancelled = await job.getRun(run.id)
        expect(cancelled?.status).toBe('cancelled')
      })

      it('cancels running run immediately', async () => {
        const job = durably.defineJob(
          {
            name: 'cancel-running-test',
            input: z.object({}),
          },
          async (context) => {
            await context.run('step1', async () => {
              await new Promise((r) => setTimeout(r, 500))
              return 'done'
            })
          },
        )

        const run = await job.trigger({})
        durably.start()

        // Wait until running
        await vi.waitFor(
          async () => {
            const updated = await job.getRun(run.id)
            expect(updated?.status).toBe('running')
          },
          { timeout: 500 },
        )

        // Cancel while running - marks as cancelled immediately
        await durably.cancel(run.id)

        const cancelled = await job.getRun(run.id)
        expect(cancelled?.status).toBe('cancelled')
      })

      it('throws when cancelling completed run', async () => {
        const job = durably.defineJob(
          {
            name: 'cancel-completed-test',
            input: z.object({}),
          },
          async () => {},
        )

        const run = await job.trigger({})
        durably.start()

        await vi.waitFor(
          async () => {
            const updated = await job.getRun(run.id)
            expect(updated?.status).toBe('completed')
          },
          { timeout: 1000 },
        )

        await expect(durably.cancel(run.id)).rejects.toThrow(
          /completed|cannot cancel/i,
        )
      })

      it('throws when cancelling failed run', async () => {
        const job = durably.defineJob(
          {
            name: 'cancel-failed-test',
            input: z.object({}),
          },
          async () => {
            throw new Error('fail')
          },
        )

        const run = await job.trigger({})
        durably.start()

        await vi.waitFor(
          async () => {
            const updated = await job.getRun(run.id)
            expect(updated?.status).toBe('failed')
          },
          { timeout: 1000 },
        )

        await expect(durably.cancel(run.id)).rejects.toThrow(
          /failed|cannot cancel/i,
        )
      })

      it('throws when cancelling already cancelled run', async () => {
        const job = durably.defineJob(
          {
            name: 'cancel-cancelled-test',
            input: z.object({}),
          },
          async () => {},
        )

        const run = await job.trigger({})
        await durably.cancel(run.id)

        await expect(durably.cancel(run.id)).rejects.toThrow(
          /cancelled|cannot cancel/i,
        )
      })

      it('throws when run does not exist', async () => {
        await expect(durably.cancel('non-existent-id')).rejects.toThrow(
          /not found/i,
        )
      })

      it('stops execution before next step when cancelled during run', async () => {
        let step1Executed = false
        let step2Executed = false
        let step3Executed = false

        const job = durably.defineJob(
          {
            name: 'cancel-mid-execution-test',
            input: z.object({}),
          },
          async (context) => {
            await context.run('step1', async () => {
              step1Executed = true
              // Give time for cancellation to be triggered
              await new Promise((r) => setTimeout(r, 100))
              return 'step1'
            })
            await context.run('step2', async () => {
              step2Executed = true
              return 'step2'
            })
            await context.run('step3', async () => {
              step3Executed = true
              return 'step3'
            })
          },
        )

        const run = await job.trigger({})
        durably.start()

        // Wait until running
        await vi.waitFor(
          async () => {
            const updated = await job.getRun(run.id)
            expect(updated?.status).toBe('running')
          },
          { timeout: 500 },
        )

        // Cancel while step1 is executing
        await durably.cancel(run.id)

        // Wait for worker to finish processing
        await new Promise((r) => setTimeout(r, 200))

        // Run should stay cancelled (not overwritten to completed)
        const finalRun = await job.getRun(run.id)
        expect(finalRun?.status).toBe('cancelled')

        // step1 was executed (was in progress when cancelled)
        expect(step1Executed).toBe(true)
        // step2 and step3 should NOT have executed (cancelled before they started)
        expect(step2Executed).toBe(false)
        expect(step3Executed).toBe(false)
      })

      it('does not overwrite cancelled status with completed', async () => {
        const job = durably.defineJob(
          {
            name: 'cancel-no-overwrite-test',
            input: z.object({}),
          },
          async (context) => {
            await context.run('step1', async () => {
              await new Promise((r) => setTimeout(r, 150))
              return 'done'
            })
          },
        )

        const run = await job.trigger({})
        durably.start()

        // Wait until running
        await vi.waitFor(
          async () => {
            const updated = await job.getRun(run.id)
            expect(updated?.status).toBe('running')
          },
          { timeout: 500 },
        )

        // Cancel while step is executing
        await durably.cancel(run.id)

        // Wait for step to complete naturally
        await new Promise((r) => setTimeout(r, 300))

        // Status should remain cancelled even though job function returned normally
        const finalRun = await job.getRun(run.id)
        expect(finalRun?.status).toBe('cancelled')
      })
    })

    describe('deleteRun() API', () => {
      it('deletes completed run with its steps and logs', async () => {
        const job = durably.defineJob(
          {
            name: 'delete-completed-test',
            input: z.object({}),
          },
          async (context) => {
            context.log.info('test log')
            await context.run('step1', () => 'done')
          },
        )

        const run = await job.trigger({})
        durably.start()

        await vi.waitFor(
          async () => {
            const updated = await job.getRun(run.id)
            expect(updated?.status).toBe('completed')
          },
          { timeout: 1000 },
        )

        // Verify steps and logs exist
        const steps = await durably.storage.getSteps(run.id)
        expect(steps.length).toBeGreaterThan(0)

        // Delete the run
        await durably.deleteRun(run.id)

        // Run should be gone
        const deleted = await job.getRun(run.id)
        expect(deleted).toBeNull()

        // Steps should also be deleted
        const deletedSteps = await durably.storage.getSteps(run.id)
        expect(deletedSteps.length).toBe(0)
      })

      it('deletes failed run', async () => {
        const job = durably.defineJob(
          {
            name: 'delete-failed-test',
            input: z.object({}),
          },
          async () => {
            throw new Error('fail')
          },
        )

        const run = await job.trigger({})
        durably.start()

        await vi.waitFor(
          async () => {
            const updated = await job.getRun(run.id)
            expect(updated?.status).toBe('failed')
          },
          { timeout: 1000 },
        )

        await durably.deleteRun(run.id)

        const deleted = await job.getRun(run.id)
        expect(deleted).toBeNull()
      })

      it('deletes cancelled run', async () => {
        const job = durably.defineJob(
          {
            name: 'delete-cancelled-test',
            input: z.object({}),
          },
          async () => {},
        )

        const run = await job.trigger({})
        await durably.cancel(run.id)

        await durably.deleteRun(run.id)

        const deleted = await job.getRun(run.id)
        expect(deleted).toBeNull()
      })

      it('throws when deleting pending run', async () => {
        const job = durably.defineJob(
          {
            name: 'delete-pending-test',
            input: z.object({}),
          },
          async () => {},
        )

        const run = await job.trigger({})
        // Don't start worker - run stays pending

        await expect(durably.deleteRun(run.id)).rejects.toThrow(
          /pending|cannot delete/i,
        )
      })

      it('throws when deleting running run', async () => {
        const job = durably.defineJob(
          {
            name: 'delete-running-test',
            input: z.object({}),
          },
          async (context) => {
            await context.run('long-step', async () => {
              await new Promise((r) => setTimeout(r, 500))
            })
          },
        )

        const run = await job.trigger({})
        durably.start()

        await vi.waitFor(
          async () => {
            const updated = await job.getRun(run.id)
            expect(updated?.status).toBe('running')
          },
          { timeout: 500 },
        )

        await expect(durably.deleteRun(run.id)).rejects.toThrow(
          /running|cannot delete/i,
        )
      })

      it('throws when run does not exist', async () => {
        await expect(durably.deleteRun('non-existent-id')).rejects.toThrow(
          /not found/i,
        )
      })
    })
  })
}
