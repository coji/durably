import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'

import type {
  AgentCallOptions,
  AgentProvider,
  AgentResult,
} from '../src/providers/types.js'
import type { AttemptMeasurement } from '../src/providers/types.js'
import { runAgentCall } from '../src/runner.js'

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
): AgentProvider {
  return {
    name: 'codex',
    fake: false,
    partialUsage: false,
    resolveExecution: () => ({ model: 'resolved-model', effort: 'low' }),
    call: behavior,
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
    const provider = stubProvider(
      (options) =>
        new Promise<AgentResult>((_resolve, reject) => {
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
    await new Promise((r) => setTimeout(r, 50))
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
