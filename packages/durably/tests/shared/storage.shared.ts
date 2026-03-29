import type { Dialect } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ConflictError, createDurably, type Durably } from '../../src'

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
        const { run } = await durably.storage.enqueue({
          jobName: 'test-job',
          input: { foo: 'bar' },
        })

        expect(run.id).toBeDefined()
        expect(run.jobName).toBe('test-job')
        expect(run.status).toBe('pending')
        expect(run.input).toEqual({ foo: 'bar' })
      })

      it('creates a run with idempotency key', async () => {
        const { run: run1 } = await durably.storage.enqueue({
          jobName: 'test-job',
          input: { foo: 'bar' },
          idempotencyKey: 'key-1',
        })

        const { run: run2 } = await durably.storage.enqueue({
          jobName: 'test-job',
          input: { foo: 'baz' },
          idempotencyKey: 'key-1',
        })

        // Same idempotency key should return the same run
        expect(run2.id).toBe(run1.id)
        expect(run2.input).toEqual({ foo: 'bar' }) // Original input
      })

      it('gets a run by id', async () => {
        const { run: created } = await durably.storage.enqueue({
          jobName: 'test-job',
          input: { foo: 'bar' },
        })

        const run = await durably.storage.getRun(created.id)

        expect(run).not.toBeNull()
        expect(run!.id).toBe(created.id)
        expect(run!.jobName).toBe('test-job')
      })

      it('returns completedStepCount as 0 for new run', async () => {
        const { run: created } = await durably.storage.enqueue({
          jobName: 'test-job',
          input: {},
        })

        const run = await durably.storage.getRun(created.id)

        expect(run).not.toBeNull()
        expect(run!.completedStepCount).toBe(0)
      })

      it('returns completedStepCount reflecting completed steps', async () => {
        const { run: created } = await durably.storage.enqueue({
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
        expect(run!.completedStepCount).toBe(3)
      })

      it('returns completedStepCount in getRuns', async () => {
        const { run: run1 } = await durably.storage.enqueue({
          jobName: 'job-a',
          input: {},
        })
        const { run: run2 } = await durably.storage.enqueue({
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

        expect(foundRun1!.completedStepCount).toBe(2)
        expect(foundRun2!.completedStepCount).toBe(1)
      })

      it('returns null for non-existent run', async () => {
        const run = await durably.storage.getRun('non-existent-id')
        expect(run).toBeNull()
      })

      it('updates a run', async () => {
        const { run: created } = await durably.storage.enqueue({
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
        const { run: run3 } = await durably.storage.enqueue({
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
        const { run } = await durably.storage.enqueue({
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
        const { run } = await durably.storage.enqueue({
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
        const { run } = await durably.storage.enqueue({
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
        const { run: created } = await durably.storage.enqueue({
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
        expect(claimed!.completedStepCount).toBe(0)

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

      it('claimNext preserves started_at on re-claim of recovered run', async () => {
        // Create and claim a run
        const { run: created } = await durably.storage.enqueue({
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
        const { run } = await durably.storage.enqueue({
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
        const { run } = await durably.storage.enqueue({
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
        const { run } = await durably.storage.enqueue({
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
        const { run } = await durably.storage.enqueue({
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

    describe('enqueueMany', () => {
      it('returns an empty array for empty input', async () => {
        const results = await durably.storage.enqueueMany([])
        expect(results).toEqual([])
      })

      it('persists every run in a successful batch', async () => {
        const results = await durably.storage.enqueueMany([
          { jobName: 'batch-a', input: { n: 1 } },
          { jobName: 'batch-b', input: { n: 2 } },
        ])
        expect(results).toHaveLength(2)
        expect(results[0].disposition).toBe('created')
        expect(results[1].disposition).toBe('created')

        const r0 = await durably.storage.getRun(results[0].run.id)
        const r1 = await durably.storage.getRun(results[1].run.id)
        expect(r0!.jobName).toBe('batch-a')
        expect(r0!.input).toEqual({ n: 1 })
        expect(r1!.jobName).toBe('batch-b')
        expect(r1!.input).toEqual({ n: 2 })
      })

      it('rolls back the entire batch when a later item conflicts', async () => {
        await expect(
          durably.storage.enqueueMany([
            { jobName: 'c-job', input: { x: 1 }, concurrencyKey: 'ck' },
            { jobName: 'c-job', input: { x: 2 }, concurrencyKey: 'ck' },
          ]),
        ).rejects.toThrow(ConflictError)

        const runs = await durably.storage.getRuns({ jobName: 'c-job' })
        expect(runs).toHaveLength(0)
      })
    })

    describe('renewLease', () => {
      it('extends the lease when leaseGeneration matches', async () => {
        await durably.storage.enqueue({
          jobName: 'lease-job',
          input: {},
        })
        const claimed = await durably.storage.claimNext(
          'w1',
          new Date().toISOString(),
          30_000,
        )
        const gen = claimed!.leaseGeneration
        const before = (await durably.storage.getRun(claimed!.id))!
          .leaseExpiresAt

        const renewed = await durably.storage.renewLease(
          claimed!.id,
          gen,
          new Date().toISOString(),
          60_000,
        )
        expect(renewed).toBe(true)

        const after = (await durably.storage.getRun(claimed!.id))!
          .leaseExpiresAt
        expect(after).not.toBe(before)
        expect(Date.parse(after!)).toBeGreaterThan(Date.parse(before!))
      })

      it('does not change persisted lease when leaseGeneration is stale', async () => {
        await durably.storage.enqueue({
          jobName: 'lease-job',
          input: {},
        })
        const claimed = await durably.storage.claimNext(
          'w1',
          new Date().toISOString(),
          30_000,
        )
        const snapshot = (await durably.storage.getRun(claimed!.id))!

        const renewed = await durably.storage.renewLease(
          claimed!.id,
          claimed!.leaseGeneration + 1,
          new Date().toISOString(),
          60_000,
        )
        expect(renewed).toBe(false)

        const after = (await durably.storage.getRun(claimed!.id))!
        expect(after.leaseExpiresAt).toBe(snapshot.leaseExpiresAt)
        expect(after.leaseGeneration).toBe(snapshot.leaseGeneration)
      })
    })

    describe('completeRun and failRun', () => {
      it('completeRun persists terminal state and rejects stale leaseGeneration', async () => {
        const { run } = await durably.storage.enqueue({
          jobName: 'term-job',
          input: {},
        })
        const claimed = await durably.storage.claimNext(
          'w1',
          new Date().toISOString(),
          30_000,
        )
        const gen = claimed!.leaseGeneration
        const completedAt = new Date().toISOString()
        const out = { ok: true }

        const ok = await durably.storage.completeRun(
          run.id,
          gen,
          out,
          completedAt,
        )
        expect(ok).toBe(true)

        let stored = await durably.storage.getRun(run.id)
        expect(stored!.status).toBe('completed')
        expect(stored!.output).toEqual(out)
        expect(stored!.error).toBeNull()
        expect(stored!.completedAt).toBe(completedAt)
        expect(stored!.leaseOwner).toBeNull()
        expect(stored!.leaseExpiresAt).toBeNull()

        expect(
          await durably.storage.claimNext(
            'w2',
            new Date().toISOString(),
            30_000,
          ),
        ).toBeNull()
        expect(
          await durably.storage.cancelRun(run.id, new Date().toISOString()),
        ).toBe(false)

        await durably.storage.enqueue({
          jobName: 'term-job-stale-complete',
          input: {},
        })
        const t0 = new Date().toISOString()
        const firstLease = await durably.storage.claimNext('w1', t0, 1)
        expect(firstLease).not.toBeNull()
        const staleGen = firstLease!.leaseGeneration
        const afterExpiry = new Date(Date.parse(t0) + 100).toISOString()
        await durably.storage.releaseExpiredLeases(afterExpiry)
        const secondLease = await durably.storage.claimNext(
          'w2',
          afterExpiry,
          30_000,
        )
        expect(secondLease).not.toBeNull()
        expect(secondLease!.leaseGeneration).toBeGreaterThan(staleGen)

        const snapshot = (await durably.storage.getRun(secondLease!.id))!
        const nope = await durably.storage.completeRun(
          secondLease!.id,
          staleGen,
          { x: 'ignored' },
          new Date().toISOString(),
        )
        expect(nope).toBe(false)
        stored = await durably.storage.getRun(secondLease!.id)
        expect(stored!.status).toBe('leased')
        expect(stored!.leaseGeneration).toBe(secondLease!.leaseGeneration)
        expect(stored!.leaseOwner).toBe(snapshot.leaseOwner)
        expect(stored!.leaseExpiresAt).toBe(snapshot.leaseExpiresAt)
        expect(stored!.output).toBeNull()
      })

      it('failRun persists terminal state and rejects stale leaseGeneration', async () => {
        const { run } = await durably.storage.enqueue({
          jobName: 'term-job',
          input: {},
        })
        const claimed = await durably.storage.claimNext(
          'w1',
          new Date().toISOString(),
          30_000,
        )
        const gen = claimed!.leaseGeneration
        const completedAt = new Date().toISOString()
        const errMsg = 'step failed'

        const ok = await durably.storage.failRun(
          run.id,
          gen,
          errMsg,
          completedAt,
        )
        expect(ok).toBe(true)

        let stored = await durably.storage.getRun(run.id)
        expect(stored!.status).toBe('failed')
        expect(stored!.error).toBe(errMsg)
        expect(stored!.completedAt).toBe(completedAt)
        expect(stored!.leaseOwner).toBeNull()
        expect(stored!.leaseExpiresAt).toBeNull()

        expect(
          await durably.storage.claimNext(
            'w2',
            new Date().toISOString(),
            30_000,
          ),
        ).toBeNull()

        expect(
          await durably.storage.cancelRun(run.id, new Date().toISOString()),
        ).toBe(false)
        stored = await durably.storage.getRun(run.id)
        expect(stored!.status).toBe('failed')
        expect(stored!.error).toBe(errMsg)

        await durably.storage.enqueue({
          jobName: 'term-job-stale-fail',
          input: {},
        })
        const t0 = new Date().toISOString()
        const firstLease = await durably.storage.claimNext('w1', t0, 1)
        expect(firstLease).not.toBeNull()
        const staleGen = firstLease!.leaseGeneration
        const afterExpiry = new Date(Date.parse(t0) + 100).toISOString()
        await durably.storage.releaseExpiredLeases(afterExpiry)
        const secondLease = await durably.storage.claimNext(
          'w2',
          afterExpiry,
          30_000,
        )
        expect(secondLease).not.toBeNull()
        expect(secondLease!.leaseGeneration).toBeGreaterThan(staleGen)

        const snapshot = (await durably.storage.getRun(secondLease!.id))!
        const nope = await durably.storage.failRun(
          secondLease!.id,
          staleGen,
          'ignored',
          new Date().toISOString(),
        )
        expect(nope).toBe(false)
        stored = await durably.storage.getRun(secondLease!.id)
        expect(stored!.status).toBe('leased')
        expect(stored!.leaseGeneration).toBe(secondLease!.leaseGeneration)
        expect(stored!.leaseOwner).toBe(snapshot.leaseOwner)
        expect(stored!.leaseExpiresAt).toBe(snapshot.leaseExpiresAt)
        expect(stored!.error).toBeNull()
      })
    })

    describe('updateProgress', () => {
      it('stores progress with matching leaseGeneration and ignores stale generation', async () => {
        const { run } = await durably.storage.enqueue({
          jobName: 'prog-job',
          input: {},
        })
        const claimed = await durably.storage.claimNext(
          'w1',
          new Date().toISOString(),
          30_000,
        )
        const gen = claimed!.leaseGeneration
        const progress = { current: 2, total: 10, message: 'working' }

        await durably.storage.updateProgress(run.id, gen, progress)
        let stored = await durably.storage.getRun(run.id)
        expect(stored!.progress).toEqual(progress)

        await durably.storage.updateProgress(run.id, gen + 1, {
          current: 99,
          total: 99,
        })
        stored = await durably.storage.getRun(run.id)
        expect(stored!.progress).toEqual(progress)
      })
    })

    describe('cancelRun', () => {
      it('cancels a pending run and persists terminal state', async () => {
        const { run } = await durably.storage.enqueue({
          jobName: 'cancel-job',
          input: { a: 1 },
        })
        const now = new Date().toISOString()
        const ok = await durably.storage.cancelRun(run.id, now)
        expect(ok).toBe(true)

        const stored = await durably.storage.getRun(run.id)
        expect(stored!.status).toBe('cancelled')
        expect(stored!.completedAt).toBe(now)
        expect(stored!.leaseOwner).toBeNull()
        expect(stored!.leaseExpiresAt).toBeNull()

        expect(
          await durably.storage.claimNext(
            'w1',
            new Date().toISOString(),
            30_000,
          ),
        ).toBeNull()
        expect(
          await durably.storage.cancelRun(run.id, new Date().toISOString()),
        ).toBe(false)
      })

      it('cancels a leased run and persists terminal state', async () => {
        const { run } = await durably.storage.enqueue({
          jobName: 'cancel-job',
          input: {},
        })
        await durably.storage.claimNext('w1', new Date().toISOString(), 30_000)
        const now = new Date().toISOString()
        const ok = await durably.storage.cancelRun(run.id, now)
        expect(ok).toBe(true)

        const stored = await durably.storage.getRun(run.id)
        expect(stored!.status).toBe('cancelled')
        expect(stored!.completedAt).toBe(now)
        expect(stored!.leaseOwner).toBeNull()
        expect(stored!.leaseExpiresAt).toBeNull()

        expect(
          await durably.storage.claimNext(
            'w2',
            new Date().toISOString(),
            30_000,
          ),
        ).toBeNull()
      })

      it('returns false for terminal runs', async () => {
        const { run } = await durably.storage.enqueue({
          jobName: 'cancel-job',
          input: {},
        })
        const claimed = await durably.storage.claimNext(
          'w1',
          new Date().toISOString(),
          30_000,
        )
        const completedAt = new Date().toISOString()
        await durably.storage.completeRun(
          run.id,
          claimed!.leaseGeneration,
          {},
          completedAt,
        )

        const ok = await durably.storage.cancelRun(
          run.id,
          new Date().toISOString(),
        )
        expect(ok).toBe(false)
        expect((await durably.storage.getRun(run.id))!.status).toBe('completed')
      })
    })

    describe('releaseExpiredLeases', () => {
      it('requeues an expired lease when no conflicting pending run exists', async () => {
        const { run } = await durably.storage.enqueue({
          jobName: 'rel-job',
          input: {},
          concurrencyKey: 'ck-rel',
        })
        const now = new Date().toISOString()
        const pastExpiry = new Date(Date.now() - 1000).toISOString()
        await durably.storage.updateRun(run.id, {
          status: 'leased',
          leaseOwner: 'worker-1',
          leaseExpiresAt: pastExpiry,
          startedAt: now,
        })

        await durably.storage.releaseExpiredLeases(now)

        const stored = await durably.storage.getRun(run.id)
        expect(stored!.status).toBe('pending')
        expect(stored!.leaseOwner).toBeNull()
        expect(stored!.leaseExpiresAt).toBeNull()
      })

      it('fails an expired leased run when a pending run shares jobName and concurrencyKey', async () => {
        const { run: runA } = await durably.storage.enqueue({
          jobName: 'rel-job',
          input: { which: 'a' },
          concurrencyKey: 'ck-conf',
        })
        const now = new Date().toISOString()
        const pastExpiry = new Date(Date.now() - 1000).toISOString()
        await durably.storage.updateRun(runA.id, {
          status: 'leased',
          leaseOwner: 'worker-1',
          leaseExpiresAt: pastExpiry,
          startedAt: now,
        })

        const { run: runB } = await durably.storage.enqueue({
          jobName: 'rel-job',
          input: { which: 'b' },
          concurrencyKey: 'ck-conf',
        })
        expect(runB.id).not.toBe(runA.id)

        await durably.storage.releaseExpiredLeases(now)

        const updatedA = await durably.storage.getRun(runA.id)
        expect(updatedA!.status).toBe('failed')
        expect(updatedA!.error).toContain('pending run already exists')

        const updatedB = await durably.storage.getRun(runB.id)
        expect(updatedB!.status).toBe('pending')
      })
    })

    describe('deleteRun and deleteSteps', () => {
      it('deleteRun removes the run row, labels, steps, and logs', async () => {
        const { run } = await durably.storage.enqueue({
          jobName: 'del-job',
          input: {},
          labels: { k: 'v' },
        })
        const claimed = await durably.storage.claimNext(
          'w1',
          new Date().toISOString(),
          30_000,
        )
        await durably.storage.persistStep(run.id, claimed!.leaseGeneration, {
          name: 's1',
          index: 0,
          status: 'completed',
          startedAt: new Date().toISOString(),
        })
        await durably.storage.createLog({
          runId: run.id,
          stepName: 's1',
          level: 'info',
          message: 'hello',
          data: { z: 1 },
        })

        await durably.storage.deleteRun(run.id)

        expect(await durably.storage.getRun(run.id)).toBeNull()
        const labelRows = await durably.db
          .selectFrom('durably_run_labels')
          .select('run_id')
          .where('run_id', '=', run.id)
          .execute()
        expect(labelRows).toHaveLength(0)
        const stepRows = await durably.db
          .selectFrom('durably_steps')
          .select('run_id')
          .where('run_id', '=', run.id)
          .execute()
        expect(stepRows).toHaveLength(0)
        const logRows = await durably.db
          .selectFrom('durably_logs')
          .select('run_id')
          .where('run_id', '=', run.id)
          .execute()
        expect(logRows).toHaveLength(0)
      })

      it('deleteSteps removes steps and logs but keeps the run row', async () => {
        const { run } = await durably.storage.enqueue({
          jobName: 'del-job',
          input: {},
        })
        const claimed = await durably.storage.claimNext(
          'w1',
          new Date().toISOString(),
          30_000,
        )
        await durably.storage.persistStep(run.id, claimed!.leaseGeneration, {
          name: 's1',
          index: 0,
          status: 'completed',
          startedAt: new Date().toISOString(),
        })
        await durably.storage.createLog({
          runId: run.id,
          stepName: null,
          level: 'warn',
          message: 'x',
        })

        await durably.storage.deleteSteps(run.id)

        const stored = await durably.storage.getRun(run.id)
        expect(stored).not.toBeNull()
        expect(stored!.id).toBe(run.id)
        expect(await durably.storage.getSteps(run.id)).toHaveLength(0)
        expect(await durably.storage.getLogs(run.id)).toHaveLength(0)
      })
    })

    describe('logs, progress clearing, and completed step replay', () => {
      it('createLog and getLogs preserve insertion order and payloads', async () => {
        const { run } = await durably.storage.enqueue({
          jobName: 'log-job',
          input: {},
        })
        const a = await durably.storage.createLog({
          runId: run.id,
          stepName: 'step-a',
          level: 'info',
          message: 'first',
          data: { order: 1 },
        })
        const b = await durably.storage.createLog({
          runId: run.id,
          stepName: 'step-b',
          level: 'error',
          message: 'second',
          data: { order: 2 },
        })

        const logs = await durably.storage.getLogs(run.id)
        expect(logs).toHaveLength(2)
        expect(logs[0].id).toBe(a.id)
        expect(logs[1].id).toBe(b.id)
        expect(logs[0].message).toBe('first')
        expect(logs[1].message).toBe('second')
        expect(logs[0].data).toEqual({ order: 1 })
        expect(logs[1].data).toEqual({ order: 2 })
      })

      it('updateProgress(null) clears stored progress', async () => {
        const { run } = await durably.storage.enqueue({
          jobName: 'prog-job',
          input: {},
        })
        const claimed = await durably.storage.claimNext(
          'w1',
          new Date().toISOString(),
          30_000,
        )
        await durably.storage.updateProgress(run.id, claimed!.leaseGeneration, {
          current: 1,
          total: 3,
        })
        expect((await durably.storage.getRun(run.id))!.progress).not.toBeNull()

        await durably.storage.updateProgress(
          run.id,
          claimed!.leaseGeneration,
          null,
        )
        expect((await durably.storage.getRun(run.id))!.progress).toBeNull()
      })

      it('replays completed step output unchanged from getCompletedStep', async () => {
        const { run } = await durably.storage.enqueue({
          jobName: 'replay-job',
          input: {},
        })
        const claimed = await durably.storage.claimNext(
          'w1',
          new Date().toISOString(),
          30_000,
        )
        const payload = { items: [1, 2, 3], meta: { nested: true } }
        await durably.storage.persistStep(run.id, claimed!.leaseGeneration, {
          name: 'checkpoint',
          index: 0,
          status: 'completed',
          output: payload,
          startedAt: new Date().toISOString(),
        })

        const step = await durably.storage.getCompletedStep(
          run.id,
          'checkpoint',
        )
        expect(step!.output).toEqual(payload)
      })
    })

    describe('getRuns pagination and combined filters', () => {
      it('applies limit and offset with stable ordering', async () => {
        await durably.storage.enqueue({ jobName: 'page-job', input: { i: 0 } })
        await durably.storage.enqueue({ jobName: 'page-job', input: { i: 1 } })
        await durably.storage.enqueue({ jobName: 'page-job', input: { i: 2 } })
        await durably.storage.enqueue({ jobName: 'page-job', input: { i: 3 } })

        const all = await durably.storage.getRuns({ jobName: 'page-job' })
        expect(all).toHaveLength(4)

        const page1 = await durably.storage.getRuns({
          jobName: 'page-job',
          limit: 2,
          offset: 0,
        })
        const page2 = await durably.storage.getRuns({
          jobName: 'page-job',
          limit: 2,
          offset: 2,
        })
        expect(page1).toHaveLength(2)
        expect(page2).toHaveLength(2)
        expect(page1.map((r) => r.id)).not.toEqual(page2.map((r) => r.id))
      })

      it('filters by status and jobName together', async () => {
        await durably.storage.enqueue({ jobName: 'mix-a', input: {} })
        const { run: bPending } = await durably.storage.enqueue({
          jobName: 'mix-b',
          input: {},
        })
        await durably.storage.updateRun(bPending.id, { status: 'completed' })

        const runs = await durably.storage.getRuns({
          status: 'pending',
          jobName: 'mix-b',
        })
        expect(runs).toHaveLength(0)

        const completedB = await durably.storage.getRuns({
          status: 'completed',
          jobName: 'mix-b',
        })
        expect(completedB).toHaveLength(1)
        expect(completedB[0].id).toBe(bPending.id)
      })
    })

    describe('purgeRuns', () => {
      it('deletes only terminal runs older than the cutoff, preserves non-terminal', async () => {
        const { run: oldDone } = await durably.storage.enqueue({
          jobName: 'purge-j',
          input: {},
        })
        const claimed = await durably.storage.claimNext(
          'w1',
          new Date().toISOString(),
          30_000,
        )
        const t0 = new Date(Date.now() - 60_000).toISOString()
        await durably.storage.completeRun(
          oldDone.id,
          claimed!.leaseGeneration,
          { done: true },
          t0,
        )

        const { run: pending } = await durably.storage.enqueue({
          jobName: 'purge-j',
          input: {},
        })

        const cutoff = new Date().toISOString()
        const deleted = await durably.storage.purgeRuns({ olderThan: cutoff })
        expect(deleted).toBe(1)

        expect(await durably.storage.getRun(oldDone.id)).toBeNull()
        expect((await durably.storage.getRun(pending.id))!.status).toBe(
          'pending',
        )
      })

      it('respects limit and returns 0 when no rows match', async () => {
        const tOld = new Date(Date.now() - 120_000).toISOString()
        for (let i = 0; i < 3; i++) {
          const { run } = await durably.storage.enqueue({
            jobName: 'purge-limit',
            input: { i },
          })
          const c = await durably.storage.claimNext(
            'w1',
            new Date().toISOString(),
            30_000,
          )
          await durably.storage.completeRun(
            run.id,
            c!.leaseGeneration,
            {},
            tOld,
          )
        }

        const cutoff = new Date().toISOString()
        const deleted = await durably.storage.purgeRuns({
          olderThan: cutoff,
          limit: 2,
        })
        expect(deleted).toBe(2)

        const remaining = await durably.storage.getRuns({
          jobName: 'purge-limit',
        })
        expect(remaining).toHaveLength(1)

        const none = await durably.storage.purgeRuns({
          olderThan: new Date(Date.now() - 3600_000).toISOString(),
        })
        expect(none).toBe(0)
      })
    })
  })
}
