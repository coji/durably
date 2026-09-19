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

  it(
    'preserves a crashed attempt and records a fresh successful invocation',
    { timeout: 15_000 },
    async () => {
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
        leaseMs: 200,
        leaseRenewIntervalMs: 10_000,
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
      await new Promise((resolve) => setTimeout(resolve, 250))

      await runtime.processOne({ workerId: 'recovery-worker' })
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
    },
  )
})
