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

      it('routes POST /retrigger to retrigger handler', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'retrigger-route-test',
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
          `http://localhost/api/durably/retrigger?runId=${run.id}`,
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

      it('calls onRequest hook after authentication', async () => {
        const onRequest = vi.fn()
        const handlerWithHook = createDurablyHandler(durably, { onRequest })

        const request = new Request('http://localhost/api/durably/runs', {
          method: 'GET',
        })
        await handlerWithHook.handle(request, '/api/durably')

        expect(onRequest).toHaveBeenCalled()
      })
    })

    describe('trigger', () => {
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

        const response = await handler.handle(request, '/api/durably')
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

        const response = await handler.handle(request, '/api/durably')
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

        const response = await handler.handle(request, '/api/durably')
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

        const response = await handler.handle(request, '/api/durably')
        const body = await response.json()

        expect(response.status).toBe(200)

        const run = await durably.getRun(body.runId)
        expect(run?.idempotencyKey).toBe('idem-key')
        expect(run?.concurrencyKey).toBe('conc-key')
      })
    })

    describe('runs', () => {
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

        const response = await handler.handle(request, '/api/durably')
        const body = await response.json()

        expect(response.status).toBe(200)
        expect(body).toHaveLength(2)
      })

      it('excludes internal fields from response', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'client-run-test',
            input: z.object({}),
            run: async () => {},
          }),
        })
        await d.jobs.job.trigger({})

        const request = new Request('http://localhost/api/durably/runs', {
          method: 'GET',
        })

        const response = await handler.handle(request, '/api/durably')
        const body = await response.json()

        expect(body).toHaveLength(1)
        expect(body[0]).not.toHaveProperty('idempotencyKey')
        expect(body[0]).not.toHaveProperty('concurrencyKey')
        expect(body[0]).not.toHaveProperty('leaseOwner')
        expect(body[0]).not.toHaveProperty('leaseExpiresAt')
        expect(body[0]).not.toHaveProperty('updatedAt')
        expect(body[0]).not.toHaveProperty('heartbeatAt')
        expect(body[0]).toHaveProperty('id')
        expect(body[0]).toHaveProperty('jobName')
        expect(body[0]).toHaveProperty('status')
        expect(body[0]).toHaveProperty('createdAt')
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

        const response = await handler.handle(request, '/api/durably')
        const body = await response.json()

        expect(body).toHaveLength(1)
        expect(body[0].jobName).toBe('filter-job-1')
      })

      it('filters by multiple jobName params', async () => {
        const d2 = durably.register({
          job1: defineJob({
            name: 'multi-filter-1',
            input: z.object({}),
            run: async () => {},
          }),
          job2: defineJob({
            name: 'multi-filter-2',
            input: z.object({}),
            run: async () => {},
          }),
          job3: defineJob({
            name: 'multi-filter-3',
            input: z.object({}),
            run: async () => {},
          }),
        })
        await d2.jobs.job1.trigger({})
        await d2.jobs.job2.trigger({})
        await d2.jobs.job3.trigger({})

        const request = new Request(
          'http://localhost/api/durably/runs?jobName=multi-filter-1&jobName=multi-filter-3',
          { method: 'GET' },
        )

        const response = await handler.handle(request, '/api/durably')
        const body = await response.json()

        expect(body).toHaveLength(2)
        expect(body.map((r: { jobName: string }) => r.jobName).sort()).toEqual([
          'multi-filter-1',
          'multi-filter-3',
        ])
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

        const response = await handler.handle(request, '/api/durably')
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

        const response = await handler.handle(request, '/api/durably')
        const body = await response.json()

        expect(body).toHaveLength(2)
      })
    })

    describe('run', () => {
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

        const response = await handler.handle(request, '/api/durably')
        const body = await response.json()

        expect(response.status).toBe(200)
        expect(body.id).toBe(run.id)
        expect(body.input).toEqual({ value: 42 })
      })

      it('excludes internal fields from response', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'single-client-run-test',
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
        const body = await response.json()

        expect(response.status).toBe(200)
        expect(body).not.toHaveProperty('idempotencyKey')
        expect(body).not.toHaveProperty('concurrencyKey')
        expect(body).not.toHaveProperty('leaseOwner')
        expect(body).not.toHaveProperty('leaseExpiresAt')
        expect(body).not.toHaveProperty('updatedAt')
        expect(body).not.toHaveProperty('heartbeatAt')
      })

      it('returns 400 when runId is missing', async () => {
        const request = new Request('http://localhost/api/durably/run', {
          method: 'GET',
        })

        const response = await handler.handle(request, '/api/durably')
        const body = await response.json()

        expect(response.status).toBe(400)
        expect(body.error).toBe('runId query parameter is required')
      })

      it('returns 404 when run is not found', async () => {
        const request = new Request(
          'http://localhost/api/durably/run?runId=non-existent',
          { method: 'GET' },
        )

        const response = await handler.handle(request, '/api/durably')
        const body = await response.json()

        expect(response.status).toBe(404)
        expect(body.error).toBe('Run not found')
      })
    })

    describe('retrigger', () => {
      it('creates a fresh run from a failed run', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'retrigger-test',
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
          `http://localhost/api/durably/retrigger?runId=${run.id}`,
          { method: 'POST' },
        )

        const response = await handler.handle(request, '/api/durably')
        const body = await response.json()

        expect(response.status).toBe(200)
        expect(body.success).toBe(true)
        expect(body.runId).not.toBe(run.id)

        await vi.waitFor(
          async () => {
            const updated = await d.getRun(body.runId)
            expect(updated?.status).toBe('failed')
          },
          { timeout: 1000 },
        )
      })

      it('returns 400 when runId is missing', async () => {
        const request = new Request('http://localhost/api/durably/retrigger', {
          method: 'POST',
        })

        const response = await handler.handle(request, '/api/durably')
        const body = await response.json()

        expect(response.status).toBe(400)
        expect(body.error).toBe('runId query parameter is required')
      })

      it('returns 500 when retriggering a pending run', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'retrigger-pending-test',
            input: z.object({}),
            run: async () => {},
          }),
        })
        const run = await d.jobs.job.trigger({})

        const request = new Request(
          `http://localhost/api/durably/retrigger?runId=${run.id}`,
          { method: 'POST' },
        )

        const response = await handler.handle(request, '/api/durably')
        expect(response.status).toBe(500)
      })
    })

    describe('cancel', () => {
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

        const response = await handler.handle(request, '/api/durably')
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

        const response = await handler.handle(request, '/api/durably')
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

        const response = await handler.handle(request, '/api/durably')
        expect(response.status).toBe(500)
      })
    })

    describe('subscribe', () => {
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

        const response = await handler.handle(request, '/api/durably')

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

        const response = await handler.handle(request, '/api/durably')
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

        expect(events.length).toBeGreaterThan(0)
        const allEvents = events.join('')
        expect(allEvents).toContain('data:')
      })

      it('returns 400 when runId is missing', async () => {
        const request = new Request('http://localhost/api/durably/subscribe', {
          method: 'GET',
        })

        const response = await handler.handle(request, '/api/durably')
        expect(response.status).toBe(400)
      })
    })

    describe('runsSubscribe', () => {
      it('returns SSE stream for run updates', async () => {
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

        const response = await handler.handle(request, '/api/durably')
        const reader = response.body!.getReader()
        const decoder = new TextDecoder()

        const events: string[] = []
        const readPromise = (async () => {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            events.push(decoder.decode(value))
            if (events.some((e) => e.includes('run:trigger'))) break
          }
        })()

        await d.jobs.job.trigger({})

        await Promise.race([
          readPromise,
          new Promise((r) => setTimeout(r, 500)),
        ])

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

        const response = await handler.handle(request, '/api/durably')
        const reader = response.body!.getReader()
        const decoder = new TextDecoder()

        const events: string[] = []
        const readPromise = (async () => {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            events.push(decoder.decode(value))
            if (events.some((e) => e.includes('run:cancel'))) break
          }
        })()

        const run = await d.jobs.job.trigger({})
        await d.cancel(run.id)

        await Promise.race([
          readPromise,
          new Promise((r) => setTimeout(r, 500)),
        ])

        const allEvents = events.join('')
        expect(allEvents).toContain('run:cancel')
      })

      it('streams run:trigger when job is retriggered', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'runs-subscribe-retrigger-test',
            input: z.object({}),
            run: async () => {
              throw new Error('test error')
            },
          }),
        })

        const run = await d.jobs.job.trigger({})
        d.start()

        await new Promise((r) => setTimeout(r, 200))

        const request = new Request(
          'http://localhost/api/durably/runs/subscribe',
          { method: 'GET' },
        )

        const response = await handler.handle(request, '/api/durably')
        const reader = response.body!.getReader()
        const decoder = new TextDecoder()

        const events: string[] = []
        const readPromise = (async () => {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            events.push(decoder.decode(value))
            if (events.some((e) => e.includes('run:trigger'))) break
          }
        })()

        await d.retrigger(run.id)

        await Promise.race([
          readPromise,
          new Promise((r) => setTimeout(r, 500)),
        ])

        const allEvents = events.join('')
        expect(allEvents).toContain('run:trigger')
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

        const response = await handler.handle(request, '/api/durably')
        const reader = response.body!.getReader()
        const decoder = new TextDecoder()

        await d.jobs.job.trigger({})
        d.start()

        const events: string[] = []
        const readEvents = async () => {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            events.push(decoder.decode(value))
            if (events.length >= 3) break
          }
        }

        await Promise.race([
          readEvents(),
          new Promise((r) => setTimeout(r, 1000)),
        ])

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

        const request = new Request(
          'http://localhost/api/durably/runs/subscribe?jobName=filter-subscribe-1',
          { method: 'GET' },
        )

        const response = await handler.handle(request, '/api/durably')
        const reader = response.body!.getReader()
        const decoder = new TextDecoder()

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

        const allEvents = events.join('')
        if (allEvents.includes('jobName')) {
          expect(allEvents).toContain('filter-subscribe-1')
          expect(allEvents).not.toContain('filter-subscribe-2')
        }
      })

      it('filters by multiple jobName params', async () => {
        const d1 = durably.register({
          job1: defineJob({
            name: 'multi-subscribe-1',
            input: z.object({}),
            run: async () => {},
          }),
        })
        const d2 = d1.register({
          job2: defineJob({
            name: 'multi-subscribe-2',
            input: z.object({}),
            run: async () => {},
          }),
        })
        const d3 = d2.register({
          job3: defineJob({
            name: 'multi-subscribe-3',
            input: z.object({}),
            run: async () => {},
          }),
        })

        const request = new Request(
          'http://localhost/api/durably/runs/subscribe?jobName=multi-subscribe-1&jobName=multi-subscribe-3',
          { method: 'GET' },
        )

        const response = await handler.handle(request, '/api/durably')
        const reader = response.body!.getReader()
        const decoder = new TextDecoder()

        await d3.jobs.job1.trigger({})
        await d3.jobs.job2.trigger({})
        await d3.jobs.job3.trigger({})

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

        const allEvents = events.join('')
        if (allEvents.includes('jobName')) {
          expect(allEvents).not.toContain('multi-subscribe-2')
        }
      })
    })

    describe('auth middleware', () => {
      it('calls authenticate before onRequest', async () => {
        const callOrder: string[] = []
        const authHandler = createDurablyHandler(durably, {
          onRequest: () => {
            callOrder.push('onRequest')
          },
          auth: {
            authenticate: () => {
              callOrder.push('authenticate')
              return { userId: 'user-1' }
            },
          },
        })

        const request = new Request('http://localhost/api/durably/runs', {
          method: 'GET',
        })
        await authHandler.handle(request, '/api/durably')

        expect(callOrder).toEqual(['authenticate', 'onRequest'])
      })

      it('rejects unauthenticated requests without calling onRequest', async () => {
        const onRequest = vi.fn()
        const authHandler = createDurablyHandler(durably, {
          onRequest,
          auth: {
            authenticate: () => {
              throw new Response('Unauthorized', { status: 401 })
            },
          },
        })

        const request = new Request('http://localhost/api/durably/runs', {
          method: 'GET',
        })
        const response = await authHandler.handle(request, '/api/durably')

        expect(response.status).toBe(401)
        expect(onRequest).not.toHaveBeenCalled()
      })

      it('passes context to onTrigger', async () => {
        durably.register({
          job: defineJob({
            name: 'auth-trigger-test',
            input: z.object({}),
            run: async () => {},
          }),
        })

        const onTrigger = vi.fn()
        const authHandler = createDurablyHandler(durably, {
          auth: {
            authenticate: () => ({ userId: 'user-1' }),
            onTrigger,
          },
        })

        const request = new Request('http://localhost/api/durably/trigger', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jobName: 'auth-trigger-test',
            input: {},
          }),
        })

        await authHandler.handle(request, '/api/durably')

        expect(onTrigger).toHaveBeenCalledWith(
          { userId: 'user-1' },
          expect.objectContaining({ jobName: 'auth-trigger-test' }),
        )
      })

      it('onTrigger runs after validation (missing jobName returns 400)', async () => {
        const onTrigger = vi.fn()
        const authHandler = createDurablyHandler(durably, {
          auth: {
            authenticate: () => ({ userId: 'user-1' }),
            onTrigger,
          },
        })

        const request = new Request('http://localhost/api/durably/trigger', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ input: {} }),
        })

        const response = await authHandler.handle(request, '/api/durably')

        expect(response.status).toBe(400)
        expect(onTrigger).not.toHaveBeenCalled()
      })

      it('onTrigger runs after validation (unknown job returns 404)', async () => {
        const onTrigger = vi.fn()
        const authHandler = createDurablyHandler(durably, {
          auth: {
            authenticate: () => ({ userId: 'user-1' }),
            onTrigger,
          },
        })

        const request = new Request('http://localhost/api/durably/trigger', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jobName: 'nonexistent', input: {} }),
        })

        const response = await authHandler.handle(request, '/api/durably')

        expect(response.status).toBe(404)
        expect(onTrigger).not.toHaveBeenCalled()
      })

      it('onTrigger can reject with thrown Response', async () => {
        durably.register({
          job: defineJob({
            name: 'auth-reject-test',
            input: z.object({}),
            run: async () => {},
          }),
        })

        const authHandler = createDurablyHandler(durably, {
          auth: {
            authenticate: () => ({ userId: 'user-1' }),
            onTrigger: () => {
              throw new Response('Forbidden', { status: 403 })
            },
          },
        })

        const request = new Request('http://localhost/api/durably/trigger', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jobName: 'auth-reject-test',
            input: {},
          }),
        })

        const response = await authHandler.handle(request, '/api/durably')
        expect(response.status).toBe(403)
      })

      it('onRunAccess receives run and operation type', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'auth-run-access-test',
            input: z.object({}),
            run: async () => {},
          }),
        })
        const run = await d.jobs.job.trigger({})

        const onRunAccess = vi.fn()
        const authHandler = createDurablyHandler(durably, {
          auth: {
            authenticate: () => ({ userId: 'user-1' }),
            onRunAccess,
          },
        })

        const request = new Request(
          `http://localhost/api/durably/run?runId=${run.id}`,
          { method: 'GET' },
        )

        await authHandler.handle(request, '/api/durably')

        expect(onRunAccess).toHaveBeenCalledWith(
          { userId: 'user-1' },
          expect.objectContaining({ id: run.id }),
          { operation: 'read' },
        )
      })

      it('onRunAccess receives correct operation for each endpoint', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'auth-ops-test',
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

        const operations: string[] = []
        const authHandler = createDurablyHandler(durably, {
          auth: {
            authenticate: () => ({ userId: 'user-1' }),
            onRunAccess: (_ctx, _run, { operation }) => {
              operations.push(operation)
            },
          },
        })

        // retrigger
        await authHandler.handle(
          new Request(
            `http://localhost/api/durably/retrigger?runId=${run.id}`,
            {
              method: 'POST',
            },
          ),
          '/api/durably',
        )

        expect(operations).toContain('retrigger')
      })

      it('onRunAccess can reject with thrown Response', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'auth-run-reject-test',
            input: z.object({}),
            run: async () => {},
          }),
        })
        const run = await d.jobs.job.trigger({})

        const authHandler = createDurablyHandler(durably, {
          auth: {
            authenticate: () => ({ userId: 'user-1' }),
            onRunAccess: () => {
              throw new Response('Not Found', { status: 404 })
            },
          },
        })

        const request = new Request(
          `http://localhost/api/durably/run?runId=${run.id}`,
          { method: 'GET' },
        )

        const response = await authHandler.handle(request, '/api/durably')
        expect(response.status).toBe(404)
      })

      it('scopeRuns transforms filter', async () => {
        const d = durably.register({
          job: defineJob({
            name: 'auth-scope-test',
            input: z.object({}),
            run: async () => {},
          }),
        })
        await d.jobs.job.trigger({}, { labels: { tenant: 'org-1' } })
        await d.jobs.job.trigger({}, { labels: { tenant: 'org-2' } })

        const authHandler = createDurablyHandler(durably, {
          auth: {
            authenticate: () => ({ tenantId: 'org-1' }),
            scopeRuns: (ctx, filter) => ({
              ...filter,
              labels: { ...filter.labels, tenant: ctx.tenantId },
            }),
          },
        })

        const request = new Request('http://localhost/api/durably/runs', {
          method: 'GET',
        })

        const response = await authHandler.handle(request, '/api/durably')
        const body = await response.json()

        expect(body).toHaveLength(1)
        expect(body[0].labels.tenant).toBe('org-1')
      })

      it('only exposes handle() method', () => {
        const authHandler = createDurablyHandler(durably, {
          auth: {
            authenticate: () => ({ userId: 'user-1' }),
          },
        })

        expect(authHandler.handle).toBeDefined()
        expect(Object.keys(authHandler)).toEqual(['handle'])
      })

      it('throws if auth is provided without authenticate', () => {
        expect(() =>
          // biome-ignore lint/suspicious/noExplicitAny: testing runtime validation
          createDurablyHandler(durably, { auth: {} as any }),
        ).toThrow('auth.authenticate is required')
      })
    })
  })
}
