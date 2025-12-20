import type { Dialect } from 'kysely'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createDurably, type Durably, type LogWriteEvent } from '../../src'

export function createLogTests(createDialect: () => Dialect) {
  describe('ctx.log', () => {
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

    it('ctx.log.info() emits log:write event', async () => {
      const logEvents: LogWriteEvent[] = []
      durably.on('log:write', (e) => logEvents.push(e))

      const job = durably.defineJob(
        { name: 'log-info-test', input: z.object({}) },
        async (ctx) => {
          ctx.log.info('Hello from job')
          await ctx.run('step', () => {})
        }
      )

      await job.trigger({})
      durably.start()

      await vi.waitFor(
        async () => {
          expect(logEvents.length).toBeGreaterThanOrEqual(1)
          expect(logEvents[0].level).toBe('info')
          expect(logEvents[0].message).toBe('Hello from job')
        },
        { timeout: 1000 }
      )
    })

    it('ctx.log.warn() sets level to warn', async () => {
      const logEvents: LogWriteEvent[] = []
      durably.on('log:write', (e) => logEvents.push(e))

      const job = durably.defineJob(
        { name: 'log-warn-test', input: z.object({}) },
        async (ctx) => {
          ctx.log.warn('Warning message')
          await ctx.run('step', () => {})
        }
      )

      await job.trigger({})
      durably.start()

      await vi.waitFor(
        async () => {
          expect(logEvents.length).toBeGreaterThanOrEqual(1)
          expect(logEvents[0].level).toBe('warn')
          expect(logEvents[0].message).toBe('Warning message')
        },
        { timeout: 1000 }
      )
    })

    it('ctx.log.error() sets level to error', async () => {
      const logEvents: LogWriteEvent[] = []
      durably.on('log:write', (e) => logEvents.push(e))

      const job = durably.defineJob(
        { name: 'log-error-test', input: z.object({}) },
        async (ctx) => {
          ctx.log.error('Error message')
          await ctx.run('step', () => {})
        }
      )

      await job.trigger({})
      durably.start()

      await vi.waitFor(
        async () => {
          expect(logEvents.length).toBeGreaterThanOrEqual(1)
          expect(logEvents[0].level).toBe('error')
          expect(logEvents[0].message).toBe('Error message')
        },
        { timeout: 1000 }
      )
    })

    it('can attach structured data to log', async () => {
      const logEvents: LogWriteEvent[] = []
      durably.on('log:write', (e) => logEvents.push(e))

      const job = durably.defineJob(
        { name: 'log-data-test', input: z.object({}) },
        async (ctx) => {
          ctx.log.info('Processing item', { itemId: 123, status: 'active' })
          await ctx.run('step', () => {})
        }
      )

      await job.trigger({})
      durably.start()

      await vi.waitFor(
        async () => {
          expect(logEvents.length).toBeGreaterThanOrEqual(1)
          expect(logEvents[0].data).toEqual({ itemId: 123, status: 'active' })
        },
        { timeout: 1000 }
      )
    })

    it('log events include runId', async () => {
      const logEvents: LogWriteEvent[] = []
      durably.on('log:write', (e) => logEvents.push(e))

      const job = durably.defineJob(
        { name: 'log-runid-test', input: z.object({}) },
        async (ctx) => {
          ctx.log.info('Test message')
          await ctx.run('step', () => {})
        }
      )

      const run = await job.trigger({})
      durably.start()

      await vi.waitFor(
        async () => {
          expect(logEvents.length).toBeGreaterThanOrEqual(1)
          expect(logEvents[0].runId).toBe(run.id)
        },
        { timeout: 1000 }
      )
    })
  })
}
