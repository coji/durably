import type { Dialect } from 'kysely'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import {
  createDurably,
  createDurablyHandler,
  defineJob,
  type Durably,
  type DurablyHandler,
} from '../../src'

export function createServerTests(createDialect: () => Dialect) {
  describe('createDurablyHandler', () => {
    let durably: Durably
    let handler: DurablyHandler

    beforeEach(async () => {
      durably = createDurably({
        dialect: createDialect(),
        pollingInterval: 50,
      })
      await durably.migrate()
      handler = createDurablyHandler(durably)
    })

    afterEach(async () => {
      await durably.stop()
      await durably.db.destroy()
    })

    describe('handle() routing', () => {
      it('routes GET /subscribe to subscribe handler', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'subscribe-test',
            input: z.object({}),
            run: async () => {},
          }),
        })
        const run = await d.jobs.job.trigger({})

        const request = new Request(
          `http://localhost/api/durably/subscribe?runId=${run.id}`,
          { method: 'GET' },
        )
        const response = await handler.handle(request, '/api/durably')

        expect(response.status).toBe(200)
        expect(response.headers.get('Content-Type')).toBe('text/event-stream')
      })

      it('routes GET /runs to runs handler', async () => {
        const request = new Request('http://localhost/api/durably/runs', {
          method: 'GET',
        })
        const response = await handler.handle(request, '/api/durably')

        expect(response.status).toBe(200)
        expect(response.headers.get('Content-Type')).toBe('application/json')
      })

      it('routes GET /run to run handler', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'run-route-test',
            input: z.object({}),
            run: async () => {},
          }),
        })
        const run = await d.jobs.job.trigger({})

        const request = new Request(
          `http://localhost/api/durably/run?runId=${run.id}`,
          { method: 'GET' },
        )
        const response = await handler.handle(request, '/api/durably')

        expect(response.status).toBe(200)
      })

      it('routes POST /trigger to trigger handler', async () => {
        durably.register({
          job: defineJob({
            name: 'trigger-route-test',
            input: z.object({}),
            run: async () => {},
          }),
        })

        const request = new Request('http://localhost/api/durably/trigger', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobName: 'trigger-route-test', input: {} }),
        })
        const response = await handler.handle(request, '/api/durably')

        expect(response.status).toBe(200)
      })

      it('routes POST /retry to retry handler', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'retry-route-test',
            input: z.object({}),
            run: async () => {
              throw new Error('fail')
            },
          }),
        })

        const run = await d.jobs.job.trigger({})
        d.start()

        await vi.waitFor(
          async () => {
            const updated = await d.getRun(run.id)
            expect(updated?.status).toBe('failed')
          },
          { timeout: 1000 },
        )

        const request = new Request(
          `http://localhost/api/durably/retry?runId=${run.id}`,
          { method: 'POST' },
        )
        const response = await handler.handle(request, '/api/durably')

        expect(response.status).toBe(200)
      })

      it('routes POST /cancel to cancel handler', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'cancel-route-test',
            input: z.object({}),
            run: async () => {},
          }),
        })
        const run = await d.jobs.job.trigger({})

        const request = new Request(
          `http://localhost/api/durably/cancel?runId=${run.id}`,
          { method: 'POST' },
        )
        const response = await handler.handle(request, '/api/durably')

        expect(response.status).toBe(200)
      })

      it('returns 404 for unknown routes', async () => {
        const request = new Request('http://localhost/api/durably/unknown', {
          method: 'GET',
        })
        const response = await handler.handle(request, '/api/durably')

        expect(response.status).toBe(404)
      })

      it('calls onRequest hook before handling', async () => {
        const onRequest = vi.fn()
        const handlerWithHook = createDurablyHandler(durably, { onRequest })

        const request = new Request('http://localhost/api/durably/runs', {
          method: 'GET',
        })
        await handlerWithHook.handle(request, '/api/durably')

        expect(onRequest).toHaveBeenCalled()
      })
    })

    describe('trigger()', () => {
      it('triggers a job and returns runId', async () => {
        durably.register({
          job: defineJob({
            name: 'trigger-test',
            input: z.object({ value: z.number() }),
            run: async () => {},
          }),
        })

        const request = new Request('http://localhost/api/durably/trigger', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jobName: 'trigger-test',
            input: { value: 42 },
          }),
        })

        const response = await handler.trigger(request)
        const body = await response.json()

        expect(response.status).toBe(200)
        expect(body.runId).toBeDefined()
      })

      it('returns 400 when jobName is missing', async () => {
        const request = new Request('http://localhost/api/durably/trigger', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input: {} }),
        })

        const response = await handler.trigger(request)
        const body = await response.json()

        expect(response.status).toBe(400)
        expect(body.error).toBe('jobName is required')
      })

      it('returns 404 when job is not found', async () => {
        const request = new Request('http://localhost/api/durably/trigger', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobName: 'non-existent', input: {} }),
        })

        const response = await handler.trigger(request)
        const body = await response.json()

        expect(response.status).toBe(404)
        expect(body.error).toBe('Job not found: non-existent')
      })

      it('supports idempotencyKey and concurrencyKey', async () => {
        durably.register({
          job: defineJob({
            name: 'trigger-options-test',
            input: z.object({}),
            run: async () => {},
          }),
        })

        const request = new Request('http://localhost/api/durably/trigger', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jobName: 'trigger-options-test',
            input: {},
            idempotencyKey: 'idem-key',
            concurrencyKey: 'conc-key',
          }),
        })

        const response = await handler.trigger(request)
        const body = await response.json()

        expect(response.status).toBe(200)

        const run = await durably.getRun(body.runId)
        expect(run?.idempotencyKey).toBe('idem-key')
        expect(run?.concurrencyKey).toBe('conc-key')
      })
    })

    describe('runs()', () => {
      it('returns all runs', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'runs-test',
            input: z.object({}),
            run: async () => {},
          }),
        })
        await d.jobs.job.trigger({})
        await d.jobs.job.trigger({})

        const request = new Request('http://localhost/api/durably/runs', {
          method: 'GET',
        })

        const response = await handler.runs(request)
        const body = await response.json()

        expect(response.status).toBe(200)
        expect(body).toHaveLength(2)
      })

      it('filters by jobName', async () => {
        const d1 = durably.register({
          job1: defineJob({
            name: 'filter-job-1',
            input: z.object({}),
            run: async () => {},
          }),
        })
        const d2 = d1.register({
          job2: defineJob({
            name: 'filter-job-2',
            input: z.object({}),
            run: async () => {},
          }),
        })
        await d2.jobs.job1.trigger({})
        await d2.jobs.job2.trigger({})

        const request = new Request(
          'http://localhost/api/durably/runs?jobName=filter-job-1',
          { method: 'GET' },
        )

        const response = await handler.runs(request)
        const body = await response.json()

        expect(body).toHaveLength(1)
        expect(body[0].jobName).toBe('filter-job-1')
      })

      it('filters by status', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'status-filter-test',
            input: z.object({}),
            run: async () => {},
          }),
        })
        await d.jobs.job.trigger({})
        await d.jobs.job.trigger({})
        d.start()

        await vi.waitFor(
          async () => {
            const runs = await d.getRuns({ status: 'completed' })
            expect(runs.length).toBeGreaterThanOrEqual(1)
          },
          { timeout: 1000 },
        )

        const request = new Request(
          'http://localhost/api/durably/runs?status=completed',
          { method: 'GET' },
        )

        const response = await handler.runs(request)
        const body = await response.json()

        for (const run of body) {
          expect(run.status).toBe('completed')
        }
      })

      it('supports limit and offset', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'pagination-test',
            input: z.object({ order: z.number() }),
            run: async () => {},
          }),
        })
        for (let i = 1; i <= 5; i++) {
          await d.jobs.job.trigger({ order: i })
          if (i < 5) await new Promise((r) => setTimeout(r, 5))
        }

        const request = new Request(
          'http://localhost/api/durably/runs?limit=2&offset=1',
          { method: 'GET' },
        )

        const response = await handler.runs(request)
        const body = await response.json()

        expect(body).toHaveLength(2)
      })
    })

    describe('run()', () => {
      it('returns a single run', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'single-run-test',
            input: z.object({ value: z.number() }),
            run: async () => {},
          }),
        })
        const run = await d.jobs.job.trigger({ value: 42 })

        const request = new Request(
          `http://localhost/api/durably/run?runId=${run.id}`,
          { method: 'GET' },
        )

        const response = await handler.run(request)
        const body = await response.json()

        expect(response.status).toBe(200)
        expect(body.id).toBe(run.id)
        expect(body.payload).toEqual({ value: 42 })
      })

      it('returns 400 when runId is missing', async () => {
        const request = new Request('http://localhost/api/durably/run', {
          method: 'GET',
        })

        const response = await handler.run(request)
        const body = await response.json()

        expect(response.status).toBe(400)
        expect(body.error).toBe('runId query parameter is required')
      })

      it('returns 404 when run is not found', async () => {
        const request = new Request(
          'http://localhost/api/durably/run?runId=non-existent',
          { method: 'GET' },
        )

        const response = await handler.run(request)
        const body = await response.json()

        expect(response.status).toBe(404)
        expect(body.error).toBe('Run not found')
      })
    })

    describe('retry()', () => {
      it('retries a failed run', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'retry-test',
            input: z.object({}),
            run: async () => {
              throw new Error('fail')
            },
          }),
        })
        const run = await d.jobs.job.trigger({})
        d.start()

        await vi.waitFor(
          async () => {
            const updated = await d.getRun(run.id)
            expect(updated?.status).toBe('failed')
          },
          { timeout: 1000 },
        )

        const request = new Request(
          `http://localhost/api/durably/retry?runId=${run.id}`,
          { method: 'POST' },
        )

        const response = await handler.retry(request)
        const body = await response.json()

        expect(response.status).toBe(200)
        expect(body.success).toBe(true)

        const updated = await d.getRun(run.id)
        expect(updated?.status).toBe('pending')
      })

      it('returns 400 when runId is missing', async () => {
        const request = new Request('http://localhost/api/durably/retry', {
          method: 'POST',
        })

        const response = await handler.retry(request)
        const body = await response.json()

        expect(response.status).toBe(400)
        expect(body.error).toBe('runId query parameter is required')
      })

      it('returns 500 when retrying non-failed run', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'retry-pending-test',
            input: z.object({}),
            run: async () => {},
          }),
        })
        const run = await d.jobs.job.trigger({})

        const request = new Request(
          `http://localhost/api/durably/retry?runId=${run.id}`,
          { method: 'POST' },
        )

        const response = await handler.retry(request)
        expect(response.status).toBe(500)
      })
    })

    describe('cancel()', () => {
      it('cancels a pending run', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'cancel-test',
            input: z.object({}),
            run: async () => {},
          }),
        })
        const run = await d.jobs.job.trigger({})

        const request = new Request(
          `http://localhost/api/durably/cancel?runId=${run.id}`,
          { method: 'POST' },
        )

        const response = await handler.cancel(request)
        const body = await response.json()

        expect(response.status).toBe(200)
        expect(body.success).toBe(true)

        const updated = await d.getRun(run.id)
        expect(updated?.status).toBe('cancelled')
      })

      it('returns 400 when runId is missing', async () => {
        const request = new Request('http://localhost/api/durably/cancel', {
          method: 'POST',
        })

        const response = await handler.cancel(request)
        const body = await response.json()

        expect(response.status).toBe(400)
        expect(body.error).toBe('runId query parameter is required')
      })

      it('returns 500 when cancelling completed run', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'cancel-completed-test',
            input: z.object({}),
            run: async () => {},
          }),
        })
        const run = await d.jobs.job.trigger({})
        d.start()

        await vi.waitFor(
          async () => {
            const updated = await d.getRun(run.id)
            expect(updated?.status).toBe('completed')
          },
          { timeout: 1000 },
        )

        const request = new Request(
          `http://localhost/api/durably/cancel?runId=${run.id}`,
          { method: 'POST' },
        )

        const response = await handler.cancel(request)
        expect(response.status).toBe(500)
      })
    })

    describe('subscribe()', () => {
      it('returns SSE stream', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'sse-test',
            input: z.object({}),
            run: async () => {},
          }),
        })
        const run = await d.jobs.job.trigger({})

        const request = new Request(
          `http://localhost/api/durably/subscribe?runId=${run.id}`,
          { method: 'GET' },
        )

        const response = handler.subscribe(request)

        expect(response.status).toBe(200)
        expect(response.headers.get('Content-Type')).toBe('text/event-stream')
        expect(response.headers.get('Cache-Control')).toBe('no-cache')
      })

      it('streams events for a run', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'sse-stream-test',
            input: z.object({}),
            run: async (step) => {
              await step.run('step1', async () => 'result')
            },
          }),
        })
        const run = await d.jobs.job.trigger({})

        const request = new Request(
          `http://localhost/api/durably/subscribe?runId=${run.id}`,
          { method: 'GET' },
        )

        const response = handler.subscribe(request)
        const reader = response.body!.getReader()
        const decoder = new TextDecoder()

        // Start worker to process the job
        d.start()

        const events: string[] = []
        const readEvents = async () => {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            events.push(decoder.decode(value))
          }
        }

        await Promise.race([
          readEvents(),
          new Promise((r) => setTimeout(r, 1000)),
        ])

        // Should have received some events
        expect(events.length).toBeGreaterThan(0)
        const allEvents = events.join('')
        expect(allEvents).toContain('data:')
      })

      it('returns 400 when runId is missing', () => {
        const request = new Request('http://localhost/api/durably/subscribe', {
          method: 'GET',
        })

        const response = handler.subscribe(request)
        expect(response.status).toBe(400)
      })
    })

    describe('runsSubscribe()', () => {
      it('returns SSE stream for run updates', () => {
        const request = new Request(
          'http://localhost/api/durably/runs/subscribe',
          { method: 'GET' },
        )

        const response = handler.runsSubscribe(request)

        expect(response.status).toBe(200)
        expect(response.headers.get('Content-Type')).toBe('text/event-stream')
      })

      it('routes to runsSubscribe via handle()', async () => {
        const request = new Request(
          'http://localhost/api/durably/runs/subscribe',
          { method: 'GET' },
        )

        const response = await handler.handle(request, '/api/durably')

        expect(response.status).toBe(200)
        expect(response.headers.get('Content-Type')).toBe('text/event-stream')
      })

      it('streams run:trigger immediately when job is triggered', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'runs-subscribe-trigger-test',
            input: z.object({}),
            run: async () => {},
          }),
        })

        const request = new Request(
          'http://localhost/api/durably/runs/subscribe',
          { method: 'GET' },
        )

        const response = handler.runsSubscribe(request)
        const reader = response.body!.getReader()
        const decoder = new TextDecoder()

        const events: string[] = []
        const readPromise = (async () => {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            events.push(decoder.decode(value))
            // Stop after receiving the trigger event
            if (events.some((e) => e.includes('run:trigger'))) break
          }
        })()

        // Trigger the job (don't start worker yet)
        await d.jobs.job.trigger({})

        await Promise.race([
          readPromise,
          new Promise((r) => setTimeout(r, 500)),
        ])

        // Should have received run:trigger event immediately
        const allEvents = events.join('')
        expect(allEvents).toContain('run:trigger')
      })

      it('streams run:cancel when job is cancelled', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'runs-subscribe-cancel-test',
            input: z.object({}),
            run: async () => {},
          }),
        })

        const request = new Request(
          'http://localhost/api/durably/runs/subscribe',
          { method: 'GET' },
        )

        const response = handler.runsSubscribe(request)
        const reader = response.body!.getReader()
        const decoder = new TextDecoder()

        const events: string[] = []
        const readPromise = (async () => {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            events.push(decoder.decode(value))
            // Stop after receiving the cancel event
            if (events.some((e) => e.includes('run:cancel'))) break
          }
        })()

        // Trigger and then cancel the job
        const run = await d.jobs.job.trigger({})
        await d.cancel(run.id)

        await Promise.race([
          readPromise,
          new Promise((r) => setTimeout(r, 500)),
        ])

        // Should have received run:cancel event
        const allEvents = events.join('')
        expect(allEvents).toContain('run:cancel')
      })

      it('streams run:retry when job is retried', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'runs-subscribe-retry-test',
            input: z.object({}),
            run: async () => {
              throw new Error('test error')
            },
          }),
        })

        // First, trigger and let it fail
        const run = await d.jobs.job.trigger({})
        d.start()

        // Wait for the job to fail
        await new Promise((r) => setTimeout(r, 200))

        const request = new Request(
          'http://localhost/api/durably/runs/subscribe',
          { method: 'GET' },
        )

        const response = handler.runsSubscribe(request)
        const reader = response.body!.getReader()
        const decoder = new TextDecoder()

        const events: string[] = []
        const readPromise = (async () => {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            events.push(decoder.decode(value))
            // Stop after receiving the retry event
            if (events.some((e) => e.includes('run:retry'))) break
          }
        })()

        // Retry the failed job
        await d.retry(run.id)

        await Promise.race([
          readPromise,
          new Promise((r) => setTimeout(r, 500)),
        ])

        // Should have received run:retry event
        const allEvents = events.join('')
        expect(allEvents).toContain('run:retry')
      })

      it('streams run lifecycle events', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'runs-subscribe-test',
            input: z.object({}),
            run: async (step) => {
              step.progress(50)
              await step.run('work', async () => {})
            },
          }),
        })

        const request = new Request(
          'http://localhost/api/durably/runs/subscribe',
          { method: 'GET' },
        )

        const response = handler.runsSubscribe(request)
        const reader = response.body!.getReader()
        const decoder = new TextDecoder()

        // Trigger a job to generate events
        await d.jobs.job.trigger({})
        d.start()

        const events: string[] = []
        const readEvents = async () => {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            events.push(decoder.decode(value))
            // Stop after receiving some events
            if (events.length >= 3) break
          }
        }

        await Promise.race([
          readEvents(),
          new Promise((r) => setTimeout(r, 1000)),
        ])

        // Should have received run:trigger, run:start and run:complete events
        expect(events.length).toBeGreaterThan(0)
        const allEvents = events.join('')
        expect(allEvents).toContain('data:')
        expect(allEvents).toContain('run:')
      })

      it('filters by jobName', async () => {
        const d1 = durably.register({
          job1: defineJob({
            name: 'filter-subscribe-1',
            input: z.object({}),
            run: async () => {},
          }),
        })
        const d2 = d1.register({
          job2: defineJob({
            name: 'filter-subscribe-2',
            input: z.object({}),
            run: async () => {},
          }),
        })

        // Subscribe only to job1
        const request = new Request(
          'http://localhost/api/durably/runs/subscribe?jobName=filter-subscribe-1',
          { method: 'GET' },
        )

        const response = handler.runsSubscribe(request)
        const reader = response.body!.getReader()
        const decoder = new TextDecoder()

        // Trigger both jobs
        await d2.jobs.job1.trigger({})
        await d2.jobs.job2.trigger({})
        d2.start()

        const events: string[] = []
        const readEvents = async () => {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            events.push(decoder.decode(value))
            if (events.length >= 2) break
          }
        }

        await Promise.race([
          readEvents(),
          new Promise((r) => setTimeout(r, 1000)),
        ])

        // All events should be for filter-subscribe-1 only
        const allEvents = events.join('')
        if (allEvents.includes('jobName')) {
          expect(allEvents).toContain('filter-subscribe-1')
          expect(allEvents).not.toContain('filter-subscribe-2')
        }
      })
    })
  })
}
