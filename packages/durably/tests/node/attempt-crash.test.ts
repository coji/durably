import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { createDurably, defineJob, type Durably } from '../../src'
import { createNodeDialectForFile } from '../helpers/node-dialect'

const childPath = fileURLToPath(
  new URL('../fixtures/attempt-crash-child.ts', import.meta.url),
)

describe('step attempt after process termination', () => {
  const runtimes: Durably<any, any>[] = []
  afterEach(async () => {
    await Promise.all(runtimes.map((runtime) => runtime.stop()))
    await Promise.all(runtimes.map((runtime) => runtime.db.destroy()))
    runtimes.length = 0
  })

  it('preserves a crashed attempt and records a fresh successful invocation', async () => {
    const dbFile = join(tmpdir(), `durably-attempt-crash-${randomUUID()}.db`)
    const job = defineJob({
      name: 'crash-recovery-attempt',
      input: z.object({}),
      run: async (step) => {
        await step.run('external-call', async (_signal, attempt) => {
          await attempt.setMetadata({ usage: 7 })
          return 'recovered'
        })
      },
    })
    const runtime = createDurably({
      dialect: createNodeDialectForFile(dbFile),
      preserveSteps: true,
      jobs: { job },
    })
    runtimes.push(runtime)
    await runtime.migrate()
    const run = await runtime.jobs.job.trigger({})

    const child = fork(childPath, [dbFile], {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    const firstId = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`Child did not begin attempt: ${stderr}`)),
        8_000,
      )
      child.once('message', (message: unknown) => {
        clearTimeout(timeout)
        resolve((message as { attemptId: string }).attemptId)
      })
      child.once('error', reject)
      child.once('exit', (code) =>
        reject(new Error(`Child exited early (${code}): ${stderr}`)),
      )
    })
    child.kill('SIGKILL')
    await new Promise<void>((resolve) => child.once('exit', () => resolve()))
    // End the dead child's lease directly instead of sleeping past a short
    // one: a sleep races the lease clock on a loaded machine, and a short
    // lease can also expire inside the child before it reports its attempt.
    await runtime.db
      .updateTable('durably_runs')
      .set({ lease_expires_at: new Date(0).toISOString() })
      .where('id', '=', run.id)
      .where('status', '=', 'leased')
      .execute()

    expect(await runtime.processOne({ workerId: 'recovery-worker' })).toBe(true)
    const attempts = await runtime.getStepAttempts(run.id)
    expect(attempts).toHaveLength(2)
    expect(attempts[0]).toMatchObject({
      id: firstId,
      status: 'started',
      metadata: { usage: 4 },
      completedAt: null,
      interruptionReason: 'lease-lost',
    })
    expect(attempts[1]).toMatchObject({
      status: 'completed',
      metadata: { usage: 7 },
      interruptionReason: null,
    })
    expect((await runtime.getRun(run.id))?.status).toBe('completed')
    expect(await runtime.storage.getSteps(run.id)).toHaveLength(1)
    expect(await runtime.processOne()).toBe(false)
    expect(await runtime.getStepAttempts(run.id)).toHaveLength(2)
  })
})
