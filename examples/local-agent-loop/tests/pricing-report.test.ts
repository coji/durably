import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { PRICE_BASIS, estimateCostUsd } from '../src/engine/pricing.js'
import { reportToMarkdown } from '../src/engine/report.js'
import type { LoopReport } from '../src/engine/report.js'

function baseReport(): LoopReport {
  return {
    runId: 'r1',
    jobName: 'agent-loop',
    status: 'waiting',
    input: {},
    output: null,
    fake: true,
    configVersion: null,
    triage: null,
    summary: {
      success: false,
      conclusion: null,
      leadTimeMs: null,
      workMs: null,
      humanWaitMs: null,
      humanWaitRatio: null,
      llmInvocations: 0,
      totalTokens: null,
      costUsd: null,
      costPerSuccessUsd: null,
      repairs: 0,
      reviewRounds: 0,
    },
    stageUsage: [],
    roleUsage: [],
    inputs: { task: null, spec: null, dispositions: null },
    candidate: null,
    candidates: [],
    reviews: [],
    reviewRounds: [],
    delivery: null,
    failure: null,
    stageVisits: [],
    realLlmCallCount: 0,
    fullLoopVerified: false,
    attempts: [
      {
        stepName: 'implement:1',
        stepIndex: 1,
        attemptId: 'a1',
        leaseGeneration: 1,
        status: 'completed',
        startedAt: 't',
        completedAt: 't',
        interruptionReason: null,
        measurement: {
          provider: 'fake',
          fake: true,
          stage: 'implement',
          iteration: 1,
          requestedModel: null,
          requestedEffort: null,
          effectiveModel: null,
          effectiveEffort: null,
          reportedModel: null,
          reportedEffort: null,
          versions: {},
          elapsedMs: null,
          usage: null,
          costUsdEstimate: null,
          costBasis: null,
          result: 'implemented',
          error: null,
          interruptionReason: null,
        },
      },
    ],
    waits: [],
    stageTimings: [{ stage: 'implement', elapsedMs: null, complete: false }],
    stageTotalMs: null,
    runElapsedMs: null,
    versions: {},
    priceBasis: PRICE_BASIS,
    notes: ['fake mode'],
  }
}

describe('pricing/report', () => {
  it('returns null when usage is missing (never zero-filled)', () => {
    assert.equal(estimateCostUsd('gpt-5', null), null)
    assert.equal(
      estimateCostUsd('gpt-5', { inputTokens: null, outputTokens: null }),
      null,
    )
  })

  it('returns null for unknown models', () => {
    assert.equal(
      estimateCostUsd('mystery-model', { inputTokens: 100, outputTokens: 100 }),
      null,
    )
  })

  it('returns null when EITHER priced leg is missing (no partial costs)', () => {
    assert.equal(
      estimateCostUsd('gpt-5', { inputTokens: 1000, outputTokens: null }),
      null,
    )
    assert.equal(
      estimateCostUsd('gpt-5', { inputTokens: null, outputTokens: 1000 }),
      null,
    )
    const full = estimateCostUsd('gpt-5', {
      inputTokens: 1000,
      outputTokens: 1000,
    })
    assert.ok(full !== null && full > 0)
  })

  it('renders unknown (not 0) for missing measurements', () => {
    const md = reportToMarkdown(baseReport())
    assert.match(md, /unknown/)
    assert.doesNotMatch(md, /\| 0 \|/)
  })

  it('separates real-call counts from full-loop verification', () => {
    const md = reportToMarkdown({
      ...baseReport(),
      fake: false,
      realLlmCallCount: 3,
      fullLoopVerified: false,
      notes: ['real CLI calls observed but loop incomplete'],
    })
    assert.match(md, /real LLM calls observed: 3/)
    assert.match(md, /full loop verified: no/)
  })

  it('distinguishes human input wait from execution-slot wait', () => {
    const md = reportToMarkdown({
      ...baseReport(),
      waits: [
        {
          id: 'w1',
          name: 'human-approval',
          outcome: 'signal',
          createdAt: 't0',
          suspendedAt: 't1',
          resolvedAt: 't2',
          inputWaitMs: 60000,
          executionSlotWaitMs: 500,
        },
      ],
    })
    assert.match(md, /inputWait=60000ms/)
    assert.match(md, /executionSlotWait=500ms/)
  })

  it('keeps aggregate cost unknown when any invocation cannot be priced', () => {
    const known = baseReport().attempts[0]!
    const md = reportToMarkdown({
      ...baseReport(),
      attempts: [
        {
          ...known,
          stepName: 'stage:0:code:agent',
          measurement: {
            ...known.measurement!,
            invocationId: 'known',
            usage: {
              inputTokens: 100,
              cachedInputTokens: null,
              outputTokens: 50,
              totalTokens: 150,
              usageSource: 'provider-final',
            },
            reportedModel: 'gpt-5',
            costUsdEstimate: 0.000625,
            costBasis: 'api-equivalent-estimate',
          },
        },
        {
          ...known,
          attemptId: 'a2',
          stepName: 'stage:1:review:correctness',
          measurement: {
            ...known.measurement!,
            invocationId: 'unknown',
            usage: {
              inputTokens: 100,
              cachedInputTokens: null,
              outputTokens: 50,
              totalTokens: 150,
              usageSource: 'provider-final',
            },
            reportedModel: null,
            costUsdEstimate: null,
            costBasis: null,
          },
        },
      ],
    })
    assert.match(
      md,
      /aggregate cost \(stored per-invocation estimates\): unknown/,
    )
  })

  it('labels interrupted verification attempts and log write errors', () => {
    const known = baseReport().attempts[0]!
    const verify = (id: string, log: object) => ({
      ...known,
      attemptId: id,
      stepName: 'stage:1:verify:acceptance',
      measurement: { ...known.measurement!, verificationLog: log as never },
    })
    const md = reportToMarkdown({
      ...baseReport(),
      attempts: [
        verify('lost0000', {
          stdoutPath: '/l/1/stdout.log',
          stderrPath: '/l/1/stderr.log',
          exitCode: null,
          interrupted: true,
        }),
        verify('graded00', {
          stdoutPath: '/l/2/stdout.log',
          stderrPath: '/l/2/stderr.log',
          exitCode: 1,
          writeError: 'ENOSPC',
        }),
      ],
    })
    assert.ok(
      md.includes(
        '(lost0000): exit code null, interrupted, not part of the verdict',
      ),
    )
    assert.ok(md.includes('(graded00): exit code 1\n'))
    assert.ok(md.includes('  - log write error: ENOSPC'))
  })

  it('adds per-invocation costs across different models', () => {
    const known = baseReport().attempts[0]!
    const invocation = (id: string, cost: number, model: string) => ({
      ...known,
      attemptId: id,
      stepName: 'stage:0:code:agent',
      measurement: {
        ...known.measurement!,
        invocationId: id,
        reportedModel: model,
        usage: {
          inputTokens: 100,
          cachedInputTokens: null,
          outputTokens: 50,
          totalTokens: 150,
          usageSource: 'provider-final' as const,
        },
        costUsdEstimate: cost,
        costBasis: 'api-equivalent-estimate' as const,
      },
    })
    const md = reportToMarkdown({
      ...baseReport(),
      attempts: [
        invocation('codex-call', 0.001, 'gpt-5'),
        invocation('claude-call', 0.002, 'claude-opus-5'),
      ],
    })
    assert.match(
      md,
      /aggregate cost \(stored per-invocation estimates\): 0\.003000 USD/,
    )
    assert.ok(!md.includes(PRICE_BASIS.checkedAt))
    assert.ok(!md.includes(PRICE_BASIS.source))
  })
})
