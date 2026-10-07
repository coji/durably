import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import type { JsonValue } from '@coji/durably'

import { repairCallsOf } from '../src/engine/build-report.js'
import { SpawnCancelledError } from '../src/engine/child.js'
import {
  classifyFailure,
  lastVerificationLogs,
  uncertainCheckpoints,
} from '../src/engine/failure-reasons.js'
import { claudeOutput } from '../src/engine/providers/claude.js'
import { watchActivity } from '../src/engine/providers/codex.js'
import type {
  AgentCallOptions,
  AgentProvider,
  AgentResult,
} from '../src/engine/providers/types.js'
import type { AttemptMeasurement } from '../src/engine/providers/types.js'
import { cacheReadRatio, toAttemptRow } from '../src/engine/report.js'
import {
  AgentTimeoutError,
  checkpointPaths,
  PROVIDER_TIMEOUT_MARGIN_MS,
  RejectedInvocationError,
  runAgentCall,
  UncertainInvocationError,
} from '../src/engine/runner.js'
import type { TokenUsage } from '../src/engine/usage.js'
import { logAfterError } from '../src/engine/verification.js'

interface StubAttempt {
  id: string
  snapshots: AttemptMeasurement[]
  log: { info: (...a: unknown[]) => void }
  setMetadata: (m: unknown) => Promise<void>
}

function fakeAttempt(): StubAttempt {
  const snapshots: AttemptMeasurement[] = []
  return {
    id: randomUUID(),
    snapshots,
    log: { info: () => {} },
    setMetadata: async (m: unknown) => {
      snapshots.push(JSON.parse(JSON.stringify(m)) as AttemptMeasurement)
    },
  }
}

function stubProvider(
  behavior: (options: AgentCallOptions) => Promise<AgentResult>,
  rejectionReason: (error: unknown) => string | null = () => null,
): AgentProvider {
  return {
    name: 'codex',
    fake: false,
    cliPath: null,
    partialUsage: false,
    resolveExecution: () => ({ model: 'resolved-model', effort: 'low' }),
    call: behavior,
    checkAvailability: async () => ({
      verdict: 'unknown',
      method: 'stub',
      detail: 'stub',
    }),
    rejectionReason,
  }
}

describe('runner measurement on the real launch path', () => {
  it('recovers a completed invocation without sending the prompt twice', async () => {
    const checkpointsDir = await mkdtemp(join(tmpdir(), 'checkpoints-'))
    const operationKey = `test/${randomUUID()}`
    let calls = 0
    const provider = stubProvider(async () => {
      calls++
      return {
        text: 'saved result',
        session: { id: 'native-session' },
        resolvedModel: 'resolved-model',
        resolvedEffort: 'low',
        reportedModel: null,
        reportedEffort: null,
        usage: null,
        elapsedMs: 5,
      }
    })
    const spec = {
      provider,
      providerName: 'codex' as const,
      prompt: 'p',
      workdir: '/tmp',
      timeoutMs: 5000,
      requestedModel: null,
      requestedEffort: null,
      effectiveModel: 'resolved-model',
      effectiveEffort: 'low',
      role: 'implement' as const,
      stage: 'implement',
      iteration: 1,
      operationKey,
      checkpointsDir,
      session: null,
    }
    const first = await runAgentCall(
      new AbortController().signal,
      fakeAttempt() as never,
      spec,
    )
    const second = await runAgentCall(
      new AbortController().signal,
      fakeAttempt() as never,
      spec,
    )
    assert.equal(calls, 1)
    assert.equal(second.recovered, true)
    assert.equal(second.invocationId, first.invocationId)
    assert.equal(second.sessionId, 'native-session')
    assert.equal(second.measurement.elapsedMs, 5)
  })

  it('records refused tool calls on the attempt, the same when read back from the completed checkpoint', async () => {
    const checkpointsDir = await mkdtemp(join(tmpdir(), 'checkpoints-'))
    let calls = 0
    const denial = `Glob: glob outside the review's directories denied: ${'y'.repeat(400)}`
    const provider = stubProvider(async () => {
      calls++
      return {
        text: 'DECISION: pass',
        session: null,
        resolvedModel: 'resolved-model',
        resolvedEffort: 'low',
        reportedModel: null,
        reportedEffort: null,
        usage: null,
        elapsedMs: 5,
        permissionDenials: Array.from({ length: 11 }, () => denial),
      }
    })
    const spec = {
      provider,
      providerName: 'codex' as const,
      prompt: 'p',
      workdir: '/tmp',
      timeoutMs: 5000,
      requestedModel: null,
      requestedEffort: null,
      effectiveModel: 'resolved-model',
      effectiveEffort: 'low',
      role: 'review-a' as const,
      stage: 'review:correctness',
      iteration: 1,
      operationKey: `test/${randomUUID()}`,
      checkpointsDir,
      session: null,
    }
    const kept = {
      count: 11,
      entries: Array.from({ length: 10 }, () => denial.slice(0, 300)),
    }
    for (const recovered of [false, true]) {
      const attempt = fakeAttempt()
      const outcome = await runAgentCall(
        new AbortController().signal,
        attempt as never,
        spec,
      )
      assert.equal(outcome.recovered, recovered)
      assert.equal(outcome.permissionDenials.length, 11)
      assert.deepEqual(attempt.snapshots.at(-1)?.permissionDenials, kept)
    }
    assert.equal(calls, 1)
  })

  it('treats a start checkpoint with no completion as uncertain, not retryable', async () => {
    const checkpointsDir = await mkdtemp(join(tmpdir(), 'checkpoints-'))
    const operationKey = `test/${randomUUID()}`
    // A worker died after the prompt went out and before the result was
    // recorded: only the start checkpoint exists.
    const paths = checkpointPaths(checkpointsDir, operationKey)
    await writeFile(
      paths.started,
      `${JSON.stringify({
        operationKey,
        invocationId: randomUUID(),
        status: 'started',
        invocationStartedAt: new Date().toISOString(),
      })}\n`,
    )
    let calls = 0
    const provider = stubProvider(async () => {
      calls++
      throw new Error('must not be called')
    })
    const attempt = fakeAttempt()
    const error = await runAgentCall(
      new AbortController().signal,
      attempt as never,
      {
        provider,
        providerName: 'codex',
        prompt: 'p',
        workdir: '/tmp',
        timeoutMs: 5000,
        requestedModel: null,
        requestedEffort: null,
        effectiveModel: 'resolved-model',
        effectiveEffort: 'low',
        role: 'implement',
        stage: 'implement',
        iteration: 1,
        operationKey,
        checkpointsDir,
      },
    ).then(
      () => null,
      (e: unknown) => e as Error,
    )
    assert.ok(error instanceof UncertainInvocationError)
    assert.equal(calls, 0, 'the prompt is never resent')

    const metadata = attempt.snapshots.at(-1) as unknown as JsonValue
    const uncertain = uncertainCheckpoints(checkpointsDir, [
      { metadata, status: 'failed' },
    ])
    assert.deepEqual(uncertain, [paths.started])
    // A step that completed anyway (a triage call recorded as unknown) will
    // not send the call again, so its start is not treated as uncertain.
    assert.deepEqual(
      uncertainCheckpoints(checkpointsDir, [{ metadata, status: 'completed' }]),
      [],
    )
    const failure = classifyFailure({
      runId: 'r1',
      status: 'failed',
      output: null,
      error: error.message,
      uncertain,
    })
    assert.equal(failure?.kind, 'uncertain-invocation')
    assert.equal(failure?.retryable, false)
    assert.ok(failure?.details.some((d) => d.includes(paths.started)))
    assert.ok(
      failure?.next.every((n) => !n.includes('trigger')),
      'no command that would send the prompt again',
    )

    // Once the completion is on disk the call is no longer uncertain, and an
    // unrecognised error is still not called retryable.
    await writeFile(paths.completed, '{}\n')
    assert.deepEqual(
      uncertainCheckpoints(checkpointsDir, [{ metadata, status: 'failed' }]),
      [],
    )
    const other = classifyFailure({
      runId: 'r1',
      status: 'failed',
      output: null,
      error: 'something else',
      uncertain: [],
    })
    assert.equal(other?.kind, 'unclassified')
    assert.equal(other?.retryable, false)

    // A cancel may land after a push or pull request that was never
    // recorded, so a publishing run is not called retryable.
    const cancel = (publish: boolean) =>
      classifyFailure({
        runId: 'r1',
        status: 'cancelled',
        output: null,
        error: 'setup failed\n\nfatal: bad ref\n',
        uncertain: [],
        publish,
      })
    assert.equal(cancel(false)?.retryable, true)
    assert.equal(cancel(true)?.kind, 'cancelled-publish')
    assert.equal(cancel(true)?.retryable, false)
    assert.match(cancel(true)?.humanCheck ?? '', /pull request/)
    // The error detail stays on one line, and no step is a bare trigger.
    assert.deepEqual(cancel(false)?.details, [
      'error: setup failed | fatal: bad ref',
    ])
    assert.ok(cancel(false)?.next.every((n) => !/demo trigger/.test(n)))
  })

  it('keeps requested, effective, and reported settings separate', async () => {
    const attempt = fakeAttempt()
    const provider = stubProvider(async () => ({
      text: 'done',
      resolvedModel: 'resolved-model',
      resolvedEffort: 'low',
      // Native response confirms nothing: reported must stay null, never
      // back-filled from the resolved settings.
      reportedModel: null,
      reportedEffort: null,
      usage: null,
      elapsedMs: 5,
    }))
    const { measurement } = await runAgentCall(
      new AbortController().signal,
      attempt as never,
      {
        provider,
        providerName: 'codex',
        prompt: 'p',
        workdir: '/tmp',
        timeoutMs: 5000,
        requestedModel: null,
        requestedEffort: null,
        effectiveModel: 'resolved-model',
        effectiveEffort: 'low',
        role: 'implement',
        stage: 'implement',
        iteration: 1,
        operationKey: `test/${randomUUID()}`,
      },
    )
    assert.equal(measurement.requestedModel, null)
    assert.equal(measurement.requestedEffort, null)
    assert.equal(measurement.effectiveModel, 'resolved-model')
    assert.equal(measurement.effectiveEffort, 'low')
    assert.equal(measurement.reportedModel, null)
    assert.equal(measurement.reportedEffort, null)
    // The FIRST persisted snapshot already carries the resolved settings.
    assert.equal(attempt.snapshots[0]?.requestedModel, null)
    assert.equal(attempt.snapshots[0]?.effectiveModel, 'resolved-model')
  })

  it('propagates AbortSignal into the provider and records the cancel', async () => {
    const attempt = fakeAttempt()
    let sawAbort = false
    // The provider reports when it is running, so the abort below always
    // lands on an in-flight call rather than racing its start.
    let markStarted!: () => void
    const providerStarted = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const provider = stubProvider(
      (options) =>
        new Promise<AgentResult>((_resolve, reject) => {
          markStarted()
          options.signal?.addEventListener(
            'abort',
            () => {
              sawAbort = true
              reject(new Error('provider torn down on abort'))
            },
            { once: true },
          )
        }),
    )
    const controller = new AbortController()
    const pendingOperationKey = `test/${randomUUID()}`
    const pending = runAgentCall(controller.signal, attempt as never, {
      provider,
      providerName: 'codex',
      prompt: 'p',
      workdir: '/tmp',
      timeoutMs: 30000,
      requestedModel: null,
      requestedEffort: null,
      effectiveModel: 'resolved-model',
      effectiveEffort: 'low',
      role: 'implement',
      stage: 'implement',
      iteration: 1,
      operationKey: pendingOperationKey,
    })
    await providerStarted
    controller.abort()
    await assert.rejects(pending)
    assert.equal(sawAbort, true)
    const last = attempt.snapshots[attempt.snapshots.length - 1]
    assert.equal(last?.result, 'uncertain')
    assert.equal(last?.interruptionReason, 'cancelled-or-lease-lost')

    let resent = false
    const retryProvider = stubProvider(async () => {
      resent = true
      throw new Error('must not be called')
    })
    await assert.rejects(
      runAgentCall(new AbortController().signal, fakeAttempt() as never, {
        provider: retryProvider,
        providerName: 'codex',
        prompt: 'p',
        workdir: '/tmp',
        timeoutMs: 30000,
        requestedModel: null,
        requestedEffort: null,
        effectiveModel: 'resolved-model',
        effectiveEffort: 'low',
        role: 'implement',
        stage: 'implement',
        iteration: 1,
        operationKey: pendingOperationKey,
      }),
      /uncertain external invocation/,
    )
    assert.equal(resent, false)
  })

  it('classifies the runner timeout separately from cancellation', async () => {
    const attempt = fakeAttempt()
    const provider = stubProvider(
      (options) =>
        new Promise<AgentResult>((_resolve, reject) => {
          options.signal?.addEventListener(
            'abort',
            () => reject(new Error('The operation was aborted due to timeout')),
            { once: true },
          )
        }),
    )
    await assert.rejects(
      runAgentCall(new AbortController().signal, attempt as never, {
        provider,
        providerName: 'codex',
        prompt: 'p',
        workdir: '/tmp',
        timeoutMs: 10,
        requestedModel: null,
        requestedEffort: null,
        effectiveModel: 'resolved-model',
        effectiveEffort: 'low',
        role: 'implement',
        stage: 'implement',
        iteration: 1,
        operationKey: `test/${randomUUID()}`,
      }),
    )
    assert.equal(attempt.snapshots.at(-1)?.interruptionReason, 'timeout')
  })
})

const FINAL_USAGE: TokenUsage = {
  inputTokens: 100,
  cachedInputTokens: null,
  cacheReadTokens: null,
  cacheWriteTokens: null,
  outputTokens: 50,
  totalTokens: 150,
  usageSource: 'provider-final',
}

const PARTIAL_USAGE: TokenUsage = {
  ...FINAL_USAGE,
  inputTokens: 999,
  outputTokens: null,
  totalTokens: null,
  usageSource: 'provider-partial',
}

function baseSpec(provider: AgentProvider, checkpointsDir: string) {
  return {
    provider,
    providerName: 'codex' as const,
    prompt: 'p',
    workdir: '/tmp',
    timeoutMs: 5000,
    requestedModel: null,
    requestedEffort: null,
    effectiveModel: 'resolved-model',
    effectiveEffort: 'low',
    role: 'implement' as const,
    stage: 'implement',
    iteration: 1,
    operationKey: `test/${randomUUID()}`,
    checkpointsDir,
  }
}

describe('a repair call records its session handling before it is sent', () => {
  const usage = (
    input: number | null,
    cacheRead: number | null,
  ): TokenUsage => ({
    inputTokens: input,
    cachedInputTokens: cacheRead,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: null,
    outputTokens: 10,
    totalTokens: input === null ? null : input + 10,
    usageSource: 'provider-final',
  })
  const repairSpec = (
    provider: AgentProvider,
    checkpointsDir: string,
    operationKey: string,
  ) => ({
    provider,
    providerName: 'codex' as const,
    prompt: 'p',
    workdir: '/tmp',
    timeoutMs: 5000,
    requestedModel: null,
    requestedEffort: 'high',
    effectiveModel: 'resolved-model',
    effectiveEffort: 'low',
    role: 'repair' as const,
    stage: 'code',
    iteration: 2,
    operationKey,
    checkpointsDir,
    session: {
      provider: 'codex' as const,
      nativeId: 'native-1',
      profileId: 'code',
      model: 'resolved-model',
      cwd: '/tmp',
      instructionsVersion: 'v',
    },
    requireSession: true,
    sessionHandling: 'continued-effort-change' as const,
  })
  /** A report row from one stub attempt's last measurement. */
  const row = (attempt: StubAttempt, stepName: string) =>
    toAttemptRow({
      stepName,
      stepIndex: 0,
      id: attempt.id,
      leaseGeneration: 1,
      status: 'completed',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      interruptionReason: null,
      metadata: attempt.snapshots.at(-1) as unknown as JsonValue,
    } as never)

  it('saves it with the first measurement, and a recovery returns the same record and usage', async () => {
    const checkpointsDir = await mkdtemp(join(tmpdir(), 'checkpoints-'))
    const operationKey = `test/${randomUUID()}`
    let calls = 0
    let seenBeforeCall: AttemptMeasurement | undefined
    const first = fakeAttempt()
    const provider = stubProvider(async (options) => {
      calls++
      seenBeforeCall = first.snapshots.at(-1)
      assert.equal(options.sessionId, 'native-1')
      return {
        text: 'fixed',
        session: { id: 'native-1' },
        resolvedModel: 'resolved-model',
        resolvedEffort: 'low',
        reportedModel: null,
        reportedEffort: null,
        usage: usage(46000, 43628),
        elapsedMs: 5,
      }
    })
    const spec = repairSpec(provider, checkpointsDir, operationKey)
    const made = await runAgentCall(
      new AbortController().signal,
      first as never,
      spec,
    )
    assert.equal(first.snapshots[0]?.sessionHandling, 'continued-effort-change')
    assert.equal(seenBeforeCall?.sessionHandling, 'continued-effort-change')
    const second = fakeAttempt()
    const recovered = await runAgentCall(
      new AbortController().signal,
      second as never,
      spec,
    )
    assert.equal(calls, 1, 'the recovery sends nothing')
    assert.equal(recovered.recovered, true)
    assert.equal(
      recovered.measurement.sessionHandling,
      'continued-effort-change',
    )
    assert.deepEqual(recovered.measurement.usage, made.measurement.usage)
    // One call in the report, with its own ratio, whichever attempt is read.
    const listed = repairCallsOf([
      row(first, 'stage:3:code:agent'),
      row(second, 'stage:3:code:agent'),
    ])
    assert.equal(listed.length, 1)
    assert.equal(listed[0]?.sessionHandling, 'continued-effort-change')
    assert.equal(listed[0]?.recovered, true)
    assert.equal(listed[0]?.cacheReadTokens, 43628)
    assert.equal(listed[0]?.cacheReadRatio, 43628 / 46000)
  })

  it('never resends from a start-only checkpoint, and keeps the handling on record', async () => {
    const checkpointsDir = await mkdtemp(join(tmpdir(), 'checkpoints-'))
    const operationKey = `test/${randomUUID()}`
    const paths = checkpointPaths(checkpointsDir, operationKey)
    await writeFile(
      paths.started,
      `${JSON.stringify({
        operationKey,
        invocationId: randomUUID(),
        status: 'started',
        invocationStartedAt: new Date().toISOString(),
      })}\n`,
    )
    let calls = 0
    const provider = stubProvider(async () => {
      calls++
      throw new Error('must not be called')
    })
    const attempt = fakeAttempt()
    await assert.rejects(
      runAgentCall(
        new AbortController().signal,
        attempt as never,
        repairSpec(provider, checkpointsDir, operationKey),
      ),
      UncertainInvocationError,
    )
    assert.equal(calls, 0)
    assert.equal(
      attempt.snapshots.at(-1)?.sessionHandling,
      'continued-effort-change',
    )
  })

  it('reports the ratio as null when usage is missing or the input is 0', async () => {
    assert.equal(cacheReadRatio(null, 10), null)
    assert.equal(cacheReadRatio(100, null), null)
    assert.equal(cacheReadRatio(0, 0), null)
    assert.equal(cacheReadRatio(100, 0), 0)
    for (const reported of [null, usage(0, 0), usage(null, 5)]) {
      const attempt = fakeAttempt()
      const provider = stubProvider(async () => ({
        text: 'fixed',
        session: { id: 'native-1' },
        resolvedModel: 'resolved-model',
        resolvedEffort: 'low',
        reportedModel: null,
        reportedEffort: null,
        usage: reported,
        elapsedMs: 5,
      }))
      await runAgentCall(
        new AbortController().signal,
        attempt as never,
        repairSpec(
          provider,
          await mkdtemp(join(tmpdir(), 'checkpoints-')),
          `test/${randomUUID()}`,
        ),
      )
      const [call] = repairCallsOf([row(attempt, 'stage:3:code:agent')])
      assert.equal(call?.cacheReadRatio, null, JSON.stringify(reported))
      assert.equal(call?.sessionHandling, 'continued-effort-change')
    }
  })
})

describe('partial usage snapshots never outrank the terminal write', () => {
  it('survives a failed snapshot write instead of rejecting the call', async () => {
    const snapshots: AttemptMeasurement[] = []
    const attempt = {
      id: randomUUID(),
      snapshots,
      log: { info: () => {} },
      setMetadata: async (m: unknown) => {
        const next = m as AttemptMeasurement
        // A busy database, a lost lease, or an already-terminal run makes the
        // advisory progress write fail while the call itself is still fine.
        if (next.usage?.usageSource === 'provider-partial')
          throw new Error('metadata store unavailable')
        snapshots.push(JSON.parse(JSON.stringify(next)) as AttemptMeasurement)
      },
    }
    const checkpointsDir = await mkdtemp(join(tmpdir(), 'checkpoints-'))
    const provider = stubProvider(async (options) => {
      options.onPartialUsage?.(PARTIAL_USAGE)
      return {
        text: 'done',
        resolvedModel: 'resolved-model',
        resolvedEffort: 'low',
        reportedModel: 'resolved-model',
        reportedEffort: null,
        usage: FINAL_USAGE,
        elapsedMs: 5,
      }
    })
    const { measurement } = await runAgentCall(
      new AbortController().signal,
      attempt as never,
      baseSpec(provider, checkpointsDir),
    )
    assert.equal(measurement.result, 'implement-done')
    assert.equal(measurement.usage?.inputTokens, 100)
    assert.equal(measurement.usage?.usageSource, 'provider-final')
  })

  it('drops a snapshot that arrives after the terminal write', async () => {
    const attempt = fakeAttempt()
    const checkpointsDir = await mkdtemp(join(tmpdir(), 'checkpoints-'))
    const late: { fire: ((usage: TokenUsage) => void) | null } = { fire: null }
    const provider = stubProvider(async (options) => {
      // The provider schedules one more snapshot and returns before it lands.
      late.fire = options.onPartialUsage ?? null
      return {
        text: 'done',
        resolvedModel: 'resolved-model',
        resolvedEffort: 'low',
        reportedModel: 'resolved-model',
        reportedEffort: null,
        usage: FINAL_USAGE,
        elapsedMs: 5,
      }
    })
    await runAgentCall(
      new AbortController().signal,
      attempt as never,
      baseSpec(provider, checkpointsDir),
    )
    const settled = attempt.snapshots.length
    late.fire?.(PARTIAL_USAGE)
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(attempt.snapshots.length, settled)
    assert.equal(attempt.snapshots.at(-1)?.result, 'implement-done')
    assert.equal(attempt.snapshots.at(-1)?.usage?.inputTokens, 100)
  })
})

describe('logs of the verification that stopped the run', () => {
  const log = (name: string) => ({
    stdoutPath: `/logs/${name}/stdout.log`,
    stderrPath: `/logs/${name}/stderr.log`,
    exitCode: 1,
  })
  const verify = (
    sequence: number,
    startedAt: string,
    verificationLog: ReturnType<typeof log> | null,
  ) => ({
    stepName: `stage:${sequence}:verify:acceptance`,
    startedAt,
    metadata: { verificationLog } as never,
  })

  it('reports every attempt of the last verify step, oldest first', () => {
    assert.deepEqual(
      lastVerificationLogs([
        verify(2, '2026-01-01T00:00:00Z', log('early')),
        verify(4, '2026-01-01T00:02:00Z', log('retry')),
        verify(4, '2026-01-01T00:01:00Z', log('first')),
      ]),
      [log('first'), log('retry')],
    )
  })

  it('labels an interrupted attempt and a log write error in the details', () => {
    const failure = classifyFailure({
      runId: 'r1',
      status: 'completed',
      output: { conclusion: 'verification-failed' },
      error: null,
      uncertain: [],
      verificationLogs: [
        { ...log('lost'), exitCode: null, interrupted: true },
        { ...log('graded'), writeError: 'ENOSPC: no space left' },
      ],
    })
    assert.deepEqual(failure?.details, [
      'check attempt: interrupted, not part of the verdict',
      'check exit code: null',
      'check stdout log: /logs/lost/stdout.log',
      'check stderr log: /logs/lost/stderr.log',
      'check exit code: 1',
      'check stdout log: /logs/graded/stdout.log',
      'check stderr log: /logs/graded/stderr.log',
      'check log write error: ENOSPC: no space left',
    ])
  })

  it('builds the log a grade left from the error that ended it', () => {
    const files = { stdoutFile: '/l/stdout.log', stderrFile: '/l/stderr.log' }
    const paths = { stdoutPath: '/l/stdout.log', stderrPath: '/l/stderr.log' }
    // Never spawned: no files exist, so no log is recorded.
    assert.equal(
      logAfterError(files, new SpawnCancelledError('aborted', false)),
      null,
    )
    // Cancelled mid-check: a partial log marked interrupted, keeping the
    // write error.
    assert.deepEqual(
      logAfterError(
        files,
        Object.assign(new SpawnCancelledError('cancelled'), {
          logError: 'EIO',
        }),
      ),
      { ...paths, exitCode: null, writeError: 'EIO', interrupted: true },
    )
    // Timed out: graded as a failure, and the write error is kept.
    assert.deepEqual(
      logAfterError(
        files,
        Object.assign(new Error('timed out'), { logError: 'EIO' }),
      ),
      { ...paths, exitCode: null, writeError: 'EIO' },
    )
  })

  it("reports none when the last verify step has no log, not an earlier step's", () => {
    assert.deepEqual(
      lastVerificationLogs([
        verify(2, '2026-01-01T00:00:00Z', log('early')),
        verify(4, '2026-01-01T00:01:00Z', null),
      ]),
      [],
    )
  })
})

describe('a refused preflight call is settled, not uncertain', () => {
  it('records an explicit refusal as completed and reads it back without resending', async () => {
    const checkpointsDir = await mkdtemp(join(tmpdir(), 'checkpoints-'))
    let calls = 0
    const provider = stubProvider(
      async () => {
        calls++
        throw new Error('400: model is not supported')
      },
      (error) =>
        error instanceof Error && error.message.startsWith('400')
          ? error.message
          : null,
    )
    const spec = {
      ...baseSpec(provider, checkpointsDir),
      role: 'preflight' as const,
      stage: 'preflight',
      acceptRejection: true,
    }
    const first = fakeAttempt()
    const refused = await runAgentCall(
      new AbortController().signal,
      first as never,
      spec,
    )
    assert.equal(refused.rejection, '400: model is not supported')
    assert.equal(first.snapshots.at(-1)?.result, 'rejected')
    const paths = checkpointPaths(checkpointsDir, spec.operationKey)
    assert.ok(existsSync(paths.completed))
    // A replay reads the refusal back and sends nothing.
    const replay = fakeAttempt()
    const again = await runAgentCall(
      new AbortController().signal,
      replay as never,
      spec,
    )
    assert.equal(again.rejection, refused.rejection)
    assert.equal(again.recovered, true)
    assert.equal(calls, 1)
  })

  it('leaves any other error uncertain, so the run stops instead of resending', async () => {
    const checkpointsDir = await mkdtemp(join(tmpdir(), 'checkpoints-'))
    const provider = stubProvider(
      async () => {
        throw new Error('connection reset')
      },
      () => null,
    )
    const spec = {
      ...baseSpec(provider, checkpointsDir),
      role: 'preflight' as const,
      stage: 'preflight',
      acceptRejection: true,
    }
    await assert.rejects(
      runAgentCall(new AbortController().signal, fakeAttempt() as never, spec),
      /connection reset/,
    )
    const paths = checkpointPaths(checkpointsDir, spec.operationKey)
    assert.ok(existsSync(paths.started))
    assert.equal(existsSync(paths.completed), false)
    await assert.rejects(
      runAgentCall(new AbortController().signal, fakeAttempt() as never, spec),
      UncertainInvocationError,
    )
  })
})

describe('a refused call after preflight stops the run, settled', () => {
  /** A provider whose every call is refused; `calls` counts what was sent. */
  function refusing() {
    const sent = { calls: 0 }
    const provider = stubProvider(
      async () => {
        sent.calls++
        throw new Error('401: login expired')
      },
      (error) =>
        error instanceof Error && error.message.startsWith('401')
          ? error.message
          : null,
    )
    return { provider, sent }
  }

  for (const role of ['implement', 'repair', 'review-a', 'triage'] as const) {
    it(`saves the ${role} refusal as completed and throws it again on replay without resending`, async () => {
      const checkpointsDir = await mkdtemp(join(tmpdir(), 'checkpoints-'))
      const { provider, sent } = refusing()
      const spec = { ...baseSpec(provider, checkpointsDir), role, stage: role }
      const first = fakeAttempt()
      const error = await runAgentCall(
        new AbortController().signal,
        first as never,
        spec,
      ).catch((e: unknown) => e)
      assert.ok(error instanceof RejectedInvocationError)
      assert.equal(error.rejection, '401: login expired')
      assert.match(
        error.message,
        new RegExp(
          `^rejected-invocation: the ${role} call \\(codex resolved-model\\) was refused: 401: login expired$`,
        ),
      )
      assert.equal(first.snapshots.at(-1)?.result, 'rejected')
      assert.equal(first.snapshots.at(-1)?.error, '401: login expired')
      const paths = checkpointPaths(checkpointsDir, spec.operationKey)
      assert.ok(existsSync(paths.completed))
      // The resume reads the saved refusal: the same reason, nothing sent.
      const replay = fakeAttempt()
      const again = await runAgentCall(
        new AbortController().signal,
        replay as never,
        spec,
      ).catch((e: unknown) => e)
      assert.ok(again instanceof RejectedInvocationError)
      assert.equal(again.message, error.message)
      assert.equal(replay.snapshots.at(-1)?.recovered, true)
      assert.equal(sent.calls, 1)
    })
  }

  it('stops as uncertain on a start-only checkpoint, even with a provider that refuses', async () => {
    const checkpointsDir = await mkdtemp(join(tmpdir(), 'checkpoints-'))
    const { provider, sent } = refusing()
    const spec = baseSpec(provider, checkpointsDir)
    const paths = checkpointPaths(checkpointsDir, spec.operationKey)
    await writeFile(
      paths.started,
      `${JSON.stringify({
        operationKey: spec.operationKey,
        invocationId: 'lost',
        status: 'started',
        invocationStartedAt: new Date().toISOString(),
      })}\n`,
    )
    await assert.rejects(
      runAgentCall(new AbortController().signal, fakeAttempt() as never, spec),
      UncertainInvocationError,
    )
    assert.equal(sent.calls, 0)
  })

  it('never reads a timeout or a cancel as a refusal, whatever the provider says', async () => {
    const provider = stubProvider(
      (options) =>
        new Promise((_, reject) => {
          const refuse = () => reject(new Error('401: login expired'))
          if (options.signal?.aborted) refuse()
          else options.signal?.addEventListener('abort', refuse)
        }),
      (error) => (error instanceof Error ? error.message : null),
    )
    // Timed out.
    const timedOutDir = await mkdtemp(join(tmpdir(), 'checkpoints-'))
    const timedOut = { ...baseSpec(provider, timedOutDir), timeoutMs: 10 }
    const error = await runAgentCall(
      new AbortController().signal,
      fakeAttempt() as never,
      timedOut,
    ).catch((e: unknown) => e)
    // The factory's own timeout is settled as one, never as a refusal.
    assert.ok(error instanceof AgentTimeoutError)
    assert.ok(
      existsSync(checkpointPaths(timedOutDir, timedOut.operationKey).completed),
    )
    // Cancelled.
    const cancelledDir = await mkdtemp(join(tmpdir(), 'checkpoints-'))
    const cancelled = baseSpec(provider, cancelledDir)
    const controller = new AbortController()
    const pending = runAgentCall(
      controller.signal,
      fakeAttempt() as never,
      cancelled,
    ).catch((e: unknown) => e)
    controller.abort(new Error('cancelled'))
    assert.ok(!((await pending) instanceof RejectedInvocationError))
    assert.equal(
      existsSync(
        checkpointPaths(cancelledDir, cancelled.operationKey).completed,
      ),
      false,
    )
    // The cancel is left start-only: a resume stops as uncertain, never
    // resends. The timeout replays as the same timeout.
    await assert.rejects(
      runAgentCall(
        new AbortController().signal,
        fakeAttempt() as never,
        cancelled,
      ),
      UncertainInvocationError,
    )
    await assert.rejects(
      runAgentCall(
        new AbortController().signal,
        fakeAttempt() as never,
        timedOut,
      ),
      AgentTimeoutError,
    )
  })

  it('keeps a refusal after agent activity uncertain, except in preflight', async () => {
    /** Works on the call first, then fails with an error that reads as a refusal. */
    const actsThenRefuses = stubProvider(
      async (options) => {
        options.onActivity?.()
        throw new Error('401: login expired')
      },
      (error) =>
        error instanceof Error && error.message.startsWith('401')
          ? error.message
          : null,
    )
    for (const role of ['implement', 'repair', 'review-a', 'triage'] as const) {
      const checkpointsDir = await mkdtemp(join(tmpdir(), 'checkpoints-'))
      const spec = {
        ...baseSpec(actsThenRefuses, checkpointsDir),
        role,
        stage: role,
      }
      const attempt = fakeAttempt()
      const error = await runAgentCall(
        new AbortController().signal,
        attempt as never,
        spec,
      ).catch((e: unknown) => e)
      assert.ok(!(error instanceof RejectedInvocationError), role)
      assert.equal(attempt.snapshots.at(-1)?.result, 'uncertain', role)
      const paths = checkpointPaths(checkpointsDir, spec.operationKey)
      assert.equal(existsSync(paths.completed), false, role)
      // The resume never resends it: it stops as uncertain.
      await assert.rejects(
        runAgentCall(
          new AbortController().signal,
          fakeAttempt() as never,
          spec,
        ),
        UncertainInvocationError,
      )
    }
    // Preflight asks for a reply only, so its refusal still settles the call.
    const preflightDir = await mkdtemp(join(tmpdir(), 'checkpoints-'))
    const outcome = await runAgentCall(
      new AbortController().signal,
      fakeAttempt() as never,
      {
        ...baseSpec(actsThenRefuses, preflightDir),
        role: 'preflight',
        stage: 'preflight',
        acceptRejection: true,
      },
    )
    assert.equal(outcome.rejection, '401: login expired')
  })

  it('treats reported partial usage as activity', async () => {
    const checkpointsDir = await mkdtemp(join(tmpdir(), 'checkpoints-'))
    const provider = stubProvider(
      async (options) => {
        options.onPartialUsage?.({
          inputTokens: 10,
          cachedInputTokens: null,
          cacheReadTokens: null,
          cacheWriteTokens: null,
          outputTokens: 1,
          totalTokens: 11,
          usageSource: 'provider-partial',
        })
        throw new Error('401: login expired')
      },
      (error) => (error instanceof Error ? error.message : null),
    )
    const error = await runAgentCall(
      new AbortController().signal,
      fakeAttempt() as never,
      baseSpec(provider, checkpointsDir),
    ).catch((e: unknown) => e)
    assert.ok(!(error instanceof RejectedInvocationError))
  })

  it('classifies the stop as rejected-invocation, retryable, with the refusal and the reload retry', () => {
    const error =
      'rejected-invocation: the review-a call (codex gpt-5.6-sol) was refused: 401: login expired'
    const base = {
      runId: 'run-1',
      status: 'failed',
      output: null,
      error,
      uncertain: [],
    }
    const repo = classifyFailure({ ...base, reload: 'config' })
    assert.equal(repo?.kind, 'rejected-invocation')
    assert.equal(repo?.retryable, true)
    assert.ok(repo?.details.includes('refusal: 401: login expired'))
    assert.ok(
      repo?.next.some((n) =>
        n.startsWith(
          'pnpm --filter example-local-agent-loop demo retrigger --run run-1 --reload-config  # after fixing factory.json',
        ),
      ),
    )
    const flags = classifyFailure({ ...base, reload: 'flags-win' })
    assert.ok(
      flags?.next.some((n) => /--reload-config .*still wins over it/.test(n)),
    )
    // The bundled sample has no factory.json: no reload, its own check.
    const sample = classifyFailure({ ...base, reload: 'none' })
    assert.ok(!sample?.next.some((n) => n.includes('--reload-config')))
    assert.match(sample?.humanCheck ?? '', /trigger anew/)
    // An unresolved call still outranks the refusal.
    const both = classifyFailure({ ...base, uncertain: ['/tmp/x.started'] })
    assert.equal(both?.kind, 'uncertain-invocation')
    assert.equal(both?.retryable, false)
  })
})

describe('an agent call writes its output to a log of its own', () => {
  const result: AgentResult = {
    text: 'done',
    session: { id: 'native-session' },
    resolvedModel: 'resolved-model',
    resolvedEffort: 'low',
    reportedModel: null,
    reportedEffort: null,
    usage: null,
    elapsedMs: 5,
  }
  const specOf = async (provider: AgentProvider) => {
    const root = await mkdtemp(join(tmpdir(), 'agent-log-'))
    return {
      provider,
      providerName: 'codex' as const,
      prompt: 'the prompt is never written',
      workdir: '/tmp',
      timeoutMs: 5000,
      requestedModel: null,
      requestedEffort: null,
      effectiveModel: 'resolved-model',
      effectiveEffort: 'low',
      role: 'implement' as const,
      stage: 'implement',
      iteration: 1,
      operationKey: `test/${randomUUID()}`,
      checkpointsDir: join(root, 'operation-checkpoints'),
      agentLogsDir: join(root, 'agent-logs'),
      session: null,
    }
  }

  it('records the file before the first output and waits for every append before the terminal write', async () => {
    const attempt = fakeAttempt()
    let late: ((chunk: string) => void) | undefined
    const recordedAtFirstOutput: (string | undefined)[] = []
    const spec = await specOf(
      stubProvider(async (options) => {
        recordedAtFirstOutput.push(attempt.snapshots.at(-1)?.agentLog?.path)
        for (const chunk of ['one\n', 'two\n', 'three\n'])
          options.onOutput?.(chunk)
        late = options.onOutput
        return result
      }),
    )
    const outcome = await runAgentCall(
      new AbortController().signal,
      attempt as never,
      spec,
    )
    const path = join(spec.agentLogsDir, `${attempt.id}.log`)
    assert.deepEqual(recordedAtFirstOutput, [path])
    assert.deepEqual(outcome.measurement.agentLog, { path })
    // Every append had landed before the call returned.
    assert.equal(await readFile(path, 'utf8'), 'one\ntwo\nthree\n')
    // Output after the terminal write is dropped.
    late?.('after the end\n')
    // sleep-ok(negative): gives a dropped append the chance to land anyway
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(await readFile(path, 'utf8'), 'one\ntwo\nthree\n')
    assert.ok(!(await readFile(path, 'utf8')).includes('prompt'))
  })

  it('keeps a failed append as the log write error instead of failing the call', async () => {
    const attempt = fakeAttempt()
    const spec = await specOf(
      stubProvider(async (options) => {
        const path = attempt.snapshots.at(-1)?.agentLog?.path ?? ''
        // The file is replaced by a directory, so every append fails.
        await rm(path)
        await mkdir(path)
        options.onOutput?.('lost\n')
        return result
      }),
    )
    const outcome = await runAgentCall(
      new AbortController().signal,
      attempt as never,
      spec,
    )
    assert.equal(outcome.text, 'done')
    assert.match(outcome.measurement.agentLog?.writeError ?? '', /EISDIR/)
    assert.match(attempt.snapshots.at(-1)?.agentLog?.writeError ?? '', /EISDIR/)
  })

  it('makes no log and writes nothing on a replay or a call never sent', async () => {
    let calls = 0
    const spec = await specOf(
      stubProvider(async (options) => {
        calls++
        options.onOutput?.('first\n')
        return result
      }),
    )
    const first = fakeAttempt()
    await runAgentCall(new AbortController().signal, first as never, spec)
    const replay = fakeAttempt()
    const recovered = await runAgentCall(
      new AbortController().signal,
      replay as never,
      spec,
    )
    assert.equal(calls, 1)
    assert.equal(recovered.recovered, true)
    assert.equal(recovered.measurement.agentLog, undefined)
    assert.deepEqual(await readdir(spec.agentLogsDir), [`${first.id}.log`])
    assert.equal(
      await readFile(join(spec.agentLogsDir, `${first.id}.log`), 'utf8'),
      'first\n',
    )

    const superseded = new AbortController()
    superseded.abort()
    const unsent = await specOf(spec.provider)
    const notSent = await runAgentCall(
      new AbortController().signal,
      fakeAttempt() as never,
      {
        ...unsent,
        supersede: {
          signal: superseded.signal,
          reason: 'superseded-by-verify',
        },
      },
    )
    assert.equal(notSent.measurement.agentLog, undefined)
    assert.equal(existsSync(unsent.agentLogsDir), false)
    assert.equal(calls, 1)
  })
})

describe('what a provider writes to the agent log', () => {
  it('Codex: text deltas and one line per tool call, never reasoning or usage', async () => {
    const parts = [
      { type: 'stream-start' },
      { type: 'reasoning-start', id: 'r' },
      { type: 'reasoning-delta', id: 'r', delta: 'secret reasoning' },
      { type: 'text-start', id: 't' },
      { type: 'text-delta', id: 't', delta: 'Reading ' },
      { type: 'text-delta', id: 't', delta: 'the code' },
      { type: 'text-end', id: 't' },
      { type: 'text-start', id: 't2' },
      { type: 'text-delta', id: 't2', delta: 'Next message' },
      { type: 'text-end', id: 't2' },
      { type: 'tool-input-start', id: 'c', toolName: 'exec_command' },
      { type: 'tool-input-delta', id: 'c', delta: '{"command":"ls"}' },
      { type: 'tool-input-end', id: 'c' },
      {
        type: 'tool-call',
        toolCallId: 'c',
        toolName: 'exec_command',
        input: '{"command":"rg -n\\n formatCost src"}',
      },
      { type: 'tool-result', toolCallId: 'c', toolName: 'exec_command' },
      // The app-server shape: the whole item as JSON, `type` first; a
      // preliminary output delta, then the final result with its exit code.
      {
        type: 'tool-call',
        toolCallId: 'd',
        toolName: 'exec',
        input:
          '{"type":"commandExecution","id":"d","command":"pnpm test","cwd":"/w","status":"inProgress"}',
      },
      {
        type: 'tool-result',
        toolCallId: 'd',
        toolName: 'exec',
        preliminary: true,
        result: { type: 'output-delta', delta: 'ok\n' },
      },
      {
        type: 'tool-result',
        toolCallId: 'd',
        toolName: 'exec',
        result: {
          type: 'commandExecution',
          id: 'd',
          command: 'pnpm test',
          exitCode: 1,
        },
      },
      { type: 'finish', usage: { inputTokens: 123, outputTokens: 45 } },
    ]
    const model = {
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            for (const part of parts) controller.enqueue(part)
            controller.close()
          },
        }),
      }),
    }
    let written = ''
    const watched = watchActivity(model, undefined, (chunk) => {
      written += chunk
    })
    const { stream } = await watched.doStream()
    for await (const _ of stream as unknown as AsyncIterable<unknown>);
    assert.equal(
      written,
      'Reading the code\nNext message\n> exec_command rg -n formatCost src\n> exec pnpm test\n< exec exit 1\n',
    )
  })

  it('Claude: each text block and tool call once, never thinking, errors or results', () => {
    let written = ''
    const read = claudeOutput((chunk) => {
      written += chunk
    })
    const assistant = (content: unknown[], extra: object = {}) =>
      ({
        type: 'assistant',
        message: { id: 'm1', content, usage: { input_tokens: 9 } },
        ...extra,
      }) as never
    read({ type: 'system', subtype: 'init', model: 'claude-x' } as never)
    const thinking = { type: 'thinking', thinking: 'secret thinking' }
    const text = { type: 'text', text: 'Looking at the tests.' }
    const tool = {
      type: 'tool_use',
      id: 'tool-1',
      name: 'Bash',
      input: { command: 'pnpm test', description: 'run' },
    }
    read(assistant([thinking, text]))
    // The same message again, with the block it had already sent.
    read(assistant([thinking, text, tool]))
    read(assistant([{ type: 'text', text: 'refused' }], { error: 'x' }))
    read({
      type: 'user',
      message: { content: [{ type: 'tool_result', content: 'ok' }] },
    } as never)
    read({ type: 'result', usage: { input_tokens: 9 } } as never)
    assert.equal(written, 'Looking at the tests.\n> Bash pnpm test\n')
  })
})

describe("the factory's total and idle limits on an agent call", () => {
  const RESULT: AgentResult = {
    text: 'done',
    session: { id: 'native-session' },
    resolvedModel: 'resolved-model',
    resolvedEffort: 'low',
    reportedModel: null,
    reportedEffort: null,
    usage: null,
    elapsedMs: 1,
  }

  /**
   * A call that sends `beat` every `everyMs` until `doneMs` (never when
   * null), then answers; it rejects at once when aborted. `calls` counts
   * what was sent.
   */
  function beating(
    beat: (options: AgentCallOptions) => void,
    everyMs: number,
    doneMs: number | null,
  ) {
    let markStarted = () => {}
    const sent = {
      calls: 0,
      timeoutMs: 0,
      /** Settles once the call has been sent. */
      started: new Promise<void>((r) => (markStarted = r)),
    }
    const provider = stubProvider(
      (options) =>
        new Promise<AgentResult>((resolve, reject) => {
          sent.calls++
          markStarted()
          sent.timeoutMs = options.timeoutMs
          const started = Date.now()
          const timer = setInterval(() => {
            if (doneMs !== null && Date.now() - started >= doneMs) {
              clearInterval(timer)
              resolve(RESULT)
            } else beat(options)
          }, everyMs)
          options.signal?.addEventListener(
            'abort',
            () => {
              clearInterval(timer)
              reject(new Error('aborted'))
            },
            { once: true },
          )
        }),
    )
    return { provider, sent }
  }

  const specOf = async (
    provider: AgentProvider,
    limits: { timeoutMs: number; idleTimeoutMs?: number },
  ) => ({
    ...baseSpec(provider, await mkdtemp(join(tmpdir(), 'checkpoints-'))),
    ...limits,
  })

  for (const [name, beat] of [
    ['activity', (o: AgentCallOptions) => o.onActivity?.()],
    ['output', (o: AgentCallOptions) => o.onOutput?.('.')],
    [
      'partial usage',
      (o: AgentCallOptions) => o.onPartialUsage?.(PARTIAL_USAGE),
    ],
  ] as const) {
    it(`keeps a call that reports ${name} more often than the idle limit going past it`, async () => {
      const { provider } = beating(beat, 10, 250)
      const spec = await specOf(provider, {
        timeoutMs: 5000,
        idleTimeoutMs: 80,
      })
      const outcome = await runAgentCall(
        new AbortController().signal,
        fakeAttempt() as never,
        spec,
      )
      assert.equal(outcome.text, 'done')
      assert.equal(outcome.timedOut, null)
    })
  }

  it('stops a call that goes silent at the idle limit, and records it settled', async () => {
    const { provider, sent } = beating(() => {}, 10, null)
    const spec = await specOf(provider, { timeoutMs: 5000, idleTimeoutMs: 60 })
    const attempt = fakeAttempt()
    const error = await runAgentCall(
      new AbortController().signal,
      attempt as never,
      spec,
    ).catch((e: unknown) => e)
    assert.ok(error instanceof AgentTimeoutError)
    assert.deepEqual(error.timedOut, { kind: 'idle', limitMs: 60 })
    assert.match(
      error.message,
      /^agent-timeout: the implement call was stopped at its idle limit of 60 ms$/,
    )
    const last = attempt.snapshots.at(-1)
    assert.equal(last?.result, 'timed-out')
    assert.equal(last?.interruptionReason, 'timeout')
    assert.deepEqual(last?.timedOut, { kind: 'idle', limitMs: 60 })
    const completed = JSON.parse(
      await readFile(
        checkpointPaths(spec.checkpointsDir, spec.operationKey).completed,
        'utf8',
      ),
    ) as { result: unknown; timedOut: unknown }
    assert.equal(completed.result, null)
    assert.deepEqual(completed.timedOut, { kind: 'idle', limitMs: 60 })
    // The provider got a later copy of the total, never the runner's own.
    assert.equal(sent.timeoutMs, 5000 + PROVIDER_TIMEOUT_MARGIN_MS)
  })

  it('stops a call that keeps working at the total limit', async () => {
    const { provider } = beating((o) => o.onActivity?.(), 10, null)
    const spec = await specOf(provider, { timeoutMs: 150, idleTimeoutMs: 60 })
    const error = await runAgentCall(
      new AbortController().signal,
      fakeAttempt() as never,
      spec,
    ).catch((e: unknown) => e)
    assert.ok(error instanceof AgentTimeoutError)
    assert.deepEqual(error.timedOut, { kind: 'total', limitMs: 150 })
  })

  it('has no idle limit when none is given, as on a run set up before it existed', async () => {
    const { provider } = beating(() => {}, 10, 150)
    const spec = await specOf(provider, { timeoutMs: 5000 })
    const outcome = await runAgentCall(
      new AbortController().signal,
      fakeAttempt() as never,
      spec,
    )
    assert.equal(outcome.text, 'done')
  })

  it('hands the stop to a caller that accepts it, keeps the partial usage, and replays it without resending', async () => {
    const { provider, sent } = beating(
      (o) => o.onPartialUsage?.(PARTIAL_USAGE),
      10,
      null,
    )
    const spec = {
      ...(await specOf(provider, { timeoutMs: 120, idleTimeoutMs: 100 })),
      acceptTimeout: true,
    }
    const first = await runAgentCall(
      new AbortController().signal,
      fakeAttempt() as never,
      spec,
    )
    assert.deepEqual(first.timedOut, { kind: 'total', limitMs: 120 })
    assert.equal(first.measurement.usage?.inputTokens, 999)
    assert.equal(first.measurement.result, 'timed-out')
    const replay = fakeAttempt()
    const again = await runAgentCall(
      new AbortController().signal,
      replay as never,
      spec,
    )
    assert.deepEqual(again.timedOut, first.timedOut)
    assert.equal(again.recovered, true)
    assert.equal(replay.snapshots.at(-1)?.result, 'timed-out')
    assert.equal(sent.calls, 1)
    // A caller that does not accept it gets the same stop as an error.
    await assert.rejects(
      runAgentCall(new AbortController().signal, fakeAttempt() as never, {
        ...spec,
        acceptTimeout: false,
      }),
      AgentTimeoutError,
    )
    assert.equal(sent.calls, 1)
  })

  it('leaves a run-signal abort start-only and uncertain, even past the idle limit', async () => {
    const { provider, sent } = beating(() => {}, 10, null)
    const spec = await specOf(provider, { timeoutMs: 5000, idleTimeoutMs: 40 })
    const controller = new AbortController()
    const pending = runAgentCall(
      controller.signal,
      fakeAttempt() as never,
      spec,
    ).catch((e: unknown) => e)
    await sent.started
    controller.abort(new Error('lease lost'))
    const error = await pending
    assert.ok(!(error instanceof AgentTimeoutError))
    const paths = checkpointPaths(spec.checkpointsDir, spec.operationKey)
    assert.equal(existsSync(paths.completed), false)
    await assert.rejects(
      runAgentCall(new AbortController().signal, fakeAttempt() as never, spec),
      UncertainInvocationError,
    )
    assert.equal(sent.calls, 1)
  })

  it('settles a superseded call as cancelled, not as a timeout', async () => {
    const { provider, sent } = beating(() => {}, 10, null)
    const supersede = new AbortController()
    const spec = {
      ...(await specOf(provider, { timeoutMs: 5000, idleTimeoutMs: 200 })),
      role: 'review-a' as const,
      supersede: {
        signal: supersede.signal,
        reason: 'superseded-by-verify' as const,
      },
    }
    const pending = runAgentCall(
      new AbortController().signal,
      fakeAttempt() as never,
      spec,
    )
    await sent.started
    supersede.abort()
    const outcome = await pending
    assert.equal(outcome.cancelled, 'superseded-by-verify')
    assert.equal(outcome.timedOut, null)
  })

  it("never reads the provider's own timeout as the factory's", async () => {
    const sent = { calls: 0 }
    const provider = stubProvider(async () => {
      sent.calls++
      throw new Error('The operation was aborted due to timeout')
    })
    const spec = await specOf(provider, {
      timeoutMs: 5000,
      idleTimeoutMs: 1000,
    })
    const attempt = fakeAttempt()
    const error = await runAgentCall(
      new AbortController().signal,
      attempt as never,
      spec,
    ).catch((e: unknown) => e)
    assert.ok(!(error instanceof AgentTimeoutError))
    assert.equal(attempt.snapshots.at(-1)?.result, 'uncertain')
    assert.equal(attempt.snapshots.at(-1)?.timedOut, undefined)
    assert.equal(
      existsSync(
        checkpointPaths(spec.checkpointsDir, spec.operationKey).completed,
      ),
      false,
    )
    await assert.rejects(
      runAgentCall(new AbortController().signal, fakeAttempt() as never, spec),
      UncertainInvocationError,
    )
    assert.equal(sent.calls, 1)
  })

  it('restarts no limit on a notice that arrives after the call ended', async () => {
    let late: AgentCallOptions | null = null
    const provider = stubProvider(async (options) => {
      late = options
      return RESULT
    })
    const spec = await specOf(provider, { timeoutMs: 5000, idleTimeoutMs: 30 })
    const outcome = await runAgentCall(
      new AbortController().signal,
      fakeAttempt() as never,
      spec,
    )
    const options = late as AgentCallOptions | null
    options?.onActivity?.()
    options?.onOutput?.('late')
    // sleep-ok(negative): gives a restarted idle limit the time to fire
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(options?.signal?.aborted, false)
    assert.equal(outcome.timedOut, null)
  })
})
