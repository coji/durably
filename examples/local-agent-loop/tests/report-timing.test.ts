import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { asReportReview, asSpecReview } from '../src/engine/build-report.js'
import { PRICE_BASIS } from '../src/engine/pricing.js'
import {
  reportToMarkdown,
  reviewHighlights,
  specWallMs,
  stageTimings,
  totalStageMs,
  type AttemptRow,
  type LoopReport,
  type ReportReview,
  type ReportReviewRound,
  type RunSummary,
} from '../src/engine/report.js'

/** A finished run with two code attempts, one of them unmeasured. */
function baseReport(): LoopReport {
  return {
    runId: 'r1',
    jobName: 'agent-loop',
    status: 'completed',
    input: {},
    output: null,
    fake: false,
    configVersion: null,
    triage: null,
    baseline: null,
    preflight: null,
    summary: emptySummary(),
    stageUsage: [],
    roleUsage: [],
    inputs: { task: null, spec: null, dispositions: null, findings: null },
    lineage: { parent: null, children: [] },
    candidate: null,
    candidates: [],
    repairSession: null,
    repairCalls: [],
    reviews: [],
    reviewRounds: [],
    reviewHighlights: reviewHighlights([], [], []),
    specRounds: [],
    spec: null,
    delivery: null,
    worktree: null,
    failure: null,
    stageVisits: [],
    realLlmCallCount: 1,
    fullLoopVerified: false,
    attempts: [
      row('stage:0:code:agent', 'a1', 100),
      row('stage:0:code:agent', 'a2', null),
    ],
    waits: [],
    stageTimings: stageTimings([
      row('stage:0:code:agent', 'a1', 100),
      row('stage:0:code:agent', 'a2', null),
    ]),
    stageTotalMs: null,
    specWallMs: null,
    runElapsedMs: 200,
    versions: {},
    priceBasis: PRICE_BASIS,
    notes: [],
  }
}

function emptySummary(): RunSummary {
  return {
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
  }
}

function row(
  stepName: string,
  attemptId: string,
  elapsedMs: number | null,
): AttemptRow {
  return {
    stepName,
    stepIndex: 1,
    attemptId,
    leaseGeneration: 1,
    status: 'completed',
    startedAt: 't',
    completedAt: 't',
    interruptionReason: null,
    measurement: {
      provider: 'codex',
      fake: false,
      stage: stepName,
      iteration: 1,
      requestedModel: 'gpt-5.6-sol',
      requestedEffort: 'low',
      effectiveModel: 'gpt-5.6-sol',
      effectiveEffort: 'low',
      reportedModel: 'gpt-5.6-sol',
      reportedEffort: null,
      versions: {},
      elapsedMs,
      usage: null,
      costUsdEstimate: null,
      costBasis: null,
      result: 'implement-done',
      error: null,
      interruptionReason: null,
    },
  }
}

describe('stage timing completeness', () => {
  it('marks a stage partial when any attempt lacks elapsedMs', () => {
    const timings = stageTimings([
      row('stage:0:code:agent', 'a1', 100),
      row('stage:0:code:agent', 'a2', null),
    ])
    assert.equal(timings.length, 1)
    assert.equal(timings[0]?.stage, 'code')
    assert.equal(timings[0]?.elapsedMs, 100)
    assert.equal(timings[0]?.complete, false)
  })

  it('marks a stage complete when every attempt reports elapsedMs', () => {
    const timings = stageTimings([row('stage:0:code:agent', 'a1', 100)])
    assert.equal(timings[0]?.complete, true)
  })

  it('stage total is unknown when any stage is partial', () => {
    assert.equal(
      totalStageMs([
        { stage: 'implement', elapsedMs: 100, complete: true },
        { stage: 'test', elapsedMs: null, complete: false },
      ]),
      null,
    )
    assert.equal(
      totalStageMs([{ stage: 'implement', elapsedMs: 100, complete: true }]),
      100,
    )
  })

  it('markdown flags partial stages instead of presenting known-only sums', () => {
    const md = reportToMarkdown(baseReport())
    assert.match(md, /PARTIAL/)
    // Times read as durations; an unknown one is unknown, never 0 or `ms`.
    assert.match(md, /- stage total: unknown/)
    assert.match(md, /- run elapsed: 0\.2s/)
    assert.match(md, /- code: work=0\.1s, wall=/)
    assert.doesNotMatch(md, /\d ?ms\b/)
  })

  it('uses the original invocation interval after checkpoint recovery', () => {
    const recovered = row('stage:0:code:agent', 'retry', 1000)
    recovered.startedAt = '2026-01-01T00:01:00.000Z'
    recovered.completedAt = '2026-01-01T00:01:00.010Z'
    recovered.measurement = {
      ...recovered.measurement!,
      invocationId: 'same-invocation',
      recovered: true,
      result: 'checkpoint-recovered',
      invocationStartedAt: '2026-01-01T00:00:00.000Z',
      invocationCompletedAt: '2026-01-01T00:00:01.000Z',
    }
    const [timing] = stageTimings([recovered])
    assert.equal(timing?.elapsedMs, 1000)
    assert.equal(timing?.wallElapsedMs, 1000)
  })
})

function timedRow(
  stepName: string,
  attemptId: string,
  startedAt: string,
  completedAt: string,
): AttemptRow {
  const base = row(
    stepName,
    attemptId,
    Date.parse(completedAt) - Date.parse(startedAt),
  )
  return {
    ...base,
    startedAt,
    completedAt,
    measurement: {
      ...base.measurement!,
      invocationStartedAt: startedAt,
      invocationCompletedAt: completedAt,
    },
  }
}

describe('stage wall time across repeat visits', () => {
  it('sums each visit instead of spanning the stages that ran in between', () => {
    // code(0-20s) -> verify(20-40s) -> code again(200-220s)
    const timings = stageTimings([
      timedRow(
        'stage:0:code:agent',
        'a1',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:20.000Z',
      ),
      timedRow(
        'stage:1:verify:acceptance',
        'v1',
        '2026-01-01T00:00:20.000Z',
        '2026-01-01T00:00:40.000Z',
      ),
      timedRow(
        'stage:2:code:agent',
        'a2',
        '2026-01-01T00:03:20.000Z',
        '2026-01-01T00:03:40.000Z',
      ),
    ])
    const code = timings.find((t) => t.stage === 'code')
    assert.equal(code?.elapsedMs, 40000)
    // Not 220000: the verify stage and the idle gap belong to neither visit.
    assert.equal(code?.wallElapsedMs, 40000)
    assert.equal(
      timings.find((t) => t.stage === 'verify')?.wallElapsedMs,
      20000,
    )
  })

  it('still spans parallel branches within one visit', () => {
    const timings = stageTimings([
      timedRow(
        'stage:2:review:correctness',
        'r1',
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:10.000Z',
      ),
      timedRow(
        'stage:2:review:edge-cases',
        'r2',
        '2026-01-01T00:00:02.000Z',
        '2026-01-01T00:00:12.000Z',
      ),
    ])
    const review = timings.find((t) => t.stage === 'review')
    assert.equal(review?.elapsedMs, 20000)
    assert.equal(review?.wallElapsedMs, 12000)
  })
})

describe('the spec stages together', () => {
  const at = (s: number) =>
    new Date(Date.UTC(2026, 0, 1) + s * 1000).toISOString()
  const spec = [
    timedRow('spec:author', 's1', at(0), at(60)),
    // Two reviewers side by side count once.
    timedRow('spec-review:1:alice', 'r1', at(60), at(100)),
    timedRow('spec-review:1:bob', 'r2', at(65), at(110)),
    timedRow('spec:fix:1', 'f1', at(110), at(140)),
    // A person decides on the blocked spec from 140 s to 1000 s.
    timedRow('spec-review:2:alice', 'r3', at(1000), at(1030)),
    timedRow('spec-check', 'c1', at(1030), at(1040)),
  ]

  it('counts the wall time of spec, spec review and spec check once, without the gaps between', () => {
    const rows = [
      ...spec,
      timedRow('stage:3:code:agent', 'a1', at(1040), at(2000)),
    ]
    assert.equal(specWallMs(rows), 180_000)
    // The per-stage work sums both reviewers, so it exceeds the wall time.
    const timings = stageTimings(rows)
    const work = timings
      .filter((t) => ['spec', 'spec-review', 'spec-check'].includes(t.stage))
      .reduce((sum, t) => sum + (t.elapsedMs ?? 0), 0)
    assert.equal(work, 215_000)
    // Each stage's wall time is its own intervals' union: the two review
    // rounds give 50 s and 30 s, never the 970 s from the first start to
    // the last end with the person's decision in between.
    const wall = (stage: string) =>
      timings.find((t) => t.stage === stage)?.wallElapsedMs
    assert.equal(wall('spec-review'), 80_000)
    // The author and the fix are both the spec stage: 60 s and 30 s.
    assert.equal(wall('spec'), 90_000)
    assert.equal(wall('spec-check'), 10_000)
  })

  it('does not span the gap between two rounds of one stage without a sequence', () => {
    const timings = stageTimings([
      timedRow('spec:fix:1', 'f1', at(0), at(20)),
      timedRow('spec:fix:2', 'f2', at(500), at(530)),
    ])
    const fix = timings.find((t) => t.stage === 'spec')
    assert.equal(fix?.wallElapsedMs, 50_000)
  })

  it('is unknown without spec stages, or with a spec attempt that has no end', () => {
    assert.equal(
      specWallMs([timedRow('stage:0:code:agent', 'a1', at(0), at(10))]),
      null,
    )
    const open = timedRow('spec:author', 's1', at(0), at(60))
    open.completedAt = null
    open.measurement = {
      ...open.measurement!,
      invocationCompletedAt: undefined,
    }
    assert.equal(specWallMs([open]), null)
  })
})

describe('review highlights', () => {
  const findings = (blocker: string[], nonBlocker: string[]) => ({
    blocker: blocker.map((title) => ({
      severity: 'blocker' as const,
      title,
      body: 'b',
    })),
    nonBlocker: nonBlocker.map((title) => ({
      severity: 'non-blocker' as const,
      title,
      body: 'b',
    })),
    counts: { blocker: blocker.length, nonBlocker: nonBlocker.length },
  })
  const review = (
    lens: string,
    decision: string,
    f: ReturnType<typeof findings> | null,
    notes = 'first line\nmore',
  ): ReportReview => ({ lens, decision, notes, findings: f })
  const round = (n: number, reviews: ReportReview[]): ReportReviewRound => ({
    round: n,
    sequence: n * 2,
    candidate: null,
    reviews,
  })

  const LENSES = ['correctness', 'edge-cases']

  it('takes the blockers before the last round as earlier and the last non-blockers as left', () => {
    const h = reviewHighlights(
      [
        round(1, [
          review('correctness', 'needsChanges', findings(['A', 'B'], ['x'])),
          review('edge-cases', 'needsChanges', findings(['C'], [])),
        ]),
        round(2, [
          review('correctness', 'pass', findings([], ['D'])),
          review('edge-cases', 'pass', findings([], ['E', 'F'])),
        ]),
      ],
      [],
      LENSES,
    )
    assert.equal(h.rounds, 2)
    assert.equal(h.last, 'passed')
    assert.deepEqual([h.earlier.count, h.earlier.titles], [3, ['A', 'B', 'C']])
    assert.deepEqual([h.left.count, h.left.titles], [3, ['D', 'E', 'F']])
    assert.equal(h.open.count, 0)
  })

  it("keeps the last round's blockers apart when it did not pass", () => {
    const h = reviewHighlights(
      [
        round(1, [
          review('correctness', 'needsChanges', findings(['A'], [])),
          review('edge-cases', 'pass', findings([], [])),
        ]),
        round(2, [
          review('correctness', 'needsChanges', findings(['G'], ['H'])),
          review('edge-cases', 'pass', findings([], [])),
        ]),
      ],
      [],
      LENSES,
    )
    assert.equal(h.last, 'blocked')
    assert.deepEqual(h.earlier.titles, ['A'])
    assert.deepEqual(h.open.titles, ['G'])
    assert.deepEqual(h.left.titles, ['H'])
  })

  it('does not call a last round passed while a reviewer has no verdict', () => {
    // The edge-cases reviewer is still running, or failed: only one verdict.
    const h = reviewHighlights(
      [
        round(1, [
          review('correctness', 'needsChanges', findings(['A'], [])),
          review('edge-cases', 'pass', findings([], [])),
        ]),
        round(2, [review('correctness', 'pass', findings(['G'], ['H']))]),
      ],
      [],
      LENSES,
    )
    assert.equal(h.last, 'incomplete')
    assert.deepEqual(h.earlier.titles, ['A'])
    assert.deepEqual(h.open.titles, ['G'])
    assert.deepEqual(h.left.titles, ['H'])
  })

  it('shows a verdict review by its decision and the first line of its notes', () => {
    const h = reviewHighlights(
      [
        round(1, [
          review(
            'correctness',
            'needsChanges',
            null,
            '\n  Fix the parser\nDetails',
          ),
          review('edge-cases', 'pass', null),
        ]),
        round(2, [
          review('correctness', 'pass', null, 'Looks right'),
          review('edge-cases', 'pass', null, 'Fine'),
        ]),
      ],
      [],
      LENSES,
    )
    assert.equal(h.last, 'passed')
    assert.deepEqual(h.earlier.verdicts, [
      {
        round: 1,
        lens: 'correctness',
        decision: 'needsChanges',
        line: 'Fix the parser',
      },
    ])
    // The passing verdicts of the last round left nothing: no group
    // lists or counts them.
    assert.deepEqual(h.lastPasses, [
      { round: 2, lens: 'correctness', decision: 'pass', line: 'Looks right' },
      { round: 2, lens: 'edge-cases', decision: 'pass', line: 'Fine' },
    ])
    assert.deepEqual(h.left.verdicts, [])
    assert.equal(h.earlier.count + h.left.count + h.open.count, 0)
  })

  it('counts findings only, and keeps a passing verdict out of what was left', () => {
    const h = reviewHighlights(
      [
        round(1, [
          review('correctness', 'needsChanges', findings(['A'], [])),
          review('edge-cases', 'needsChanges', null),
        ]),
        round(2, [
          review('correctness', 'pass', findings([], ['D', 'E', 'F'])),
          review('edge-cases', 'pass', null, 'Fine'),
        ]),
      ],
      [],
      LENSES,
    )
    assert.equal(h.last, 'passed')
    assert.deepEqual([h.left.count, h.left.verdicts], [3, []])
    assert.deepEqual([h.earlier.count, h.earlier.verdicts.length], [1, 1])
    assert.deepEqual(
      h.lastPasses.map((v) => v.lens),
      ['edge-cases'],
    )
    const md = reportToMarkdown({
      ...baseReport(),
      reviewHighlights: h,
    })
    assert.match(md, /left \(non-blockers of the last round\): 3 finding\(s\)/)
    assert.match(
      md,
      /fixed \(blockers of the rounds before the last\): 1 finding\(s\)/,
    )
    assert.match(md, /last round passed\n {2}- round 2 edge-cases: pass — Fine/)
  })

  it('reads the last verdicts as one round when no round was stored, and nothing before a review', () => {
    const h = reviewHighlights(
      [],
      [review('correctness', 'pass', findings([], ['Z']))],
      ['correctness'],
    )
    assert.deepEqual([h.rounds, h.last, h.left.titles], [1, 'passed', ['Z']])
    const none = reviewHighlights([], [], LENSES)
    assert.deepEqual([none.rounds, none.last], [0, null])
  })
})

describe('refused tool calls of a review', () => {
  it('reads them from stored repository and spec review steps, held to ten entries of 300 characters, and shows one line under each affected review', () => {
    const long = (i: number) => `Glob: denied ${i} ${'x'.repeat(400)}`
    const stored = asReportReview({
      lens: 'correctness',
      decision: 'pass',
      notes: 'Fine',
      findings: null,
      permissionDenials: {
        count: 12,
        entries: Array.from({ length: 12 }, (_, i) => long(i)),
      },
    })
    assert.equal(stored?.permissionDenials?.count, 12)
    assert.equal(stored?.permissionDenials?.entries.length, 10)
    for (const entry of stored?.permissionDenials?.entries ?? [])
      assert.equal(entry.length, 300)
    const plain = asReportReview({
      lens: 'edge-cases',
      decision: 'pass',
      notes: 'Fine too',
      findings: null,
    })
    assert.ok(plain && !('permissionDenials' in plain))
    const spec = asSpecReview({
      name: 'security',
      decision: 'needsChanges',
      notes: 'Spec gap',
      findings: null,
      permissionDenials: { count: 1, entries: ['Read: outside /etc'] },
    })
    assert.deepEqual(spec?.permissionDenials, {
      count: 1,
      entries: ['Read: outside /etc'],
    })
    const reviews = [stored, plain].filter((r): r is ReportReview => r !== null)
    const md = reportToMarkdown({
      ...baseReport(),
      reviews,
      reviewRounds: [
        {
          round: 1,
          sequence: 1,
          candidate: null,
          reviews,
          status: 'completed',
        },
      ],
      specRounds: [
        {
          round: 1,
          sequence: 1,
          candidate: null,
          reviews: spec ? [spec] : [],
        },
      ],
    })
    // Every stored entry, in order, then how many more were refused.
    const listed = (indent: string) =>
      [
        `${indent}- tool calls the guard refused: 12`,
        ...Array.from(
          { length: 10 },
          (_, i) => `${indent}  - ${long(i).slice(0, 300)}`,
        ),
        `${indent}  - 2 more not listed`,
      ].join('\n')
    assert.ok(
      md.includes(
        `- correctness: pass — Fine\n${listed('  ')}\n- edge-cases: pass — Fine too\n`,
      ),
      md,
    )
    assert.ok(
      md.includes(
        `  - correctness: pass — Fine\n${listed('    ')}\n  - edge-cases: pass — Fine too\n`,
      ),
      md,
    )
    assert.ok(
      md.includes(
        '  - security: needsChanges — Spec gap\n    - tool calls the guard refused: 1\n      - Read: outside /etc\n',
      ),
      md,
    )
  })
})
