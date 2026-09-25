import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import type { JsonValue } from '@coji/durably'

import { SpawnCancelledError } from '../src/engine/child.js'
import {
  classifyFailure,
  lastVerificationLogs,
  uncertainCheckpoints,
} from '../src/engine/failure-reasons.js'
import type {
  AgentCallOptions,
  AgentProvider,
  AgentResult,
} from '../src/engine/providers/types.js'
import type { AttemptMeasurement } from '../src/engine/providers/types.js'
import {
  checkpointPaths,
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
    assert.ok(!(error instanceof RejectedInvocationError))
    assert.equal(
      existsSync(checkpointPaths(timedOutDir, timedOut.operationKey).completed),
      false,
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
    // Both are left start-only: a resume stops as uncertain, never resends.
    await assert.rejects(
      runAgentCall(
        new AbortController().signal,
        fakeAttempt() as never,
        timedOut,
      ),
      UncertainInvocationError,
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
