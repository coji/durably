import type { Dialect } from 'kysely'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDurably, type Durably, type DurablyEvent } from '../../src'

export function createEventsTests(createDialect: () => Dialect) {
  describe('EventEmitter', () => {
    let durably: Durably

    beforeEach(async () => {
      durably = createDurably({ dialect: createDialect() })
      await durably.migrate()
    })

    afterEach(async () => {
      await durably.db.destroy()
    })

    it('can register and call event listeners', () => {
      const listener = vi.fn()
      durably.on('run:leased', listener)

      durably.emit({
        type: 'run:leased',
        runId: 'run_1',
        jobName: 'test-job',
        input: { foo: 'bar' },
        leaseOwner: 'worker-1',
        leaseExpiresAt: '2024-01-01T00:00:30.000Z',
        labels: {},
      })

      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'run:leased',
          runId: 'run_1',
          jobName: 'test-job',
          input: { foo: 'bar' },
          labels: {},
        }),
      )
    })

    it('auto-assigns sequence number to events', () => {
      const events: DurablyEvent[] = []
      durably.on('run:leased', (e) => events.push(e))
      durably.on('run:complete', (e) => events.push(e))

      durably.emit({
        type: 'run:leased',
        runId: 'run_1',
        jobName: 'test-job',
        input: {},
        leaseOwner: 'worker-1',
        leaseExpiresAt: '2024-01-01T00:00:30.000Z',
        labels: {},
      })

      durably.emit({
        type: 'run:complete',
        runId: 'run_1',
        jobName: 'test-job',
        output: { result: 42 },
        duration: 100,
        labels: {},
      })

      expect(events[0].sequence).toBe(1)
      expect(events[1].sequence).toBe(2)
    })

    it('auto-assigns timestamp to events', () => {
      const events: DurablyEvent[] = []
      durably.on('run:leased', (e) => events.push(e))

      durably.emit({
        type: 'run:leased',
        runId: 'run_1',
        jobName: 'test-job',
        input: {},
        leaseOwner: 'worker-1',
        leaseExpiresAt: '2024-01-01T00:00:30.000Z',
        labels: {},
      })

      expect(events[0].timestamp).toBeDefined()
      expect(new Date(events[0].timestamp).getTime()).toBeCloseTo(
        Date.now(),
        -2,
      )
    })

    it('can register multiple listeners for the same event', () => {
      const listener1 = vi.fn()
      const listener2 = vi.fn()

      durably.on('run:leased', listener1)
      durably.on('run:leased', listener2)

      durably.emit({
        type: 'run:leased',
        runId: 'run_1',
        jobName: 'test-job',
        input: {},
        leaseOwner: 'worker-1',
        leaseExpiresAt: '2024-01-01T00:00:30.000Z',
        labels: {},
      })

      expect(listener1).toHaveBeenCalledTimes(1)
      expect(listener2).toHaveBeenCalledTimes(1)
    })

    it('listener exceptions do not affect other listeners', () => {
      const listener1 = vi.fn(() => {
        throw new Error('Listener 1 failed')
      })
      const listener2 = vi.fn()

      durably.on('run:leased', listener1)
      durably.on('run:leased', listener2)

      // Should not throw
      expect(() => {
        durably.emit({
          type: 'run:leased',
          runId: 'run_1',
          jobName: 'test-job',
          input: {},
          leaseOwner: 'worker-1',
          leaseExpiresAt: '2024-01-01T00:00:30.000Z',
          labels: {},
        })
      }).not.toThrow()

      expect(listener1).toHaveBeenCalledTimes(1)
      expect(listener2).toHaveBeenCalledTimes(1)
    })

    it('can unsubscribe from events', () => {
      const listener = vi.fn()
      const unsubscribe = durably.on('run:leased', listener)

      durably.emit({
        type: 'run:leased',
        runId: 'run_1',
        jobName: 'test-job',
        input: {},
        leaseOwner: 'worker-1',
        leaseExpiresAt: '2024-01-01T00:00:30.000Z',
        labels: {},
      })

      expect(listener).toHaveBeenCalledTimes(1)

      unsubscribe()

      durably.emit({
        type: 'run:leased',
        runId: 'run_2',
        jobName: 'test-job',
        input: {},
        leaseOwner: 'worker-1',
        leaseExpiresAt: '2024-01-01T00:00:30.000Z',
        labels: {},
      })

      expect(listener).toHaveBeenCalledTimes(1) // Still 1, not called again
    })

    it('only calls listeners for matching event type', () => {
      const startListener = vi.fn()
      const completeListener = vi.fn()

      durably.on('run:leased', startListener)
      durably.on('run:complete', completeListener)

      durably.emit({
        type: 'run:leased',
        runId: 'run_1',
        jobName: 'test-job',
        input: {},
        leaseOwner: 'worker-1',
        leaseExpiresAt: '2024-01-01T00:00:30.000Z',
        labels: {},
      })

      expect(startListener).toHaveBeenCalledTimes(1)
      expect(completeListener).toHaveBeenCalledTimes(0)
    })

    it('emits run:delete event with correct fields', () => {
      const listener = vi.fn()
      durably.on('run:delete', listener)

      durably.emit({
        type: 'run:delete',
        runId: 'run_1',
        jobName: 'test-job',
        labels: { env: 'test' },
      })

      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'run:delete',
          runId: 'run_1',
          jobName: 'test-job',
          labels: { env: 'test' },
        }),
      )
    })

    it('calls onError handler when listener throws', () => {
      const errorHandler = vi.fn()
      const failingListener = vi.fn(() => {
        throw new Error('Listener error')
      })

      durably.onError(errorHandler)
      durably.on('run:leased', failingListener)

      durably.emit({
        type: 'run:leased',
        runId: 'run_1',
        jobName: 'test-job',
        input: {},
        leaseOwner: 'worker-1',
        leaseExpiresAt: '2024-01-01T00:00:30.000Z',
        labels: {},
      })

      expect(failingListener).toHaveBeenCalledTimes(1)
      expect(errorHandler).toHaveBeenCalledTimes(1)
      expect(errorHandler).toHaveBeenCalledWith(
        expect.any(Error),
        expect.objectContaining({
          type: 'run:leased',
          runId: 'run_1',
        }),
      )
    })
  })
}
