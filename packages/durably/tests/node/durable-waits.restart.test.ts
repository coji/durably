import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { createDurably, defineJob } from '../../src'
import { createNodeDialectForFile } from '../helpers/node-dialect'

afterEach(() => vi.useRealTimers())

it('recreates a runtime after the deadline and resumes the original run through timeout', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
  const directory = mkdtempSync(join(tmpdir(), `durably-wait-${randomUUID()}-`))
  const file = join(directory, 'wait.db')
  const job = defineJob({
    name: 'deadline-restart',
    input: z.object({}),
    output: z.unknown(),
    run: async (step) => {
      const wait = await step.prepareWait('approval', { timeoutMs: 1_000 })
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

    vi.setSystemTime(new Date('2026-01-01T00:00:02.000Z'))
    second = createDurably({
      dialect: createNodeDialectForFile(file),
    }).register({ job })
    await second.migrate()
    expect((await second.getWait(wait.id))?.deadlineAt).toBe(
      '2026-01-01T00:00:01.000Z',
    )
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
