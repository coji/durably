import type { Dialect } from 'kysely'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { createDurably, defineJob, type Durably } from '../../src'

/**
 * A state change's event follows its storage write directly: nothing else
 * touches storage between the write resolving and the event being emitted.
 * A listener that reads the run on the event therefore sees the new state.
 * The reverse is not promised: a concurrent reader may see the new state
 * just before the event is delivered.
 *
 * The trace records every storage call and resolution plus every event, in
 * order, so a regression shows up as another storage call in between rather
 * than as a timing-dependent failure.
 */
function traceStorage(durably: Durably<any, any>) {
  const trace: string[] = []
  const storage = durably.storage as unknown as Record<string, unknown>
  for (const [name, value] of Object.entries(storage)) {
    if (typeof value !== 'function') continue
    const original = value as (...args: unknown[]) => unknown
    storage[name] = (...args: unknown[]) => {
      trace.push(`call:${name}`)
      const result = original.apply(durably.storage, args)
      if (result instanceof Promise) {
        return result.then((resolved) => {
          trace.push(`done:${name}`)
          return resolved
        })
      }
      return result
    }
  }
  return trace
}

function recordEvents(durably: Durably<any, any>, trace: string[]) {
  for (const type of [
    'run:trigger',
    'run:leased',
    'run:complete',
    'run:fail',
    'run:cancel',
    'run:delete',
    'run:waiting',
    'run:coalesced',
    'step:start',
    'step:complete',
    'step:fail',
  ] as const) {
    durably.on(type, () => {
      trace.push(`event:${type}`)
    })
  }
}

/** The entry right after the last resolution of `write` is `event`. */
function expectEventRightAfter(trace: string[], write: string, event: string) {
  const index = trace.lastIndexOf(`done:${write}`)
  expect(index, `${write} never resolved: ${trace.join(' ')}`).not.toBe(-1)
  expect(trace.slice(index, index + 2)).toEqual([
    `done:${write}`,
    `event:${event}`,
  ])
}

export function createEventOrderingTests(createDialect: () => Dialect) {
  describe('events follow their storage writes directly', () => {
    const runtimes: Durably<any, any>[] = []

    async function setup() {
      const durably = createDurably({ dialect: createDialect() })
      runtimes.push(durably)
      await durably.migrate()
      const trace = traceStorage(durably)
      recordEvents(durably, trace)
      return { durably, trace }
    }

    afterEach(async () => {
      await Promise.all(runtimes.map((runtime) => runtime.stop()))
      await Promise.all(runtimes.map((runtime) => runtime.db.destroy()))
      runtimes.length = 0
    })

    it('trigger, lease, step completion and run completion', async () => {
      const { durably, trace } = await setup()
      const d = durably.register({
        job: defineJob({
          name: 'ordering-complete',
          input: z.object({}),
          run: async (step) => {
            await step.run('work', () => 1)
          },
        }),
      })
      await d.jobs.job.trigger({})
      expectEventRightAfter(trace, 'enqueue', 'run:trigger')
      await d.processOne()
      expectEventRightAfter(trace, 'claimNext', 'run:leased')
      expectEventRightAfter(trace, 'beginStepAttempt', 'step:start')
      expectEventRightAfter(trace, 'persistStep', 'step:complete')
      expectEventRightAfter(trace, 'completeRun', 'run:complete')
    })

    it('step and run failure', async () => {
      const { durably, trace } = await setup()
      const d = durably.register({
        job: defineJob({
          name: 'ordering-fail',
          input: z.object({}),
          run: async (step) => {
            await step.run('work', () => {
              throw new Error('boom')
            })
          },
        }),
      })
      await d.jobs.job.trigger({})
      await d.processOne()
      expectEventRightAfter(trace, 'persistStep', 'step:fail')
      expectEventRightAfter(trace, 'failRun', 'run:fail')
    })

    it('coalesced trigger', async () => {
      const { durably, trace } = await setup()
      const d = durably.register({
        job: defineJob({
          name: 'ordering-coalesce',
          input: z.object({}),
          run: async () => {},
        }),
      })
      const options = { concurrencyKey: 'key', coalesce: 'skip' } as const
      await d.jobs.job.trigger({}, options)
      await d.jobs.job.trigger({}, options)
      expectEventRightAfter(trace, 'enqueue', 'run:coalesced')
    })

    it('failure of a run whose job is not registered', async () => {
      const { durably, trace } = await setup()
      const failures: { error: string; failedStepName: string }[] = []
      durably.on('run:fail', (event) => failures.push(event))
      const { run } = await durably.storage.enqueue({
        jobName: 'not-registered',
        input: {},
      })
      await durably.processOne()
      expectEventRightAfter(trace, 'claimNext', 'run:leased')
      expectEventRightAfter(trace, 'failRun', 'run:fail')
      expect(failures).toEqual([
        expect.objectContaining({
          error: 'Unknown job: not-registered',
          failedStepName: 'unknown',
        }),
      ])
      expect((await durably.getRun(run.id))?.status).toBe('failed')
    })

    it('suspension on a durable wait', async () => {
      const { durably, trace } = await setup()
      const d = durably.register({
        job: defineJob({
          name: 'ordering-wait',
          input: z.object({}),
          run: async (step) => {
            await step.waitFor(await step.prepareWait('approval'))
          },
        }),
      })
      await d.jobs.job.trigger({})
      await d.processOne()
      expectEventRightAfter(trace, 'suspendRun', 'run:waiting')
    })

    it('cancellation, deletion and retrigger', async () => {
      const { durably, trace } = await setup()
      const d = durably.register({
        job: defineJob({
          name: 'ordering-cancel',
          input: z.object({}),
          run: async () => {},
        }),
      })
      const run = await d.jobs.job.trigger({})
      await d.cancel(run.id)
      expectEventRightAfter(trace, 'cancelRun', 'run:cancel')
      await d.retrigger(run.id)
      expectEventRightAfter(trace, 'enqueue', 'run:trigger')
      await d.deleteRun(run.id)
      expectEventRightAfter(trace, 'deleteRun', 'run:delete')
    })

    it('cancel resolves and reports a failed checkpoint cleanup', async () => {
      const { durably } = await setup()
      const errors: { context: string; runId?: string }[] = []
      durably.on('worker:error', (event) => errors.push(event))
      const d = durably.register({
        job: defineJob({
          name: 'ordering-cancel-cleanup',
          input: z.object({}),
          run: async () => {},
        }),
      })
      const run = await d.jobs.job.trigger({})
      d.storage.deleteSteps = async () => {
        throw new Error('cleanup failed')
      }
      await d.cancel(run.id)
      expect((await d.getRun(run.id))?.status).toBe('cancelled')
      expect(errors).toEqual([
        expect.objectContaining({ context: 'cancel-cleanup', runId: run.id }),
      ])
    })

    it('cancel resolves even when reporting the cleanup failure throws', async () => {
      const { durably } = await setup()
      durably.on('worker:error', () => {
        throw new Error('listener failed')
      })
      durably.onError(() => {
        throw new Error('onError failed')
      })
      const d = durably.register({
        job: defineJob({
          name: 'ordering-cancel-report',
          input: z.object({}),
          run: async () => {},
        }),
      })
      const run = await d.jobs.job.trigger({})
      d.storage.deleteSteps = async () => {
        throw new Error('cleanup failed')
      }
      await expect(d.cancel(run.id)).resolves.toBeUndefined()
      expect((await d.getRun(run.id))?.status).toBe('cancelled')
    })
  })
}
