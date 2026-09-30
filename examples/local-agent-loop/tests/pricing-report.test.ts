import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  compareReports,
  comparisonToMarkdown,
  parseTrendDays,
  trendOf,
  trendRunIds,
  trendToMarkdown,
  type TrendRun,
} from '../src/engine/compare.js'
import { PRICE_BASIS, estimateCostUsd } from '../src/engine/pricing.js'
import {
  reportToJson,
  reportToMarkdown,
  reviewHighlights,
  summarizeRun,
} from '../src/engine/report.js'
import type { LoopReport } from '../src/engine/report.js'
import { groupTasks } from '../src/engine/status.js'

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
    baseline: null,
    preflight: null,
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
      discardedReviewCostUsd: 0,
    },
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
    specWallMs: null,
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
    assert.match(md, /- lead time \(trigger -> terminal\): unknown/)
    assert.match(md, /- total tokens: unknown/)
    assert.match(md, /- cost \(api-equiv\): unknown/)
    assert.doesNotMatch(md, /\| 0 \|/)
  })

  it('writes quantities as a person reads them and keeps the JSON raw', () => {
    const r: LoopReport = {
      ...baseReport(),
      summary: {
        ...baseReport().summary,
        leadTimeMs: 1_093_000,
        totalTokens: 5_123_456,
        costUsd: 6.443984,
      },
    }
    const md = reportToMarkdown(r)
    assert.match(md, /- lead time \(trigger -> terminal\): 18m 13s/)
    assert.match(md, /- total tokens: 5\.1M/)
    assert.match(md, /- cost \(api-equiv\): \$6\.44/)
    assert.ok(!md.includes('6.443984'))
    assert.doesNotMatch(md, /\d ?ms\b/)
    // The JSON keeps every stored number and null as it was.
    const json = JSON.parse(reportToJson(r)) as LoopReport
    assert.equal(json.summary.leadTimeMs, 1_093_000)
    assert.equal(json.summary.totalTokens, 5_123_456)
    assert.equal(json.summary.costUsd, 6.443984)
    assert.equal(json.summary.workMs, null)
    assert.equal(json.summary.costPerSuccessUsd, null)
    assert.equal(reportToJson(r), JSON.stringify(r, null, 2))
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
    assert.match(md, /inputWait=1m/)
    assert.match(md, /executionSlotWait=0\.5s/)
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
        invocation('codex-call', 0.25, 'gpt-5'),
        invocation('claude-call', 1.5, 'claude-opus-5'),
      ],
    })
    assert.match(
      md,
      /aggregate cost \(stored per-invocation estimates\): \$1\.75/,
    )
    assert.ok(!md.includes(PRICE_BASIS.checkedAt))
    assert.ok(!md.includes(PRICE_BASIS.source))
  })
})

describe('repair runs from outside findings', () => {
  const run = (
    runId: string,
    parent: string | null,
    costUsd: number,
    configVersion = 'cfg-1',
  ): LoopReport => {
    const r = baseReport()
    return {
      ...r,
      runId,
      status: 'completed',
      configVersion,
      lineage: {
        parent: parent
          ? { runId: parent, candidateCommit: 'c'.repeat(40) }
          : null,
        children: [],
      },
      summary: {
        ...r.summary,
        success: true,
        conclusion: 'approved',
        leadTimeMs: costUsd * 1000,
        costUsd,
        costPerSuccessUsd: costUsd,
        repairs: parent ? 1 : 0,
      },
    }
  }

  it('groups repair runs apart from normal runs of the same config', () => {
    const c = compareReports([
      run('parent', null, 10),
      run('child-a', 'parent', 1),
      run('child-b', 'parent', 3),
      run('child-c', 'parent', 5, 'cfg-2'),
    ])
    const normal = c.groups.filter((g) => g.kind === 'normal')
    const repair = c.groups.filter((g) => g.kind === 'repair')
    assert.deepEqual(
      normal.map((g) => g.runIds),
      [['parent']],
    )
    // Repair runs keep their per-config grouping among themselves.
    assert.deepEqual(
      repair.map((g) => g.runIds),
      [['child-a', 'child-b'], ['child-c']],
    )
    // Only the children's own numbers: the parent's cost and time never
    // enter them.
    const [first] = repair
    assert.equal(first?.costUsd.median, 2)
    assert.equal(first?.costUsd.max, 3)
    assert.equal(first?.leadTimeMs.max, 3000)
    assert.equal(first?.repairs.median, 1)
    const md = comparisonToMarkdown(c)
    assert.match(md, /## repair from findings: .* — config cfg-1/)
    assert.match(md, /grouped apart from normal runs/)
  })

  it("labels a repair group with the inherited code profile, not the repair profile's", () => {
    const measured = (role: 'implement' | 'repair', model: string) => ({
      stepName: 'stage:0:code:agent',
      measurement: { role, effectiveModel: model, effectiveEffort: 'high' },
    })
    const normal = {
      ...run('parent', null, 1),
      input: { provider: 'codex', context: 'reuse' },
      attempts: [measured('implement', 'code-model')],
    } as unknown as LoopReport
    const child = {
      ...run('child', 'parent', 1),
      input: {
        provider: 'codex',
        context: 'reuse',
        repairOf: {
          profiles: {
            code: { effectiveModel: 'code-model', effectiveEffort: 'high' },
          },
        },
      },
      // Its first code call is the repair, on a repair profile of its own.
      attempts: [measured('repair', 'repair-model')],
    } as unknown as LoopReport
    const labels = compareReports([normal, child]).groups.map((g) => g.label)
    assert.deepEqual(labels, [
      'codex/code-model/high/reuse',
      'codex/code-model/high/reuse',
    ])
  })

  it('names the parent, the children and the findings in the report', () => {
    const r = {
      ...run('child', 'parent', 1),
      inputs: {
        task: null,
        spec: null,
        dispositions: null,
        findings: { path: '/tmp/findings.md', sha256: 'f'.repeat(64) },
      },
    }
    const md = reportToMarkdown(r)
    assert.match(
      md,
      new RegExp(`- parent: parent \\(candidate ${'c'.repeat(40)}\\)`),
    )
    assert.match(md, /- children: none/)
    assert.match(
      md,
      new RegExp(`- findings: ${'f'.repeat(64)} \\(/tmp/findings\\.md\\)`),
    )
    const parent = {
      ...run('parent', null, 1),
      lineage: { parent: null, children: ['a', 'b'] },
    }
    assert.match(reportToMarkdown(parent), /- parent: none\n- children: a, b/)
  })

  it('names the parent run as the source of findings built from its stored check failure or reviews', () => {
    const findings = { parentRun: 'parent', sha256: 'e'.repeat(64) }
    const r = {
      ...run('child', 'parent', 1),
      inputs: { task: null, spec: null, dispositions: null, findings },
    }
    assert.match(
      reportToMarkdown(r),
      new RegExp(
        `- findings: ${'e'.repeat(64)} \\(built from the stored record of run parent\\)`,
      ),
    )
    assert.deepEqual(
      (JSON.parse(reportToJson(r)) as { inputs: { findings: unknown } }).inputs
        .findings,
      findings,
    )
  })
})

describe('trend by task, week and code profile', () => {
  // Local times, so the weeks are the same in every time zone: Wednesday
  // 2026-09-30 at noon; its week starts on Monday 2026-09-28.
  const local = (d: number, h = 12) => new Date(2026, 8, d, h).getTime()
  const now = local(30)
  const iso = (ms: number) => new Date(ms).toISOString()
  /** A run that finished at `completed`, created an hour before it. */
  const run = (
    id: string,
    completed: number | null,
    over: {
      parent?: string
      created?: number
      model?: string
      effort?: string
      fake?: boolean
      success?: boolean
      leadTimeMs?: number | null
      costUsd?: number | null
      status?: string
    } = {},
  ): TrendRun => {
    const success = over.success ?? true
    return {
      id,
      parentId: over.parent ?? null,
      createdAt: iso(over.created ?? (completed ?? now) - 3_600_000),
      status: over.status ?? 'completed',
      completedAt: completed === null ? null : iso(completed),
      report: {
        ...baseReport(),
        runId: id,
        status: over.status ?? 'completed',
        fake: over.fake ?? false,
        input: { provider: 'codex', model: 'm1', effort: 'low' },
        attempts: [
          {
            ...baseReport().attempts[0]!,
            stepName: 'stage:3:code:agent',
            measurement: {
              ...baseReport().attempts[0]!.measurement!,
              effectiveModel: over.model ?? 'gpt-6-astra',
              effectiveEffort: over.effort ?? 'medium',
              versions: { codex: `0.${id.length}` },
            },
          },
        ],
        delivery: success
          ? {
              kind: 'branch',
              location: '/repo',
              summary: 'delivered',
              branch: `factory/${id}`,
              commit: 'c'.repeat(40),
              squashedBranch: null,
              squashedCommit: null,
            }
          : null,
        summary: {
          ...baseReport().summary,
          success,
          leadTimeMs: over.leadTimeMs === undefined ? 600_000 : over.leadTimeMs,
          costUsd: over.costUsd === undefined ? 2 : over.costUsd,
          // Repairs inside a run are not repair runs.
          repairs: 3,
        },
      } as LoopReport,
    }
  }

  it("counts tasks by the week their newest run finished and by the first run's model/effort, never an unknown as 0", () => {
    const t = trendOf(
      [
        run('a', local(29), { leadTimeMs: 300_000, costUsd: 1 }),
        run('b', local(28, 0), { success: false, costUsd: null }),
        run('c', local(27, 23), { leadTimeMs: 900_000, costUsd: 3 }),
        run('d', local(22), { effort: 'low' }),
        // Before the window, an open run, a fake run and one from the future.
        run('old', local(30) - 31 * 86_400_000),
        run('open', null, { status: 'leased' }),
        run('fake', local(29), { fake: true }),
        run('later', local(30) + 1000),
      ],
      { now },
    )
    assert.deepEqual(t.weeks, ['2026-09-21', '2026-09-28'])
    assert.deepEqual(t.taskIds, ['a', 'b', 'c', 'd'])
    assert.equal(t.fakeExcluded, 1)
    assert.deepEqual(
      t.groups.map((g) => [g.model, g.effort, g.taskIds]),
      [
        ['gpt-6-astra', 'medium', ['a', 'b', 'c']],
        ['gpt-6-astra', 'low', ['d']],
      ],
    )
    const [medium] = t.groups
    const [lastWeek, thisWeek] = medium!.weeks
    assert.deepEqual(
      [lastWeek?.week, lastWeek?.tasks, thisWeek?.week, thisWeek?.tasks],
      ['2026-09-21', 1, '2026-09-28', 2],
    )
    assert.deepEqual(
      [
        thisWeek?.firstPassApproved,
        thisWeek?.firstPassRate,
        thisWeek?.approved,
        thisWeek?.approvalRate,
      ],
      [1, 0.5, 1, 0.5],
    )
    assert.equal(thisWeek?.leadTimeMs.median, 450_000)
    // b's cost is unknown: left out of the median, not counted as $0.
    assert.deepEqual(
      [
        thisWeek?.costUsd.median,
        thisWeek?.costUsd.n,
        thisWeek?.costUsd.unknown,
      ],
      [1, 1, 1],
    )
    // Repairs inside a run are not repair runs.
    assert.equal(thisWeek?.repairRuns.median, 0)
    assert.equal(medium?.total.tasks, 3)
    // A week without tasks has no rate and no median at all.
    const low = t.groups[1]!
    assert.deepEqual(
      low.weeks.map((w) => [w.tasks, w.approvalRate, w.firstPassRate]),
      [
        [1, 1, 1],
        [0, null, null],
      ],
    )
    assert.equal(low.weeks[1]?.leadTimeMs.median, null)
  })

  it('counts a task once, over every run it took, by its newest run', () => {
    const t = trendOf(
      [
        // Started before the window, with an unknown-cost run inside it:
        // counted this week by its approved repair, with totals over both.
        run('root', local(30) - 40 * 86_400_000, {
          success: false,
          leadTimeMs: 100_000,
          costUsd: 5,
          model: 'root-model',
          effort: 'high',
        }),
        run('fix', local(29), {
          parent: 'root',
          leadTimeMs: 200_000,
          costUsd: 1,
          model: 'other-model',
        }),
        // Approved on its first run, a week earlier.
        run('clean', local(23), { model: 'root-model', effort: 'high' }),
        // Its repair's cost is unknown: the task's cost is unknown too.
        run('p', local(24), { model: 'root-model', effort: 'high' }),
        run('p1', local(25), { parent: 'p', costUsd: null }),
        run('p2', local(26), { parent: 'p1' }),
        // Newest run still open: the task is not in the trend yet.
        run('q', local(28), { model: 'root-model', effort: 'high' }),
        run('q1', null, { parent: 'q', status: 'leased', created: local(29) }),
      ],
      { now },
    )
    assert.deepEqual(t.taskIds, ['root', 'p', 'clean'])
    assert.equal(t.groups.length, 1)
    const [g] = t.groups
    // The first run's code profile names the group, not its repair's.
    assert.deepEqual([g?.model, g?.effort], ['root-model', 'high'])
    const [last, current] = g!.weeks
    assert.deepEqual(
      [
        current?.week,
        current?.tasks,
        current?.approved,
        current?.firstPassApproved,
      ],
      ['2026-09-28', 1, 1, 0],
    )
    assert.equal(current?.leadTimeMs.median, 300_000)
    assert.equal(current?.costUsd.median, 6)
    assert.equal(current?.repairRuns.median, 1)
    assert.deepEqual(
      [last?.tasks, last?.firstPassApproved, last?.approved],
      [2, 1, 2],
    )
    assert.deepEqual(
      [last?.costUsd.n, last?.costUsd.unknown, last?.costUsd.median],
      [1, 1, 2],
    )
    assert.deepEqual([last?.repairRuns.min, last?.repairRuns.max], [0, 2])
    // The window's weeks start at the first counted task's week.
    assert.deepEqual(t.weeks, ['2026-09-21', '2026-09-28'])
    // The runs to build reports for: every run of every counted task.
    assert.deepEqual(
      trendRunIds(
        [
          run('root', local(30) - 40 * 86_400_000),
          run('fix', local(29), { parent: 'root' }),
          run('q', local(28)),
          run('q1', null, {
            parent: 'q',
            status: 'leased',
            created: local(29),
          }),
          run('gone', local(30) - 31 * 86_400_000),
        ],
        { now },
      ).sort(),
      ['fix', 'root'],
    )
  })

  it('reads final approval from the newest run, not the run the list shows', () => {
    // The first run stopped at the review cap; its repair of that candidate
    // was approved. The list shows the stop, which nobody archived.
    const runs = [
      run('capped', local(28), { success: false }),
      run('repaired', local(29), { parent: 'capped' }),
    ]
    const [task] = groupTasks(
      runs.map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        parentId: r.parentId,
        kind: r.id === 'capped' ? ('stopped' as const) : ('finished' as const),
        approved: r.report.summary.success,
        leadTimeMs: r.report.summary.leadTimeMs,
        costUsd: r.report.summary.costUsd,
      })),
    )
    assert.equal(task?.representative, 'capped')
    const cell = trendOf(runs, { now }).groups[0]!.total
    assert.deepEqual(
      [cell.tasks, cell.approved, cell.approvalRate, cell.firstPassApproved],
      [1, 1, 1, 0],
    )
    // An approval without a delivery is not a final approval.
    const undelivered = run('solo', local(29))
    undelivered.report = { ...undelivered.report, delivery: null }
    assert.equal(trendOf([undelivered], { now }).groups[0]!.total.approved, 0)
  })

  it('takes fake tasks only when asked, by their first run, and the CLI version is not part of a group', () => {
    const runs = [
      run('a', local(29)),
      run('bb', local(29)),
      run('f', local(28), { fake: true }),
      // A real repair of a fake task is still a fake task.
      run('f1', local(29), { parent: 'f' }),
    ]
    const left = trendOf(runs, { now, days: 7 })
    assert.equal(left.fakeExcluded, 1)
    assert.deepEqual(left.taskIds, ['a', 'bb'])
    const t = trendOf(runs, { now, includeFake: true, days: 7 })
    assert.equal(t.fakeExcluded, 0)
    assert.equal(t.groups.length, 1)
    assert.deepEqual(t.groups[0]?.taskIds.length, 3)
    assert.deepEqual(t.weeks, ['2026-09-28'])
  })

  it('prints the same numbers in Markdown', () => {
    const t = trendOf(
      [
        run('a', local(29), { leadTimeMs: 300_000, costUsd: 1 }),
        run('b', local(28), { success: false, costUsd: null }),
        run('c', local(29), { parent: 'b', leadTimeMs: 600_000 }),
        run('d', local(22), { effort: 'low' }),
      ],
      { now },
    )
    const md = trendToMarkdown(t)
    assert.match(md, /^# Task trend/)
    assert.match(md, /Fake-provider tasks left out: 0\./)
    assert.match(md, /## gpt-6-astra \/ medium/)
    assert.match(
      md,
      /\| week of 2026-09-28 \| 2 \| 1\/2 \(50%\) \| 2\/2 \(100%\) \| 12m 30s \[5m\.\.20m\] \(n=2\) \| \$1\.00 \[\$1\.00\.\.\$1\.00\] \(n=1, 1 unknown\) \| \$0\.00 \[\$0\.00\.\.\$0\.00\] \(n=2\) \| 1 \[0\.\.1\] \(n=2\) \|/,
    )
    assert.match(
      md,
      /\| week of 2026-09-28 \| 0 \| - \| - \| - \| - \| - \| - \|/,
    )
    assert.match(md, /\| last 30 days \| 1 \| 1\/1 \(100%\)/)
    assert.match(
      trendToMarkdown(trendOf([], { now })),
      /No finished task in the window\./,
    )
  })

  it('accepts only a whole positive number of days within the safe range', () => {
    assert.equal(parseTrendDays(undefined), 30)
    assert.equal(parseTrendDays('7'), 7)
    assert.equal(
      parseTrendDays(String(Number.MAX_SAFE_INTEGER)),
      Number.MAX_SAFE_INTEGER,
    )
    for (const bad of [
      '0',
      '-1',
      'NaN',
      'Infinity',
      '1.5',
      '1e3',
      '',
      'true',
      String(Number.MAX_SAFE_INTEGER + 1),
      '9007199254740993',
    ])
      assert.throws(() => parseTrendDays(bad), /--days/, bad)
    // The longest window still lists weeks from the first run only.
    const t = trendOf([run('a', local(29))], {
      now,
      days: Number.MAX_SAFE_INTEGER,
    })
    assert.deepEqual(t.weeks, ['2026-09-28'])
  })
})

describe('reviews of candidates that failed verification', () => {
  const report = (
    runId: string,
    discardedReviewCostUsd: number | null,
  ): LoopReport => {
    const r = baseReport()
    return {
      ...r,
      runId,
      status: 'completed',
      configVersion: 'cfg-parallel',
      summary: {
        ...r.summary,
        conclusion: 'verification-failed',
        costUsd: 3,
        discardedReviewCostUsd,
      } as LoopReport['summary'],
    }
  }

  it('keeps their cost apart from the total, and an unknown one unknown', () => {
    const summary = (
      discarded: Parameters<typeof summarizeRun>[0]['discardedReviews'],
    ) =>
      summarizeRun({
        status: 'completed',
        output: null,
        runElapsedMs: null,
        stageTotalMs: null,
        waits: [],
        attempts: [],
        stageUsage: [],
        stageVisits: [],
        discardedReviews: discarded,
      })
    // None: zero cost, a known value.
    assert.equal(summary(null).discardedReviewCostUsd, 0)
    // A call without usage or a price leaves the cost unknown, never 0.
    const unknown = summary({
      invocations: 2,
      inputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      outputTokens: null,
      totalTokens: null,
      costUsd: null,
      complete: false,
      costComplete: false,
    })
    assert.equal(unknown.discardedReviewCostUsd, null)

    const c = compareReports([
      report('a', 0.5),
      report('b', 0),
      report('c', null),
    ])
    const g = c.groups[0]!
    assert.deepEqual(g.discardedReviewCostUsd, {
      n: 2,
      unknown: 1,
      median: 0.25,
      min: 0,
      max: 0.5,
    })
    assert.equal(g.costUsd.median, 3)
    assert.match(
      comparisonToMarkdown(c),
      /- of which reviews of candidates that failed verification: \$0\.25 \[\$0\.00\.\.\$0\.50\] \(n=2, 1 unknown\)/,
    )
  })

  it('counts only the rounds that counted for a run with no output yet', () => {
    const summary = (countedReviewRounds?: number) =>
      summarizeRun({
        status: 'leased',
        output: null,
        runElapsedMs: null,
        stageTotalMs: null,
        waits: [],
        attempts: [],
        stageUsage: [],
        // Two review stage visits: one cancelled or discarded round, one
        // still waiting on its check.
        stageVisits: [{ stage: 'review', visits: 2, reworked: 1 }],
        ...(countedReviewRounds === undefined ? {} : { countedReviewRounds }),
      })
    assert.equal(summary(0).reviewRounds, 0)
    assert.equal(summary(1).reviewRounds, 1)
    // A summary made without the rounds keeps counting the visits.
    assert.equal(summary().reviewRounds, 2)
  })

  it("adds up a task's runs in the trend, and leaves out a task with an unknown one", () => {
    const now = new Date(2026, 8, 30, 12).getTime()
    const iso = (ms: number) => new Date(ms).toISOString()
    const run = (
      id: string,
      parentId: string | null,
      discarded: number | null,
    ): TrendRun => ({
      id,
      parentId,
      createdAt: iso(now - 7_200_000 + (parentId ? 60_000 : 0)),
      status: 'completed',
      completedAt: iso(now - 3_600_000 + (parentId ? 60_000 : 0)),
      report: { ...report(id, discarded), fake: false },
    })
    const t = trendOf(
      [run('a', null, 0.25), run('a2', 'a', 0.5), run('b', null, null)],
      { now },
    )
    const total = t.groups[0]!.total
    assert.equal(total.tasks, 2)
    assert.equal(total.discardedReviewCostUsd.median, 0.75)
    assert.equal(total.discardedReviewCostUsd.unknown, 1)
    assert.match(trendToMarkdown(t), /failed-candidate reviews/)
  })
})
