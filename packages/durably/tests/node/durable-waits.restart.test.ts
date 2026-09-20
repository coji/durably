import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect, it } from 'vitest'
import { z } from 'zod'

import { createDurably, createDurablyHandler, defineJob } from '../../src'
import { createNodeDialectForFile } from '../helpers/node-dialect'

it('recreates a runtime after the deadline and resumes the original run through timeout', async () => {
  const directory = mkdtempSync(join(tmpdir(), `durably-wait-${randomUUID()}-`))
  const file = join(directory, 'wait.db')
  const job = defineJob({
    name: 'deadline-restart',
    input: z.object({}),
    output: z.unknown(),
    run: async (step) => {
      const wait = await step.prepareWait('approval', { timeoutMs: 500 })
      return step.waitFor(wait)
    },
  })

  const first = createDurably({
    dialect: createNodeDialectForFile(file),
  }).register({ job })
  let second: typeof first | null = null
  let firstDestroyed = false
  try {
    await first.migrate()
    const run = await first.jobs.job.trigger({})
    await first.processOne()
    const [wait] = await first.getWaits(run.id)
    expect((await first.getRun(run.id))?.status).toBe('waiting')
    await first.stop()
    await first.db.destroy()
    firstDestroyed = true

    await new Promise((resolve) =>
      setTimeout(
        resolve,
        Math.max(0, Date.parse(wait.deadlineAt!) - Date.now() + 10),
      ),
    )
    second = createDurably({
      dialect: createNodeDialectForFile(file),
    }).register({ job })
    await second.migrate()
    expect((await second.getWait(wait.id))?.deadlineAt).toBe(wait.deadlineAt)
    await second.processOne()
    expect((await second.getRun(run.id))?.output).toEqual({ type: 'timeout' })
    expect((await second.getWait(wait.id))?.id).toBe(wait.id)
    expect((await second.getWait(wait.id))?.outcome).toBe('timeout')
  } finally {
    if (!firstDestroyed) {
      await first.stop()
      await first.db.destroy()
    }
    await second?.stop()
    await second?.db.destroy()
    rmSync(directory, { recursive: true, force: true })
  }
})

it('recovers a missed wait result through HTTP after recreating the runtime', async () => {
  const directory = mkdtempSync(
    join(tmpdir(), `durably-http-wait-${randomUUID()}-`),
  )
  const file = join(directory, 'wait.db')
  const job = defineJob({
    name: 'http-restart',
    input: z.object({}),
    output: z.boolean(),
    run: async (step) => {
      const wait = await step.prepareWait('decision')
      const result = await step.waitFor(wait)
      return result.type === 'signal' && result.payload === true
    },
  })
  const open = () =>
    createDurably({ dialect: createNodeDialectForFile(file), jobs: { job } })
  let current = open()
  try {
    await current.migrate()
    const run = await current.jobs.job.trigger({}, { labels: { owner: 'one' } })
    await current.processUntilIdle()
    await current.db.destroy()

    current = open()
    await current.migrate()
    const handler = createDurablyHandler(current, {
      auth: {
        authenticate: () => ({ owner: 'one' }),
        onRunAccess: (ctx, item) => {
          if (item.labels.owner !== ctx.owner)
            throw new Response('Forbidden', { status: 403 })
        },
      },
    })
    const base = 'http://localhost/api/durably'
    const savedRun = await handler.handle(
      new Request(`${base}/run?runId=${run.id}`),
      '/api/durably',
    )
    expect((await savedRun.json()).status).toBe('waiting')
    const savedWaits = await handler.handle(
      new Request(`${base}/waits?runId=${run.id}`),
      '/api/durably',
    )
    const [wait] = (await savedWaits.json()) as { id: string }[]
    const signal = await handler.handle(
      new Request(`${base}/signal?runId=${run.id}&waitId=${wait.id}`, {
        method: 'POST',
        body: JSON.stringify({ signalId: 'decision-1', payload: true }),
      }),
      '/api/durably',
    )
    expect((await signal.json()).disposition).toBe('accepted')
    const savedResult = await handler.handle(
      new Request(`${base}/wait?runId=${run.id}&waitId=${wait.id}`),
      '/api/durably',
    )
    expect((await savedResult.json()).outcome).toBe('signal')
    await current.processUntilIdle()
    expect((await current.getRun(run.id))?.output).toBe(true)
  } finally {
    await current.stop()
    await current.db.destroy()
    rmSync(directory, { recursive: true, force: true })
  }
})
