import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Test verification step: acceptance-tamper check + grading against the
 * pristine snapshot with a sample-fixed command.
 *
 * Measurement merges into the attempt snapshot (never wholesale replace),
 * and the Durably step signal is forwarded so cancel/lease-loss kills only
 * the owned test process.
 */
import type { StepAttemptContext } from '@coji/durably'

import { runAcceptanceSuite } from './acceptance.js'
import type { ProviderName } from './providers/types.js'
import { UncertainInvocationError, writeMeasurement } from './runner.js'

export interface TestStepSpec {
  provider: ProviderName
  workdir: string
  acceptanceHash: string
  /** Pristine snapshot dir (setup step); grading reads tests from here. */
  acceptanceDir: string
  /** Rebuilt scratch dir for grading (outside the agent's workdir). */
  scratchDir: string
  operationKey: string
  checkpointsDir: string
  timeoutMs: number
  stage: string
  iteration: number
}

export interface TestStepOutcome {
  passed: boolean
  stdout: string
  exitCode: number | null
}

export async function runAgentTestStep(
  attempt: StepAttemptContext,
  spec: TestStepSpec,
  signal: AbortSignal,
): Promise<TestStepOutcome> {
  const started = Date.now()
  const checkpointId = createHash('sha256')
    .update(spec.operationKey)
    .digest('hex')
  const startedPath = join(spec.checkpointsDir, `${checkpointId}.started.json`)
  const completedPath = join(
    spec.checkpointsDir,
    `${checkpointId}.completed.json`,
  )
  await mkdir(spec.checkpointsDir, { recursive: true })
  const readCheckpoint = async <T>(path: string): Promise<T | null> => {
    try {
      return JSON.parse(await readFile(path, 'utf8')) as T
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }
  type Started = {
    operationKey: string
    invocationId: string
    invocationStartedAt: string
  }
  type Completed = Started & {
    invocationCompletedAt: string
    result: TestStepOutcome
    elapsedMs: number
  }
  const saved = await readCheckpoint<Completed>(completedPath)
  const prior = await readCheckpoint<Started>(startedPath)
  const invocationId =
    saved?.invocationId ?? prior?.invocationId ?? randomUUID()
  if (saved && saved.operationKey !== spec.operationKey)
    throw new Error('verification checkpoint key mismatch')
  if (prior && prior.operationKey !== spec.operationKey)
    throw new Error('verification start checkpoint key mismatch')
  let measurement = await writeMeasurement(
    attempt,
    {
      provider: spec.provider,
      fake: spec.provider === 'fake',
      stage: spec.stage,
      role: null,
      iteration: spec.iteration,
      operationKey: spec.operationKey,
      invocationId,
      sessionId: null,
      recovered: saved !== null,
      usageScope: null,
      requestedModel: null,
      requestedEffort: null,
      effectiveModel: null,
      effectiveEffort: null,
      reportedModel: null,
      reportedEffort: null,
      invocationStartedAt:
        saved?.invocationStartedAt ?? prior?.invocationStartedAt ?? null,
      invocationCompletedAt: saved?.invocationCompletedAt ?? null,
      versions: {},
      elapsedMs: null,
      usage: null,
      costUsdEstimate: null,
      costBasis: null,
      result: saved ? 'checkpoint-recovered' : 'started',
      error: null,
      interruptionReason: null,
    },
    {},
  )
  if (saved) {
    await writeMeasurement(attempt, measurement, {
      elapsedMs: saved.elapsedMs,
      recovered: true,
      result: 'checkpoint-recovered',
    })
    return saved.result
  }
  // A start-only checkpoint means the worker died mid-grading. Unlike an LLM
  // invocation — which may already have been billed and must never be resent —
  // the acceptance suite only reads the sealed candidate and writes to a
  // scratch directory, so re-running it is free and yields the same verdict.
  // Clear the stale start record and grade again; the invocation id is kept so
  // the retry reports as the same logical verification.
  if (prior) await rm(startedPath, { force: true })
  const startRecord: Started = {
    operationKey: spec.operationKey,
    invocationId,
    invocationStartedAt: new Date().toISOString(),
  }
  try {
    const handle = await open(startedPath, 'wx')
    await handle.writeFile(`${JSON.stringify(startRecord)}\n`, 'utf8')
    await handle.close()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const raced = await readCheckpoint<Completed>(completedPath)
      if (raced) {
        if (raced.operationKey !== spec.operationKey)
          throw new Error('verification checkpoint key mismatch')
        await writeMeasurement(attempt, measurement, {
          invocationId: raced.invocationId,
          elapsedMs: raced.elapsedMs,
          recovered: true,
          result: 'checkpoint-recovered',
          invocationStartedAt: raced.invocationStartedAt,
          invocationCompletedAt: raced.invocationCompletedAt,
        })
        return raced.result
      }
      const racedStart = await readCheckpoint<Started>(startedPath)
      throw new UncertainInvocationError(
        spec.operationKey,
        racedStart?.invocationId ?? invocationId,
      )
    }
    throw error
  }
  measurement = await writeMeasurement(attempt, measurement, {
    invocationStartedAt: startRecord.invocationStartedAt,
  })
  try {
    // Tamper check + grading run the pristine snapshot via a fixed argv;
    // the workdir's `npm test` is never executed, so a rewritten test
    // script cannot fake a pass.
    const res = await runAcceptanceSuite(
      {
        workdir: spec.workdir,
        acceptanceDir: spec.acceptanceDir,
        scratchDir: spec.scratchDir,
        timeoutMs: spec.timeoutMs,
        signal,
      },
      spec.acceptanceHash,
    )
    const result: TestStepOutcome = {
      passed: res.passed,
      stdout: res.stdout.slice(-4000),
      exitCode: res.exitCode,
    }
    const completed: Completed = {
      ...startRecord,
      invocationCompletedAt: new Date().toISOString(),
      result,
      elapsedMs: res.elapsedMs,
    }
    const temporary = `${completedPath}.${attempt.id}.tmp`
    await writeFile(temporary, `${JSON.stringify(completed)}\n`, 'utf8')
    await rename(temporary, completedPath)
    measurement = await writeMeasurement(attempt, measurement, {
      elapsedMs: res.elapsedMs,
      result: res.passed ? 'pass' : 'fail',
      error: res.passed ? null : res.stdout.slice(-2000),
      invocationStartedAt: startRecord.invocationStartedAt,
      invocationCompletedAt: completed.invocationCompletedAt,
    })
    void measurement
    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await writeMeasurement(attempt, measurement, {
      elapsedMs: Date.now() - started,
      result: 'fail',
      error: message.slice(0, 2000),
      interruptionReason: signal.aborted ? 'cancelled-or-lease-lost' : null,
    })
    throw err
  }
}
