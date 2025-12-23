import type { Dialect } from 'kysely'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  createDurably,
  defineJob,
  type Durably,
  type LogWriteEvent,
} from '../../src'

export function createLogTests(createDialect: () => Dialect) {
  describe('step.log', () => {
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

    it('step.log.info() emits log:write event', async () => {
      const logEvents: LogWriteEvent[] = []
      durably.on('log:write', (e) => logEvents.push(e))

      const logInfoTestDef = defineJob({
        name: 'log-info-test',
        input: z.object({}),
        run: async (step) => {
          step.log.info('Hello from job')
          await step.run('step', () => {})
        },
      })
      const job = durably.register(logInfoTestDef)

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

    it('step.log.warn() sets level to warn', async () => {
      const logEvents: LogWriteEvent[] = []
      durably.on('log:write', (e) => logEvents.push(e))

      const logWarnTestDef = defineJob({
        name: 'log-warn-test',
        input: z.object({}),
        run: async (step) => {
          step.log.warn('Warning message')
          await step.run('step', () => {})
        },
      })
      const job = durably.register(logWarnTestDef)

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

    it('step.log.error() sets level to error', async () => {
      const logEvents: LogWriteEvent[] = []
      durably.on('log:write', (e) => logEvents.push(e))

      const logErrorTestDef = defineJob({
        name: 'log-error-test',
        input: z.object({}),
        run: async (step) => {
          step.log.error('Error message')
          await step.run('step', () => {})
        },
      })
      const job = durably.register(logErrorTestDef)

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

      const logDataTestDef = defineJob({
        name: 'log-data-test',
        input: z.object({}),
        run: async (step) => {
          step.log.info('Processing item', { itemId: 123, status: 'active' })
          await step.run('step', () => {})
        },
      })
      const job = durably.register(logDataTestDef)

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

      const logRunIdTestDef = defineJob({
        name: 'log-runid-test',
        input: z.object({}),
        run: async (step) => {
          step.log.info('Test message')
          await step.run('step', () => {})
        },
      })
      const job = durably.register(logRunIdTestDef)

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

      const logStepNameTestDef = defineJob({
        name: 'log-stepname-test',
        input: z.object({}),
        run: async (step) => {
          step.log.info('Outside step') // stepName should be null
          await step.run('my-step', () => {
            step.log.info('Inside step') // stepName should be 'my-step'
          })
          step.log.info('After step') // stepName should be null
        },
      })
      const job = durably.register(logStepNameTestDef)

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
