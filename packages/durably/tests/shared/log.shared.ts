import type { Dialect } from 'kysely'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createDurably, type Durably, type LogWriteEvent } from '../../src'

export function createLogTests(createDialect: () => Dialect) {
  describe('context.log', () => {
    let durably: Durably

    beforeEach(async () => {
      durably = createDurably({
        dialect: createDialect(),
        pollingInterval: 50,
      })
      await durably.migrate()
    })

    afterEach(async () => {
      await durably.stop()
      await durably.db.destroy()
    })

    it('context.log.info() emits log:write event', async () => {
      const logEvents: LogWriteEvent[] = []
      durably.on('log:write', (e) => logEvents.push(e))

      const job = durably.defineJob(
        { name: 'log-info-test', input: z.object({}) },
        async (context) => {
          context.log.info('Hello from job')
          await context.run('step', () => {})
        },
      )

      await job.trigger({})
      durably.start()

      await vi.waitFor(
        async () => {
          expect(logEvents.length).toBeGreaterThanOrEqual(1)
          expect(logEvents[0].level).toBe('info')
          expect(logEvents[0].message).toBe('Hello from job')
        },
        { timeout: 1000 },
      )
    })

    it('context.log.warn() sets level to warn', async () => {
      const logEvents: LogWriteEvent[] = []
      durably.on('log:write', (e) => logEvents.push(e))

      const job = durably.defineJob(
        { name: 'log-warn-test', input: z.object({}) },
        async (context) => {
          context.log.warn('Warning message')
          await context.run('step', () => {})
        },
      )

      await job.trigger({})
      durably.start()

      await vi.waitFor(
        async () => {
          expect(logEvents.length).toBeGreaterThanOrEqual(1)
          expect(logEvents[0].level).toBe('warn')
          expect(logEvents[0].message).toBe('Warning message')
        },
        { timeout: 1000 },
      )
    })

    it('context.log.error() sets level to error', async () => {
      const logEvents: LogWriteEvent[] = []
      durably.on('log:write', (e) => logEvents.push(e))

      const job = durably.defineJob(
        { name: 'log-error-test', input: z.object({}) },
        async (context) => {
          context.log.error('Error message')
          await context.run('step', () => {})
        },
      )

      await job.trigger({})
      durably.start()

      await vi.waitFor(
        async () => {
          expect(logEvents.length).toBeGreaterThanOrEqual(1)
          expect(logEvents[0].level).toBe('error')
          expect(logEvents[0].message).toBe('Error message')
        },
        { timeout: 1000 },
      )
    })

    it('can attach structured data to log', async () => {
      const logEvents: LogWriteEvent[] = []
      durably.on('log:write', (e) => logEvents.push(e))

      const job = durably.defineJob(
        { name: 'log-data-test', input: z.object({}) },
        async (context) => {
          context.log.info('Processing item', { itemId: 123, status: 'active' })
          await context.run('step', () => {})
        },
      )

      await job.trigger({})
      durably.start()

      await vi.waitFor(
        async () => {
          expect(logEvents.length).toBeGreaterThanOrEqual(1)
          expect(logEvents[0].data).toEqual({ itemId: 123, status: 'active' })
        },
        { timeout: 1000 },
      )
    })

    it('log events include runId', async () => {
      const logEvents: LogWriteEvent[] = []
      durably.on('log:write', (e) => logEvents.push(e))

      const job = durably.defineJob(
        { name: 'log-runid-test', input: z.object({}) },
        async (context) => {
          context.log.info('Test message')
          await context.run('step', () => {})
        },
      )

      const run = await job.trigger({})
      durably.start()

      await vi.waitFor(
        async () => {
          expect(logEvents.length).toBeGreaterThanOrEqual(1)
          expect(logEvents[0].runId).toBe(run.id)
        },
        { timeout: 1000 },
      )
    })

    it('logs inside step include stepName', async () => {
      const logEvents: LogWriteEvent[] = []
      durably.on('log:write', (e) => logEvents.push(e))

      const job = durably.defineJob(
        { name: 'log-stepname-test', input: z.object({}) },
        async (context) => {
          context.log.info('Outside step') // stepName should be null
          await context.run('my-step', () => {
            context.log.info('Inside step') // stepName should be 'my-step'
          })
          context.log.info('After step') // stepName should be null
        },
      )

      await job.trigger({})
      durably.start()

      await vi.waitFor(
        async () => {
          expect(logEvents.length).toBe(3)
          expect(logEvents[0].stepName).toBeNull()
          expect(logEvents[0].message).toBe('Outside step')
          expect(logEvents[1].stepName).toBe('my-step')
          expect(logEvents[1].message).toBe('Inside step')
          expect(logEvents[2].stepName).toBeNull()
          expect(logEvents[2].message).toBe('After step')
        },
        { timeout: 1000 },
      )
    })
  })
}
