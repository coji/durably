import type { Dialect } from 'kysely'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  createDurably,
  defineJob,
  type Durably,
  type DurablyPlugin,
} from '../../src'

export function createPluginTests(createDialect: () => Dialect) {
  describe('Plugin System', () => {
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

    describe('use()', () => {
      it('registers a plugin', async () => {
        const events: string[] = []

        const plugin: DurablyPlugin = {
          name: 'test-plugin',
          install(durably) {
            durably.on('run:start', () => {
              events.push('run:start')
            })
          },
        }

        durably.use(plugin)

        const d = durably.register({
          job: defineJob({
            name: 'plugin-test',
            input: z.object({}),
            run: async (step) => {
              await step.run('step', () => {})
            },
          }),
        })

        await d.jobs.job.trigger({})
        d.start()

        await vi.waitFor(
          async () => {
            expect(events).toContain('run:start')
          },
          { timeout: 1000 },
        )
      })

      it('can register multiple plugins', async () => {
        const events: string[] = []

        const plugin1: DurablyPlugin = {
          name: 'plugin-1',
          install(durably) {
            durably.on('run:start', () => events.push('plugin1'))
          },
        }

        const plugin2: DurablyPlugin = {
          name: 'plugin-2',
          install(durably) {
            durably.on('run:start', () => events.push('plugin2'))
          },
        }

        durably.use(plugin1)
        durably.use(plugin2)

        const d = durably.register({
          job: defineJob({
            name: 'multi-plugin-test',
            input: z.object({}),
            run: async (step) => {
              await step.run('step', () => {})
            },
          }),
        })

        await d.jobs.job.trigger({})
        d.start()

        await vi.waitFor(
          async () => {
            expect(events).toContain('plugin1')
            expect(events).toContain('plugin2')
          },
          { timeout: 1000 },
        )
      })
    })

    describe('withLogPersistence', () => {
      it('persists logs to database when enabled', async () => {
        const { withLogPersistence } = await import('../../src')
        durably.use(withLogPersistence())

        const d = durably.register({
          job: defineJob({
            name: 'log-persist-test',
            input: z.object({}),
            run: async (step) => {
              step.log.info('Test log message', { key: 'value' })
              await step.run('step', () => {})
            },
          }),
        })

        const run = await d.jobs.job.trigger({})
        d.start()

        await vi.waitFor(
          async () => {
            const updated = await d.jobs.job.getRun(run.id)
            expect(updated?.status).toBe('completed')
          },
          { timeout: 1000 },
        )

        // Check logs were persisted
        const logs = await d.storage.getLogs(run.id)
        expect(logs.length).toBeGreaterThanOrEqual(1)
        expect(logs[0].message).toBe('Test log message')
        expect(logs[0].level).toBe('info')
        expect(logs[0].data).toEqual({ key: 'value' })
      })

      it('logs table is empty without plugin', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'no-log-persist-test',
            input: z.object({}),
            run: async (step) => {
              step.log.info('This should not be persisted')
              await step.run('step', () => {})
            },
          }),
        })

        const run = await d.jobs.job.trigger({})
        d.start()

        await vi.waitFor(
          async () => {
            const updated = await d.jobs.job.getRun(run.id)
            expect(updated?.status).toBe('completed')
          },
          { timeout: 1000 },
        )

        // Logs should not be persisted
        const logs = await d.storage.getLogs(run.id)
        expect(logs).toHaveLength(0)
      })
    })
  })
}
