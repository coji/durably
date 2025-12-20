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
      durably.on('run:start', listener)

      durably.emit({
        type: 'run:start',
        runId: 'run_1',
        jobName: 'test-job',
        payload: { foo: 'bar' },
      })

      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'run:start',
          runId: 'run_1',
          jobName: 'test-job',
          payload: { foo: 'bar' },
        }),
      )
    })

    it('auto-assigns sequence number to events', () => {
      const events: DurablyEvent[] = []
      durably.on('run:start', (e) => events.push(e))
      durably.on('run:complete', (e) => events.push(e))

      durably.emit({
        type: 'run:start',
        runId: 'run_1',
        jobName: 'test-job',
        payload: {},
      })

      durably.emit({
        type: 'run:complete',
        runId: 'run_1',
        jobName: 'test-job',
        output: { result: 42 },
        duration: 100,
      })

      expect(events[0].sequence).toBe(1)
      expect(events[1].sequence).toBe(2)
    })

    it('auto-assigns timestamp to events', () => {
      const events: DurablyEvent[] = []
      durably.on('run:start', (e) => events.push(e))

      durably.emit({
        type: 'run:start',
        runId: 'run_1',
        jobName: 'test-job',
        payload: {},
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

      durably.on('run:start', listener1)
      durably.on('run:start', listener2)

      durably.emit({
        type: 'run:start',
        runId: 'run_1',
        jobName: 'test-job',
        payload: {},
      })

      expect(listener1).toHaveBeenCalledTimes(1)
      expect(listener2).toHaveBeenCalledTimes(1)
    })

    it('listener exceptions do not affect other listeners', () => {
      const listener1 = vi.fn(() => {
        throw new Error('Listener 1 failed')
      })
      const listener2 = vi.fn()

      durably.on('run:start', listener1)
      durably.on('run:start', listener2)

      // Should not throw
      expect(() => {
        durably.emit({
          type: 'run:start',
          runId: 'run_1',
          jobName: 'test-job',
          payload: {},
        })
      }).not.toThrow()

      expect(listener1).toHaveBeenCalledTimes(1)
      expect(listener2).toHaveBeenCalledTimes(1)
    })

    it('can unsubscribe from events', () => {
      const listener = vi.fn()
      const unsubscribe = durably.on('run:start', listener)

      durably.emit({
        type: 'run:start',
        runId: 'run_1',
        jobName: 'test-job',
        payload: {},
      })

      expect(listener).toHaveBeenCalledTimes(1)

      unsubscribe()

      durably.emit({
        type: 'run:start',
        runId: 'run_2',
        jobName: 'test-job',
        payload: {},
      })

      expect(listener).toHaveBeenCalledTimes(1) // Still 1, not called again
    })

    it('only calls listeners for matching event type', () => {
      const startListener = vi.fn()
      const completeListener = vi.fn()

      durably.on('run:start', startListener)
      durably.on('run:complete', completeListener)

      durably.emit({
        type: 'run:start',
        runId: 'run_1',
        jobName: 'test-job',
        payload: {},
      })

      expect(startListener).toHaveBeenCalledTimes(1)
      expect(completeListener).toHaveBeenCalledTimes(0)
    })
  })
}
