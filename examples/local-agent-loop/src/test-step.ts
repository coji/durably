/**
 * Test verification step: acceptance-tamper check + grading against the
 * pristine snapshot with a sample-fixed command.
 *
 * Measurement merges into the attempt snapshot (never wholesale replace),
 * and the Durably step signal is forwarded so cancel/lease-loss kills only
 * the owned test process.
 */
import type { StepAttemptContext } from '@coji/durably'
import type { JsonValue } from '@coji/durably'

import { runAcceptanceSuite } from './acceptance.js'
import type { ProviderName } from './providers/types.js'
import { writeMeasurement } from './runner.js'

export interface TestStepSpec {
  provider: ProviderName
  workdir: string
  acceptanceHash: string
  /** Pristine snapshot dir (prepare step); grading reads tests from here. */
  acceptanceDir: string
  /** Rebuilt scratch dir for grading (outside the agent's workdir). */
  scratchDir: string
  /** Pid marker so a restarted worker can reconcile the grading process. */
  pidFile: string
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
  let measurement = await writeMeasurement(
    attempt,
    {
      provider: spec.provider,
      fake: spec.provider === 'fake',
      stage: spec.stage,
      iteration: spec.iteration,
      operationKey: null,
      invocationId: null,
      sessionId: null,
      recovered: false,
      usageScope: null,
      requestedModel: null,
      requestedEffort: null,
      reportedModel: null,
      reportedEffort: null,
      versions: {},
      elapsedMs: null,
      usage: null,
      costUsdEstimate: null,
      costBasis: null,
      result: 'started',
      error: null,
      interruptionReason: null,
    },
    {},
  )
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
        pidFile: spec.pidFile,
        signal,
      },
      spec.acceptanceHash,
    )
    measurement = await writeMeasurement(attempt, measurement, {
      elapsedMs: res.elapsedMs,
      result: res.passed ? 'pass' : 'fail',
      error: res.passed ? null : res.stdout.slice(-2000),
    })
    void measurement
    return {
      passed: res.passed,
      stdout: res.stdout.slice(-4000),
      exitCode: res.exitCode,
    }
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

export function toJson<T>(value: T): JsonValue {
  return value as unknown as JsonValue
}
