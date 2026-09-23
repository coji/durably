import type { Dialect } from 'kysely'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { createDurably, defineJob, type Durably } from '../../src'
import { createDeferred, expireLease, untilAborted } from '../helpers/sync'

export function createRecoveryTests(createDialect: () => Dialect) {
  describe('Failure Recovery', () => {
    let durably: Durably

    beforeEach(async () => {
      durably = createDurably({
        dialect: createDialect(),
        pollingIntervalMs: 50,
        leaseRenewIntervalMs: 100,
        // Long enough that a stalled runner never loses a lease by accident;
        // tests that need a lost lease end it with expireLease()
        leaseMs: 30_000,
      })
      await durably.migrate()
    })

    afterEach(async () => {
      await durably.stop()
      await durably.db.destroy()
    })

    describe('Lease Renewal', () => {
      it('renews lease periodically for leased runs', async () => {
        // Hold the step until a renewal has been observed
        const release = createDeferred()
        const d = durably.register({
          job: defineJob({
            name: 'lease-renewal-test',
            input: z.object({}),
            run: async (step) => {
              await step.run('long-step', () => release.promise)
            },
          }),
        })

        const run = await d.jobs.job.trigger({})
        expect(run.leaseExpiresAt).toBeNull() // pending run has no lease

        d.start()

        try {
          // Wait for run to be claimed, then record initial lease
          let initialLeaseExpiresAt: string | null = null
          await vi.waitFor(
            async () => {
              const claimed = await d.jobs.job.getRun(run.id)
              expect(claimed?.status).toBe('leased')
              initialLeaseExpiresAt = claimed!.leaseExpiresAt
            },
            { timeout: 5_000 },
          )

          // Wait for a renewal to push the lease expiry forward
          await vi.waitFor(
            async () => {
              const midRun = await d.jobs.job.getRun(run.id)
              expect(midRun?.status).toBe('leased')
              expect(
                new Date(midRun!.leaseExpiresAt!).getTime(),
              ).toBeGreaterThan(new Date(initialLeaseExpiresAt!).getTime())
            },
            { timeout: 5_000 },
          )
        } finally {
          release.resolve()
        }

        // Wait for completion
        await vi.waitFor(
          async () => {
            const updated = await d.jobs.job.getRun(run.id)
            expect(updated?.status).toBe('completed')
          },
          { timeout: 5_000 },
        )
      })

      it('respects custom lease renewal interval', async () => {
        // Create with longer lease renewal interval
        const customDurably = createDurably({
          dialect: createDialect(),
          pollingIntervalMs: 50,
          leaseRenewIntervalMs: 200,
          leaseMs: 1000,
        })
        await customDurably.migrate()

        const timestamps: string[] = []

        const d = customDurably.register({
          job: defineJob({
            name: 'custom-lease-renewal-test',
            input: z.object({}),
            run: async (step) => {
              await step.run('step', async () => {
                // Record lease expiry timestamps during execution
                for (let i = 0; i < 3; i++) {
                  const run = await customDurably.storage.getRun(step.runId)
                  if (run) timestamps.push(run.leaseExpiresAt ?? '')
                  // sleep-ok(work): spaces the samples out; the test only
                  // asserts that at least one sample was recorded
                  await new Promise((r) => setTimeout(r, 100))
                }
              })
            },
          }),
        })

        const run = await d.jobs.job.trigger({})
        d.start()

        await vi.waitFor(
          async () => {
            const updated = await d.jobs.job.getRun(run.id)
            expect(updated?.status).toBe('completed')
          },
          { timeout: 5_000 },
        )

        await d.stop()
        await customDurably.db.destroy()

        // Should have recorded multiple timestamps
        expect(timestamps.length).toBeGreaterThan(0)
      })

      it('rejects renewal after lease has expired', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'expired-renewal-test',
            input: z.object({}),
            run: async () => {},
          }),
        })

        const run = await d.jobs.job.trigger({})

        // Claim the run to get a valid leaseGeneration
        const claimed = await d.storage.claimNext(
          'worker-1',
          new Date().toISOString(),
          30_000,
        )
        const gen = claimed!.leaseGeneration

        // Manually expire the lease
        const pastTime = new Date(Date.now() - 5000).toISOString()
        await d.storage.updateRun(run.id, {
          leaseExpiresAt: pastTime,
        })

        // Attempt to renew — should fail because lease already expired
        const renewed = await d.storage.renewLease(
          run.id,
          gen,
          new Date().toISOString(),
          30000,
        )
        expect(renewed).toBe(false)
      })
    })

    describe('Stale Run Recovery', () => {
      it('recovers stale leased runs to pending', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'stale-recovery-test',
            input: z.object({}),
            run: async () => {},
          }),
        })

        // Create a run and manually set it to leased with expired lease
        const run = await d.jobs.job.trigger({})
        const oldTime = new Date(Date.now() - 1000).toISOString() // 1 second ago

        await d.storage.updateRun(run.id, {
          status: 'leased',
          leaseExpiresAt: oldTime,
        })

        // Start worker - should recover the stale run
        d.start()

        await vi.waitFor(
          async () => {
            const updated = await d.jobs.job.getRun(run.id)
            // Should either be pending (recovered) or completed (re-executed)
            expect(['pending', 'completed']).toContain(updated?.status)
          },
          { timeout: 5_000 },
        )
      })

      it('skips completed steps when resuming recovered run', async () => {
        let step1Calls = 0
        let step2Calls = 0

        const d = durably.register({
          job: defineJob({
            name: 'resume-skip-test',
            input: z.object({}),
            run: async (step) => {
              await step.run('step1', () => {
                step1Calls++
                return 'step1-done'
              })
              await step.run('step2', () => {
                step2Calls++
                return 'step2-done'
              })
            },
          }),
        })

        // Create run and simulate partial execution
        const run = await d.jobs.job.trigger({})

        // Claim the run so we have a valid leaseGeneration
        const claimed = await d.storage.claimNext(
          'worker-1',
          new Date().toISOString(),
          30_000,
        )
        const gen = claimed!.leaseGeneration

        // Manually complete step1 via persistStep
        await d.storage.persistStep(run.id, gen, {
          name: 'step1',
          index: 0,
          status: 'completed',
          output: 'step1-done',
          startedAt: new Date().toISOString(),
        })

        // Expire the lease so it can be reclaimed
        await d.storage.updateRun(run.id, {
          leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
        })

        d.start()

        await vi.waitFor(
          async () => {
            const updated = await d.jobs.job.getRun(run.id)
            expect(updated?.status).toBe('completed')
          },
          { timeout: 5_000 },
        )

        // step1 was skipped, step2 was executed
        expect(step1Calls).toBe(0)
        expect(step2Calls).toBe(1)
      })
    })

    describe('Step preservation on lease loss', () => {
      it('preserves steps when lease is lost mid-execution', async () => {
        let step2Started = false
        let leaseLost = false
        // Holds a re-execution after the worker reclaims the expired run, so
        // the run cannot complete (and clean up its steps) before the check.
        // Releasing it also ends the first execution if the abort never
        // comes, so stop() can finish when the test fails.
        const release = createDeferred()
        let step2Calls = 0
        const d = durably.register({
          job: defineJob({
            name: 'lease-loss-steps-test',
            input: z.object({}),
            run: async (step) => {
              await step.run('step1', () => 'result-1')
              await step.run('step2', async (signal) => {
                step2Calls++
                if (step2Calls === 1) {
                  step2Started = true
                  // Stay in the step until the worker notices the lost lease
                  await Promise.race([untilAborted(signal), release.promise])
                  leaseLost = signal.aborted
                }
                await release.promise
                return 'result-2'
              })
            },
          }),
        })

        const run = await d.jobs.job.trigger({})
        d.start()

        try {
          // step1 is persisted once step2 has started
          await vi.waitFor(() => expect(step2Started).toBe(true), {
            timeout: 5_000,
          })

          // Expire the lease to simulate lease loss
          await expireLease(d, run.id)

          // Wait for worker to detect lease loss
          await vi.waitFor(() => expect(leaseLost).toBe(true), {
            timeout: 5_000,
          })

          // Steps from before lease loss should still exist
          const steps = await d.storage.getSteps(run.id)
          expect(steps.length).toBeGreaterThanOrEqual(1)
          expect(steps.find((s) => s.name === 'step1')?.output).toBe('result-1')
        } finally {
          release.resolve()
        }
      })
    })

    describe('Step write guard on lease generation', () => {
      it('rejects persistStep when lease generation does not match', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'step-guard-test',
            input: z.object({}),
            run: async () => {},
          }),
        })

        const run = await d.jobs.job.trigger({})

        // worker-a claims the run (generation increments to 1)
        const claimA = await d.storage.claimNext(
          'worker-a',
          new Date().toISOString(),
          30_000,
        )
        const genA = claimA!.leaseGeneration

        // worker-a creates a step (should succeed)
        const step1 = await d.storage.persistStep(run.id, genA, {
          name: 'guarded-step',
          index: 0,
          status: 'completed',
          output: 'ok',
          startedAt: new Date().toISOString(),
        })
        expect(step1).not.toBeNull()

        // Expire lease and let worker-b reclaim (generation increments to 2)
        await d.storage.updateRun(run.id, {
          leaseExpiresAt: new Date(Date.now() - 1000).toISOString(),
        })
        const claimB = await d.storage.claimNext(
          'worker-b',
          new Date().toISOString(),
          30_000,
        )
        expect(claimB).not.toBeNull()

        // Stale worker-a tries to create another step with old generation (should be rejected)
        const step2 = await d.storage.persistStep(run.id, genA, {
          name: 'stale-step',
          index: 1,
          status: 'completed',
          output: 'should-not-exist',
          startedAt: new Date().toISOString(),
        })
        expect(step2).toBeNull()

        // Verify the stale step was NOT written
        const steps = await d.storage.getSteps(run.id)
        expect(steps).toHaveLength(1)
        expect(steps[0].name).toBe('guarded-step')
      })

      it('persistStep atomically advances step index for completed steps', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'advance-guard-test',
            input: z.object({}),
            run: async () => {},
          }),
        })

        const run = await d.jobs.job.trigger({})

        // Claim the run
        const claimed = await d.storage.claimNext(
          'worker-a',
          new Date().toISOString(),
          30_000,
        )
        const gen = claimed!.leaseGeneration

        // persistStep with status=completed should advance currentStepIndex
        await d.storage.persistStep(run.id, gen, {
          name: 'step-1',
          index: 0,
          status: 'completed',
          output: 'ok',
          startedAt: new Date().toISOString(),
        })

        const updated = await d.storage.getRun(run.id)
        expect(updated?.currentStepIndex).toBe(1)

        // persistStep with status=failed should NOT advance currentStepIndex
        await d.storage.persistStep(run.id, gen, {
          name: 'step-2',
          index: 1,
          status: 'failed',
          error: 'oops',
          startedAt: new Date().toISOString(),
        })

        const afterFail = await d.storage.getRun(run.id)
        expect(afterFail?.currentStepIndex).toBe(1)
      })
    })

    describe('retrigger() API', () => {
      it('creates a fresh run from a failed run', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'retrigger-test',
            input: z.object({ shouldFail: z.boolean() }),
            run: async (_step, input) => {
              if (input.shouldFail) {
                throw new Error('Intentional failure')
              }
            },
          }),
        })

        const run = await d.jobs.job.trigger({ shouldFail: true })
        d.start()

        await vi.waitFor(
          async () => {
            const updated = await d.jobs.job.getRun(run.id)
            expect(updated?.status).toBe('failed')
          },
          { timeout: 5_000 },
        )

        const retriggered = await d.retrigger(run.id)
        expect(retriggered.id).not.toBe(run.id)
        expect(retriggered.status).toBe('pending')
        expect(retriggered.input).toEqual({ shouldFail: true })
      })

      it('creates a fresh run from a completed run', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'retrigger-completed-test',
            input: z.object({}),
            run: async () => {},
          }),
        })

        const run = await d.jobs.job.trigger({})
        d.start()

        await vi.waitFor(
          async () => {
            const updated = await d.jobs.job.getRun(run.id)
            expect(updated?.status).toBe('completed')
          },
          { timeout: 5_000 },
        )

        const retriggered = await d.retrigger(run.id)
        expect(retriggered.id).not.toBe(run.id)
        expect(retriggered.status).toBe('pending')
      })

      it('throws when retriggering pending run', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'retrigger-pending-test',
            input: z.object({}),
            run: async () => {},
          }),
        })

        const run = await d.jobs.job.trigger({})
        // Don't start worker - run stays pending

        await expect(d.retrigger(run.id)).rejects.toThrow(
          /pending|cannot retrigger/i,
        )
      })

      it('throws when input does not match current schema', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'retrigger-schema-test',
            input: z.object({ name: z.string(), age: z.number() }),
            run: async () => {},
          }),
        })

        // Create a run, then simulate schema evolution by overwriting
        // the stored input with data incompatible with the current schema
        const run = await d.jobs.job.trigger({ name: 'Alice', age: 30 })
        await d.db
          .updateTable('durably_runs')
          .set({ input: JSON.stringify({ name: 'Alice' }), status: 'failed' })
          .where('id', '=', run.id)
          .execute()

        await expect(d.retrigger(run.id)).rejects.toThrow(/Cannot retrigger/)
      })

      it('throws when retriggering leased run', async () => {
        // Hold the job so the run is still leased when retrigger is called
        const release = createDeferred()
        const d = durably.register({
          job: defineJob({
            name: 'retrigger-running-test',
            input: z.object({}),
            run: async (step) => {
              await step.run('long-step', () => release.promise)
            },
          }),
        })

        const run = await d.jobs.job.trigger({})
        d.start()

        try {
          // Wait until running
          await vi.waitFor(
            async () => {
              const updated = await d.jobs.job.getRun(run.id)
              expect(updated?.status).toBe('leased')
            },
            { timeout: 5_000 },
          )

          await expect(d.retrigger(run.id)).rejects.toThrow(
            /leased|running|cannot retrigger/i,
          )
        } finally {
          release.resolve()
        }
      })
    })

    describe('cancel() API', () => {
      it('cancels pending run', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'cancel-pending-test',
            input: z.object({}),
            run: async () => {},
          }),
        })

        const run = await d.jobs.job.trigger({})
        // Don't start worker - run stays pending

        await d.cancel(run.id)

        const cancelled = await d.jobs.job.getRun(run.id)
        expect(cancelled?.status).toBe('cancelled')
      })

      it('cancels leased run immediately', async () => {
        // Hold the job so the run is still leased when cancel is called
        const release = createDeferred()
        const d = durably.register({
          job: defineJob({
            name: 'cancel-running-test',
            input: z.object({}),
            run: async (step) => {
              await step.run('step1', async () => {
                await release.promise
                return 'done'
              })
            },
          }),
        })

        const run = await d.jobs.job.trigger({})
        d.start()

        try {
          // Wait until running
          await vi.waitFor(
            async () => {
              const updated = await d.jobs.job.getRun(run.id)
              expect(updated?.status).toBe('leased')
            },
            { timeout: 5_000 },
          )

          // Cancel while running - marks as cancelled immediately
          await d.cancel(run.id)

          const cancelled = await d.jobs.job.getRun(run.id)
          expect(cancelled?.status).toBe('cancelled')
        } finally {
          release.resolve()
        }
      })

      it('throws when cancelling completed run', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'cancel-completed-test',
            input: z.object({}),
            run: async () => {},
          }),
        })

        const run = await d.jobs.job.trigger({})
        d.start()

        await vi.waitFor(
          async () => {
            const updated = await d.jobs.job.getRun(run.id)
            expect(updated?.status).toBe('completed')
          },
          { timeout: 5_000 },
        )

        await expect(d.cancel(run.id)).rejects.toThrow(
          /completed|cannot cancel/i,
        )
      })

      it('throws when cancelling failed run', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'cancel-failed-test',
            input: z.object({}),
            run: async () => {
              throw new Error('fail')
            },
          }),
        })

        const run = await d.jobs.job.trigger({})
        d.start()

        await vi.waitFor(
          async () => {
            const updated = await d.jobs.job.getRun(run.id)
            expect(updated?.status).toBe('failed')
          },
          { timeout: 5_000 },
        )

        await expect(d.cancel(run.id)).rejects.toThrow(/failed|cannot cancel/i)
      })

      it('throws when cancelling already cancelled run', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'cancel-cancelled-test',
            input: z.object({}),
            run: async () => {},
          }),
        })

        const run = await d.jobs.job.trigger({})
        await d.cancel(run.id)

        await expect(d.cancel(run.id)).rejects.toThrow(
          /cancelled|cannot cancel/i,
        )
      })

      it('throws when run does not exist', async () => {
        await expect(durably.cancel('non-existent-id')).rejects.toThrow(
          /not found/i,
        )
      })

      it('throws when run completes between check and cancel', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'cancel-race-test',
            input: z.object({}),
            run: async () => {},
          }),
        })

        const run = await d.jobs.job.trigger({})
        d.start()

        await vi.waitFor(
          async () => {
            const updated = await d.jobs.job.getRun(run.id)
            expect(updated?.status).toBe('completed')
          },
          { timeout: 5_000 },
        )

        // Directly call cancelRun on queue store — bypasses the status pre-check
        // to verify the SQL-level guard works
        const cancelled = await d.storage.cancelRun(
          run.id,
          new Date().toISOString(),
        )
        expect(cancelled).toBe(false)

        // Run should still be completed, not overwritten
        const finalRun = await d.jobs.job.getRun(run.id)
        expect(finalRun?.status).toBe('completed')
      })

      it('stops execution before next step when cancelled during run', async () => {
        let step1Executed = false
        let step2Executed = false
        let step3Executed = false
        let step1Started = false
        const release = createDeferred()

        const d = durably.register({
          job: defineJob({
            name: 'cancel-mid-execution-test',
            input: z.object({}),
            run: async (step) => {
              await step.run('step1', async () => {
                step1Executed = true
                step1Started = true
                // Hold step1 until the test has cancelled the run
                await release.promise
                return 'step1'
              })
              await step.run('step2', async () => {
                step2Executed = true
                return 'step2'
              })
              await step.run('step3', async () => {
                step3Executed = true
                return 'step3'
              })
            },
          }),
        })

        const run = await d.jobs.job.trigger({})
        d.start()

        try {
          // Wait until step1 is running
          await vi.waitFor(() => expect(step1Started).toBe(true), {
            timeout: 5_000,
          })

          // Cancel while step1 is executing
          await d.cancel(run.id)
        } finally {
          release.resolve()
        }

        // Wait for worker to finish processing
        await d.stop()

        // Run should stay cancelled (not overwritten to completed)
        const finalRun = await d.jobs.job.getRun(run.id)
        expect(finalRun?.status).toBe('cancelled')

        // step1 was executed (was in progress when cancelled)
        expect(step1Executed).toBe(true)
        // step2 and step3 should NOT have executed (cancelled before they started)
        expect(step2Executed).toBe(false)
        expect(step3Executed).toBe(false)
      })

      it('does not overwrite cancelled status with completed', async () => {
        let stepStarted = false
        const release = createDeferred()
        const d = durably.register({
          job: defineJob({
            name: 'cancel-no-overwrite-test',
            input: z.object({}),
            run: async (step) => {
              await step.run('step1', async () => {
                stepStarted = true
                // Hold the step until the test has cancelled the run
                await release.promise
                return 'done'
              })
            },
          }),
        })

        const run = await d.jobs.job.trigger({})
        d.start()

        try {
          // Wait until the step is executing
          await vi.waitFor(() => expect(stepStarted).toBe(true), {
            timeout: 5_000,
          })

          // Cancel while step is executing
          await d.cancel(run.id)
        } finally {
          // Let the step complete naturally
          release.resolve()
        }
        // Wait for the worker to finish
        await d.stop()

        // Status should remain cancelled even though job function returned normally
        const finalRun = await d.jobs.job.getRun(run.id)
        expect(finalRun?.status).toBe('cancelled')
      })
    })

    describe('deleteRun() API', () => {
      it('deletes completed run with its steps and logs', async () => {
        const preserveDurably = createDurably({
          dialect: createDialect(),
          pollingIntervalMs: 50,
          preserveSteps: true,
        })
        await preserveDurably.migrate()

        try {
          const d = preserveDurably.register({
            job: defineJob({
              name: 'delete-completed-test',
              input: z.object({}),
              run: async (step) => {
                step.log.info('test log')
                await step.run('step1', () => 'done')
              },
            }),
          })

          const run = await d.jobs.job.trigger({})
          d.start()

          await vi.waitFor(
            async () => {
              const updated = await d.jobs.job.getRun(run.id)
              expect(updated?.status).toBe('completed')
            },
            { timeout: 5_000 },
          )

          // Steps are preserved (preserveSteps: true)
          const steps = await d.storage.getSteps(run.id)
          expect(steps).toHaveLength(1)

          // Delete the run
          await d.deleteRun(run.id)

          // Run should be gone
          const deleted = await d.jobs.job.getRun(run.id)
          expect(deleted).toBeNull()

          // Steps should also be deleted
          const deletedSteps = await d.storage.getSteps(run.id)
          expect(deletedSteps.length).toBe(0)
        } finally {
          await preserveDurably.stop()
          await preserveDurably.db.destroy()
        }
      })

      it('deletes failed run', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'delete-failed-test',
            input: z.object({}),
            run: async () => {
              throw new Error('fail')
            },
          }),
        })

        const run = await d.jobs.job.trigger({})
        d.start()

        await vi.waitFor(
          async () => {
            const updated = await d.jobs.job.getRun(run.id)
            expect(updated?.status).toBe('failed')
          },
          { timeout: 5_000 },
        )

        await d.deleteRun(run.id)

        const deleted = await d.jobs.job.getRun(run.id)
        expect(deleted).toBeNull()
      })

      it('deletes cancelled run', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'delete-cancelled-test',
            input: z.object({}),
            run: async () => {},
          }),
        })

        const run = await d.jobs.job.trigger({})
        await d.cancel(run.id)

        await d.deleteRun(run.id)

        const deleted = await d.jobs.job.getRun(run.id)
        expect(deleted).toBeNull()
      })

      it('throws when deleting pending run', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'delete-pending-test',
            input: z.object({}),
            run: async () => {},
          }),
        })

        const run = await d.jobs.job.trigger({})
        // Don't start worker - run stays pending

        await expect(d.deleteRun(run.id)).rejects.toThrow(
          /pending|cannot delete/i,
        )
      })

      it('throws when deleting leased run', async () => {
        // Hold the job so the run is still leased when deleteRun is called
        const release = createDeferred()
        const d = durably.register({
          job: defineJob({
            name: 'delete-running-test',
            input: z.object({}),
            run: async (step) => {
              await step.run('long-step', () => release.promise)
            },
          }),
        })

        const run = await d.jobs.job.trigger({})
        d.start()

        try {
          await vi.waitFor(
            async () => {
              const updated = await d.jobs.job.getRun(run.id)
              expect(updated?.status).toBe('leased')
            },
            { timeout: 5_000 },
          )

          await expect(d.deleteRun(run.id)).rejects.toThrow(
            /leased|running|cannot delete/i,
          )
        } finally {
          release.resolve()
        }
      })

      it('throws when run does not exist', async () => {
        await expect(durably.deleteRun('non-existent-id')).rejects.toThrow(
          /not found/i,
        )
      })
    })
  })
}
