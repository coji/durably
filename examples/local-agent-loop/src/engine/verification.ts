import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Checkpointed verification step.
 *
 * Owns the durability mechanics only: the start/complete checkpoint pair, the
 * attempt measurement, and forwarding the Durably step signal so a cancel or a
 * lost lease kills the owned process. WHAT counts as verification is supplied
 * by the caller as `grade`, because that is the part every project defines
 * differently — a pinned suite over a snapshot here, a repository's own check
 * command elsewhere.
 *
 * `grade` must be idempotent. A worker killed mid-grading clears the stale
 * start record and grades again, which is safe precisely because a local check
 * reads the sealed candidate and writes only to scratch space. The
 * uncertainty contract that stops a replay belongs to billed LLM calls, not
 * here.
 */
import type { StepAttemptContext } from '@coji/durably'

import type { ProviderName, VerificationLog } from './providers/types.js'
import { UncertainInvocationError, writeMeasurement } from './runner.js'

export type { VerificationLog }

export interface VerificationOutcome {
  passed: boolean
  /** Tail of the output, for the report excerpt and the repair prompt. */
  stdout: string
  exitCode: number | null
  /**
   * The full output of the grading attempt that produced this verdict. A
   * checkpoint written before logs existed has none.
   */
  log?: VerificationLog | null
}

export interface GradeResult extends VerificationOutcome {
  elapsedMs: number
}

export interface VerificationStepSpec {
  provider: ProviderName
  operationKey: string
  checkpointsDir: string
  stage: string
  iteration: number
  /** Idempotent grading of the sealed candidate. */
  grade: (signal: AbortSignal) => Promise<GradeResult>
}

/** Log file paths for one grading attempt, with the directory created. */
export async function prepareCheckLogs(
  logDir: string | undefined,
): Promise<{ stdoutFile: string; stderrFile: string } | null> {
  if (!logDir) return null
  await mkdir(logDir, { recursive: true })
  return {
    stdoutFile: join(logDir, 'stdout.log'),
    stderrFile: join(logDir, 'stderr.log'),
  }
}

/** The recorded log of a grading attempt that ended with `exitCode`. */
export function checkLog(
  files: { stdoutFile: string; stderrFile: string } | null,
  exitCode: number | null,
): VerificationLog | null {
  return files
    ? {
        stdoutPath: files.stdoutFile,
        stderrPath: files.stderrFile,
        exitCode,
      }
    : null
}

export async function runVerificationStep(
  attempt: StepAttemptContext,
  spec: VerificationStepSpec,
  signal: AbortSignal,
): Promise<VerificationOutcome> {
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
    result: VerificationOutcome
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
    // The recovered verdict points at the logs of the attempt that graded it;
    // nothing is graded again, so no new log exists.
    await writeMeasurement(attempt, measurement, {
      elapsedMs: saved.elapsedMs,
      recovered: true,
      result: 'checkpoint-recovered',
      verificationLog: saved.result.log ?? null,
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
          verificationLog: raced.result.log ?? null,
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
    const res = await spec.grade(signal)
    const result: VerificationOutcome = {
      passed: res.passed,
      stdout: res.stdout.slice(-4000),
      exitCode: res.exitCode,
      log: res.log ?? null,
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
      verificationLog: result.log,
    })
    void measurement
    return result
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // An interrupted grading produced no verdict, so it is not a failure.
    // Recording it as one turns "the worker was killed" into "the check did
    // not pass" in every report that reads the result column.
    const interrupted = signal.aborted || /timed? out|timeout/i.test(message)
    await writeMeasurement(attempt, measurement, {
      elapsedMs: Date.now() - started,
      result: interrupted ? 'uncertain' : 'fail',
      error: message.slice(0, 2000),
      interruptionReason: signal.aborted
        ? 'cancelled-or-lease-lost'
        : interrupted
          ? 'timeout'
          : null,
    })
    throw err
  }
}
