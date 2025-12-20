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
        const run = await durably.storage.createRun({
          jobName: 'test-job',
          payload: { foo: 'bar' },
        })

        expect(run.id).toBeDefined()
        expect(run.jobName).toBe('test-job')
        expect(run.status).toBe('pending')
        expect(run.payload).toEqual({ foo: 'bar' })
      })

      it('creates a run with idempotency key', async () => {
        const run1 = await durably.storage.createRun({
          jobName: 'test-job',
          payload: { foo: 'bar' },
          idempotencyKey: 'key-1',
        })

        const run2 = await durably.storage.createRun({
          jobName: 'test-job',
          payload: { foo: 'baz' },
          idempotencyKey: 'key-1',
        })

        // Same idempotency key should return the same run
        expect(run2.id).toBe(run1.id)
        expect(run2.payload).toEqual({ foo: 'bar' }) // Original payload
      })

      it('gets a run by id', async () => {
        const created = await durably.storage.createRun({
          jobName: 'test-job',
          payload: { foo: 'bar' },
        })

        const run = await durably.storage.getRun(created.id)

        expect(run).not.toBeNull()
        expect(run!.id).toBe(created.id)
        expect(run!.jobName).toBe('test-job')
      })

      it('returns null for non-existent run', async () => {
        const run = await durably.storage.getRun('non-existent-id')
        expect(run).toBeNull()
      })

      it('updates a run', async () => {
        const created = await durably.storage.createRun({
          jobName: 'test-job',
          payload: {},
        })

        await durably.storage.updateRun(created.id, {
          status: 'running',
        })

        const run = await durably.storage.getRun(created.id)
        expect(run!.status).toBe('running')
      })

      it('gets runs with filter', async () => {
        await durably.storage.createRun({ jobName: 'job-a', payload: {} })
        await durably.storage.createRun({ jobName: 'job-b', payload: {} })
        const run3 = await durably.storage.createRun({
          jobName: 'job-a',
          payload: {},
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

      it('gets next pending run respecting concurrency keys', async () => {
        // Create runs with different concurrency keys
        await durably.storage.createRun({
          jobName: 'job',
          payload: {},
          concurrencyKey: 'key-a',
        })
        await durably.storage.createRun({
          jobName: 'job',
          payload: {},
          concurrencyKey: 'key-b',
        })

        // Get next pending run, excluding key-a
        const run = await durably.storage.getNextPendingRun(['key-a'])

        expect(run).not.toBeNull()
        expect(run!.concurrencyKey).toBe('key-b')
      })
    })

    describe('Step operations', () => {
      it('creates a step', async () => {
        const run = await durably.storage.createRun({
          jobName: 'test-job',
          payload: {},
        })

        await durably.storage.createStep({
          runId: run.id,
          name: 'step-1',
          index: 0,
          status: 'completed',
          output: { result: 42 },
        })

        const steps = await durably.storage.getSteps(run.id)
        expect(steps).toHaveLength(1)
        expect(steps[0].name).toBe('step-1')
        expect(steps[0].output).toEqual({ result: 42 })
      })

      it('gets completed step by name', async () => {
        const run = await durably.storage.createRun({
          jobName: 'test-job',
          payload: {},
        })

        await durably.storage.createStep({
          runId: run.id,
          name: 'fetch-data',
          index: 0,
          status: 'completed',
          output: { data: [1, 2, 3] },
        })

        const step = await durably.storage.getCompletedStep(
          run.id,
          'fetch-data',
        )
        expect(step).not.toBeNull()
        expect(step!.output).toEqual({ data: [1, 2, 3] })
      })

      it('returns null for non-existent step', async () => {
        const run = await durably.storage.createRun({
          jobName: 'test-job',
          payload: {},
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
