import type { Dialect } from 'kysely'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  ConflictError,
  ValidationError,
  createDurably,
  defineJob,
  type Durably,
  type DurablyEvent,
} from '../../src'

const jobDef = defineJob({
  name: 'coalesce-test',
  input: z.object({ value: z.string() }),
  output: z.object({ result: z.string() }),
  run: async (step, input) => {
    await step.run('work', async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
    return { result: input.value }
  },
})

export function createCoalesceTests(createDialect: () => Dialect) {
  describe('coalesce trigger', () => {
    let durably: Durably
    let d: any

    beforeEach(async () => {
      durably = createDurably({
        dialect: createDialect(),
        pollingIntervalMs: 50,
      })
      await durably.migrate()
      d = durably.register({ job: jobDef })
    })

    afterEach(async () => {
      await durably.stop()
      // Clean up data for PostgreSQL (shared schema across tests)
      await durably.db.deleteFrom('durably_steps').execute()
      await durably.db.deleteFrom('durably_run_labels').execute()
      await durably.db.deleteFrom('durably_logs').execute()
      await durably.db.deleteFrom('durably_runs').execute()
      await durably.db.destroy()
    })

    // ─── concurrencyKey pending limit ─────────────────────────────

    describe('concurrencyKey pending limit', () => {
      it('creates first pending run normally', async () => {
        const run = await d.jobs.job.trigger(
          { value: 'a' },
          { concurrencyKey: 'key-1' },
        )
        expect(run.status).toBe('pending')
        expect(run.disposition).toBe('created')
      })

      it('throws ConflictError on second pending with same key', async () => {
        await d.jobs.job.trigger({ value: 'a' }, { concurrencyKey: 'key-1' })
        await expect(
          d.jobs.job.trigger({ value: 'b' }, { concurrencyKey: 'key-1' }),
        ).rejects.toThrow(ConflictError)
      })

      it('allows second trigger with coalesce: skip', async () => {
        const first = await d.jobs.job.trigger(
          { value: 'a' },
          { concurrencyKey: 'key-1' },
        )
        const second = await d.jobs.job.trigger(
          { value: 'b' },
          { concurrencyKey: 'key-1', coalesce: 'skip' },
        )
        expect(second.id).toBe(first.id)
        expect(second.disposition).toBe('coalesced')
      })

      it('allows new pending after first is leased', async () => {
        await d.jobs.job.trigger({ value: 'a' }, { concurrencyKey: 'key-1' })
        durably.start()

        await vi.waitFor(
          async () => {
            const runs = await d.jobs.job.getRuns()
            expect(
              runs.some((r: { status: string }) => r.status === 'leased'),
            ).toBe(true)
          },
          { timeout: 2000 },
        )

        const second = await d.jobs.job.trigger(
          { value: 'b' },
          { concurrencyKey: 'key-1' },
        )
        expect(second.disposition).toBe('created')
        expect(second.status).toBe('pending')
      })

      it('throws on third trigger when running + pending exists', async () => {
        await d.jobs.job.trigger({ value: 'a' }, { concurrencyKey: 'key-1' })
        durably.start()

        await vi.waitFor(
          async () => {
            const runs = await d.jobs.job.getRuns()
            expect(
              runs.some((r: { status: string }) => r.status === 'leased'),
            ).toBe(true)
          },
          { timeout: 2000 },
        )

        await d.jobs.job.trigger({ value: 'b' }, { concurrencyKey: 'key-1' })

        await expect(
          d.jobs.job.trigger({ value: 'c' }, { concurrencyKey: 'key-1' }),
        ).rejects.toThrow(ConflictError)
      })

      it('allows different concurrencyKeys independently', async () => {
        const run1 = await d.jobs.job.trigger(
          { value: 'a' },
          { concurrencyKey: 'key-1' },
        )
        const run2 = await d.jobs.job.trigger(
          { value: 'b' },
          { concurrencyKey: 'key-2' },
        )
        expect(run1.disposition).toBe('created')
        expect(run2.disposition).toBe('created')
        expect(run1.id).not.toBe(run2.id)
      })

      it('allows unlimited pending without concurrencyKey', async () => {
        const run1 = await d.jobs.job.trigger({ value: 'a' })
        const run2 = await d.jobs.job.trigger({ value: 'b' })
        const run3 = await d.jobs.job.trigger({ value: 'c' })
        expect(run1.disposition).toBe('created')
        expect(run2.disposition).toBe('created')
        expect(run3.disposition).toBe('created')
      })
    })

    // ─── coalesce behavior ────────────────────────────────────────

    describe('coalesce behavior', () => {
      it('returns existing run input, not new input', async () => {
        const first = await d.jobs.job.trigger(
          { value: 'original' },
          { concurrencyKey: 'key-1' },
        )
        const second = await d.jobs.job.trigger(
          { value: 'new-ignored' },
          { concurrencyKey: 'key-1', coalesce: 'skip' },
        )
        expect(second.input).toEqual({ value: 'original' })
        expect(second.id).toBe(first.id)
      })

      it('returns existing run labels, not new labels', async () => {
        const first = await d.jobs.job.trigger(
          { value: 'a' },
          { concurrencyKey: 'key-1', labels: { env: 'prod' } },
        )
        const second = await d.jobs.job.trigger(
          { value: 'b' },
          {
            concurrencyKey: 'key-1',
            coalesce: 'skip',
            labels: { env: 'staging' },
          },
        )
        expect(second.labels).toEqual({ env: 'prod' })
        expect(second.id).toBe(first.id)
      })

      it('throws ValidationError for coalesce without concurrencyKey', async () => {
        await expect(
          d.jobs.job.trigger({ value: 'a' }, { coalesce: 'skip' }),
        ).rejects.toThrow(ValidationError)
      })
    })

    // ─── disposition ──────────────────────────────────────────────

    describe('disposition', () => {
      it('returns created for normal trigger', async () => {
        const run = await d.jobs.job.trigger({ value: 'a' })
        expect(run.disposition).toBe('created')
      })

      it('returns idempotent for idempotencyKey hit', async () => {
        await d.jobs.job.trigger({ value: 'a' }, { idempotencyKey: 'idem-1' })
        const second = await d.jobs.job.trigger(
          { value: 'b' },
          { idempotencyKey: 'idem-1' },
        )
        expect(second.disposition).toBe('idempotent')
      })

      it('returns idempotent even with coalesce: skip when idempotencyKey matches', async () => {
        await d.jobs.job.trigger(
          { value: 'a' },
          { idempotencyKey: 'idem-1', concurrencyKey: 'key-1' },
        )
        const second = await d.jobs.job.trigger(
          { value: 'b' },
          {
            idempotencyKey: 'idem-1',
            concurrencyKey: 'key-1',
            coalesce: 'skip',
          },
        )
        expect(second.disposition).toBe('idempotent')
      })

      it('returns coalesced for skip mode', async () => {
        await d.jobs.job.trigger({ value: 'a' }, { concurrencyKey: 'key-1' })
        const second = await d.jobs.job.trigger(
          { value: 'b' },
          { concurrencyKey: 'key-1', coalesce: 'skip' },
        )
        expect(second.disposition).toBe('coalesced')
      })
    })

    // ─── events ───────────────────────────────────────────────────

    describe('events', () => {
      it('emits run:trigger on created', async () => {
        const events: DurablyEvent[] = []
        durably.on('run:trigger', (e) => events.push(e))

        await d.jobs.job.trigger({ value: 'a' })

        expect(events).toHaveLength(1)
        expect(events[0].type).toBe('run:trigger')
      })

      it('emits run:coalesced on skip with skipped data', async () => {
        const events: DurablyEvent[] = []
        durably.on('run:coalesced', (e) => events.push(e))

        await d.jobs.job.trigger(
          { value: 'original' },
          { concurrencyKey: 'key-1' },
        )
        await d.jobs.job.trigger(
          { value: 'skipped' },
          { concurrencyKey: 'key-1', coalesce: 'skip' },
        )

        expect(events).toHaveLength(1)
        const event = events[0]
        if (event.type !== 'run:coalesced') throw new Error('wrong type')
        expect(event.skippedInput).toEqual({ value: 'skipped' })
        expect(event.skippedLabels).toEqual({})
      })

      it('does not emit run:trigger on idempotent', async () => {
        const events: DurablyEvent[] = []
        durably.on('run:trigger', (e) => events.push(e))

        await d.jobs.job.trigger({ value: 'a' }, { idempotencyKey: 'idem-1' })
        await d.jobs.job.trigger({ value: 'b' }, { idempotencyKey: 'idem-1' })

        expect(events).toHaveLength(1) // only the first
      })
    })

    // ─── batchTrigger ─────────────────────────────────────────────

    describe('batchTrigger', () => {
      it('coalesces same concurrencyKey within batch', async () => {
        const results = await d.jobs.job.batchTrigger([
          {
            input: { value: 'a' },
            options: { concurrencyKey: 'key-1', coalesce: 'skip' },
          },
          {
            input: { value: 'b' },
            options: { concurrencyKey: 'key-1', coalesce: 'skip' },
          },
        ])
        expect(results).toHaveLength(2)
        expect(results[0].disposition).toBe('created')
        expect(results[1].disposition).toBe('coalesced')
        expect(results[1].id).toBe(results[0].id)
      })

      it('throws ConflictError on same key without coalesce', async () => {
        await expect(
          d.jobs.job.batchTrigger([
            { input: { value: 'a' }, options: { concurrencyKey: 'key-1' } },
            { input: { value: 'b' }, options: { concurrencyKey: 'key-1' } },
          ]),
        ).rejects.toThrow(ConflictError)

        // Atomic — no runs should exist
        const runs = await d.jobs.job.getRuns()
        expect(runs).toHaveLength(0)
      })
    })

    // ─── triggerAndWait ───────────────────────────────────────────

    describe('triggerAndWait', () => {
      it('includes disposition in result', async () => {
        durably.start()
        const result = await d.jobs.job.triggerAndWait(
          { value: 'test' },
          { timeout: 5000 },
        )
        expect(result.disposition).toBe('created')
        expect(result.output).toEqual({ result: 'test' })
      })

      it('includes coalesced disposition when coalesced', async () => {
        // Trigger first run (pending), then coalesce before starting worker
        await d.jobs.job.trigger(
          { value: 'original' },
          { concurrencyKey: 'key-1' },
        )

        // triggerAndWait coalesces onto existing pending run, then start worker
        const resultPromise = d.jobs.job.triggerAndWait(
          { value: 'skipped' },
          { concurrencyKey: 'key-1', coalesce: 'skip', timeout: 5000 },
        )

        // Start worker after trigger to ensure coalesce happens before execution
        durably.start()

        const result = await resultPromise
        expect(result.disposition).toBe('coalesced')
        expect(result.output).toEqual({ result: 'original' })
      })
    })

    // ─── validation ───────────────────────────────────────────────

    describe('validation', () => {
      it('throws on invalid coalesce value', async () => {
        await expect(
          d.jobs.job.trigger(
            { value: 'a' },

            { concurrencyKey: 'key-1', coalesce: 'invalid' },
          ),
        ).rejects.toThrow(ValidationError)
      })

      it('throws on batch item with invalid coalesce', async () => {
        await expect(
          d.jobs.job.batchTrigger([
            {
              input: { value: 'a' },

              options: { concurrencyKey: 'key-1', coalesce: 'invalid' },
            },
          ]),
        ).rejects.toThrow(ValidationError)
      })
    })

    // ─── releaseExpiredLeases interaction ──────────────────────────

    describe('releaseExpiredLeases interaction', () => {
      it('fails expired lease when pending replacement exists', async () => {
        // Create and lease run A
        const runA = await d.jobs.job.trigger(
          { value: 'a' },
          { concurrencyKey: 'key-1' },
        )

        const now = new Date().toISOString()
        const pastExpiry = new Date(Date.now() - 1000).toISOString()

        // Manually lease and expire run A
        await durably.storage.updateRun(runA.id, {
          status: 'leased',
          leaseOwner: 'worker-1',
          leaseExpiresAt: pastExpiry,
          startedAt: now,
        })

        // Create pending run B with same key
        const runB = await d.jobs.job.trigger(
          { value: 'b' },
          { concurrencyKey: 'key-1' },
        )
        expect(runB.disposition).toBe('created')

        // Release expired leases
        await durably.storage.releaseExpiredLeases(now)

        // Run A should be failed (not pending — would violate unique index)
        const updatedA = await durably.storage.getRun(runA.id)
        expect(updatedA?.status).toBe('failed')
        expect(updatedA?.error).toContain('pending run already exists')

        // Run B should still be pending
        const updatedB = await durably.storage.getRun(runB.id)
        expect(updatedB?.status).toBe('pending')
      })

      it('resets expired lease to pending when no replacement exists', async () => {
        const run = await d.jobs.job.trigger(
          { value: 'a' },
          { concurrencyKey: 'key-1' },
        )

        const now = new Date().toISOString()
        const pastExpiry = new Date(Date.now() - 1000).toISOString()

        await durably.storage.updateRun(run.id, {
          status: 'leased',
          leaseOwner: 'worker-1',
          leaseExpiresAt: pastExpiry,
          startedAt: now,
        })

        await durably.storage.releaseExpiredLeases(now)

        const updated = await durably.storage.getRun(run.id)
        expect(updated?.status).toBe('pending')
      })
    })

    // ─── retrigger interaction ────────────────────────────────────

    describe('retrigger interaction', () => {
      it('throws ConflictError when retriggering with pending same-key run', async () => {
        // Create and complete run A
        const runA = await d.jobs.job.trigger(
          { value: 'a' },
          { concurrencyKey: 'key-1' },
        )
        durably.start()
        await vi.waitFor(
          async () => {
            const r = await d.jobs.job.getRun(runA.id)
            expect(r?.status).toBe('completed')
          },
          { timeout: 5000 },
        )
        await durably.stop()

        // Create pending run B with same key
        await d.jobs.job.trigger({ value: 'b' }, { concurrencyKey: 'key-1' })

        // Retrigger A — should fail because B is pending with same key
        await expect(durably.retrigger(runA.id)).rejects.toThrow(ConflictError)
      })
    })

    // ─── edge cases ───────────────────────────────────────────────

    describe('edge cases', () => {
      it('handles batch with mixed coalesce and non-coalesce for different keys', async () => {
        const results = await d.jobs.job.batchTrigger([
          {
            input: { value: 'a' },
            options: { concurrencyKey: 'key-1', coalesce: 'skip' },
          },
          {
            input: { value: 'b' },
            options: { concurrencyKey: 'key-2' },
          },
          {
            input: { value: 'c' },
            options: { concurrencyKey: 'key-1', coalesce: 'skip' },
          },
        ])
        expect(results).toHaveLength(3)
        expect(results[0].disposition).toBe('created')
        expect(results[1].disposition).toBe('created')
        expect(results[2].disposition).toBe('coalesced')
        expect(results[2].id).toBe(results[0].id)
      })

      it('prioritizes idempotencyKey over concurrencyKey conflict', async () => {
        // Create run with both keys
        const first = await d.jobs.job.trigger(
          { value: 'a' },
          { concurrencyKey: 'key-1', idempotencyKey: 'idem-1' },
        )

        // Same idempotencyKey + same concurrencyKey — should be idempotent, not conflict
        const second = await d.jobs.job.trigger(
          { value: 'b' },
          { concurrencyKey: 'key-1', idempotencyKey: 'idem-1' },
        )
        expect(second.disposition).toBe('idempotent')
        expect(second.id).toBe(first.id)
      })
    })
  })
}
