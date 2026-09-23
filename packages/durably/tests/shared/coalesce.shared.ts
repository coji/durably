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
import { createDeferred } from '../helpers/sync'

// A test that needs a run to stay leased points this at an unresolved gate;
// afterEach releases it so the worker can stop
let workGate: Promise<void> = Promise.resolve()
let releaseWork: () => void = () => {}

function holdWork() {
  const gate = createDeferred()
  workGate = gate.promise
  releaseWork = () => gate.resolve()
}

const jobDef = defineJob({
  name: 'coalesce-test',
  input: z.object({ value: z.string() }),
  output: z.object({ result: z.string() }),
  run: async (step, input) => {
    await step.run('work', () => workGate)
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
      releaseWork()
      workGate = Promise.resolve()
      releaseWork = () => {}
      await durably.stop()
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
        holdWork()
        await d.jobs.job.trigger({ value: 'a' }, { concurrencyKey: 'key-1' })
        durably.start()

        await vi.waitFor(
          async () => {
            const runs = await d.jobs.job.getRuns()
            expect(
              runs.some((r: { status: string }) => r.status === 'leased'),
            ).toBe(true)
          },
          { timeout: 5_000 },
        )

        const second = await d.jobs.job.trigger(
          { value: 'b' },
          { concurrencyKey: 'key-1' },
        )
        expect(second.disposition).toBe('created')
        expect(second.status).toBe('pending')
      })

      it('throws on third trigger when running + pending exists', async () => {
        // Keep 'a' leased so 'b' stays pending when 'c' is triggered
        holdWork()
        await d.jobs.job.trigger({ value: 'a' }, { concurrencyKey: 'key-1' })
        durably.start()

        await vi.waitFor(
          async () => {
            const runs = await d.jobs.job.getRuns()
            expect(
              runs.some((r: { status: string }) => r.status === 'leased'),
            ).toBe(true)
          },
          { timeout: 5_000 },
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

      it('creates pending replacement with coalesce: skip when predecessor is leased and no pending run exists', async () => {
        const first = await d.jobs.job.trigger(
          { value: 'first' },
          { concurrencyKey: 'key-skip-leased' },
        )
        const now = new Date().toISOString()
        const futureExpiry = new Date(Date.now() + 60000).toISOString()
        await durably.storage.updateRun(first.id, {
          status: 'leased',
          leaseOwner: 'worker-1',
          leaseExpiresAt: futureExpiry,
          startedAt: now,
        })

        const second = await d.jobs.job.trigger(
          { value: 'second' },
          { concurrencyKey: 'key-skip-leased', coalesce: 'skip' },
        )
        expect(second.disposition).toBe('created')
        expect(second.id).not.toBe(first.id)
        expect(second.status).toBe('pending')
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
            { concurrencyKey: 'key-1', coalesce: 'invalid' as any },
          ),
        ).rejects.toThrow(ValidationError)
      })

      it('throws on batch item with invalid coalesce', async () => {
        await expect(
          d.jobs.job.batchTrigger([
            {
              input: { value: 'a' },
              options: { concurrencyKey: 'key-1', coalesce: 'invalid' as any },
            },
          ]),
        ).rejects.toThrow(ValidationError)
      })

      it('throws ValidationError for coalesce: queue without concurrencyKey', async () => {
        await expect(
          d.jobs.job.trigger({ value: 'a' }, { coalesce: 'queue' }),
        ).rejects.toThrow(ValidationError)
      })

      it('throws ValidationError for coalesce: queue with empty string concurrencyKey', async () => {
        await expect(
          d.jobs.job.trigger(
            { value: 'a' },
            { concurrencyKey: '', coalesce: 'queue' },
          ),
        ).rejects.toThrow(ValidationError)
      })

      it('throws ValidationError for coalesce: active without concurrencyKey', async () => {
        await expect(
          d.jobs.job.trigger({ value: 'a' }, { coalesce: 'active' }),
        ).rejects.toThrow(ValidationError)
      })

      it('throws ValidationError for coalesce: active with empty string concurrencyKey', async () => {
        await expect(
          d.jobs.job.trigger(
            { value: 'a' },
            { concurrencyKey: '', coalesce: 'active' },
          ),
        ).rejects.toThrow(ValidationError)
      })

      it('includes skip, queue, and active in ValidationError message', async () => {
        await expect(
          d.jobs.job.trigger(
            { value: 'a' },
            { concurrencyKey: 'key-1', coalesce: 'invalid' as any },
          ),
        ).rejects.toThrow(/Valid values: 'skip', 'queue', 'active'/)
      })

      it('includes skip, queue, and active in ConflictError message', async () => {
        await d.jobs.job.trigger({ value: 'a' }, { concurrencyKey: 'key-err' })
        await expect(
          d.jobs.job.trigger({ value: 'b' }, { concurrencyKey: 'key-err' }),
        ).rejects.toThrow(/coalesce: 'skip', 'queue', or 'active'/)
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

    // ─── coalesce: queue (behaviorally equivalent to skip in this release) ───

    describe("coalesce: 'queue'", () => {
      // In this release, 'queue' and 'skip' are behaviorally equivalent aliases:
      // both reuse an existing pending run, and both create a pending trailing run
      // when only a leased run exists. They do not imply a future change to skip.

      it('queueing when only a pending same-key run exists returns that run with disposition coalesced and does not create another run', async () => {
        const first = await d.jobs.job.trigger(
          { value: 'a' },
          { concurrencyKey: 'key-q1' },
        )
        expect(first.status).toBe('pending')
        expect(first.disposition).toBe('created')

        const second = await d.jobs.job.trigger(
          { value: 'b' },
          { concurrencyKey: 'key-q1', coalesce: 'queue' },
        )
        expect(second.id).toBe(first.id)
        expect(second.disposition).toBe('coalesced')

        const all = await d.jobs.job.getRuns()
        expect(all).toHaveLength(1)
      })

      it('does not overwrite existing pending run input, labels, or idempotency key when coalesced', async () => {
        const first = await d.jobs.job.trigger(
          { value: 'original' },
          {
            concurrencyKey: 'key-q2',
            idempotencyKey: 'idem-orig',
            labels: { env: 'prod' },
          },
        )
        const second = await d.jobs.job.trigger(
          { value: 'ignored' },
          {
            concurrencyKey: 'key-q2',
            idempotencyKey: 'idem-new',
            labels: { env: 'staging' },
            coalesce: 'queue',
          },
        )

        expect(second.id).toBe(first.id)
        expect(second.input).toEqual({ value: 'original' })
        expect(second.labels).toEqual({ env: 'prod' })
        expect(second.idempotencyKey).toBe('idem-orig')
      })

      it('creates a distinct pending run with disposition created when queueing behind a live leased same-key run', async () => {
        const first = await d.jobs.job.trigger(
          { value: 'first' },
          { concurrencyKey: 'key-q3' },
        )

        const now = new Date().toISOString()
        const futureExpiry = new Date(Date.now() + 60000).toISOString()
        await durably.storage.updateRun(first.id, {
          status: 'leased',
          leaseOwner: 'worker-1',
          leaseExpiresAt: futureExpiry,
          startedAt: now,
        })

        const second = await d.jobs.job.trigger(
          { value: 'second' },
          { concurrencyKey: 'key-q3', coalesce: 'queue' },
        )

        expect(second.id).not.toBe(first.id)
        expect(second.status).toBe('pending')
        expect(second.disposition).toBe('created')
      })

      it('returns trailing pending run with disposition coalesced for further queue triggers while leased and pending coexist', async () => {
        const first = await d.jobs.job.trigger(
          { value: 'first' },
          { concurrencyKey: 'key-q4' },
        )

        const now = new Date().toISOString()
        const futureExpiry = new Date(Date.now() + 60000).toISOString()
        await durably.storage.updateRun(first.id, {
          status: 'leased',
          leaseOwner: 'worker-1',
          leaseExpiresAt: futureExpiry,
          startedAt: now,
        })

        const trailing = await d.jobs.job.trigger(
          { value: 'trailing' },
          { concurrencyKey: 'key-q4', coalesce: 'queue' },
        )
        expect(trailing.disposition).toBe('created')

        const third = await d.jobs.job.trigger(
          { value: 'third' },
          { concurrencyKey: 'key-q4', coalesce: 'queue' },
        )
        expect(third.disposition).toBe('coalesced')
        expect(third.id).toBe(trailing.id)

        // Verify at most one pending run exists for this job and concurrencyKey
        const runs = await d.jobs.job.getRuns()
        const pendingRuns = runs.filter(
          (r: { status: string }) => r.status === 'pending',
        )
        expect(pendingRuns).toHaveLength(1)
        expect(pendingRuns[0].id).toBe(trailing.id)
      })

      it('prioritizes matching idempotency key over queue conflict resolution', async () => {
        // When only pending run exists
        const first = await d.jobs.job.trigger(
          { value: 'a' },
          { concurrencyKey: 'key-idem-q', idempotencyKey: 'idem-1' },
        )
        const second = await d.jobs.job.trigger(
          { value: 'b' },
          {
            concurrencyKey: 'key-idem-q',
            idempotencyKey: 'idem-1',
            coalesce: 'queue',
          },
        )
        expect(second.disposition).toBe('idempotent')
        expect(second.id).toBe(first.id)

        // When leased run exists
        const now = new Date().toISOString()
        const futureExpiry = new Date(Date.now() + 60000).toISOString()
        await durably.storage.updateRun(first.id, {
          status: 'leased',
          leaseOwner: 'worker-1',
          leaseExpiresAt: futureExpiry,
          startedAt: now,
        })

        const third = await d.jobs.job.trigger(
          { value: 'c' },
          {
            concurrencyKey: 'key-idem-q',
            idempotencyKey: 'idem-1',
            coalesce: 'queue',
          },
        )
        expect(third.disposition).toBe('idempotent')
        expect(third.id).toBe(first.id)
      })

      describe('events', () => {
        it('emits one run:trigger event and no run:coalesced event on newly created trailing run', async () => {
          const triggerEvents: DurablyEvent[] = []
          const coalescedEvents: DurablyEvent[] = []
          durably.on('run:trigger', (e) => triggerEvents.push(e))
          durably.on('run:coalesced', (e) => coalescedEvents.push(e))

          const run = await d.jobs.job.trigger(
            { value: 'created' },
            { concurrencyKey: 'key-ev1', coalesce: 'queue' },
          )
          expect(run.disposition).toBe('created')
          expect(triggerEvents).toHaveLength(1)
          expect(coalescedEvents).toHaveLength(0)
        })

        it('emits one run:coalesced event with unused input and labels and no run:trigger event when reusing trailing pending run', async () => {
          const triggerEvents: DurablyEvent[] = []
          const coalescedEvents: DurablyEvent[] = []
          durably.on('run:trigger', (e) => triggerEvents.push(e))
          durably.on('run:coalesced', (e) => coalescedEvents.push(e))

          const first = await d.jobs.job.trigger(
            { value: 'first' },
            {
              concurrencyKey: 'key-ev2',
              labels: { env: 'prod' },
              coalesce: 'queue',
            },
          )
          expect(triggerEvents).toHaveLength(1)

          const second = await d.jobs.job.trigger(
            { value: 'second' },
            {
              concurrencyKey: 'key-ev2',
              labels: { env: 'staging' },
              coalesce: 'queue',
            },
          )
          expect(second.disposition).toBe('coalesced')
          expect(triggerEvents).toHaveLength(1)
          expect(coalescedEvents).toHaveLength(1)

          const event = coalescedEvents[0]
          if (event.type !== 'run:coalesced') throw new Error('wrong type')
          expect(event.runId).toBe(first.id)
          expect(event.skippedInput).toEqual({ value: 'second' })
          expect(event.skippedLabels).toEqual({ env: 'staging' })
        })

        it('emits neither run:trigger nor run:coalesced for idempotent queue trigger', async () => {
          const events: DurablyEvent[] = []
          durably.on('run:trigger', (e) => events.push(e))
          durably.on('run:coalesced', (e) => events.push(e))

          await d.jobs.job.trigger(
            { value: 'first' },
            {
              concurrencyKey: 'key-ev3',
              idempotencyKey: 'idem-ev',
              coalesce: 'queue',
            },
          )
          expect(events).toHaveLength(1)

          const second = await d.jobs.job.trigger(
            { value: 'second' },
            {
              concurrencyKey: 'key-ev3',
              idempotencyKey: 'idem-ev',
              coalesce: 'queue',
            },
          )
          expect(second.disposition).toBe('idempotent')
          expect(events).toHaveLength(1)
        })
      })

      describe('batchTrigger', () => {
        it('first eligible queue item creates trailing pending run and subsequent same-key queue items coalesce onto it within one batch', async () => {
          const results = await d.jobs.job.batchTrigger([
            {
              input: { value: 'batch-1' },
              options: { concurrencyKey: 'key-batch', coalesce: 'queue' },
            },
            {
              input: { value: 'batch-2' },
              options: { concurrencyKey: 'key-batch', coalesce: 'queue' },
            },
            {
              input: { value: 'batch-3' },
              options: { concurrencyKey: 'key-batch', coalesce: 'queue' },
            },
          ])

          expect(results).toHaveLength(3)
          expect(results[0].disposition).toBe('created')
          expect(results[1].disposition).toBe('coalesced')
          expect(results[2].disposition).toBe('coalesced')
          expect(results[1].id).toBe(results[0].id)
          expect(results[2].id).toBe(results[0].id)

          const runs = await d.jobs.job.getRuns()
          expect(runs).toHaveLength(1)
          expect(runs[0].input).toEqual({ value: 'batch-1' })
        })

        it('failed batch containing queue items rolls back all runs and emits no events', async () => {
          const events: DurablyEvent[] = []
          durably.on('run:trigger', (e) => events.push(e))
          durably.on('run:coalesced', (e) => events.push(e))

          // Case 1: validation error
          await expect(
            d.jobs.job.batchTrigger([
              {
                input: { value: 'ok' },
                options: { concurrencyKey: 'key-b-fail', coalesce: 'queue' },
              },
              {
                input: { invalid: 123 } as any,
                options: { concurrencyKey: 'key-b-fail', coalesce: 'queue' },
              },
            ]),
          ).rejects.toThrow(ValidationError)

          expect(events).toHaveLength(0)
          let runs = await d.jobs.job.getRuns()
          expect(runs).toHaveLength(0)

          // Case 2: conflict error during enqueueMany transaction
          await expect(
            d.jobs.job.batchTrigger([
              {
                input: { value: 'ok-1' },
                options: {
                  concurrencyKey: 'key-b-conflict',
                  coalesce: 'queue',
                },
              },
              {
                input: { value: 'ok-2' },
                options: { concurrencyKey: 'key-b-conflict' },
              },
            ]),
          ).rejects.toThrow(ConflictError)

          expect(events).toHaveLength(0)
          runs = await d.jobs.job.getRuns()
          expect(runs).toHaveLength(0)
        })
      })

      it('mixed skip and queue triggers reuse the same pending run', async () => {
        const first = await d.jobs.job.trigger(
          { value: 'first' },
          { concurrencyKey: 'key-mixed', coalesce: 'skip' },
        )
        const second = await d.jobs.job.trigger(
          { value: 'second' },
          { concurrencyKey: 'key-mixed', coalesce: 'queue' },
        )
        const third = await d.jobs.job.trigger(
          { value: 'third' },
          { concurrencyKey: 'key-mixed', coalesce: 'skip' },
        )
        const fourth = await d.jobs.job.trigger(
          { value: 'fourth' },
          { concurrencyKey: 'key-mixed', coalesce: 'queue' },
        )

        expect(first.disposition).toBe('created')
        expect(second.disposition).toBe('coalesced')
        expect(third.disposition).toBe('coalesced')
        expect(fourth.disposition).toBe('coalesced')
        expect(second.id).toBe(first.id)
        expect(third.id).toBe(first.id)
        expect(fourth.id).toBe(first.id)
      })

      it('concurrent queue triggers behind a leased same-key run yield exactly one new pending replacement and coalesce the remaining triggers', async () => {
        const first = await d.jobs.job.trigger(
          { value: 'leased-run' },
          { concurrencyKey: 'key-concurrent-q' },
        )

        const now = new Date().toISOString()
        const futureExpiry = new Date(Date.now() + 60000).toISOString()
        await durably.storage.updateRun(first.id, {
          status: 'leased',
          leaseOwner: 'worker-1',
          leaseExpiresAt: futureExpiry,
          startedAt: now,
        })

        const results = await Promise.all([
          d.jobs.job.trigger(
            { value: 'c1' },
            { concurrencyKey: 'key-concurrent-q', coalesce: 'queue' },
          ),
          d.jobs.job.trigger(
            { value: 'c2' },
            { concurrencyKey: 'key-concurrent-q', coalesce: 'queue' },
          ),
          d.jobs.job.trigger(
            { value: 'c3' },
            { concurrencyKey: 'key-concurrent-q', coalesce: 'queue' },
          ),
          d.jobs.job.trigger(
            { value: 'c4' },
            { concurrencyKey: 'key-concurrent-q', coalesce: 'queue' },
          ),
          d.jobs.job.trigger(
            { value: 'c5' },
            { concurrencyKey: 'key-concurrent-q', coalesce: 'queue' },
          ),
        ])

        const created = results.filter((r) => r.disposition === 'created')
        const coalesced = results.filter((r) => r.disposition === 'coalesced')

        expect(created).toHaveLength(1)
        expect(coalesced).toHaveLength(4)

        const trailingId = created[0].id
        expect(trailingId).not.toBe(first.id)
        for (const c of coalesced) {
          expect(c.id).toBe(trailingId)
        }

        const allRuns = await d.jobs.job.getRuns()
        expect(allRuns).toHaveLength(2)
        const pendingRuns = allRuns.filter(
          (r: { status: string }) => r.status === 'pending',
        )
        expect(pendingRuns).toHaveLength(1)
        expect(pendingRuns[0].id).toBe(trailingId)
      })

      it('deterministic scheduling: trailing pending run is not leased while predecessor holds live lease and runs sequentially without overlap when maxConcurrentRuns > 1', async () => {
        const durablyMulti = createDurably({
          dialect: createDialect(),
          pollingIntervalMs: 20,
          maxConcurrentRuns: 2,
        })
        await durablyMulti.migrate()

        let resolveBlocker!: () => void
        const blockerPromise = new Promise<void>((resolve) => {
          resolveBlocker = resolve
        })

        const activeRuns: string[] = []
        let maxConcurrentActive = 0

        const schedulingJob = defineJob({
          name: 'coalesce-sched-test',
          input: z.object({ value: z.string() }),
          output: z.object({ result: z.string() }),
          run: async (step, input) => {
            return await step.run('work', async () => {
              activeRuns.push(input.value)
              maxConcurrentActive = Math.max(
                maxConcurrentActive,
                activeRuns.length,
              )
              if (input.value === 'first') {
                await blockerPromise
              }
              activeRuns.splice(activeRuns.indexOf(input.value), 1)
              return { result: input.value }
            })
          },
        })

        const dMulti = durablyMulti.register({ job: schedulingJob })

        try {
          const first = await dMulti.jobs.job.trigger(
            { value: 'first' },
            { concurrencyKey: 'key-sched-deterministic' },
          )
          expect(first.disposition).toBe('created')

          durablyMulti.start()

          // Wait until first run is leased and executing its step
          await vi.waitFor(
            () => {
              expect(activeRuns).toContain('first')
            },
            { timeout: 5_000 },
          )

          const firstRun = await dMulti.jobs.job.getRun(first.id)
          expect(firstRun?.status).toBe('leased')

          // Queue trailing run while predecessor is leased
          const second = await dMulti.jobs.job.trigger(
            { value: 'second' },
            { concurrencyKey: 'key-sched-deterministic', coalesce: 'queue' },
          )
          expect(second.disposition).toBe('created')
          expect(second.id).not.toBe(first.id)
          expect(second.status).toBe('pending')

          // Further queue trigger coalesces onto the trailing pending run
          const third = await dMulti.jobs.job.trigger(
            { value: 'third' },
            { concurrencyKey: 'key-sched-deterministic', coalesce: 'queue' },
          )
          expect(third.disposition).toBe('coalesced')
          expect(third.id).toBe(second.id)

          // Verify trailing run is NOT leased while predecessor holds live lease,
          // even though maxConcurrentRuns is 2 and the second slot is idle.
          // sleep-ok(negative): gives the idle slot a chance to lease the
          // trailing run; a slow runner can only hide a bug here
          await new Promise((r) => setTimeout(r, 100))
          const secondCheck = await dMulti.jobs.job.getRun(second.id)
          expect(secondCheck?.status).toBe('pending')
          expect(maxConcurrentActive).toBe(1)

          // Release predecessor
          resolveBlocker()

          // Verify predecessor completes and trailing run is then claimed and executed
          await vi.waitFor(
            async () => {
              const r1 = await dMulti.jobs.job.getRun(first.id)
              const r2 = await dMulti.jobs.job.getRun(second.id)
              expect(r1?.status).toBe('completed')
              expect(r2?.status).toBe('completed')
            },
            { timeout: 5000 },
          )

          expect(maxConcurrentActive).toBe(1)
        } finally {
          resolveBlocker?.()
          await durablyMulti.stop()
          await durablyMulti.db.destroy()
        }
      })
    })

    // ─── coalesce: active ──────────────────────────────────────────
    describe("coalesce: 'active'", () => {
      it('returns existing pending run with disposition coalesced and creates no new run', async () => {
        const first = await d.jobs.job.trigger(
          { value: 'first' },
          { concurrencyKey: 'key-act-1' },
        )
        expect(first.disposition).toBe('created')

        const second = await d.jobs.job.trigger(
          { value: 'second' },
          { concurrencyKey: 'key-act-1', coalesce: 'active' },
        )
        expect(second.disposition).toBe('coalesced')
        expect(second.id).toBe(first.id)

        const all = await d.jobs.job.getRuns()
        expect(all).toHaveLength(1)
      })

      it('when pending and valid leased runs coexist for the same job name and concurrency key, returns the pending run', async () => {
        const first = await d.jobs.job.trigger(
          { value: 'first' },
          { concurrencyKey: 'key-act-coexist' },
        )
        const futureExpiry = new Date(Date.now() + 60_000).toISOString()
        await durably.storage.updateRun(first.id, {
          status: 'leased',
          leaseOwner: 'worker-1',
          leaseExpiresAt: futureExpiry,
        })

        const second = await d.jobs.job.trigger(
          { value: 'second' },
          { concurrencyKey: 'key-act-coexist', coalesce: 'queue' },
        )
        expect(second.status).toBe('pending')

        const third = await d.jobs.job.trigger(
          { value: 'third' },
          { concurrencyKey: 'key-act-coexist', coalesce: 'active' },
        )
        expect(third.disposition).toBe('coalesced')
        expect(third.id).toBe(second.id)
      })

      it('when only a non-expired leased run exists, returns that leased run and creates no pending run', async () => {
        const first = await d.jobs.job.trigger(
          { value: 'first' },
          { concurrencyKey: 'key-act-leased' },
        )
        const futureExpiry = new Date(Date.now() + 60_000).toISOString()
        await durably.storage.updateRun(first.id, {
          status: 'leased',
          leaseOwner: 'worker-1',
          leaseExpiresAt: futureExpiry,
        })

        const second = await d.jobs.job.trigger(
          { value: 'second' },
          { concurrencyKey: 'key-act-leased', coalesce: 'active' },
        )
        expect(second.disposition).toBe('coalesced')
        expect(second.id).toBe(first.id)
        expect(second.status).toBe('leased')

        const pending = await durably.storage.getRuns({
          jobName: 'coalesce-test',
          status: 'pending',
        })
        expect(pending).toHaveLength(0)
      })

      it('leased run with a null or expired lease expiry does not block creation of a new pending run', async () => {
        for (const [suffix, leaseExpiresAt] of [
          ['null', null],
          ['expired', new Date(Date.now() - 1000).toISOString()],
        ] as const) {
          const concurrencyKey = `key-act-${suffix}`
          const first = await d.jobs.job.trigger(
            { value: 'first' },
            { concurrencyKey },
          )
          await durably.storage.updateRun(first.id, {
            status: 'leased',
            leaseOwner: 'worker-1',
            leaseExpiresAt,
          })

          const second = await d.jobs.job.trigger(
            { value: 'second' },
            { concurrencyKey, coalesce: 'active' },
          )
          expect(second.disposition).toBe('created')
          expect(second.id).not.toBe(first.id)
          expect(second.status).toBe('pending')
        }
      })

      it('completed, failed, and cancelled runs do not block a later active trigger', async () => {
        for (const terminalStatus of [
          'completed',
          'failed',
          'cancelled',
        ] as const) {
          const run = await d.jobs.job.trigger(
            { value: `term-${terminalStatus}` },
            { concurrencyKey: `key-term-${terminalStatus}` },
          )
          await durably.storage.updateRun(run.id, {
            status: terminalStatus,
            completedAt: new Date().toISOString(),
          })

          const next = await d.jobs.job.trigger(
            { value: `after-${terminalStatus}` },
            {
              concurrencyKey: `key-term-${terminalStatus}`,
              coalesce: 'active',
            },
          )
          expect(next.disposition).toBe('created')
          expect(next.id).not.toBe(run.id)
          expect(next.status).toBe('pending')
        }
      })

      it('does not reuse a run from another job definition with the same concurrency key', async () => {
        const otherJob = defineJob({
          name: 'coalesce-other-job',
          input: z.object({ value: z.string() }),
          run: async () => {},
        })
        const dOther = durably.register({ otherJob })

        const first = await d.jobs.job.trigger(
          { value: 'first' },
          { concurrencyKey: 'shared-key' },
        )
        await durably.storage.updateRun(first.id, {
          status: 'leased',
          leaseOwner: 'worker-1',
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        })

        const second = await dOther.jobs.otherJob.trigger(
          { value: 'second' },
          { concurrencyKey: 'shared-key', coalesce: 'active' },
        )
        expect(second.id).not.toBe(first.id)
        expect(second.disposition).toBe('created')
      })

      it('idempotency-key match returns disposition idempotent before active-coalescing resolution', async () => {
        const first = await d.jobs.job.trigger(
          { value: 'first' },
          { concurrencyKey: 'key-act-idem', idempotencyKey: 'idem-1' },
        )

        const second = await d.jobs.job.trigger(
          { value: 'different' },
          {
            concurrencyKey: 'key-act-idem',
            idempotencyKey: 'idem-1',
            coalesce: 'active',
          },
        )
        expect(second.disposition).toBe('idempotent')
        expect(second.id).toBe(first.id)
      })

      it('does not overwrite existing run input, labels, or idempotency key when coalesced', async () => {
        const first = await d.jobs.job.trigger(
          { value: 'original' },
          {
            concurrencyKey: 'key-act-no-overwrite',
            labels: { env: 'prod' },
            idempotencyKey: 'orig-idem',
          },
        )

        const second = await d.jobs.job.trigger(
          { value: 'replacement' },
          {
            concurrencyKey: 'key-act-no-overwrite',
            labels: { env: 'staging' },
            idempotencyKey: 'new-idem',
            coalesce: 'active',
          },
        )
        expect(second.disposition).toBe('coalesced')

        const fetched = await d.jobs.job.getRun(first.id)
        expect(fetched?.input).toEqual({ value: 'original' })
        expect(fetched?.labels).toEqual({ env: 'prod' })
        expect(fetched?.idempotencyKey).toBe('orig-idem')
      })

      it('validates labels before reusing an active run', async () => {
        const existing = await d.jobs.job.trigger(
          { value: 'existing' },
          { concurrencyKey: 'key-act-invalid-label' },
        )

        await expect(
          d.jobs.job.trigger(
            { value: 'invalid' },
            {
              concurrencyKey: 'key-act-invalid-label',
              coalesce: 'active',
              labels: { 'invalid label': 'value' },
            },
          ),
        ).rejects.toThrow('Invalid label key')

        const runs = await d.jobs.job.getRuns()
        expect(runs).toHaveLength(1)
        expect(runs[0].id).toBe(existing.id)
      })

      describe('events', () => {
        it('emits one run:coalesced event with status pending and no run:trigger event when reusing pending run', async () => {
          const coalescedEvents: any[] = []
          const triggerEvents: any[] = []
          durably.on('run:coalesced', (e) => coalescedEvents.push(e))
          durably.on('run:trigger', (e) => triggerEvents.push(e))

          const first = await d.jobs.job.trigger(
            { value: 'first' },
            { concurrencyKey: 'key-ev-pending' },
          )
          expect(triggerEvents).toHaveLength(1)
          expect(coalescedEvents).toHaveLength(0)

          const second = await d.jobs.job.trigger(
            { value: 'second' },
            {
              concurrencyKey: 'key-ev-pending',
              coalesce: 'active',
              labels: { extra: 'test' },
            },
          )
          expect(second.disposition).toBe('coalesced')
          expect(triggerEvents).toHaveLength(1)
          expect(coalescedEvents).toHaveLength(1)
          expect(coalescedEvents[0]).toMatchObject({
            type: 'run:coalesced',
            runId: first.id,
            status: 'pending',
            skippedInput: { value: 'second' },
            skippedLabels: { extra: 'test' },
          })
        })

        it('emits one run:coalesced event with status leased and no run:trigger event when reusing leased run', async () => {
          const coalescedEvents: any[] = []
          const triggerEvents: any[] = []
          durably.on('run:coalesced', (e) => coalescedEvents.push(e))
          durably.on('run:trigger', (e) => triggerEvents.push(e))

          const first = await d.jobs.job.trigger(
            { value: 'first' },
            { concurrencyKey: 'key-ev-leased' },
          )
          await durably.storage.updateRun(first.id, {
            status: 'leased',
            leaseOwner: 'worker-1',
            leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          })

          const second = await d.jobs.job.trigger(
            { value: 'second' },
            {
              concurrencyKey: 'key-ev-leased',
              coalesce: 'active',
              labels: { extra: 'test' },
            },
          )
          expect(second.disposition).toBe('coalesced')
          expect(second.status).toBe('leased')
          expect(triggerEvents).toHaveLength(1)
          expect(coalescedEvents).toHaveLength(1)
          expect(coalescedEvents[0]).toMatchObject({
            type: 'run:coalesced',
            runId: first.id,
            status: 'leased',
            skippedInput: { value: 'second' },
            skippedLabels: { extra: 'test' },
          })
        })
      })

      describe('batches', () => {
        it('first eligible active item creates run and subsequent same-key active items coalesce onto it within one batch', async () => {
          const results = await d.jobs.job.batchTrigger([
            {
              input: { value: 'item-0' },
              options: { concurrencyKey: 'key-act-batch', coalesce: 'active' },
            },
            {
              input: { value: 'item-1' },
              options: { concurrencyKey: 'key-act-batch', coalesce: 'active' },
            },
            {
              input: { value: 'item-2' },
              options: { concurrencyKey: 'key-act-batch', coalesce: 'active' },
            },
          ])

          expect(results[0].disposition).toBe('created')
          expect(results[1].disposition).toBe('coalesced')
          expect(results[2].disposition).toBe('coalesced')
          expect(results[1].id).toBe(results[0].id)
          expect(results[2].id).toBe(results[0].id)
        })

        it('batch validation and enqueue failures remain atomic and emit no events for rolled-back work', async () => {
          const triggerEvents: any[] = []
          const coalescedEvents: any[] = []
          durably.on('run:trigger', (e) => triggerEvents.push(e))
          durably.on('run:coalesced', (e) => coalescedEvents.push(e))

          await expect(
            d.jobs.job.batchTrigger([
              {
                input: { value: 'valid' },
                options: { concurrencyKey: 'key-act-fail', coalesce: 'active' },
              },
              {
                input: { invalid: 123 } as any,
                options: { concurrencyKey: 'key-act-fail', coalesce: 'active' },
              },
            ]),
          ).rejects.toThrow(ValidationError)

          expect(triggerEvents).toHaveLength(0)
          expect(coalescedEvents).toHaveLength(0)

          const runs = await d.jobs.job.getRuns()
          expect(runs).toHaveLength(0)
        })

        it('rolls back a batch when invalid labels would otherwise reuse an active run', async () => {
          const existing = await d.jobs.job.trigger(
            { value: 'existing' },
            { concurrencyKey: 'key-act-invalid-batch-existing' },
          )
          const triggerEvents: any[] = []
          const coalescedEvents: any[] = []
          durably.on('run:trigger', (event) => triggerEvents.push(event))
          durably.on('run:coalesced', (event) => coalescedEvents.push(event))

          await expect(
            d.jobs.job.batchTrigger([
              {
                input: { value: 'would-roll-back' },
                options: {
                  concurrencyKey: 'key-act-invalid-batch-new',
                  coalesce: 'active',
                },
              },
              {
                input: { value: 'invalid' },
                options: {
                  concurrencyKey: 'key-act-invalid-batch-existing',
                  coalesce: 'active',
                  labels: { 'invalid label': 'value' },
                },
              },
            ]),
          ).rejects.toThrow('Invalid label key')

          expect(triggerEvents).toHaveLength(0)
          expect(coalescedEvents).toHaveLength(0)
          const runs = await d.jobs.job.getRuns()
          expect(runs).toHaveLength(1)
          expect(runs[0].id).toBe(existing.id)
        })
      })
    })
  })
}
