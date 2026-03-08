import type { Dialect } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createDurably, type Durably } from '../../src'

export function createStorageTests(createDialect: () => Dialect) {
  describe('Storage', () => {
    let durably: Durably

    beforeEach(async () => {
      durably = createDurably({ dialect: createDialect() })
      await durably.migrate()
    })

    afterEach(async () => {
      await durably.db.destroy()
    })

    describe('Run operations', () => {
      it('creates a run', async () => {
        const run = await durably.storage.enqueue({
          jobName: 'test-job',
          input: { foo: 'bar' },
        })

        expect(run.id).toBeDefined()
        expect(run.jobName).toBe('test-job')
        expect(run.status).toBe('pending')
        expect(run.input).toEqual({ foo: 'bar' })
      })

      it('creates a run with idempotency key', async () => {
        const run1 = await durably.storage.enqueue({
          jobName: 'test-job',
          input: { foo: 'bar' },
          idempotencyKey: 'key-1',
        })

        const run2 = await durably.storage.enqueue({
          jobName: 'test-job',
          input: { foo: 'baz' },
          idempotencyKey: 'key-1',
        })

        // Same idempotency key should return the same run
        expect(run2.id).toBe(run1.id)
        expect(run2.input).toEqual({ foo: 'bar' }) // Original input
      })

      it('gets a run by id', async () => {
        const created = await durably.storage.enqueue({
          jobName: 'test-job',
          input: { foo: 'bar' },
        })

        const run = await durably.storage.getRun(created.id)

        expect(run).not.toBeNull()
        expect(run!.id).toBe(created.id)
        expect(run!.jobName).toBe('test-job')
      })

      it('returns stepCount as 0 for new run', async () => {
        const created = await durably.storage.enqueue({
          jobName: 'test-job',
          input: {},
        })

        const run = await durably.storage.getRun(created.id)

        expect(run).not.toBeNull()
        expect(run!.stepCount).toBe(0)
      })

      it('returns stepCount reflecting completed steps', async () => {
        const created = await durably.storage.enqueue({
          jobName: 'test-job',
          input: {},
        })

        // Claim so we have a valid leaseGeneration
        const claimed = await durably.storage.claimNext(
          'test-worker',
          new Date().toISOString(),
          30_000,
        )
        const gen = claimed!.leaseGeneration

        // Add 3 steps
        await durably.storage.persistStep(created.id, gen, {
          name: 'step-1',
          index: 0,
          status: 'completed',
          startedAt: new Date().toISOString(),
        })
        await durably.storage.persistStep(created.id, gen, {
          name: 'step-2',
          index: 1,
          status: 'completed',
          startedAt: new Date().toISOString(),
        })
        await durably.storage.persistStep(created.id, gen, {
          name: 'step-3',
          index: 2,
          status: 'completed',
          startedAt: new Date().toISOString(),
        })

        const run = await durably.storage.getRun(created.id)

        expect(run).not.toBeNull()
        expect(run!.stepCount).toBe(3)
      })

      it('returns stepCount in getRuns', async () => {
        const run1 = await durably.storage.enqueue({
          jobName: 'job-a',
          input: {},
        })
        const run2 = await durably.storage.enqueue({
          jobName: 'job-b',
          input: {},
        })

        // Claim run1 and add 2 steps
        const claimed1 = await durably.storage.claimNext(
          'test-worker',
          new Date().toISOString(),
          30_000,
        )
        const gen1 = claimed1!.leaseGeneration

        await durably.storage.persistStep(run1.id, gen1, {
          name: 'step-1',
          index: 0,
          status: 'completed',
          startedAt: new Date().toISOString(),
        })
        await durably.storage.persistStep(run1.id, gen1, {
          name: 'step-2',
          index: 1,
          status: 'completed',
          startedAt: new Date().toISOString(),
        })

        // Claim run2 and add 1 step
        const claimed2 = await durably.storage.claimNext(
          'test-worker',
          new Date().toISOString(),
          30_000,
        )
        const gen2 = claimed2!.leaseGeneration

        await durably.storage.persistStep(run2.id, gen2, {
          name: 'step-1',
          index: 0,
          status: 'completed',
          startedAt: new Date().toISOString(),
        })

        const runs = await durably.storage.getRuns()

        // runs are ordered by created_at desc
        const foundRun1 = runs.find((r) => r.id === run1.id)
        const foundRun2 = runs.find((r) => r.id === run2.id)

        expect(foundRun1!.stepCount).toBe(2)
        expect(foundRun2!.stepCount).toBe(1)
      })

      it('returns null for non-existent run', async () => {
        const run = await durably.storage.getRun('non-existent-id')
        expect(run).toBeNull()
      })

      it('updates a run', async () => {
        const created = await durably.storage.enqueue({
          jobName: 'test-job',
          input: {},
        })

        await durably.storage.updateRun(created.id, {
          status: 'leased',
        })

        const run = await durably.storage.getRun(created.id)
        expect(run!.status).toBe('leased')
      })

      it('gets runs with filter', async () => {
        await durably.storage.enqueue({ jobName: 'job-a', input: {} })
        await durably.storage.enqueue({ jobName: 'job-b', input: {} })
        const run3 = await durably.storage.enqueue({
          jobName: 'job-a',
          input: {},
        })
        await durably.storage.updateRun(run3.id, { status: 'completed' })

        const pendingRuns = await durably.storage.getRuns({ status: 'pending' })
        expect(pendingRuns).toHaveLength(2)

        const jobARuns = await durably.storage.getRuns({ jobName: 'job-a' })
        expect(jobARuns).toHaveLength(2)

        const completedRuns = await durably.storage.getRuns({
          status: 'completed',
        })
        expect(completedRuns).toHaveLength(1)
      })

      it('filters runs by multiple job names', async () => {
        await durably.storage.enqueue({ jobName: 'job-a', input: {} })
        await durably.storage.enqueue({ jobName: 'job-b', input: {} })
        await durably.storage.enqueue({ jobName: 'job-c', input: {} })

        const runs = await durably.storage.getRuns({
          jobName: ['job-a', 'job-c'],
        })
        expect(runs).toHaveLength(2)
        expect(runs.map((r) => r.jobName).sort()).toEqual(['job-a', 'job-c'])
      })

      it('ignores empty jobName array', async () => {
        await durably.storage.enqueue({ jobName: 'job-a', input: {} })
        await durably.storage.enqueue({ jobName: 'job-b', input: {} })

        const runs = await durably.storage.getRuns({ jobName: [] })
        expect(runs).toHaveLength(2)
      })

      it('creates a run with labels', async () => {
        const run = await durably.storage.enqueue({
          jobName: 'test-job',
          input: {},
          labels: { organizationId: 'org_123', env: 'prod' },
        })

        expect(run.labels).toEqual({ organizationId: 'org_123', env: 'prod' })

        // Verify labels persist on getRun
        const fetched = await durably.storage.getRun(run.id)
        expect(fetched!.labels).toEqual({
          organizationId: 'org_123',
          env: 'prod',
        })
      })

      it('defaults labels to empty object', async () => {
        const run = await durably.storage.enqueue({
          jobName: 'test-job',
          input: {},
        })

        expect(run.labels).toEqual({})
      })

      it('filters runs by single label', async () => {
        await durably.storage.enqueue({
          jobName: 'test-job',
          input: {},
          labels: { organizationId: 'org_1' },
        })
        await durably.storage.enqueue({
          jobName: 'test-job',
          input: {},
          labels: { organizationId: 'org_2' },
        })
        await durably.storage.enqueue({
          jobName: 'test-job',
          input: {},
        })

        const runs = await durably.storage.getRuns({
          labels: { organizationId: 'org_1' },
        })
        expect(runs).toHaveLength(1)
        expect(runs[0].labels).toEqual({ organizationId: 'org_1' })
      })

      it('filters runs by multiple labels (AND)', async () => {
        await durably.storage.enqueue({
          jobName: 'test-job',
          input: {},
          labels: { organizationId: 'org_1', env: 'prod' },
        })
        await durably.storage.enqueue({
          jobName: 'test-job',
          input: {},
          labels: { organizationId: 'org_1', env: 'staging' },
        })
        await durably.storage.enqueue({
          jobName: 'test-job',
          input: {},
          labels: { organizationId: 'org_2', env: 'prod' },
        })

        const runs = await durably.storage.getRuns({
          labels: { organizationId: 'org_1', env: 'prod' },
        })
        expect(runs).toHaveLength(1)
        expect(runs[0].labels).toEqual({
          organizationId: 'org_1',
          env: 'prod',
        })
      })

      it('returns all runs when labels filter is not specified', async () => {
        await durably.storage.enqueue({
          jobName: 'test-job',
          input: {},
          labels: { organizationId: 'org_1' },
        })
        await durably.storage.enqueue({
          jobName: 'test-job',
          input: {},
        })

        const runs = await durably.storage.getRuns()
        expect(runs).toHaveLength(2)
      })

      it('rejects invalid label keys', async () => {
        await expect(
          durably.storage.enqueue({
            jobName: 'test-job',
            input: {},
            labels: { 'valid-key': 'ok', 'invalid key': 'bad' },
          }),
        ).rejects.toThrow('Invalid label key')
      })

      it('rejects label keys with special characters', async () => {
        await expect(
          durably.storage.enqueue({
            jobName: 'test-job',
            input: {},
            labels: { 'key"injection': 'bad' },
          }),
        ).rejects.toThrow('Invalid label key')
      })

      it('allows Kubernetes-style label keys', async () => {
        const run = await durably.storage.enqueue({
          jobName: 'test-job',
          input: {},
          labels: { 'app.kubernetes.io/name': 'my-app', env: 'prod' },
        })
        expect(run.labels).toEqual({
          'app.kubernetes.io/name': 'my-app',
          env: 'prod',
        })
      })

      it('filters runs by dotted label keys', async () => {
        await durably.storage.enqueue({
          jobName: 'test-job',
          input: {},
          labels: { 'app.kubernetes.io/name': 'my-app' },
        })
        await durably.storage.enqueue({
          jobName: 'test-job',
          input: {},
          labels: { 'app.kubernetes.io/name': 'other-app' },
        })

        const runs = await durably.storage.getRuns({
          labels: { 'app.kubernetes.io/name': 'my-app' },
        })
        expect(runs).toHaveLength(1)
        expect(runs[0].labels).toEqual({
          'app.kubernetes.io/name': 'my-app',
        })
      })

      it('claims next pending run atomically', async () => {
        const created = await durably.storage.enqueue({
          jobName: 'test-job',
          input: { x: 1 },
        })

        const claimed = await durably.storage.claimNext(
          'test-worker',
          new Date().toISOString(),
          30_000,
        )

        expect(claimed).not.toBeNull()
        expect(claimed!.id).toBe(created.id)
        expect(claimed!.status).toBe('leased')
        expect(claimed!.startedAt).not.toBeNull()
        expect(claimed!.stepCount).toBe(0)

        // Verify run is now leased in DB
        const run = await durably.storage.getRun(created.id)
        expect(run!.status).toBe('leased')
      })

      it('claimNext returns null when no pending runs', async () => {
        const result = await durably.storage.claimNext(
          'test-worker',
          new Date().toISOString(),
          30_000,
        )
        expect(result).toBeNull()
      })

      it('claimNext respects concurrency key exclusion', async () => {
        await durably.storage.enqueue({
          jobName: 'job',
          input: {},
          concurrencyKey: 'key-a',
        })
        const run2 = await durably.storage.enqueue({
          jobName: 'job',
          input: {},
          concurrencyKey: 'key-b',
        })

        const claimed = await durably.storage.claimNext(
          'test-worker',
          new Date().toISOString(),
          30_000,
          { excludeConcurrencyKeys: ['key-a'] },
        )

        expect(claimed).not.toBeNull()
        expect(claimed!.id).toBe(run2.id)
        expect(claimed!.concurrencyKey).toBe('key-b')
        expect(claimed!.status).toBe('leased')
      })

      it('claimNext skips runs with null concurrency key when not excluded', async () => {
        const run1 = await durably.storage.enqueue({
          jobName: 'job',
          input: {},
        })
        await durably.storage.enqueue({
          jobName: 'job',
          input: {},
          concurrencyKey: 'key-a',
        })

        // Excluding key-a should still return the run without a concurrency key
        const claimed = await durably.storage.claimNext(
          'test-worker',
          new Date().toISOString(),
          30_000,
          { excludeConcurrencyKeys: ['key-a'] },
        )

        expect(claimed).not.toBeNull()
        expect(claimed!.id).toBe(run1.id)
      })

      it('claimNext preserves started_at on re-claim of recovered run', async () => {
        // Create and claim a run
        const created = await durably.storage.enqueue({
          jobName: 'test-job',
          input: {},
        })
        const firstClaim = await durably.storage.claimNext(
          'test-worker',
          new Date().toISOString(),
          30_000,
        )
        expect(firstClaim).not.toBeNull()
        const originalStartedAt = firstClaim!.startedAt

        // Simulate stale run recovery: reset to pending
        await durably.storage.updateRun(created.id, { status: 'pending' })

        // Re-claim the run
        const secondClaim = await durably.storage.claimNext(
          'test-worker',
          new Date().toISOString(),
          30_000,
        )

        expect(secondClaim).not.toBeNull()
        expect(secondClaim!.id).toBe(created.id)
        expect(secondClaim!.status).toBe('leased')
        // started_at should be preserved from the first claim
        expect(secondClaim!.startedAt).toBe(originalStartedAt)
      })
    })

    describe('Step operations', () => {
      it('persists a step with lease generation guard', async () => {
        const run = await durably.storage.enqueue({
          jobName: 'test-job',
          input: {},
        })

        const claimed = await durably.storage.claimNext(
          'test-worker',
          new Date().toISOString(),
          30_000,
        )
        const gen = claimed!.leaseGeneration

        const step = await durably.storage.persistStep(run.id, gen, {
          name: 'step-1',
          index: 0,
          status: 'completed',
          output: { result: 42 },
          startedAt: new Date().toISOString(),
        })

        expect(step).not.toBeNull()

        const steps = await durably.storage.getSteps(run.id)
        expect(steps).toHaveLength(1)
        expect(steps[0].name).toBe('step-1')
        expect(steps[0].output).toEqual({ result: 42 })
      })

      it('rejects persistStep with wrong lease generation', async () => {
        const run = await durably.storage.enqueue({
          jobName: 'test-job',
          input: {},
        })

        const claimed = await durably.storage.claimNext(
          'test-worker',
          new Date().toISOString(),
          30_000,
        )
        const gen = claimed!.leaseGeneration

        // Use wrong generation
        const step = await durably.storage.persistStep(run.id, gen + 1, {
          name: 'step-1',
          index: 0,
          status: 'completed',
          output: 'should-not-exist',
          startedAt: new Date().toISOString(),
        })

        expect(step).toBeNull()

        const steps = await durably.storage.getSteps(run.id)
        expect(steps).toHaveLength(0)
      })

      it('gets completed step by name', async () => {
        const run = await durably.storage.enqueue({
          jobName: 'test-job',
          input: {},
        })

        const claimed = await durably.storage.claimNext(
          'test-worker',
          new Date().toISOString(),
          30_000,
        )
        const gen = claimed!.leaseGeneration

        await durably.storage.persistStep(run.id, gen, {
          name: 'fetch-data',
          index: 0,
          status: 'completed',
          output: { data: [1, 2, 3] },
          startedAt: new Date().toISOString(),
        })

        const step = await durably.storage.getCompletedStep(
          run.id,
          'fetch-data',
        )
        expect(step).not.toBeNull()
        expect(step!.output).toEqual({ data: [1, 2, 3] })
      })

      it('returns null for non-existent step', async () => {
        const run = await durably.storage.enqueue({
          jobName: 'test-job',
          input: {},
        })

        const step = await durably.storage.getCompletedStep(
          run.id,
          'non-existent',
        )
        expect(step).toBeNull()
      })
    })
  })
}
