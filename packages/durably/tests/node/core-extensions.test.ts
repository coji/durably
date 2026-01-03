/**
 * Core Extensions Tests
 *
 * Test getJob, subscribe, and createDurablyHandler
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  createDurably,
  createDurablyHandler,
  defineJob,
  type Durably,
} from '../../src'
import type { DurablyEvent } from '../../src/events'
import { createNodeDialect } from '../helpers/node-dialect'

describe('Core Extensions', () => {
  let durably: Durably

  beforeEach(async () => {
    const dialect = createNodeDialect()
    durably = createDurably({ dialect, pollingInterval: 50 })
    await durably.migrate()
  })

  afterEach(async () => {
    await durably.stop()
  })

  describe('getJob', () => {
    const testJobDef = defineJob({
      name: 'test-job-getjob',
      input: z.object({ value: z.number() }),
      output: z.object({ result: z.number() }),
      run: async (_ctx, payload) => ({ result: payload.value * 2 }),
    })

    it('returns registered job by name', () => {
      durably.register({ testJob: testJobDef })

      const job = durably.getJob('test-job-getjob')

      expect(job).toBeDefined()
      expect(job?.name).toBe('test-job-getjob')
    })

    it('returns undefined for unknown job', () => {
      expect(durably.getJob('unknown-job')).toBeUndefined()
    })

    it('can trigger job via getJob handle', async () => {
      durably.register({ testJob: testJobDef })

      const job = durably.getJob('test-job-getjob')
      const run = await job!.trigger({ value: 5 })

      expect(run.id).toBeDefined()
      expect(run.status).toBe('pending')
    })
  })

  describe('subscribe', () => {
    const testJobDef = defineJob({
      name: 'test-job-subscribe',
      input: z.object({ input: z.string() }),
      output: z.object({ result: z.string() }),
      run: async (ctx, payload) => {
        await ctx.run('step1', () => 'done')
        return { result: `processed: ${payload.input}` }
      },
    })

    it('returns ReadableStream of events', async () => {
      durably.register({ testJob: testJobDef })
      durably.start()

      const job = durably.getJob('test-job-subscribe')!
      const run = await job.trigger({ input: 'test' })

      const stream = durably.subscribe(run.id)
      const reader = stream.getReader()

      const events: DurablyEvent[] = []
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        events.push(value)
      }

      expect(events.some((e) => e.type === 'run:complete')).toBe(true)
    })

    it('emits run:start event', async () => {
      durably.register({ testJob: testJobDef })
      durably.start()

      const job = durably.getJob('test-job-subscribe')!
      const run = await job.trigger({ input: 'test' })

      const stream = durably.subscribe(run.id)
      const reader = stream.getReader()

      const events: DurablyEvent[] = []
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        events.push(value)
      }

      expect(events.some((e) => e.type === 'run:start')).toBe(true)
    })

    it('emits step events', async () => {
      durably.register({ testJob: testJobDef })
      durably.start()

      const job = durably.getJob('test-job-subscribe')!
      const run = await job.trigger({ input: 'test' })

      const stream = durably.subscribe(run.id)
      const reader = stream.getReader()

      const events: DurablyEvent[] = []
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        events.push(value)
      }

      expect(events.some((e) => e.type === 'step:start')).toBe(true)
      expect(events.some((e) => e.type === 'step:complete')).toBe(true)
    })

    it('cleans up event listeners when stream is cancelled', async () => {
      const longRunningJob = defineJob({
        name: 'long-running-subscribe',
        input: z.object({ input: z.string() }),
        run: async (ctx) => {
          await ctx.run('wait', async () => {
            await new Promise((resolve) => setTimeout(resolve, 10000))
          })
        },
      })

      durably.register({ longRunningJob })
      durably.start()

      const job = durably.getJob('long-running-subscribe')!
      const run = await job.trigger({ input: 'test' })

      const stream = durably.subscribe(run.id)
      const reader = stream.getReader()

      // Read one event (run:start)
      const { value } = await reader.read()
      expect(value?.type).toBe('run:start')

      // Cancel the stream before the job completes
      await reader.cancel()

      // The stream should be cancelled and no errors should occur
      // If event listeners are not cleaned up, this would cause memory leaks
      // Wait a bit to ensure no errors are thrown after cancellation
      await new Promise((resolve) => setTimeout(resolve, 100))

      // Cancel the run to clean up
      await durably.cancel(run.id)
    })
  })

  describe('createDurablyHandler', () => {
    const testJobDef = defineJob({
      name: 'test-job-handler',
      input: z.object({ value: z.number() }),
      output: z.object({ result: z.number() }),
      run: async (_ctx, payload) => ({ result: payload.value * 2 }),
    })

    beforeEach(() => {
      durably.register({ testJob: testJobDef })
    })

    it('trigger returns runId', async () => {
      const handler = createDurablyHandler(durably)

      const request = new Request('http://localhost/api', {
        method: 'POST',
        body: JSON.stringify({
          jobName: 'test-job-handler',
          input: { value: 5 },
        }),
      })

      const response = await handler.trigger(request)
      const body = (await response.json()) as { runId: string }

      expect(response.status).toBe(200)
      expect(body.runId).toBeDefined()
    })

    it('trigger returns 404 for unknown job', async () => {
      const handler = createDurablyHandler(durably)

      const request = new Request('http://localhost/api', {
        method: 'POST',
        body: JSON.stringify({ jobName: 'unknown-job', input: {} }),
      })

      const response = await handler.trigger(request)

      expect(response.status).toBe(404)
    })

    it('trigger returns 400 for missing jobName', async () => {
      const handler = createDurablyHandler(durably)

      const request = new Request('http://localhost/api', {
        method: 'POST',
        body: JSON.stringify({ input: {} }),
      })

      const response = await handler.trigger(request)

      expect(response.status).toBe(400)
    })

    it('subscribe returns SSE stream', () => {
      const handler = createDurablyHandler(durably)

      const request = new Request('http://localhost/api?runId=test-run-id')
      const response = handler.subscribe(request)

      expect(response.headers.get('Content-Type')).toBe('text/event-stream')
    })

    it('subscribe returns 400 for missing runId', () => {
      const handler = createDurablyHandler(durably)

      const request = new Request('http://localhost/api')
      const response = handler.subscribe(request)

      expect(response.status).toBe(400)
    })
  })
})
