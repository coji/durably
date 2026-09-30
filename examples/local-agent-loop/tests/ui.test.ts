/**
 * The web UI (`demo ui`): loopback only, showing the same reasons, commands
 * and numbers as `status`, `report` and `compare`, reads that write nothing,
 * and actions only through the CLI's functions behind the page token.
 *
 * The UI runs as the real CLI in a child process with `HOME` pointed at a
 * temporary directory, so the fixed state root resolves there. Runs are made
 * by an in-process fake-mode worker against that same database.
 */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { request, type IncomingHttpHeaders } from 'node:http'
import { connect, createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import Database from 'better-sqlite3'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { createAgentDurably, dbPath } from '../src/durably.js'
import {
  repairChildrenByParent,
  type ReportSource,
  reusedBaselineOf,
} from '../src/engine/build-report.js'
import { runChild } from '../src/engine/child.js'
import {
  classifyFailure,
  reloadAdvice,
  type FailureClassification,
  type FailureKind,
} from '../src/engine/failure-reasons.js'
import {
  liveElapsed,
  stageUsage,
  stageVisits,
  type AttemptRow,
  type LoopReport,
  type UsageTotals,
} from '../src/engine/report.js'
import { checkpointPaths } from '../src/engine/runner.js'
import {
  archivable,
  groupTasks,
  taskRunIds,
  needsAttention,
  type Diagnosis,
  type DiagnosisKind,
  type Task,
  type TaskRunInput,
} from '../src/engine/status.js'
import { archiveMarkerOf } from '../src/factory/layout.js'
import { repairLabels } from '../src/factory/repair.js'
import { ActionNotice } from '../src/ui/components/ActionNotice.js'
import { ReviewFindingTitles } from '../src/ui/components/ReviewFindingTitles.js'
import {
  ACTION,
  ACTION_DONE,
  COPY,
  DESIGN,
  DETAIL,
  DIAGNOSIS_TEXT,
  KIND_NAME,
  LIST,
  REVIEW,
  TREND,
} from '../src/ui/glossary.js'
import {
  commandNote,
  noteSaidByReason,
  commandText,
  detailField,
  INTERRUPTED_CHECK_TEXT,
  LOG_WRITE_ERROR_NOTE,
  NO_EXIT_CODE,
  diagnosisText,
  humanCheckText,
  isPathDetail,
  lensName,
  reviewDecision,
  squashedBranchField,
  roleName,
  stageName,
  stopName,
} from '../src/ui/labels.js'
import { TaskRuns } from '../src/ui/screens/list/TaskRuns.js'
import { RecordPanels } from '../src/ui/screens/run/RecordPanels.js'
import { SpecPanel } from '../src/ui/screens/run/SpecPanel.js'
import { BaselineSource } from '../src/ui/screens/run/StageTimings.js'

/** A page's actions, for a page rendered where nothing is sent. */
const noAct = async () => true

/** A diagnosis sentence in Japanese only. */
const KIND_TEXT_OK = (text: string) => !/[A-Za-z()（）]/.test(text)
import { pollEvery } from '../src/ui/poll.js'
import { parseRoute } from '../src/ui/route.js'
import { TrendScreen } from '../src/ui/screens/CompareScreen.js'
import { DesignScreen } from '../src/ui/screens/DesignScreen.js'
import { ReviewHighlightsPanel } from '../src/ui/screens/run/ReviewsPanel.js'
import { SummaryPanel } from '../src/ui/screens/run/SummaryPanel.js'
import { UsagePanels } from '../src/ui/screens/run/UsagePanels.js'
import { RunScreen } from '../src/ui/screens/RunScreen.js'
import { RunsScreen } from '../src/ui/screens/RunsScreen.js'
import {
  derivePipeline,
  deriveTrace,
  finishedReportCache,
  listedReports,
  readOnce,
  runName,
  SUBJECT_RUN_NAME,
  type CompareResponse,
  type RunDetailResponse,
  type RunRef,
  type RunRow,
  type RunsResponse,
  type TraceInput,
  type TrendResponse,
  type TraceNode,
  startUiServer,
  TOKEN_HEADER,
} from '../src/ui/server.js'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(packageRoot, 'src', 'cli.ts')

describe('runName', () => {
  const repo = (extra: Record<string, unknown>) => ({
    target: { kind: 'repo', task: 'unused', issue: null, ...extra },
  })

  it('uses the issue number and title when the run came from an issue', () => {
    assert.equal(
      runName(
        repo({
          task: 'the issue body',
          issue: { number: 123, title: '  Fix the parser  ', url: 'u' },
        }),
      ),
      '#123 Fix the parser',
    )
  })

  it("uses the task's first non-empty line, without a heading mark", () => {
    assert.equal(
      runName(repo({ task: '\n\n  ## Add a --dry-run flag  \nmore detail' })),
      'Add a --dry-run flag',
    )
    const long = 'x'.repeat(200)
    const name = runName(repo({ task: long }))
    assert.equal(name.length, 80)
    assert.ok(name.endsWith('…'))
  })

  it('names the bundled subject in words, and never returns an empty name', () => {
    assert.equal(runName({ target: { kind: 'subject' } }), SUBJECT_RUN_NAME)
    assert.equal(SUBJECT_RUN_NAME, '同梱題材: calc の add を直す')
    assert.notEqual(runName(repo({ task: '   \n ' })), '')
  })
})

describe('tasks', () => {
  const at = (minute: number) =>
    new Date(Date.UTC(2026, 8, 30, 0, minute)).toISOString()
  const run = (
    id: string,
    minute: number,
    kind: DiagnosisKind,
    over: Partial<TaskRunInput> = {},
  ): TaskRunInput => ({
    id,
    createdAt: at(minute),
    parentId: null,
    kind,
    approved: false,
    leadTimeMs: null,
    costUsd: null,
    ...over,
  })

  it('makes a first run and every repair below it one task, led by its first run', () => {
    const tasks = groupTasks([
      run('root', 0, 'finished', { approved: true }),
      run('fix1', 10, 'finished', { parentId: 'root', approved: true }),
      run('fix2', 20, 'finished', { parentId: 'fix1', approved: true }),
      run('alone', 5, 'finished', { approved: true }),
      // A parent that is gone leaves its repair a task of its own.
      run('orphan', 30, 'finished', { parentId: 'gone', approved: true }),
    ])
    assert.deepEqual(
      tasks.map((t) => [t.id, t.runs.map((r) => r.id), t.representative]),
      [
        ['orphan', ['orphan'], 'orphan'],
        ['root', ['root', 'fix1', 'fix2'], 'fix2'],
        ['alone', ['alone'], 'alone'],
      ],
    )
  })

  it('drops a stopped repair that a later approved repair of the same parent replaced', () => {
    const [task] = groupTasks([
      run('root', 0, 'finished', { approved: true }),
      run('capped', 10, 'stopped', { parentId: 'root' }),
      run('fixed', 20, 'finished', { parentId: 'root', approved: true }),
    ])
    assert.equal(task?.attention, 'done')
    assert.equal(task?.representative, 'fixed')
    assert.deepEqual(
      task?.runs.map((r) => [r.id, r.superseded, r.attention]),
      [
        ['root', false, 'done'],
        ['capped', true, 'done'],
        ['fixed', false, 'done'],
      ],
    )
    // An approved repair from before the stop does not replace it.
    const [still] = groupTasks([
      run('root', 0, 'finished', { approved: true }),
      run('fixed', 10, 'finished', { parentId: 'root', approved: true }),
      run('capped', 20, 'stopped', { parentId: 'root' }),
    ])
    assert.deepEqual(
      [still?.attention, still?.representative],
      ['stop', 'capped'],
    )
  })

  it('moves an archived stop to the finished tasks with its diagnosis, unless another run still needs a person', () => {
    const [alone] = groupTasks([run('stop', 0, 'stopped', { archived: true })])
    assert.deepEqual(
      [alone?.attention, alone?.representative, alone?.runs[0]?.kind],
      ['done', 'stop', 'stopped'],
    )
    assert.equal(alone?.runs[0]?.archived, true)
    // Unarchived, it is a stop again.
    const [back] = groupTasks([run('stop', 0, 'stopped')])
    assert.deepEqual(
      [back?.attention, back?.runs[0]?.archived],
      ['stop', false],
    )
    // Another run of the task still waits on a person: the task stays up.
    const [task] = groupTasks([
      run('root', 0, 'stopped', { archived: true }),
      run('fix', 10, 'approval', { parentId: 'root' }),
    ])
    assert.deepEqual(
      [task?.attention, task?.representative],
      ['decision', 'fix'],
    )
    // Only a run that has stopped can be archived: the marker of an open
    // run, or of one that finished and needs no one, changes nothing.
    const [open] = groupTasks([run('wait', 0, 'approval', { archived: true })])
    assert.deepEqual(
      [open?.attention, open?.runs[0]?.archived],
      ['decision', false],
    )
    const [done] = groupTasks([run('ok', 0, 'finished', { archived: true })])
    assert.deepEqual(
      [done?.attention, done?.runs[0]?.archived],
      ['done', false],
    )
    assert.deepEqual(
      (['stopped', 'finished', 'approval', 'pending'] as const).map(archivable),
      [true, false, false, false],
    )
  })

  it('puts decisions first, then unresolved stops, then open work, then the rest, newest first', () => {
    const tasks = groupTasks([
      run('done-new', 50, 'finished', { approved: true }),
      run('running', 40, 'running'),
      run('stopped-old', 1, 'stopped'),
      run('stopped-new', 30, 'stopped'),
      run('approval', 2, 'approval'),
      run('pending', 45, 'pending'),
      run('expired', 3, 'lease-expired'),
      run('decided', 4, 'decided'),
      run('spec', 5, 'spec-approval'),
    ])
    assert.deepEqual(
      tasks.map((t) => [t.id, t.attention]),
      [
        ['spec', 'decision'],
        ['approval', 'decision'],
        ['stopped-new', 'stop'],
        ['stopped-old', 'stop'],
        ['pending', 'active'],
        ['running', 'active'],
        ['decided', 'active'],
        ['expired', 'active'],
        ['done-new', 'done'],
      ],
    )
    assert.deepEqual(
      tasks.filter((t) => needsAttention(t.attention)).map((t) => t.id),
      ['spec', 'approval', 'stopped-new', 'stopped-old'],
    )
  })

  it('sums lead time and cost over the task, unknown when any run is, and numbers its repairs', () => {
    const [task] = groupTasks([
      run('root', 0, 'finished', {
        approved: true,
        leadTimeMs: 60_000,
        costUsd: 1.5,
      }),
      run('fix1', 10, 'stopped', {
        parentId: 'root',
        leadTimeMs: 30_000,
        costUsd: 0.25,
      }),
      run('fix2', 20, 'finished', {
        parentId: 'root',
        approved: true,
        leadTimeMs: 45_000,
        costUsd: 1,
      }),
    ])
    assert.deepEqual(task?.total, { leadTimeMs: 135_000, costUsd: 2.75 })
    assert.deepEqual(
      task?.runs.map((r) => [r.id, r.repair]),
      [
        ['root', null],
        ['fix1', 1],
        ['fix2', 2],
      ],
    )
    const [partial] = groupTasks([
      run('root', 0, 'finished', { leadTimeMs: 60_000, costUsd: 1.5 }),
      run('fix', 10, 'finished', {
        parentId: 'root',
        leadTimeMs: 30_000,
        costUsd: null,
      }),
    ])
    assert.deepEqual(partial?.total, { leadTimeMs: 90_000, costUsd: null })
  })

  it('finds every run of the task a run belongs to, as groupTasks groups them', () => {
    const runs = [
      { id: 'root', parentId: null },
      { id: 'fix1', parentId: 'root' },
      { id: 'fix2', parentId: 'fix1' },
      { id: 'other', parentId: null },
    ]
    assert.deepEqual(taskRunIds(runs, 'fix2'), ['root', 'fix1', 'fix2'])
    assert.deepEqual(taskRunIds(runs, 'other'), ['other'])
    assert.deepEqual(taskRunIds(runs, 'missing'), [])
  })

  it('shows a task by the run that needs a person, even when a newer run is running', () => {
    const [task] = groupTasks([
      run('root', 0, 'finished', { approved: true }),
      run('waits', 10, 'approval', { parentId: 'root' }),
      run('runs', 20, 'running', { parentId: 'root' }),
    ])
    assert.deepEqual(
      [task?.attention, task?.representative],
      ['decision', 'waits'],
    )
  })
})

describe('liveElapsed', () => {
  const t0 = Date.parse('2026-09-24T10:00:00.000Z')
  const iso = (ms: number) => new Date(t0 + ms).toISOString()
  const attempt = (
    stepName: string,
    startedAt: number,
    completedAt: number | null,
    leaseGeneration = 2,
  ) => ({
    stepName,
    startedAt: iso(startedAt),
    completedAt: completedAt === null ? null : iso(completedAt),
    status: completedAt === null ? 'started' : 'completed',
    leaseGeneration,
  })

  it('measures the run from its lease and the stage from the open attempt', () => {
    const run = {
      status: 'leased',
      createdAt: iso(-5000),
      startedAt: iso(0),
      leaseGeneration: 2,
    }
    const live = liveElapsed(
      run,
      [
        attempt('setup', 0, 1000),
        attempt('stage:1:verify:check', 2000, null),
        // Left open by a worker that lost its lease: not the step running now.
        attempt('stage:3:review:correctness', 9000, null, 1),
      ],
      t0 + 12_000,
    )
    assert.deepEqual(live, {
      runMs: 12_000,
      stage: 'verify',
      stepName: 'stage:1:verify:check',
      stageMs: 10_000,
    })
  })

  it('uses the creation time before any lease, and is null once finished', () => {
    const pending = {
      status: 'pending',
      createdAt: iso(0),
      startedAt: null,
      leaseGeneration: 0,
    }
    assert.deepEqual(liveElapsed(pending, [], t0 + 3000), {
      runMs: 3000,
      stage: null,
      stepName: null,
      stageMs: null,
    })
    for (const status of ['completed', 'failed', 'cancelled'])
      assert.equal(
        liveElapsed({ ...pending, status }, [attempt('setup', 0, null)], t0),
        null,
      )
  })
})

describe('pipeline and trace', () => {
  const t0 = Date.parse('2026-09-24T10:00:00.000Z')
  const iso = (s: number) => new Date(t0 + s * 1000).toISOString()
  const step = (
    stepName: string,
    start: number,
    end: number | null,
    status = end === null ? 'started' : 'completed',
    leaseGeneration = 1,
  ) => ({
    stepName,
    stepIndex: 0,
    attemptId: `${stepName}@${start}`,
    leaseGeneration,
    status,
    startedAt: iso(start),
    completedAt: end === null ? null : iso(end),
    interruptionReason: null,
    measurement: null,
  })
  const wait = (name: string, created: number, resolved: number | null) => ({
    id: name,
    name,
    outcome: resolved === null ? null : 'signal',
    createdAt: iso(created),
    suspendedAt: iso(created),
    resolvedAt: resolved === null ? null : iso(resolved),
    inputWaitMs: resolved === null ? null : (resolved - created) * 1000,
    executionSlotWaitMs: null,
  })
  const report = (
    attempts: ReturnType<typeof step>[],
    waits: ReturnType<typeof wait>[] = [],
    roles: string[] = ['code', 'correctness', 'edge-cases'],
  ) => ({
    attempts,
    waits,
    stageVisits: stageVisits(attempts),
    roleUsage: roles.map((role) => ({ role })) as never,
  })
  const stagesOf = (p: ReturnType<typeof derivePipeline>) =>
    p.stages.map((s) => [s.stage, s.state, s.count])

  // Implemented, failed the check, repaired, passed, reviewed, and now waits.
  const repaired = [
    step('setup', 0, 1),
    step('decision:0', 1, 1),
    step('stage:0:code:agent', 1, 10),
    step('stage:0:code:candidate', 10, 11),
    step('stage:1:verify:acceptance', 11, 15),
    step('stage:2:code:agent', 15, 30),
    step('stage:2:code:candidate', 30, 31),
    step('stage:3:verify:acceptance', 31, 35),
    step('stage:4:review:correctness', 35, 50),
    step('stage:4:review:edge-cases', 35, 45),
  ]
  const approval = wait('stage:5:approve:cand-2', 51, null)

  it('(a) counts a repair loop and puts a waiting run on approve', () => {
    const p = derivePipeline({
      status: 'waiting',
      diagnosisKind: 'approval',
      live: null,
      report: report(repaired, [approval]),
    })
    assert.deepEqual(stagesOf(p), [
      ['setup', 'done', 1],
      ['code', 'done', 2],
      ['verify', 'done', 2],
      ['review', 'done', 1],
      ['approve', 'waiting', 1],
      ['finish', 'not-reached', 0],
    ])
    assert.equal(p.label, '工程: 実装 2回、検証 2回、いまは承認で人待ち')
  })

  it('(b) stops a verification-failed run at verify', () => {
    const p = derivePipeline({
      status: 'completed',
      diagnosisKind: 'stopped',
      live: null,
      report: report([
        step('setup', 0, 1),
        step('stage:0:code:agent', 1, 10),
        step('stage:1:verify:acceptance', 11, 15),
        step('stage:2:code:agent', 15, 30),
        step('stage:3:verify:acceptance', 31, 35),
        step('stage:4:stop:result', 35, 36),
      ]),
    })
    assert.deepEqual(stagesOf(p), [
      ['setup', 'done', 1],
      ['code', 'done', 2],
      ['verify', 'stopped', 2],
      ['review', 'not-reached', 0],
      ['approve', 'not-reached', 0],
      ['finish', 'not-reached', 0],
    ])
    assert.equal(p.label, '工程: 実装 2回、検証 2回、検証で停止')
  })

  it('(d) shows approval as automatic on a run that finished without an approval wait', () => {
    const p = derivePipeline({
      status: 'completed',
      diagnosisKind: 'finished',
      live: null,
      report: report([
        step('setup', 0, 1),
        step('stage:0:code:agent', 1, 10),
        step('stage:1:verify:acceptance', 11, 15),
        step('stage:2:review:correctness', 15, 20),
        step('stage:4:finish:deliver', 21, 22),
      ]),
    })
    // No approval wait, yet the run finished: its settings approved it.
    assert.equal(
      stagesOf(p).find(([stage]) => stage === 'approve')?.[1],
      'auto',
    )
    assert.equal(p.label, '工程: 承認は設定による自動、完了まで終わった')
  })

  it('(e) shows the baseline check and preflight only on a run that entered them', () => {
    const stopped = derivePipeline({
      status: 'failed',
      diagnosisKind: 'stopped',
      live: null,
      report: report([step('setup', 0, 1), step('baseline', 1, 5)]),
    })
    assert.deepEqual(stagesOf(stopped).slice(0, 3), [
      ['setup', 'done', 1],
      ['baseline', 'stopped', 1],
      ['code', 'not-reached', 0],
    ])
    assert.equal(stopped.label, '工程: ベースの検証で停止')
    const refused = derivePipeline({
      status: 'failed',
      diagnosisKind: 'stopped',
      live: null,
      report: report([
        step('setup', 0, 1),
        step('preflight', 1, 2),
        step('preflight:call:0', 2, 4),
      ]),
    })
    assert.deepEqual(stagesOf(refused).slice(0, 2), [
      ['setup', 'done', 1],
      ['preflight', 'stopped', 1],
    ])
    // Every preflight step is one trace entry, labeled in Japanese.
    const trace = deriveTrace({
      run: {
        status: 'failed',
        createdAt: iso(0),
        startedAt: iso(0),
        completedAt: iso(4),
        leaseGeneration: 1,
      },
      diagnosisKind: 'stopped',
      conclusion: null,
      attempts: [
        step('setup', 0, 1),
        step('preflight', 1, 2),
        step('preflight:call:0', 2, 4),
      ],
      waits: [],
      reviews: [],
      candidate: null,
      stepOutputs: {},
      now: t0 + 10_000,
    })
    assert.deepEqual(
      trace.root.children.map((c) => [c.label, c.attempts]),
      [
        ['準備', 1],
        ['事前確認', 2],
      ],
    )
    // Without either, the stepper is as it was.
    const plain = derivePipeline({
      status: 'waiting',
      diagnosisKind: 'approval',
      live: null,
      report: report(repaired, [approval]),
    })
    assert.ok(
      !stagesOf(plain).some(([s]) => s === 'baseline' || s === 'preflight'),
    )
  })

  it('(f) shows the spec stages only on a run that has them, and waits on the spec apart from approval', () => {
    const specRoles = [
      'code',
      'correctness',
      'edge-cases',
      'spec-author',
      'spec-fix',
      'spec-review:tech',
    ]
    const specSteps = [
      step('setup', 0, 1),
      step('preflight', 1, 2),
      step('spec:author', 2, 5),
      step('spec-review:1:tech', 5, 8),
      step('spec:fix:1', 8, 10),
      step('spec-review:2:tech', 10, 12),
    ]
    const blocked = derivePipeline({
      status: 'waiting',
      diagnosisKind: 'spec-approval',
      live: null,
      report: report(specSteps, [wait('spec-wait:1', 13, null)], specRoles),
    })
    assert.deepEqual(stagesOf(blocked).slice(0, 5), [
      ['setup', 'done', 1],
      ['preflight', 'done', 1],
      ['spec', 'done', 2],
      ['spec-review', 'waiting', 2],
      ['code', 'not-reached', 0],
    ])
    assert.equal(
      blocked.label,
      '工程: 仕様 2回、仕様レビュー 2回、いまは仕様レビューで人待ち',
    )
    // Before any spec step, the stages are there from the spec roles.
    const pending = derivePipeline({
      status: 'pending',
      diagnosisKind: 'pending',
      live: null,
      report: report([], [], specRoles),
    })
    assert.deepEqual(
      stagesOf(pending)
        .map(([stage]) => stage)
        .slice(0, 3),
      ['setup', 'spec', 'spec-review'],
    )
    // A run without spec stages keeps its stepper.
    const plain = derivePipeline({
      status: 'waiting',
      diagnosisKind: 'approval',
      live: null,
      report: report(repaired, [approval]),
    })
    assert.ok(!stagesOf(plain).some(([s]) => String(s).startsWith('spec')))
    // The trace names each spec step and the wait in Japanese, under the run.
    const trace = deriveTrace({
      run: {
        status: 'waiting',
        createdAt: iso(0),
        startedAt: iso(0),
        completedAt: null,
        leaseGeneration: 1,
      },
      diagnosisKind: 'spec-approval',
      conclusion: null,
      attempts: specSteps,
      waits: [wait('spec-wait:1', 13, null)],
      reviews: [],
      candidate: null,
      specRounds: [
        {
          round: 1,
          sequence: 1,
          candidate: null,
          reviews: [
            {
              lens: 'tech',
              decision: 'needsChanges',
              notes: 'a gap',
              findings: null,
            },
          ],
        },
      ],
      stepOutputs: {},
      now: t0 + 20_000,
    })
    assert.deepEqual(
      trace.root.children.map((c) => [c.label, c.state]),
      [
        ['準備', 'done'],
        ['事前確認', 'done'],
        ['仕様の作成', 'done'],
        ['仕様レビュー tech 1回目', 'done'],
        ['仕様の修正 1回目', 'done'],
        ['仕様レビュー tech 2回目', 'done'],
        ['仕様の判断 1回目', 'waiting'],
      ],
    )
    assert.equal(trace.root.children[3]?.review?.decision, 'needsChanges')
    assert.equal(KIND_TEXT_OK(diagnosisText({ kind: 'spec-approval' })), true)
    assert.notEqual(
      diagnosisText({ kind: 'spec-approval' }),
      diagnosisText({ kind: 'approval' }),
    )
    assert.match(
      diagnosisText({ kind: 'decided', decision: 'revise' }),
      /^仕様を直すメモを記録済み/,
    )
    assert.equal(roleName('spec-review:tech'), '仕様レビュー tech')
    assert.equal(stageName('spec'), '仕様')
    assert.equal(stageName('spec-review'), '仕様レビュー')
  })

  it('(c) shows triage only for a run with triage, and the running stage', () => {
    const attempts = [
      step('setup', 0, 1),
      step('triage', 1, 5),
      step('stage:0:code:agent', 5, null),
    ]
    const p = derivePipeline({
      status: 'leased',
      diagnosisKind: 'running',
      live: { stage: 'code' },
      report: report(
        attempts,
        [],
        ['code', 'correctness', 'edge-cases', 'triage'],
      ),
    })
    assert.deepEqual(stagesOf(p), [
      ['setup', 'done', 1],
      ['triage', 'done', 1],
      ['code', 'running', 1],
      ['verify', 'not-reached', 0],
      ['review', 'not-reached', 0],
      ['approve', 'not-reached', 0],
      ['finish', 'not-reached', 0],
    ])
    assert.equal(p.label, '工程: いまは実装を実行中')
    // A triage profile alone is enough to show the stage, not yet reached.
    const queued = derivePipeline({
      status: 'pending',
      diagnosisKind: 'pending',
      live: null,
      report: report([], [], ['code', 'triage']),
    })
    assert.deepEqual(stagesOf(queued).slice(0, 2), [
      ['setup', 'current', 0],
      ['triage', 'not-reached', 0],
    ])
  })

  const traceOf = (
    attempts: AttemptRow[],
    waits: ReturnType<typeof wait>[],
    run: Partial<TraceInput['run']> & { status: string },
    extra: Partial<TraceInput> = {},
  ) =>
    deriveTrace({
      run: {
        createdAt: iso(0),
        startedAt: iso(0),
        completedAt: null,
        leaseGeneration: 1,
        ...run,
      },
      // A leased run is running unless a test says its lease ran out.
      diagnosisKind: run.status === 'leased' ? 'running' : 'pending',
      conclusion: null,
      attempts,
      waits,
      reviews: [],
      candidate: null,
      stepOutputs: {},
      now: t0 + 60_000,
      ...extra,
    })
  /** [label, state, startMs, endMs, open] of each row, children nested. */
  const shape = (n: TraceNode): unknown[] => [
    n.label,
    n.state,
    n.startMs,
    n.endMs,
    n.open,
    ...(n.children.length > 0 ? [n.children.map(shape)] : []),
  ]

  it('trace (a) nests a repair as two iterations, with parallel reviews and the open wait running to now', () => {
    const t = traceOf(
      repaired,
      [approval],
      { status: 'waiting' },
      {
        reviews: [
          {
            lens: 'correctness',
            decision: 'pass',
            notes: 'ok',
            findings: null,
          },
          {
            lens: 'edge-cases',
            decision: 'pass',
            notes: 'fine',
            findings: null,
          },
        ],
        candidate: { id: 'cand-2', branch: null, commit: null },
      },
    )
    assert.equal(t.startedAt, iso(0))
    assert.equal(t.spanMs, 60_000)
    assert.equal(t.open, true)
    assert.deepEqual(shape(t.root), [
      '実行全体',
      'waiting',
      0,
      60_000,
      true,
      [
        ['準備', 'done', 0, 1000, false],
        [
          '1回目',
          'done',
          1000,
          15_000,
          false,
          [
            ['実装', 'done', 1000, 11_000, false],
            ['検証', 'done', 11_000, 15_000, false],
          ],
        ],
        [
          '2回目',
          'waiting',
          15_000,
          60_000,
          true,
          [
            ['実装', 'done', 15_000, 31_000, false],
            ['検証', 'done', 31_000, 35_000, false],
            ['正しさのレビュー', 'done', 35_000, 50_000, false],
            ['境界条件のレビュー', 'done', 35_000, 45_000, false],
            ['承認', 'waiting', 51_000, 60_000, true],
          ],
        ],
      ],
    ])
    const second = t.root.children[2]
    assert.ok(second)
    const [code, , correctness, , approve] = second.children
    // The last round's verdicts and candidate come from the report.
    assert.equal(correctness?.review?.notes, 'ok')
    assert.equal(code?.candidate?.id, 'cand-2')
    assert.equal(t.root.children[1]?.children[0]?.candidate, null)
    assert.equal(approve?.durationMs, 9000)
    assert.deepEqual(approve?.wait, {
      outcome: null,
      inputWaitMs: null,
      executionSlotWaitMs: null,
    })
    // Ids stay the same from one refresh to the next.
    assert.deepEqual(
      second.children.map((c) => c.id),
      [
        'entry:code#2',
        'entry:verify#3',
        'entry:review:correctness#4',
        'entry:review:edge-cases#4',
        'entry:approve#5',
      ],
    )
  })

  it('trace (b) marks the verify that failed in a verification-failed run', () => {
    const failedCheck = {
      ...step('stage:3:verify:acceptance', 31, 35),
      measurement: { result: 'fail', usageScope: null } as never,
    }
    const t = traceOf(
      [
        step('setup', 0, 1),
        step('stage:0:code:agent', 1, 10),
        {
          ...step('stage:1:verify:acceptance', 11, 15),
          measurement: { result: 'fail', usageScope: null } as never,
        },
        step('stage:2:code:agent', 15, 30),
        failedCheck,
        step('stage:4:stop:result', 35, 36),
      ],
      [],
      { status: 'completed', completedAt: iso(36) },
      { conclusion: 'verification-failed' },
    )
    assert.equal(t.open, false)
    assert.equal(t.spanMs, 36_000)
    assert.equal(t.root.state, 'failed')
    const [, first, last] = t.root.children
    assert.deepEqual(
      last?.children.map((c) => [c.label, c.state, c.checkpoint]),
      [
        ['実装', 'done', null],
        ['検証', 'failed', 'completed'],
        ['停止', 'done', null],
      ],
    )
    assert.equal(last?.state, 'failed')
    // The earlier iteration's failed check is on its row, not on the iteration.
    assert.equal(first?.state, 'done')
    assert.equal(first?.children[1]?.state, 'failed')
  })

  it('trace (c) lists an attempt retried across lease generations as child attempts', () => {
    const t = traceOf(
      [
        step('stage:0:code:agent', 1, null, 'started', 1),
        step('stage:0:code:agent', 20, 25, 'completed', 2),
        step('stage:0:code:candidate', 25, 26, 'completed', 2),
        step('stage:1:verify:acceptance', 26, null, 'started', 2),
      ],
      [],
      { status: 'leased', leaseGeneration: 2 },
    )
    const [code, verify] = t.root.children[0]?.children ?? []
    assert.ok(code && verify)
    assert.equal(code.state, 'done')
    assert.equal(code.attempts, 3)
    assert.deepEqual(
      code.children.map((c) => [
        c.label,
        c.kind,
        c.state,
        c.leaseGeneration,
        c.startMs,
        c.endMs,
      ]),
      [
        // The lost worker's attempt has no end: unknown, never `now`.
        ['エージェント 試行 1', 'attempt', 'lost', 1, 1000, null],
        ['エージェント 試行 2', 'attempt', 'done', 2, 20_000, 25_000],
        ['候補の記録 試行 1', 'attempt', 'done', 2, 25_000, 26_000],
      ],
    )
    assert.deepEqual([code.startMs, code.endMs], [1000, 26_000])
    // One attempt each: no child rows. The current generation runs to now.
    assert.deepEqual(verify.children, [])
    assert.deepEqual(
      [verify.state, verify.open, verify.endMs],
      ['running', true, 60_000],
    )
    assert.equal(t.root.children[0]?.state, 'running')
    // A finished run's open attempt is not running.
    const done = traceOf(
      [step('stage:0:code:agent', 1, null, 'started', 1)],
      [],
      { status: 'failed', completedAt: iso(5) },
    )
    assert.deepEqual(shape(done.root.children[0]?.children[0] as TraceNode), [
      '実装',
      'interrupted',
      1000,
      null,
      false,
    ])
    // Nothing has run yet: only the run row, from creation to now.
    const queued = traceOf([], [], {
      status: 'pending',
      startedAt: null,
      leaseGeneration: 0,
    })
    assert.deepEqual(shape(queued.root), ['実行全体', 'idle', 0, 60_000, true])
  })

  it('trace (e) never shows an attempt under an expired lease as running', () => {
    const attempts = [step('setup', 0, 1), step('stage:0:code:agent', 1, null)]
    const live = traceOf(attempts, [], { status: 'leased' })
    assert.equal(live.root.children[1]?.children[0]?.state, 'running')
    // The same attempt once `diagnose` says the lease ran out: no worker
    // holds it and its end is unknown.
    const lost = traceOf(
      attempts,
      [],
      { status: 'leased' },
      { diagnosisKind: 'lease-expired' },
    )
    const code = lost.root.children[1]?.children[0]
    assert.deepEqual(shape(code as TraceNode), [
      '実装',
      'lost',
      1000,
      null,
      false,
    ])
    assert.equal(lost.root.children[1]?.state, 'lost')
    assert.equal(lost.root.state, 'lost')
    // A reclaimed run back in the queue has no running attempt either.
    const queued = traceOf(attempts, [], { status: 'pending' })
    assert.equal(queued.root.children[1]?.children[0]?.state, 'lost')
  })

  it('trace (f) shows no earlier candidate or verdict on a repair still at work', () => {
    const t = traceOf(
      [
        step('setup', 0, 1),
        step('stage:0:code:agent', 1, 10),
        step('stage:0:code:candidate', 10, 11),
        step('stage:1:verify:acceptance', 11, 15),
        step('stage:2:review:correctness', 15, 20),
        step('stage:2:review:edge-cases', 15, 20),
        step('stage:3:code:agent', 21, null),
      ],
      [],
      { status: 'leased' },
      {
        // What the report holds for an open run: the previous round's.
        candidate: { id: 'cand-1', branch: 'b1', commit: 'c1' },
        reviews: [
          {
            lens: 'correctness',
            decision: 'needsChanges',
            notes: 'x',
            findings: null,
          },
        ],
        stepOutputs: {
          'stage:0:code:candidate': {
            id: 'cand-1',
            branch: 'b1',
            commit: 'c1',
          },
        },
      },
    )
    const [first, second] = t.root.children.slice(1)
    assert.equal(first?.children[0]?.candidate?.id, 'cand-1')
    const repair = second?.children[0]
    assert.equal(repair?.state, 'running')
    assert.equal(repair?.candidate, null)
    // The same for a review round still at work.
    const reviewing = traceOf(
      [
        step('stage:0:code:agent', 1, 10),
        step('stage:1:verify:acceptance', 11, 15),
        step('stage:2:review:correctness', 15, null),
      ],
      [],
      { status: 'leased' },
      {
        reviews: [
          {
            lens: 'correctness',
            decision: 'needsChanges',
            notes: 'x',
            findings: null,
          },
        ],
      },
    )
    assert.equal(reviewing.root.children[0]?.children[2]?.review, null)
    // The repair's agent step is done but its candidate step has not begun:
    // the entry has sealed nothing, so neither the report's candidate nor the
    // earlier iteration's is shown on it.
    const unsealed = traceOf(
      [
        step('stage:0:code:agent', 1, 10),
        step('stage:0:code:candidate', 10, 11),
        step('stage:1:verify:acceptance', 11, 15),
        step('stage:2:code:agent', 15, 30),
      ],
      [],
      { status: 'leased' },
      {
        candidate: { id: 'cand-1', branch: 'b1', commit: 'c1' },
        stepOutputs: {
          'stage:0:code:candidate': {
            id: 'cand-1',
            branch: 'b1',
            commit: 'c1',
          },
        },
      },
    )
    const [before, after] = unsealed.root.children
    assert.equal(before?.children[0]?.candidate?.id, 'cand-1')
    assert.equal(after?.children[0]?.state, 'done')
    assert.equal(after?.children[0]?.candidate, null)
    // Once its own candidate step completes, the entry shows that candidate.
    const sealedNow = traceOf(
      [
        step('stage:0:code:agent', 1, 10),
        step('stage:0:code:candidate', 10, 11),
        step('stage:1:verify:acceptance', 11, 15),
        step('stage:2:code:agent', 15, 30),
        step('stage:2:code:candidate', 30, 31),
      ],
      [],
      { status: 'leased' },
      {
        candidate: { id: 'cand-2', branch: 'b2', commit: 'c2' },
        stepOutputs: {
          'stage:0:code:candidate': {
            id: 'cand-1',
            branch: 'b1',
            commit: 'c1',
          },
          'stage:2:code:candidate': {
            id: 'cand-2',
            branch: 'b2',
            commit: 'c2',
          },
        },
      },
    )
    assert.equal(
      sealedNow.root.children[1]?.children[0]?.candidate?.id,
      'cand-2',
    )
  })

  it('trace (g) shows each review round, candidate size and check log from the report', () => {
    const log = (n: number, exitCode: number | null) => ({
      stdoutPath: `/runs/r1/verification-logs/cand-${n}/a/stdout.log`,
      stderrPath: `/runs/r1/verification-logs/cand-${n}/a/stderr.log`,
      exitCode,
    })
    const graded = (
      name: string,
      start: number,
      end: number,
      verificationLog: ReturnType<typeof log>,
    ): AttemptRow => ({
      ...step(name, start, end),
      attemptId: `${name}@${start}`,
      measurement: {
        result: verificationLog.exitCode === 0 ? 'pass' : 'fail',
        verificationLog,
      } as never,
    })
    const changes = (files: number) => ({
      files,
      additions: files * 3,
      deletions: files,
      diffPath: `/runs/r1/candidates/cand-${files}/changes.diff`,
      changedFilesPath: `/runs/r1/candidates/cand-${files}/changed-files.txt`,
    })
    const verdict = (lens: string, decision: string, notes: string) => ({
      lens,
      decision,
      notes,
      findings: null,
    })
    const t = traceOf(
      [
        step('stage:0:code:agent', 1, 10),
        step('stage:0:code:candidate', 10, 11),
        graded('stage:1:verify:acceptance', 11, 15, log(1, 0)),
        step('stage:2:review:correctness', 15, 20),
        step('stage:2:review:edge-cases', 15, 20),
        step('stage:3:code:agent', 21, 30),
        step('stage:3:code:candidate', 30, 31),
        graded('stage:4:verify:acceptance', 31, 35, log(2, 1)),
        graded('stage:4:verify:acceptance', 36, 40, log(2, null)),
      ],
      [],
      { status: 'completed', completedAt: iso(41) },
      {
        // Only the report says what each round decided; no step outputs.
        reviews: [],
        reviewRounds: [
          {
            round: 1,
            sequence: 2,
            candidate: null,
            reviews: [
              verdict('correctness', 'needsChanges', 'round one fix'),
              verdict('edge-cases', 'pass', 'round one ok'),
            ],
          },
        ],
        candidates: [
          {
            id: 'cand-1',
            branch: 'b',
            commit: 'c1',
            changes: changes(0),
            iteration: 1,
            sequence: 0,
          },
          {
            id: 'cand-2',
            branch: 'b',
            commit: 'c2',
            changes: changes(2),
            iteration: 2,
            sequence: 3,
          },
        ],
      },
    )
    const [first, second] = t.root.children
    const [code1, verify1, correctness, edgeCases] = first?.children ?? []
    assert.deepEqual(code1?.candidate?.changes, changes(0))
    assert.deepEqual(verify1?.verificationLog, log(1, 0))
    assert.equal(correctness?.review?.notes, 'round one fix')
    assert.equal(edgeCases?.review?.decision, 'pass')
    const [code2, verify2] = second?.children ?? []
    assert.deepEqual(code2?.candidate?.changes, changes(2))
    // A retried verification: the entry shows its latest attempt's log, and
    // each attempt row its own.
    assert.deepEqual(verify2?.verificationLog, log(2, null))
    assert.deepEqual(
      verify2?.children.map((c) => c.verificationLog),
      [log(2, 1), log(2, null)],
    )
    // Rows that are not verifications carry no check log.
    assert.equal(code2?.verificationLog, null)
  })

  it('trace (h) keeps the findings a review step stored, and none from an older step', () => {
    const findings = {
      blocker: [
        {
          severity: 'blocker',
          title: 'wrong sum',
          body: 'add() truncates',
          file: 'src/calc.js',
          line: 2,
        },
      ],
      nonBlocker: [],
      counts: { blocker: 1, nonBlocker: 0 },
    }
    const t = traceOf(
      [
        step('stage:0:code:agent', 1, 10),
        step('stage:1:verify:acceptance', 10, 15),
        step('stage:2:review:correctness', 15, 20),
        step('stage:2:review:edge-cases', 15, 20),
      ],
      [],
      { status: 'leased' },
      {
        // Read straight from the review steps: one kept findings, one was
        // recorded before findings were kept.
        stepOutputs: {
          'stage:2:review:correctness': {
            lens: 'correctness',
            decision: 'needsChanges',
            notes: '- [src/calc.js:2] wrong sum — add() truncates',
            findings,
          },
          'stage:2:review:edge-cases': {
            lens: 'edge-cases',
            decision: 'pass',
            notes: 'fine',
          },
        },
      },
    )
    const [, , correctness, edgeCases] = t.root.children[0]?.children ?? []
    assert.deepEqual(correctness?.review?.findings, findings)
    assert.equal(
      correctness?.review?.notes.startsWith('- [src/calc.js:2]'),
      true,
    )
    assert.equal(edgeCases?.review?.findings, null)
    assert.equal(edgeCases?.review?.notes, 'fine')
  })

  it('trace (d) sums per-row tokens and cost to the report stage totals', () => {
    const measured = (
      name: string,
      start: number,
      invocationId: string,
      tokens: number | null,
      cost: number | null,
      leaseGeneration = 1,
    ): AttemptRow => ({
      ...step(name, start, start + 5, 'completed', leaseGeneration),
      attemptId: `${name}@${start}@${leaseGeneration}`,
      measurement: {
        invocationId,
        usageScope: 'invocation',
        provider: 'codex',
        effectiveModel: 'gpt-x',
        effectiveEffort: 'high',
        reportedModel: null,
        result: 'implement-done',
        usage:
          tokens === null
            ? null
            : {
                inputTokens: tokens,
                cachedInputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                outputTokens: 10,
                totalTokens: tokens + 10,
                usageSource: 'provider-final',
              },
        costUsdEstimate: cost,
      } as never,
    })
    const attempts = [
      measured('stage:0:code:agent', 1, 'i1', 100, 0.001),
      // A recovery attempt re-reads invocation i1: no new tokens.
      measured('stage:0:code:agent', 7, 'i1', 100, 0.001, 2),
      measured('stage:2:code:agent', 20, 'i2', 200, 0.002, 2),
      measured('stage:4:review:correctness', 40, 'i3', 300, 0.003, 2),
      measured('stage:4:review:edge-cases', 40, 'i4', 400, 0.004, 2),
    ]
    const t = traceOf(attempts, [], { status: 'leased', leaseGeneration: 2 })
    const entries = t.root.children.flatMap((it) => it.children)
    const expected = stageUsage(attempts)
    for (const stage of expected) {
      const rows = entries.filter((e) => e.stage === stage.stage)
      const sum = (pick: (u: UsageTotals) => number | null) =>
        rows.reduce((s, r) => s + (r.usage ? (pick(r.usage) ?? 0) : 0), 0)
      assert.equal(
        sum((u) => u.totalTokens),
        stage.totalTokens,
        stage.stage,
      )
      assert.equal(
        sum((u) => u.inputTokens),
        stage.inputTokens,
        stage.stage,
      )
      assert.ok(
        Math.abs(sum((u) => u.costUsd) - (stage.costUsd ?? NaN)) < 1e-12,
        stage.stage,
      )
      assert.equal(
        rows.reduce((s, r) => s + (r.usage?.invocations ?? 0), 0),
        stage.invocations,
      )
    }
    assert.equal(t.root.usage?.totalTokens, 1040)
    assert.deepEqual(entries[0]?.profile, {
      provider: 'codex',
      model: 'gpt-x',
      effort: 'high',
      reportedModel: null,
    })
    // A row whose call reported no usage is unknown, never zero.
    const unknown = traceOf(
      [measured('stage:0:code:agent', 1, 'i9', null, null)],
      [],
      { status: 'leased' },
    )
    const row = unknown.root.children[0]?.children[0]
    assert.equal(row?.usage?.totalTokens, null)
    assert.equal(row?.usage?.costUsd, null)
    assert.equal(row?.usage?.complete, false)
  })
})

describe('reads per poll', () => {
  const counting = () => {
    const calls: string[] = []
    const read =
      (name: string) =>
      async (...args: unknown[]) => {
        calls.push(`${name}:${args.join(':')}`)
        return name === 'getRun' ? null : []
      }
    const db = {
      getRun: read('getRun'),
      getStepAttempts: read('getStepAttempts'),
      getWaits: read('getWaits'),
      getRuns: read('getRuns'),
      storage: {
        getSteps: read('getSteps'),
        getCompletedStep: read('getCompletedStep'),
      },
    } as unknown as ReportSource
    return { db, calls }
  }

  it('makes each read once per request, however many readers ask', async () => {
    const { db, calls } = counting()
    const src = readOnce(db)
    await Promise.all([src.storage.getSteps('r1'), src.storage.getSteps('r1')])
    await src.storage.getCompletedStep('r1', 'setup')
    await src.storage.getCompletedStep('r1', 'setup')
    await src.storage.getCompletedStep('r1', 'triage')
    await src.getStepAttempts('r1')
    await src.getStepAttempts('r2')
    assert.deepEqual(calls, [
      'getSteps:r1',
      'getCompletedStep:r1:setup',
      'getCompletedStep:r1:triage',
      'getStepAttempts:r1',
      'getStepAttempts:r2',
    ])
    // A new request reads again.
    await readOnce(db).storage.getSteps('r1')
    assert.equal(calls.filter((c) => c === 'getSteps:r1').length, 2)
  })

  it("builds a completed run's report once, and any other run's every time", async () => {
    const built: string[] = []
    const cache = finishedReportCache(async (_src, id) => {
      built.push(id)
      return { runId: id } as LoopReport
    })
    const { db } = counting()
    const done = {
      id: 'done',
      jobName: 'local-factory.v2',
      status: 'completed' as const,
      updatedAt: 't1',
      input: {},
      output: null,
      error: null,
    }
    const open = { ...done, id: 'open', status: 'leased' as const }
    for (let i = 0; i < 3; i++) {
      await cache.get(db, done)
      await cache.get(db, open)
    }
    assert.deepEqual(built, ['done', 'open', 'open', 'open'])
    assert.equal((await cache.get(db, done)).fresh, false)
    // A changed row, or a run deleted and seen again, is built anew.
    await cache.get(db, { ...done, updatedAt: 't2' })
    cache.keep([])
    await cache.get(db, { ...done, updatedAt: 't2' })
    assert.deepEqual(built.slice(4), ['done', 'done'])
    // A failed or cancelled run's failure reads checkpoint files, which can
    // change after it stops: its report is built once, but every hit
    // classifies the failure again.
    built.length = 0
    for (const status of ['failed', 'cancelled'] as const) {
      const stopped = {
        id: status,
        jobName: 'local-factory.v2',
        status,
        updatedAt: 't1',
        input: {},
        output: null,
        error: null,
      }
      await cache.get(db, stopped)
      const hit = await cache.get(db, stopped)
      assert.equal(hit.fresh, true)
      assert.ok('failure' in hit.report)
    }
    assert.deepEqual(built, ['failed', 'cancelled'])
  })

  it("checks a reused baseline's source log again on every hit", async () => {
    const root = await mkdtemp(join(tmpdir(), 'ui-reused-log-'))
    const log = {
      stdoutPath: join(root, 'stdout.log'),
      stderrPath: join(root, 'stderr.log'),
      exitCode: 0,
    }
    await writeFile(log.stdoutPath, 'ok\n')
    await writeFile(log.stderrPath, '')
    const output = {
      passed: true,
      stdout: 'ok',
      exitCode: 0,
      log,
      source: 'reused',
      reusedFrom: { runId: 'source', checkedAt: 't0', recovered: false },
    }
    const db = {
      getRuns: async () => [],
      storage: {
        getCompletedStep: async (_id: string, name: string) =>
          name === 'baseline' ? { output } : null,
      },
    } as unknown as ReportSource
    const cache = finishedReportCache(
      async (_src, id) =>
        ({
          runId: id,
          lineage: { parent: null, children: [] },
          baseline: reusedBaselineOf(output),
        }) as unknown as LoopReport,
    )
    const run = {
      id: 'reusing',
      jobName: 'local-factory.v2',
      status: 'completed' as const,
      updatedAt: 't1',
      input: {},
      output: null,
      error: null,
    }
    assert.equal((await cache.get(db, run)).report.baseline?.logMissing, null)
    await rm(log.stderrPath)
    const hit = await cache.get(db, run)
    assert.equal(hit.fresh, false)
    assert.equal(hit.report.baseline?.log, null)
    assert.match(hit.report.baseline?.logMissing ?? '', /no longer at/)
  })

  it('groups repair children by their label, or by their input without one, oldest first', () => {
    const at = (s: number) => new Date(s * 1000).toISOString()
    const byParent = repairChildrenByParent([
      { id: 'late', createdAt: at(3), labels: { repairOf: 'p' }, input: {} },
      {
        id: 'unlabelled',
        createdAt: at(2),
        labels: {},
        input: { repairOf: { runId: 'p' } },
      },
      { id: 'early', createdAt: at(1), labels: { repairOf: 'p' }, input: {} },
      { id: 'p', createdAt: at(0), labels: {}, input: {} },
    ])
    assert.deepEqual(byParent.get('p'), ['early', 'unlabelled', 'late'])
    assert.equal(byParent.has('early'), false)
  })

  it("reads a finished run's repair children again on every hit", async () => {
    let runs: { id: string; createdAt: string; input: unknown }[] = []
    const filters: unknown[] = []
    // Children are asked for by their label, never by scanning every run.
    const db = {
      getRuns: async (filter?: { labels?: Record<string, string> }) => {
        filters.push(filter)
        return filter?.labels?.['repairOf'] === 'parent' ? runs : []
      },
    } as unknown as ReportSource
    const cache = finishedReportCache(
      async (_src, id) =>
        ({
          runId: id,
          lineage: { parent: null, children: [] },
        }) as unknown as LoopReport,
    )
    const parent = {
      id: 'parent',
      jobName: 'local-factory.v2',
      status: 'completed' as const,
      updatedAt: 't1',
      input: {},
      output: null,
      error: null,
    }
    await cache.get(db, parent)
    // A child added after the parent finished leaves the parent's row as it
    // was, so only a fresh read of the children can show it.
    runs = [
      {
        id: 'child',
        createdAt: '2026-01-01T00:00:00Z',
        input: { repairOf: { runId: 'parent' } },
      },
    ]
    const hit = await cache.get(db, parent)
    assert.equal(hit.fresh, false)
    assert.deepEqual(hit.report.lineage.children, ['child'])
    assert.deepEqual(filters.at(-1), {
      jobName: 'local-factory.v2',
      labels: { repairOf: 'parent' },
    })
  })
})

describe('diagnosis wording on the page', () => {
  const kinds: DiagnosisKind[] = [
    'pending',
    'running',
    'lease-expired',
    'approval',
    'spec-approval',
    'decided',
    'other-wait',
    'finished',
  ]
  const failures: FailureKind[] = [
    'baseline-check-failed',
    'spec-check-failed',
    'preflight-failed',
    'candidate-moved',
    'rejected-invocation',
    'verification-failed',
    'review-cap-reached',
    'uncertain-invocation',
    'cancelled',
    'cancelled-publish',
    'unclassified',
  ]
  // What the brief allows in a sentence: Japanese, an option to type, and a
  // file name.
  const plain = (text: string) =>
    text.replace(/--[a-z][a-z-]*|factory\.json/g, '').match(/[A-Za-z()（）]/g)

  it('says every state and stop in Japanese, without IDs or asides', () => {
    for (const kind of kinds)
      for (const uncertain of [false, true]) {
        const text = diagnosisText({ kind }, uncertain)
        assert.ok(text.length > 0, kind)
        assert.equal(plain(text), null, `${kind}: ${text}`)
      }
    for (const kind of failures) {
      const failure = { kind } as FailureClassification
      const text = diagnosisText({ kind: 'stopped', failure })
      assert.equal(plain(text), null, `${kind}: ${text}`)
      assert.equal(plain(humanCheckText(kind)), null, kind)
    }
    assert.notEqual(
      diagnosisText({ kind: 'lease-expired' }, true),
      diagnosisText({ kind: 'lease-expired' }, false),
    )
  })

  it('tells a baseline stop to fix the check command or the environment', () => {
    assert.match(
      humanCheckText('baseline-check-failed'),
      /採点コマンドか環境を直す/,
    )
    assert.match(
      diagnosisText({
        kind: 'stopped',
        failure: { kind: 'baseline-check-failed' } as FailureClassification,
      }),
      /エージェントを呼ぶ前に/,
    )
    assert.match(
      humanCheckText('baseline-check-failed', { setupUntracked: true }),
      /準備のコマンドが \.gitignore にないファイルを作っている[\s\S]*baselineCheck を外/,
    )
    assert.match(humanCheckText('preflight-failed'), /役割の設定/)
    // A config fix is retried with the settings read again.
    for (const kind of ['baseline-check-failed', 'preflight-failed'] as const)
      assert.match(humanCheckText(kind), /設定を読み直す再実行/)
  })

  it('offers the config reload only where factory.json decides the setting', () => {
    const stop = (reload: ReturnType<typeof reloadAdvice>) =>
      classifyFailure({
        runId: 'r1',
        status: 'failed',
        output: null,
        error: 'preflight-failed: code is not usable',
        uncertain: [],
        reload,
      })
    // The bundled sample reads no factory.json: no reload, no config advice.
    const bundled = { target: { kind: 'subject' } }
    assert.equal(reloadAdvice(bundled), 'none')
    const sample = stop('none')
    assert.ok(!sample?.next.some((c) => c.includes('--reload-config')))
    assert.ok(sample?.next.some((c) => c.includes('retrigger --run r1')))
    assert.doesNotMatch(sample?.humanCheck ?? '', /factory\.json/)
    const sampleText = humanCheckText('preflight-failed', sample ?? undefined)
    assert.doesNotMatch(sampleText, /factory\.json|設定を読み直す/)
    assert.equal(plain(sampleText.replace(/trigger/g, '')), null, sampleText)

    const repo = { target: { kind: 'repo' }, configSource: { flags: {} } }
    assert.equal(reloadAdvice(repo), 'config')
    const reloadLine = (r: FailureClassification | null) =>
      r?.next.find((c) => c.includes('--reload-config')) ?? ''
    assert.match(
      commandNote(reloadLine(stop('config'))) ?? '',
      /^factory\.json を直してから/,
    )

    // A check, setup or base given as a flag wins over factory.json.
    for (const flag of ['check', 'setup', 'base']) {
      const flagged = { ...repo, configSource: { flags: { [flag]: 'x' } } }
      assert.equal(reloadAdvice(flagged), 'flags-win', flag)
    }
    assert.equal(
      reloadAdvice({ ...repo, configSource: { flags: { provider: 'fake' } } }),
      'config',
    )
    const flagged = reloadLine(stop('flags-win'))
    assert.match(flagged, /--check, --setup or --base given at trigger/)
    assert.match(commandNote(flagged) ?? '', /優先されるので/)
  })

  it('tells a refused call to fix the setting first, then retry with the settings read again', () => {
    const stop = (reload: ReturnType<typeof reloadAdvice>) =>
      classifyFailure({
        runId: 'r1',
        status: 'failed',
        output: null,
        error:
          'rejected-invocation: the repair call (codex gpt-5.6-sol) was refused: 401: login expired',
        uncertain: [],
        reload,
      })
    const repo = stop('config')
    assert.equal(repo?.kind, 'rejected-invocation')
    assert.match(
      diagnosisText({ kind: 'stopped', failure: repo ?? undefined }),
      /はっきり断りました/,
    )
    const check = humanCheckText('rejected-invocation', repo ?? undefined)
    assert.match(check, /^下の拒否の理由を読み/)
    assert.match(check, /設定を読み直す再実行/)
    // The refusal is data under its own label.
    assert.deepEqual(detailField('refusal: 401: login expired'), {
      label: '拒否の理由',
      value: '401: login expired',
    })
    // The next commands, each explained in Japanese.
    const reload = repo?.next.find((c) => c.includes('--reload-config')) ?? ''
    assert.match(commandNote(reload) ?? '', /^factory\.json を直してから/)
    const report = repo?.next.find((c) => c.includes(' report ')) ?? ''
    assert.match(commandNote(report) ?? '', /断られた呼び出し/)
    // A run with no factory.json is told to trigger anew instead.
    const sample = stop('none')
    assert.ok(!sample?.next.some((c) => c.includes('--reload-config')))
    const sampleText = humanCheckText(
      'rejected-invocation',
      sample ?? undefined,
    )
    assert.doesNotMatch(sampleText, /factory\.json|設定を読み直す/)
    assert.equal(plain(sampleText.replace(/trigger/g, '')), null, sampleText)
  })

  it('never tells a repair run to reload a config it does not read', () => {
    const child = {
      target: { kind: 'repo' },
      configSource: { flags: {} },
      repairOf: { runId: 'parent' },
    }
    assert.equal(reloadAdvice(child), 'none')
    const stop = (error: string) =>
      classifyFailure({
        runId: 'r1',
        status: 'failed',
        output: null,
        error,
        uncertain: [],
        reload: reloadAdvice(child),
      })
    for (const error of [
      'baseline-check-failed: `true` failed on the base commit',
      'baseline-check-failed: setup-untracked: setup left untracked files that .gitignore does not cover in /w, first ["a"]; stopped before the baseline check and any agent call',
    ]) {
      const failure = stop(error)
      assert.equal(failure?.kind, 'baseline-check-failed')
      assert.doesNotMatch(failure?.humanCheck ?? '', /--reload-config/)
      assert.match(failure?.humanCheck ?? '', /start a normal run with trigger/)
      assert.ok(!failure?.next.some((c) => c.includes('--reload-config')))
      const text = humanCheckText('baseline-check-failed', failure ?? undefined)
      assert.doesNotMatch(text, /設定を読み直す/)
      assert.match(text, /通常の実行を始める/)
      assert.equal(
        plain(text.replace(/trigger|\.gitignore|baselineCheck/g, '')),
        null,
        text,
      )
    }
    const moved = stop(
      'candidate-moved: candidate branch factory/p moved to aaaaaaaaaaaa',
    )
    assert.equal(moved?.kind, 'candidate-moved')
    assert.equal(moved?.retryable, true)
    assert.equal(stopName('candidate-moved'), '修正元の候補の変更')
  })

  it('says which decision a decided run recorded', () => {
    assert.match(
      diagnosisText({ kind: 'decided', decision: 'approved' }),
      /^承認を記録済み/,
    )
    assert.match(
      diagnosisText({ kind: 'decided', decision: 'rejected' }),
      /^却下を記録済み/,
    )
  })

  it('shows a command without its English comment, and verdicts in Japanese', () => {
    for (const line of [
      'pnpm demo worker  # if none is running',
      'pnpm demo report --run r1  # read the reviews first',
      'pnpm demo status --run r1',
    ]) {
      const shown = commandText(line)
      assert.doesNotMatch(shown, / # /, shown)
      assert.equal(shown, line.split('  # ')[0])
    }
    for (const decision of ['pass', 'needsChanges']) {
      const { label, title } = reviewDecision(decision)
      assert.equal(plain(label), null, label)
      assert.equal(plain(title), null, title)
    }
  })

  it("shows a review's findings as counts and titles in Japanese, never their body or place", () => {
    const finding = (severity: string, n: number) => ({
      severity: severity as 'blocker' | 'non-blocker',
      title: `title-${severity}-${n}`,
      body: `body-${severity}-${n}`,
      file: `src/file-${n}.js`,
      line: 40 + n,
    })
    const html = renderToStaticMarkup(
      createElement(ReviewFindingTitles, {
        findings: {
          blocker: [finding('blocker', 1), finding('blocker', 2)],
          nonBlocker: Array.from({ length: 20 }, (_, i) =>
            finding('non-blocker', i + 1),
          ),
          counts: { blocker: 2, nonBlocker: 23 },
        },
      }),
    )
    const text = html.replace(/<[^>]+>/g, '\n')
    assert.match(text, /直すべき指摘\n+ 2件/)
    assert.match(text, /助言\n+ 23件/)
    assert.match(text, /ほか3件はレポートに残していません。/)
    assert.ok(text.includes('title-blocker-2'))
    assert.ok(text.includes('title-non-blocker-20'))
    // Only one note of what was left out: every blocker was kept.
    assert.equal(text.match(/ほか/g)?.length, 1)
    for (const hidden of ['body-', 'src/file-', '41', '42'])
      assert.ok(!text.includes(hidden), hidden)
    assert.equal(plain(text.replace(/title-[a-z-]+-\d+/g, '')), null, text)
    // A verdict review, or one recorded before findings were kept, shows none.
    assert.equal(
      renderToStaticMarkup(
        createElement(ReviewFindingTitles, { findings: null }),
      ),
      '',
    )
  })

  it('calls earlier blockers fixed only after a complete, passed last round, and counts findings only', () => {
    const verdictOf = (lens: string, decision: string, round = 1) => ({
      round,
      lens,
      decision,
      line: 'notes',
    })
    const group = (titles: string[], verdicts = 0) => ({
      count: titles.length,
      titles,
      verdicts: Array.from({ length: verdicts }, (_, i) =>
        verdictOf(i === 0 ? 'correctness' : 'edge-cases', 'needsChanges'),
      ),
    })
    const text = (h: Parameters<typeof ReviewHighlightsPanel>[0]['h']) =>
      renderToStaticMarkup(createElement(ReviewHighlightsPanel, { h })).replace(
        /<[^>]+>/g,
        '\n',
      )
    const base = {
      rounds: 2,
      lastPasses: [],
      earlier: group([], 1),
      left: group(['L']),
      open: group(['O']),
    }
    const passed = text({ ...base, last: 'passed', open: group([]) })
    assert.ok(passed.includes(REVIEW.fixed))
    assert.ok(!passed.includes(REVIEW.earlier))
    // Only a verdict listed under the heading: no count, and not なし.
    assert.match(
      passed,
      new RegExp(`${REVIEW.fixed}\\n+[^件]*${REVIEW.askedFor('')}`),
    )
    assert.doesNotMatch(passed, new RegExp(`${REVIEW.fixed}\\n+\\d+件`))
    assert.match(passed, new RegExp(`${REVIEW.left}\\n+1件`))
    const incomplete = text({ ...base, last: 'incomplete' })
    assert.ok(incomplete.includes(REVIEW.incompleteLast))
    assert.ok(incomplete.includes(REVIEW.earlier))
    assert.ok(incomplete.includes(REVIEW.open))
    assert.ok(!incomplete.includes(REVIEW.fixed))
    assert.ok(!incomplete.includes(REVIEW.passedLast))
    const failed = text({ ...base, last: 'blocked' })
    assert.ok(failed.includes(REVIEW.failedLast))
    assert.ok(failed.includes(REVIEW.earlier))
  })

  it('shows a passing verdict of the last round with how it ended, not as left', () => {
    const h = {
      rounds: 2,
      last: 'passed' as const,
      lastPasses: [
        { round: 2, lens: 'correctness', decision: 'pass', line: 'ok' },
        { round: 2, lens: 'edge-cases', decision: 'pass', line: 'ok' },
      ],
      earlier: { count: 0, titles: [], verdicts: [] },
      left: { count: 0, titles: [], verdicts: [] },
      open: { count: 0, titles: [], verdicts: [] },
    }
    const html = renderToStaticMarkup(
      createElement(ReviewHighlightsPanel, { h }),
    )
    const text = html.replace(/<[^>]+>/g, '\n')
    const pass = reviewDecision('pass').label
    const status = text.indexOf(REVIEW.passedLast)
    const left = text.indexOf(REVIEW.left)
    const verdict = text.indexOf(
      `${REVIEW.roundOf(2)} ${lensName('correctness')}`,
    )
    assert.ok(status >= 0 && verdict > status && verdict < left, text)
    // Nothing was left: the heading has no count, and says なし.
    assert.match(text, new RegExp(`${REVIEW.left}\\n+${REVIEW.none}`))
    assert.doesNotMatch(text, /\d+件/)
    assert.equal(text.slice(left).includes(pass), false)
  })

  it('says the fake runs it left out when they are all the window had', () => {
    const html = renderToStaticMarkup(
      createElement(TrendScreen, {
        data: {
          days: 30,
          includeFake: false,
          weeks: [],
          runIds: [],
          fakeExcluded: 1200,
          groups: [],
        },
        onView: () => {},
      }),
    )
    assert.ok(html.includes(TREND.onlyFake('30', '1,200')), html)
    assert.ok(!html.includes(TREND.empty('30')))
  })

  it('says in Japanese where the baseline verdict came from, and which run a reused one is from', () => {
    const now = '2026-09-27T12:00:00.000Z'
    const runId = '01REUSEDFROMRUN000000ABCDEF'
    const base = {
      passed: true,
      exitCode: 0,
      log: null,
      recovered: false,
      logMissing: null,
    }
    const reusedFrom = {
      reusedFrom: { runId, checkedAt: '2026-09-27T11:55:00.000Z' },
    }
    const render = (
      baseline: LoopReport['baseline'],
      source: RunRef | null = null,
    ) =>
      renderToStaticMarkup(
        createElement(BaselineSource, { baseline, source, now }),
      )

    // Named case: the source run's task name is the primary link text.
    const sourceName = '検証手順の見直し'
    const named = render(
      { ...base, ...reusedFrom },
      { id: runId, name: sourceName },
    )
    const namedText = named.replace(/<[^>]+>/g, '\n')
    assert.match(namedText, /前の実行の結果を再利用しました/)
    assert.match(namedText, /再利用元/)
    assert.match(namedText, /検証日時/)
    // The source run is a link by its task name, its ID only as a short
    // suffix, not the generic "前の実行" label.
    assert.ok(named.includes(`href="#/runs/${runId}"`))
    assert.ok(namedText.includes(sourceName))
    const namedLinkText = /<a href="#\/runs\/[^"]+"[^>]*>([^<]+)<\/a>/.exec(
      named,
    )?.[1]
    assert.equal(namedLinkText, sourceName)
    assert.ok(!namedText.includes(runId))
    assert.ok(named.includes('dateTime="2026-09-27T11:55:00.000Z"'))
    assert.ok(!namedText.includes('ログは残っていません'))
    assert.equal(
      plain(namedText.replace(/…[0-9A-Z]{6}/g, '').replace(sourceName, '')),
      null,
      namedText,
    )

    // Fallback case: the source run no longer exists, so there is no name.
    const reused = render({ ...base, ...reusedFrom }, null)
    const text = reused.replace(/<[^>]+>/g, '\n')
    assert.match(text, /前の実行の結果を再利用しました/)
    assert.match(text, /再利用元/)
    assert.match(text, /検証日時/)
    assert.ok(reused.includes(`href="#/runs/${runId}"`))
    assert.ok(text.includes('前の実行'))
    assert.ok(!text.includes(runId))
    assert.ok(reused.includes('dateTime="2026-09-27T11:55:00.000Z"'))
    assert.ok(!text.includes('ログは残っていません'))
    assert.equal(plain(text.replace(/…[0-9A-Z]{6}/g, '')), null, text)

    const gone = render(
      {
        ...base,
        log: null,
        ...reusedFrom,
        logMissing: 'the log is gone',
      },
      { id: runId, name: sourceName },
    ).replace(/<[^>]+>/g, '\n')
    assert.match(gone, /再利用元のログは残っていません/)
    assert.ok(!gone.includes('the log is gone'))

    // Measured here, or a record from before reuse existed.
    const measured = render({ ...base, reusedFrom: null }).replace(
      /<[^>]+>/g,
      '',
    )
    assert.equal(measured, 'この実行でチェックを実行しました')
    // No verdict yet, or no baseline: nothing.
    assert.equal(render({ ...base, passed: null, reusedFrom: null }), '')
    assert.equal(render(null), '')
  })

  it('shows the spec, its advice, the chosen check and each spec round in Japanese, and nothing on a run without spec stages', () => {
    const base = {
      specRounds: [
        {
          round: 1,
          sequence: 1,
          candidate: null,
          reviews: [
            {
              lens: 'tech',
              decision: 'pass',
              notes: 'fine',
              findings: null,
            },
          ],
        },
      ],
      spec: {
        content: '# Spec\n',
        sha256: 'a'.repeat(64),
        round: 1,
        blocked: true,
        advice: [
          {
            severity: 'non-blocker' as const,
            title: 'name the rule',
            body: 'b',
          },
        ],
        check: { command: ['node', 'check-ok.mjs'], notes: 'graded here' },
      },
    }
    const html = renderToStaticMarkup(
      createElement(SpecPanel, { report: base as unknown as LoopReport }),
    )
    for (const text of [
      '仕様',
      '1回目の仕様レビューで確定',
      '人の判断',
      '実装に渡した助言',
      'name the rule',
      'node check-ok.mjs',
      'graded here',
      '1回目の仕様レビュー',
      '確定した仕様を開く',
    ])
      assert.ok(html.includes(text), text)
    assert.equal(
      renderToStaticMarkup(
        createElement(SpecPanel, {
          report: { specRounds: [], spec: null } as unknown as LoopReport,
        }),
      ),
      '',
    )
  })

  it('says in Japanese what every next command the CLI annotates does', async () => {
    const sources = await Promise.all(
      ['../src/engine/failure-reasons.ts', '../src/engine/status.ts'].map((f) =>
        readFile(new URL(f, import.meta.url), 'utf8'),
      ),
    )
    const notes = [...sources.join('\n').matchAll(/ {2}# ([^`]+)`/g)].map(
      (m) => m[1] as string,
    )
    assert.ok(notes.length > 5)
    for (const note of notes) {
      // The cleanup line is shown on its own and is not a next command, and
      // the lease-expired notes repeat what the reason text already says.
      if (
        note.startsWith('keeps the branch') ||
        note.startsWith('forces the removal') ||
        noteSaidByReason(note)
      )
        continue
      const ja = commandNote(`pnpm demo x  # ${note}`)
      assert.ok(ja, note)
      // Only what the user types may stay in English.
      assert.equal(plain(ja.replace(/trigger/g, '')), null, ja)
    }
    assert.equal(commandNote('pnpm demo status --run r1'), null)
  })

  it('shows a failure detail as a label and its value', () => {
    assert.deepEqual(
      detailField('start checkpoint without completion: /tmp/a.json'),
      { label: '完了の記録がないチェックポイント', value: '/tmp/a.json' },
    )
    assert.deepEqual(detailField('error: boom'), {
      label: 'エラー',
      value: 'boom',
    })
    // A check log is a path to copy; its exit code is plain data.
    assert.deepEqual(detailField('check stdout log: /runs/r1/stdout.log'), {
      label: '検証の標準出力',
      value: '/runs/r1/stdout.log',
    })
    assert.deepEqual(detailField('check stderr log: /runs/r1/stderr.log'), {
      label: '検証の標準エラー',
      value: '/runs/r1/stderr.log',
    })
    // No exit code gets the same hover text as the trace's log slot.
    assert.deepEqual(detailField('check exit code: null'), {
      label: '検証の終了コード',
      value: 'null',
      title: NO_EXIT_CODE,
    })
    assert.deepEqual(detailField('check exit code: 1'), {
      label: '検証の終了コード',
      value: '1',
    })
    assert.deepEqual(detailField('check timed out after: 905000ms'), {
      label: '時間切れまでの時間',
      value: '905000ms',
    })
    // An interrupted attempt says in Japanese that it is not in the verdict.
    assert.deepEqual(
      detailField('check attempt: interrupted, not part of the verdict'),
      { label: '検証の試行', value: INTERRUPTED_CHECK_TEXT },
    )
    // A log write error warns that the file may be incomplete and keeps the
    // error itself as data.
    assert.deepEqual(detailField('check log write error: ENOSPC: disk full'), {
      label: 'ログの書き込みエラー',
      value: 'ENOSPC: disk full',
      note: LOG_WRITE_ERROR_NOTE,
    })
    assert.match(LOG_WRITE_ERROR_NOTE, /欠けているかもしれません/)
    assert.equal(isPathDetail('check stdout log: /runs/r1/stdout.log'), true)
    assert.equal(isPathDetail('check stderr log: /runs/r1/stderr.log'), true)
    assert.equal(isPathDetail('check exit code: 1'), false)
    assert.equal(isPathDetail('error: boom'), false)
  })
})

describe('the delivery on the page', () => {
  it('names the squashed branch in Japanese, as the report recorded it, with a copy button', () => {
    const field = squashedBranchField({
      squashedBranch: 'factory/run-1-squashed',
    })
    assert.deepEqual(field, {
      label: '1コミットにまとめたブランチ',
      value: 'factory/run-1-squashed',
      copyLabel: 'まとめたブランチ名をコピー',
    })
    // No parenthetical asides, and no English word where Japanese fits.
    for (const text of [field.label, field.copyLabel])
      assert.doesNotMatch(text, /[()（）]|[A-Za-z]/)
  })

  it('shows no name for a delivery recorded before the squashed branch existed', () => {
    assert.equal(squashedBranchField({}).value, null)
    assert.equal(squashedBranchField({ squashedBranch: null }).value, null)
  })
})

describe('pollEvery', () => {
  it('never runs two loads at once, and stops when asked', async () => {
    let active = 0
    let maxActive = 0
    let calls = 0
    let stopped = false
    const done = new Promise<void>((resolve) => {
      const stop = pollEvery(async (signal) => {
        calls++
        active++
        maxActive = Math.max(maxActive, active)
        // sleep-ok(work): a load slower than the interval; nothing depends on its length
        await new Promise((r) => setTimeout(r, 30))
        active--
        assert.equal(signal.aborted, stopped)
        if (calls === 4) {
          stopped = true
          stop()
          resolve()
        }
      }, 5)
    })
    await done
    // sleep-ok(negative): a stopped poll must not load again
    await new Promise((r) => setTimeout(r, 60))
    assert.equal(maxActive, 1)
    assert.equal(calls, 4)
  })
})

async function freePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

/** GET with an explicit Host header, which `fetch` does not allow setting. */
function get(
  port: number,
  path: string,
  options: {
    host?: string
    method?: string
    headers?: Record<string, string>
    body?: string
  } = {},
): Promise<{ status: number; body: string; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: options.method ?? 'GET',
        headers: {
          host: options.host ?? `127.0.0.1:${port}`,
          ...options.headers,
        },
      },
      (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (chunk: string) => (body += chunk))
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body, headers: res.headers }),
        )
      },
    )
    req.on('error', reject)
    req.end(options.body)
  })
}

async function api<T>(port: number, path: string): Promise<T> {
  const res = await get(port, path)
  assert.equal(res.status, 200, res.body)
  return JSON.parse(res.body) as T
}

/** Start `demo ui` and resolve with the URL it prints. */
async function startUi(
  home: string,
  port: number,
): Promise<{ child: ChildProcess; url: string; output: () => string }> {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', cli, 'ui', '--port', String(port)],
    { cwd: packageRoot, env: { ...process.env, HOME: home } },
  )
  let out = ''
  let err = ''
  child.stderr?.on('data', (d: Buffer) => (err += d.toString()))
  const url = await new Promise<string>((resolve, reject) => {
    child.stdout?.on('data', (d: Buffer) => {
      out += d.toString()
      const m = /web UI: (\S+)/.exec(out)
      if (m?.[1]) resolve(m[1])
    })
    child.on('exit', (code) =>
      reject(new Error(`demo ui exited (${code}): ${err}`)),
    )
  })
  return { child, url, output: () => out + err }
}

async function demo(home: string, args: string[]) {
  return runChild(process.execPath, ['--import', 'tsx', cli, ...args], {
    cwd: packageRoot,
    timeoutMs: 60000,
    maxOutputChars: 10_000_000,
    env: { HOME: home },
  })
}

async function until(cond: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 90_000
  for (;;) {
    if (await cond()) return
    if (Date.now() > deadline) throw new Error(`timed out: ${label}`)
    // sleep-ok(poll): one tick of a loop that re-checks the run state until its deadline
    await new Promise((r) => setTimeout(r, 300))
  }
}

/** Every row of the tables a run lives in, to prove nothing was written. */
function snapshot(path: string): string {
  const db = new Database(path, { readonly: true })
  try {
    return JSON.stringify(
      [
        'durably_runs',
        'durably_steps',
        'durably_step_attempts',
        'durably_waits',
        'durably_run_labels',
      ].map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()),
    )
  } finally {
    db.close()
  }
}

describe('demo ui --port', { timeout: 60000 }, () => {
  it('rejects a port that is not an integer from 1 to 65535', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ui-port-'))
    for (const port of ['0', '65536', 'abc', '80.5', '-1']) {
      const res = await demo(home, ['ui', '--port', port])
      assert.notEqual(res.code, 0, port)
      assert.match(res.stderr, /--port must be an integer between 1 and 65535/)
    }
    const bare = await demo(home, ['ui', '--port'])
    assert.notEqual(bare.code, 0)
    assert.equal(existsSync(join(home, '.local')), false)
  })
})

describe('demo ui shutdown', { timeout: 60000 }, () => {
  it('closes the server with a live-reload socket open, without the forced exit', async () => {
    const port = await freePort()
    const ui = await startUiServer({ port })
    // What an open tab holds: Vite's live-reload socket, which
    // `closeAllConnections` does not reach. Unfixed, `close()` waited on it
    // until the tab closed.
    const tab = connect(port, '127.0.0.1')
    tab.write(
      [
        'GET / HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Version: 13',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Protocol: vite-hmr',
        '',
        '',
      ].join('\r\n'),
    )
    await new Promise<void>((resolve, reject) => {
      tab.once('data', (d) =>
        String(d).startsWith('HTTP/1.1 101')
          ? resolve()
          : reject(new Error(String(d))),
      )
      tab.once('error', reject)
    })
    tab.on('error', () => {})
    // Well under the CLI's 2 s forced exit: `close()` itself must finish.
    let timer: NodeJS.Timeout | undefined
    const outcome = await Promise.race([
      ui.close().then(() => 'closed'),
      new Promise((r) => {
        // sleep-ok(guard): a deadline that fails the test when close() hangs
        timer = setTimeout(() => r('hung'), 1500)
      }),
    ])
    clearTimeout(timer)
    tab.destroy()
    assert.equal(outcome, 'closed')
  })

  it('stops on Ctrl-C at once, even with a live-reload socket open', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ui-stop-'))
    const port = await freePort()
    const ui = await startUi(home, port)
    // What an open tab holds: Vite's live-reload WebSocket.
    const socket = new WebSocket(`ws://127.0.0.1:${port}/`, 'vite-hmr')
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve())
      socket.addEventListener('error', () => reject(new Error('no socket')))
    })
    const exited = new Promise<number>((resolve) =>
      ui.child.once('exit', () => resolve(Date.now())),
    )
    const sent = Date.now()
    ui.child.kill('SIGINT')
    const elapsed = (await exited) - sent
    // Unfixed, it waited until the tab closed. Under the CLI's 2 s forced
    // exit, so the exit comes from the close itself.
    assert.ok(elapsed < 1900, `took ${elapsed} ms`)
  })
})

describe('web UI over fake runs', { timeout: 300000 }, () => {
  it('shows each run in its place with the CLI reasons, commands and numbers, and writes nothing', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ui-'))
    const stateRoot = join(home, '.local', 'state', 'local-agent-loop')
    const port = await freePort()
    const ui = await startUi(home, port)
    try {
      // Loopback only, on the requested port.
      assert.equal(ui.url, `http://127.0.0.1:${port}/`)

      // No database yet: the page and an empty list, and nothing created.
      const page = await get(port, '/')
      assert.equal(page.status, 200)
      assert.match(page.body, /<div id="root">/)
      const empty = await api<RunsResponse>(port, '/api/runs')
      assert.equal(empty.exists, false)
      assert.deepEqual(empty.runs, [])
      assert.deepEqual(
        (await api<CompareResponse>(port, '/api/compare')).runIds,
        [],
      )
      assert.equal((await get(port, '/api/runs/nope')).status, 404)
      assert.equal(existsSync(stateRoot), false)
      assert.equal(existsSync(dbPath(stateRoot)), false)

      // Only a loopback Host, and only reads.
      assert.equal(
        (await get(port, '/api/runs', { host: `evil.example:${port}` })).status,
        403,
      )
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE'])
        assert.equal(
          (await get(port, '/api/runs', { method })).status,
          405,
          method,
        )
      assert.equal(
        (await get(port, '/api/runs', { method: 'HEAD' })).status,
        200,
      )
      assert.equal(existsSync(dbPath(stateRoot)), false)

      // A worker process creates the database and a run: the next read,
      // from the UI that started before either existed, shows it.
      process.env.FAKE_FAIL_FIRST = '0'
      delete process.env.FAKE_REVIEW_SEQUENCE
      delete process.env.FAKE_REVIEW_SLOW_MS
      const durably = createAgentDurably({ stateRoot })
      await durably.migrate()
      const subject = async (maxIterations = 2) =>
        (
          await durably.jobs.agentLoop.trigger({
            provider: 'fake',
            target: { kind: 'subject' as const },
            maxIterations,
            context: 'reuse',
          })
        ).id
      const ids: Record<string, string> = {}
      ids['approval'] = await subject()
      const first = await api<RunsResponse>(port, '/api/runs')
      assert.equal(first.exists, true)
      assert.deepEqual(
        first.runs.map((r) => [r.id, r.diagnosis.kind, r.needsHuman]),
        [[ids['approval'], 'pending', false]],
      )
      // Each row carries a name from the stored input, not only its ID.
      assert.equal(first.runs[0]?.name, SUBJECT_RUN_NAME)

      const status = (id: string) => async () =>
        (await durably.getRun(id))?.status
      const settled = (id: string) => async () =>
        ['completed', 'failed'].includes((await status(id)()) ?? '')
      try {
        await durably.init()
        await until(
          async () => (await status(ids['approval'] ?? '')()) === 'waiting',
          'approval wait',
        )
        // The worker's progress shows on the next read.
        const progressed = await api<RunsResponse>(port, '/api/runs')
        assert.equal(progressed.runs[0]?.diagnosis.kind, 'approval')

        // Approved and finished.
        ids['approved'] = await subject()
        await until(
          async () => (await status(ids['approved'] ?? '')()) === 'waiting',
          'second approval wait',
        )
        const approveWait = (await durably.getWaits(ids['approved'] ?? ''))[0]
        assert.ok(approveWait)
        await durably.signal(
          approveWait.id,
          {
            candidateId: (approveWait.metadata as { candidateId: string })
              .candidateId,
            decision: 'approved',
          },
          { signalId: 'ui-approve' },
        )
        await until(settled(ids['approved'] ?? ''), 'approved run')

        // A reviewer still asks for changes after the last repair.
        process.env.FAKE_REVIEW_SEQUENCE = 'needsChanges,pass'
        ids['review'] = await subject(1)
        await until(settled(ids['review'] ?? ''), 'review-cap run')
        delete process.env.FAKE_REVIEW_SEQUENCE

        // The check still fails with no repair left.
        delete process.env.FAKE_FAIL_FIRST
        ids['verification'] = await subject(1)
        await until(settled(ids['verification'] ?? ''), 'verification run')

        // An agent call with a start checkpoint and no completion.
        const uncertain = await subject(1)
        ids['uncertain'] = uncertain
        const checkpointsDir = join(
          stateRoot,
          'runs',
          uncertain,
          'operation-checkpoints',
        )
        await mkdir(checkpointsDir, { recursive: true })
        const operationKey = `${uncertain}/stage:0:code/agent`
        await writeFile(
          checkpointPaths(checkpointsDir, operationKey).started,
          `${JSON.stringify({
            operationKey,
            invocationId: 'lost-invocation',
            status: 'started',
            invocationStartedAt: new Date().toISOString(),
          })}\n`,
        )
        await until(settled(uncertain), 'uncertain run')
        process.env.FAKE_FAIL_FIRST = '0'

        // Triage recorded, then a reviewer's provider refuses the call.
        const fake = (requestedModel: string | null = null) => ({
          provider: 'fake' as const,
          requestedModel,
          requestedEffort: null,
        })
        ids['rejected'] = (
          await durably.jobs.agentLoop.trigger({
            provider: 'fake',
            profiles: {
              code: fake(),
              correctness: fake('rejects-review'),
              'edge-cases': fake(),
              triage: fake(),
            },
            target: { kind: 'subject' as const },
            maxIterations: 1,
            context: 'reuse',
            fakeScenario: { failIterations: 0, triage: ['routine'] },
          })
        ).id
        await until(settled(ids['rejected'] ?? ''), 'rejected run')

        // Decided with no worker to resume it.
        ids['decided'] = await subject()
        await until(
          async () => (await status(ids['decided'] ?? '')()) === 'waiting',
          'third approval wait',
        )
      } finally {
        await durably.stop()
      }
      const decidedWait = (await durably.getWaits(ids['decided'] ?? ''))[0]
      assert.ok(decidedWait)
      await durably.signal(
        decidedWait.id,
        {
          candidateId: (decidedWait.metadata as { candidateId: string })
            .candidateId,
          decision: 'rejected',
        },
        { signalId: 'ui-reject' },
      )
      // With no worker running: queued, held by a live lease, lease run out.
      ids['pending'] = await subject()
      ids['running'] = await subject()
      ids['expired'] = await subject()
      const lease = (id: string, expiresAt: Date) =>
        durably.db
          .updateTable('durably_runs')
          .set({
            status: 'leased',
            lease_owner: 'other-worker',
            lease_expires_at: expiresAt.toISOString(),
            started_at: new Date().toISOString(),
          })
          .where('id', '=', id)
          .execute()
      await lease(ids['running'] ?? '', new Date(Date.now() + 3_600_000))
      await lease(ids['expired'] ?? '', new Date(Date.now() - 60_000))
      await durably.db.destroy()
      delete process.env.FAKE_FAIL_FIRST

      const before = snapshot(dbPath(stateRoot))
      const list = await api<RunsResponse>(port, '/api/runs')
      const row = (name: string) => {
        const found = list.runs.find((r) => r.id === ids[name])
        assert.ok(found, name)
        return found
      }
      const expected: Record<string, [string, boolean]> = {
        approval: ['approval', true],
        approved: ['finished', false],
        review: ['stopped', true],
        verification: ['stopped', true],
        uncertain: ['stopped', true],
        rejected: ['stopped', true],
        decided: ['decided', false],
        pending: ['pending', false],
        running: ['running', false],
        expired: ['lease-expired', false],
      }
      for (const [name, [kind, human]] of Object.entries(expected)) {
        assert.equal(row(name).diagnosis.kind, kind, name)
        assert.equal(row(name).needsHuman, human, name)
      }
      // The page can say which decision was recorded.
      assert.equal(row('decided').diagnosis.decision, 'rejected')
      assert.equal(row('review').diagnosis.failure?.kind, 'review-cap-reached')
      assert.equal(
        row('verification').diagnosis.failure?.kind,
        'verification-failed',
      )
      assert.equal(
        row('uncertain').diagnosis.failure?.kind,
        'uncertain-invocation',
      )
      assert.equal(
        row('rejected').diagnosis.failure?.kind,
        'rejected-invocation',
      )
      assert.equal(row('rejected').diagnosis.failure?.retryable, true)
      assert.ok(
        row('rejected').diagnosis.failure?.details.includes(
          'refusal: fake: the review-a call on rejects-review is refused',
        ),
      )
      assert.equal(row('approved').conclusion, 'approved')
      // Nothing that would send the lost prompt again.
      assert.doesNotMatch(
        row('uncertain').diagnosis.next.join('\n'),
        /retrigger|trigger|demo worker/,
      )
      // A healthy leased run is running; it has provisional times and no
      // settled lead time.
      assert.ok(row('running').live)
      assert.equal(row('running').leadTimeMs, null)
      assert.equal(row('approved').live, null)
      // Newest first.
      const created = list.runs.map((r) => Date.parse(r.createdAt))
      assert.deepEqual(
        created,
        [...created].sort((a, b) => b - a),
      )

      // The same next commands as `status --run` prints.
      for (const name of [
        'approval',
        'review',
        'verification',
        'uncertain',
        'rejected',
        'pending',
        'expired',
        'decided',
      ]) {
        const res = await demo(home, ['status', '--run', ids[name] ?? ''])
        assert.equal(res.code, 0, res.stderr)
        const shown = JSON.parse(res.stdout) as {
          diagnosis: { next: string[]; reason: string }
        }
        assert.deepEqual(row(name).diagnosis.next, shown.diagnosis.next, name)
        assert.equal(row(name).diagnosis.reason, shown.diagnosis.reason, name)
      }

      // The detail is exactly the CLI report, reviews and candidate included
      // while the run waits for approval.
      for (const name of [
        'approval',
        'approved',
        'review',
        'verification',
        'uncertain',
        'rejected',
      ]) {
        const detail = await api<RunDetailResponse>(
          port,
          `/api/runs/${ids[name]}`,
        )
        const res = await demo(home, [
          'report',
          '--run',
          ids[name] ?? '',
          '--format',
          'json',
        ])
        assert.equal(res.code, 0, res.stderr)
        assert.deepEqual(detail.report, JSON.parse(res.stdout), name)
      }
      const waiting = await api<RunDetailResponse>(
        port,
        `/api/runs/${ids['approval']}`,
      )
      assert.equal(waiting.name, SUBJECT_RUN_NAME)
      // The stepper and trace come from the same stored rows.
      assert.equal(
        waiting.pipeline.stages.find((s) => s.stage === 'approve')?.state,
        'waiting',
      )
      assert.deepEqual(waiting.pipeline, row('approval').pipeline)
      const approveRow = waiting.trace.root.children
        .at(-1)
        ?.children.find((c) => c.stage === 'approve')
      assert.equal(approveRow?.state, 'waiting')
      assert.equal(approveRow?.open, true)
      // Review verdicts of the waiting run reach its review rows.
      assert.ok(
        waiting.trace.root.children
          .at(-1)
          ?.children.filter((c) => c.stage === 'review')
          .every((c) => c.review !== null),
      )
      assert.equal(
        row('verification').pipeline.stages.find((s) => s.state === 'stopped')
          ?.stage,
        'verify',
      )
      // The stopped run names the failing check's log in its stop reason and
      // on its verification row, with the same path and exit code.
      const stopped = await api<RunDetailResponse>(
        port,
        `/api/runs/${ids['verification']}`,
      )
      const lastVerify = stopped.trace.root.children
        .flatMap((c) => c.children)
        .filter((c) => c.stage === 'verify')
        .at(-1)
      const checkLog = lastVerify?.verificationLog
      assert.ok(checkLog)
      const stopDetails = stopped.diagnosis.failure?.details ?? []
      assert.ok(
        stopDetails.includes(`check stdout log: ${checkLog.stdoutPath}`),
      )
      assert.ok(
        stopDetails.includes(`check stderr log: ${checkLog.stderrPath}`),
      )
      assert.ok(stopDetails.includes(`check exit code: ${checkLog.exitCode}`))
      assert.equal(waiting.report.reviews.length, 2)
      assert.ok(waiting.report.reviews.every((r) => r.notes.length > 0))
      assert.ok(waiting.report.candidate?.id)
      const md = await demo(home, ['report', '--run', ids['approval'] ?? ''])
      assert.match(md.stdout, /## Reviews\n\n- (correctness|edge-cases): pass/)
      // A fake run records no usage: unknown, never zero.
      const approvedDetail = await api<RunDetailResponse>(
        port,
        `/api/runs/${ids['approved']}`,
      )
      assert.equal(approvedDetail.report.summary.costUsd, null)
      assert.equal(row('approved').costUsd, null)

      // The comparison is exactly `compare` over the same finished runs.
      const compared = await api<CompareResponse>(port, '/api/compare')
      const finished = list.runs
        .filter((r) => ['completed', 'failed', 'cancelled'].includes(r.status))
        .map((r) => r.id)
      assert.deepEqual(compared.runIds, finished)
      const res = await demo(home, [
        'compare',
        '--runs',
        compared.runIds.join(','),
        '--format',
        'json',
      ])
      assert.equal(res.code, 0, res.stderr)
      assert.deepEqual(compared.comparison, JSON.parse(res.stdout))

      // The tasks, their runs and their place are what `status` prints.
      const tasksNow = await api<RunsResponse>(port, '/api/runs')
      const statusCli = await demo(home, ['status', '--format', 'json'])
      assert.equal(statusCli.code, 0, statusCli.stderr)
      assert.deepEqual(
        tasksNow.tasks,
        (JSON.parse(statusCli.stdout) as { tasks: unknown }).tasks,
      )
      assert.deepEqual(
        tasksNow.tasks
          .filter((t) => ['decision', 'stop'].includes(t.attention))
          .map((t) => t.representative)
          .sort(),
        tasksNow.runs
          .filter((r) => r.needsHuman)
          .map((r) => r.id)
          .sort(),
      )
      // The trend is `compare --trend` over the same runs: every one of
      // them is fake, so all are left out and counted as such.
      const trend = await api<TrendResponse>(port, '/api/trend')
      const trendCli = await demo(home, [
        'compare',
        '--trend',
        '--format',
        'json',
      ])
      assert.equal(trendCli.code, 0, trendCli.stderr)
      assert.deepEqual(trend, JSON.parse(trendCli.stdout))
      assert.equal(trend.fakeExcluded, finished.length)
      assert.deepEqual(trend.groups, [])
      const withFake = await demo(home, [
        'compare',
        '--trend',
        '--include-fake',
        '--format',
        'json',
      ])
      assert.equal(
        (JSON.parse(withFake.stdout) as TrendResponse).runIds.length,
        finished.length,
      )

      // The detail says the run's state once, and keeps the evidence and
      // each review's notes closed.
      const html = renderToStaticMarkup(
        createElement(RunScreen, {
          act: noAct,
          data: await api<RunDetailResponse>(
            port,
            `/api/runs/${ids['approved']}`,
          ),
        }),
      )
      const detailText = htmlText(html)
      assert.ok(detailText.includes(DETAIL.conclusion))
      assert.ok(detailText.includes(REVIEW.highlights))
      // One badge above the conclusion, and no sentence repeating it.
      const header = html.slice(0, html.indexOf(DETAIL.conclusion))
      assert.equal(header.match(/leading-4 font-medium/g)?.length, 1)
      assert.ok(header.includes(`>${KIND_NAME.finished}<`) === false)
      assert.ok(!detailText.includes(DIAGNOSIS_TEXT.finished))
      assert.doesNotMatch(html, /<details[^>]*\bopen/)
      const counts = compared.comparison.groups.reduce<Record<string, number>>(
        (acc, g) => {
          for (const [c, n] of Object.entries(g.conclusions))
            acc[c] = (acc[c] ?? 0) + n
          return acc
        },
        {},
      )
      assert.equal(counts['approved'], 1)
      assert.equal(counts['review-cap-reached'], 1)
      assert.equal(counts['verification-failed'], 1)
      // The triage row sets the calibration and the stop beside the
      // judgment, as `compare` does; the sample's spec values are unknown.
      const judged = compared.comparison.groups.flatMap((g) => g.triage)
      assert.equal(judged.length, 1)
      assert.deepEqual(judged[0]?.stops, { 'rejected-invocation': 1 })
      assert.equal(judged[0]?.calibration.taskChars.median, 58)
      assert.equal(judged[0]?.calibration.plannedFiles.unknown, 1)
      const rejectedDetail = await api<RunDetailResponse>(
        port,
        `/api/runs/${ids['rejected']}`,
      )
      assert.deepEqual(rejectedDetail.report.triage?.calibration, {
        taskChars: 58,
        specChars: null,
        acceptanceCriteria: null,
        plannedFiles: null,
      })

      // Reading, repeatedly, changed nothing in the database.
      for (let i = 0; i < 3; i++) {
        await api(port, '/api/runs')
        await api(port, '/api/compare')
        await api(port, `/api/runs/${ids['running']}`)
      }
      assert.equal(snapshot(dbPath(stateRoot)), before)
    } finally {
      ui.child.kill('SIGTERM')
      delete process.env.FAKE_FAIL_FIRST
      delete process.env.FAKE_REVIEW_SEQUENCE
    }
  })
})

/** A repair run's input, as `demo repair` stores it, for a given parent. */
function repairChildInput(home: string, parentId: string) {
  const profile = (role: string) => ({
    id: `fake:fake-model:low:${role}`,
    provider: 'fake' as const,
    requestedModel: null,
    requestedEffort: null,
    effectiveModel: 'fake-model',
    effectiveEffort: 'low',
  })
  const commit = 'a'.repeat(40)
  return {
    provider: 'fake' as const,
    maxIterations: 1,
    context: 'reuse' as const,
    target: {
      kind: 'repo' as const,
      repoPath: join(home, 'repo'),
      baseRef: commit,
      task: 'Keep the currency on refunds',
      spec: null,
      dispositions: null,
      inputFiles: { task: null, spec: null, dispositions: null },
      issue: null,
      checkCommand: ['true'],
      setupCommand: null,
      publish: false,
    },
    checkTimeoutMs: 1000,
    agentTimeoutMs: 1000,
    repairOf: {
      runId: parentId,
      candidateCommit: commit,
      candidateBranch: 'factory/parent',
      findings: 'the refund total drops the currency',
      findingsFile: { path: join(home, 'findings.md') },
      profiles: {
        code: profile('code'),
        correctness: profile('correctness'),
        'edge-cases': profile('edge-cases'),
        repair: null,
        triage: null,
      },
    },
  }
}

describe('repair runs on the page', { timeout: 120000 }, () => {
  it('lists and compares runs without a child query per run, and still shows a child added after the parent finished', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ui-repair-list-'))
    const durably = createAgentDurably({
      stateRoot: join(home, '.local', 'state', 'local-agent-loop'),
    })
    await durably.migrate()
    try {
      const parent = await durably.jobs.agentLoop.trigger({
        provider: 'fake',
        target: { kind: 'subject' as const },
        maxIterations: 1,
        context: 'reuse',
      })
      await durably.db
        .updateTable('durably_runs')
        .set({ status: 'completed', completed_at: new Date().toISOString() })
        .where('id', '=', parent.id)
        .execute()
      for (let i = 0; i < 3; i++)
        await durably.jobs.agentLoop.trigger({
          provider: 'fake',
          target: { kind: 'subject' as const },
          maxIterations: 1,
          context: 'reuse',
        })
      const filters: unknown[] = []
      const spy: ReportSource = {
        getRun: (id) => durably.getRun(id),
        getStepAttempts: (id) => durably.getStepAttempts(id),
        getWaits: (id) => durably.getWaits(id),
        getRuns: ((filter) => {
          filters.push(filter)
          return durably.getRuns(filter)
        }) as ReportSource['getRuns'],
        storage: durably.storage,
      }
      const cache = finishedReportCache()
      const listed = async () => {
        const all = await durably.getRuns({
          jobName: durably.jobs.agentLoop.name,
        })
        const byId = new Map(
          (await listedReports(cache, readOnce(spy, all), all, all)).map(
            (r) => [r.run.id, r.report.lineage.children],
          ),
        )
        return { all, byId }
      }
      const first = await listed()
      assert.equal(first.all.length, 4)
      assert.deepEqual(first.byId.get(parent.id), [])
      // The parent's report is now cached. A child added after it finished
      // leaves the parent's row as it was, and still shows.
      const child = await durably.jobs.agentLoop.trigger(
        repairChildInput(home, parent.id),
        { labels: repairLabels(repairChildInput(home, parent.id)) },
      )
      const second = await listed()
      assert.deepEqual(second.byId.get(parent.id), [child.id])
      assert.deepEqual(second.byId.get(child.id), [])
      // Compare builds the finished runs' reports, with children from every
      // run the request read.
      const done = second.all.filter((r) => r.status === 'completed')
      const compared = await listedReports(
        cache,
        readOnce(spy, done),
        done,
        second.all,
      )
      assert.deepEqual(
        compared.map((r) => r.report.lineage.children),
        [[child.id]],
      )
      // No report asked the database for its children.
      assert.deepEqual(filters, [])
    } finally {
      await durably.db.destroy()
    }
  })

  it('links a parent and its repair runs both ways, even after the parent finished', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ui-repair-'))
    const stateRoot = join(home, '.local', 'state', 'local-agent-loop')
    const port = await freePort()
    const ui = await startUi(home, port)
    try {
      const durably = createAgentDurably({ stateRoot })
      await durably.migrate()
      const parent = await durably.jobs.agentLoop.trigger({
        provider: 'fake',
        target: { kind: 'subject' as const },
        maxIterations: 1,
        context: 'reuse',
      })
      // Finished, so the page keeps its report from the first read.
      await durably.db
        .updateTable('durably_runs')
        .set({
          status: 'completed',
          completed_at: new Date().toISOString(),
        })
        .where('id', '=', parent.id)
        .execute()
      const before = await api<RunsResponse>(port, '/api/runs')
      assert.deepEqual(
        before.tasks.map((t) => t.runs.map((r) => r.id)),
        [[parent.id]],
      )
      const childInput = repairChildInput(home, parent.id)
      const child = await durably.jobs.agentLoop.trigger(childInput, {
        labels: repairLabels(childInput),
      })
      await durably.db.destroy()

      const list = await api<RunsResponse>(port, '/api/runs')
      assert.deepEqual(
        [parent.id, child.id].map(
          (id) => list.runs.find((r) => r.id === id)?.name,
        ),
        [SUBJECT_RUN_NAME, 'Keep the currency on refunds'],
      )
      // The parent and its repair are one task, shown by the repair.
      assert.deepEqual(
        list.tasks.map((t) => [
          t.id,
          t.runs.map((r) => r.id),
          t.representative,
        ]),
        [[parent.id, [parent.id, child.id], child.id]],
      )
      const detail = await api<RunDetailResponse>(
        port,
        `/api/runs/${parent.id}`,
      )
      assert.deepEqual(detail.report.lineage.children, [child.id])
      assert.deepEqual(
        detail.lineage.map((r) => r.id),
        [parent.id, child.id],
      )
      const childDetail = await api<RunDetailResponse>(
        port,
        `/api/runs/${child.id}`,
      )
      assert.equal(childDetail.report.lineage.parent?.runId, parent.id)
      assert.equal(
        childDetail.report.inputs.findings?.path,
        join(home, 'findings.md'),
      )
    } finally {
      ui.child.kill('SIGTERM')
    }
  })
})

const uiRoot = fileURLToPath(new URL('../src/ui/', import.meta.url))

async function clientFiles(): Promise<string[]> {
  const entries = await readdir(uiRoot, { recursive: true })
  return entries
    .filter((f) => /\.tsx?$/.test(f))
    .filter((f) => !['server.ts', 'glossary.ts', 'labels.ts'].includes(f))
    .map((f) => join(uiRoot, f))
}

/** Components, screens and App.tsx: the files that draw the page. */
async function drawingFiles(): Promise<string[]> {
  return (await clientFiles()).filter((f) =>
    /(^|\/)(components|screens)\/|App\.tsx$/.test(relative(uiRoot, f)),
  )
}

const htmlText = (html: string) => html.replace(/<[^>]+>/g, '\n')

describe('routes', () => {
  it('reads each page from the hash', () => {
    assert.deepEqual(parseRoute(''), { page: 'runs' })
    assert.deepEqual(parseRoute('#/'), { page: 'runs' })
    assert.deepEqual(parseRoute('#/compare'), { page: 'compare' })
    assert.deepEqual(parseRoute('#/design'), { page: 'design' })
    assert.deepEqual(parseRoute('#/runs/a%2Fb'), { page: 'run', id: 'a/b' })
  })
})

describe('the design page', () => {
  it('draws every component in light and dark without the API', () => {
    const calls: string[] = []
    const saved = globalThis.fetch
    globalThis.fetch = (async (url: string) => {
      calls.push(String(url))
      throw new Error('the design page must not fetch')
    }) as typeof fetch
    try {
      const html = renderToStaticMarkup(
        createElement(DesignScreen, { route: { page: 'design' } }),
      )
      const shown = htmlText(html)
      for (const part of Object.values(DESIGN.part))
        assert.ok(shown.includes(part.name), part.name)
      const specimens = Object.keys(DESIGN.part).length
      assert.equal(html.match(/scheme-light/g)?.length, specimens)
      assert.equal(html.match(/scheme-dark/g)?.length, specimens)
      // A confirmed action shown asking: its question and its CLI line.
      assert.match(shown, /再実行しますか/)
      assert.match(html, /pnpm demo retrigger --run/)
      // Two timelines per pane, each a treegrid.
      assert.equal(html.match(/role="treegrid"/g)?.length, 4)
      // Every inspector names its log heading with an ID of its own.
      assert.equal(html.match(/id="trace-log-slot"/g), null)
      const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1])
      assert.equal(new Set(ids).size, ids.length)
      assert.deepEqual(calls, [])
    } finally {
      globalThis.fetch = saved
    }
  })

  it('never polls or writes: no polling hook, fetch or storage in its files', async () => {
    const files = (await clientFiles()).filter(
      (f) => f.includes('/design/') || f.endsWith('DesignScreen.tsx'),
    )
    assert.ok(files.length >= 4)
    for (const file of files) {
      const source = await readFile(file, 'utf8')
      for (const banned of ['usePolled', 'pollJson', 'fetch(', 'localStorage'])
        assert.ok(!source.includes(banned), `${file}: ${banned}`)
    }
  })
})

describe('client source', () => {
  it('keeps each client file within a few hundred lines', async () => {
    for (const file of await clientFiles()) {
      const lines = (await readFile(file, 'utf8')).split('\n').length
      assert.ok(lines <= 300, `${relative(uiRoot, file)}: ${lines} lines`)
    }
  })

  it('takes every fixed word from the glossary', async () => {
    for (const file of await drawingFiles()) {
      if (file.endsWith('fixtures.ts')) continue
      const code = (await readFile(file, 'utf8'))
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '')
      const hit = /[ぁ-んァ-ヶ一-龠々]+/.exec(code)
      assert.equal(hit, null, `${relative(uiRoot, file)}: ${hit?.[0]}`)
    }
  })

  it('writes no color, type size or spacing value into a component', async () => {
    const banned = [
      /#[0-9a-f]{3,8}\b/i,
      /\b(?:oklch|rgba?|hsla?)\(/,
      /\b\d+(?:\.\d+)?px\b/,
      /\b(?:text|p[xytblr]?|m[xytblr]?|gap(?:-[xy])?|space-[xy])-\[/,
    ]
    for (const file of await drawingFiles()) {
      // Fixtures are data: an issue number such as `#261` is not a color.
      if (file.endsWith('fixtures.ts')) continue
      const code = (await readFile(file, 'utf8')).replace(
        /\/\*[\s\S]*?\*\//g,
        '',
      )
      for (const re of banned)
        assert.doesNotMatch(code, re, `${relative(uiRoot, file)}: ${re}`)
    }
  })
})

describe('numbers on the screens', () => {
  const now = '2026-09-30T12:00:00.000Z'
  const row = (over: Partial<RunRow>): RunRow =>
    ({
      id: '01K6D2Q7XB3M9RKT4WFINISH',
      name: 'task',
      status: 'completed',
      createdAt: '2026-09-30T11:00:00.000Z',
      needsHuman: false,
      conclusion: 'approved',
      leadTimeMs: 1_093_000,
      costUsd: 6.443984,
      pipeline: { stages: [], label: '' },
      live: null,
      uncertainCall: false,
      diagnosis: { kind: 'finished', next: [], failure: null },
      ...over,
    }) as unknown as RunRow

  it('shows the total on a stopped task that took more than one run, not on a single run', () => {
    const stopped = {
      status: 'failed',
      conclusion: null,
      diagnosis: { kind: 'stopped', next: [], failure: null },
    } as unknown as Partial<RunRow>
    const runs = [
      row({
        id: '01K6D2Q7XB3M9RKT4WFIRST0',
        conclusion: 'changes_requested',
        leadTimeMs: 600_000,
        costUsd: 1,
      }),
      row({
        ...stopped,
        id: '01K6D2Q7XB3M9RKT4WREPAIR',
        createdAt: '2026-09-30T11:20:00.000Z',
        leadTimeMs: 300_000,
        costUsd: 0.5,
      }),
      row({
        ...stopped,
        id: '01K6D2Q7XB3M9RKT4WALONE0',
        createdAt: '2026-09-30T11:10:00.000Z',
        leadTimeMs: 120_000,
        costUsd: 0.25,
      }),
    ]
    const parents: Record<string, string> = {
      '01K6D2Q7XB3M9RKT4WREPAIR': '01K6D2Q7XB3M9RKT4WFIRST0',
    }
    const tasks = groupTasks(
      runs.map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        parentId: parents[r.id] ?? null,
        kind: r.diagnosis.kind,
        approved: false,
        leadTimeMs: r.leadTimeMs,
        costUsd: r.costUsd,
      })),
    )
    assert.deepEqual(
      tasks.map((t) => [t.attention, t.runs.length]),
      [
        ['stop', 2],
        ['stop', 1],
      ],
    )
    const data = {
      exists: true,
      db: '/tmp/x.db',
      now,
      runs,
      tasks,
    } as unknown as RunsResponse
    const list = htmlText(
      renderToStaticMarkup(createElement(RunsScreen, { data, act: noAct })),
    )
    // The two-run task's line carries the total, labelled as one; the
    // single run's line does not, and its cost appears nowhere.
    assert.equal(list.match(new RegExp(LIST.total, 'g'))?.length, 1)
    assert.match(list, /\$1\.50/)
    assert.match(list, /15分/)
    assert.ok(!list.includes('$0.25'))
  })

  it('offers the way back beside an archived run that does not show its task', () => {
    const first = '01K6D2Q7XB3M9RKT4WFIRST0'
    const repair = '01K6D2Q7XB3M9RKT4WREPAIR'
    const back = `pnpm --filter example-local-agent-loop demo unarchive --run ${first}`
    const runs = [
      row({
        id: first,
        status: 'failed',
        conclusion: null,
        diagnosis: { kind: 'stopped', next: [], failure: null },
        archived: true,
        archiveCommand: back,
      } as unknown as Partial<RunRow>),
      row({
        id: repair,
        createdAt: '2026-09-30T11:20:00.000Z',
        archived: false,
        archiveCommand: null,
      } as unknown as Partial<RunRow>),
    ]
    const tasks = groupTasks(
      runs.map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        parentId: r.id === repair ? first : null,
        kind: r.diagnosis.kind,
        approved: r.id === repair,
        leadTimeMs: r.leadTimeMs,
        costUsd: r.costUsd,
        archived: r.archived,
      })),
    )
    const [task] = tasks
    // The newer finished run shows the task, among the finished ones.
    assert.deepEqual(
      [tasks.length, task?.attention, task?.representative],
      [1, 'done', repair],
    )
    const data = { exists: true, db: '/tmp/x.db', now, runs, tasks }
    const html = renderToStaticMarkup(
      createElement(RunsScreen, {
        data: data as unknown as RunsResponse,
        act: noAct,
      }),
    )
    const list = htmlText(html)
    // One quiet way back, beside the archived run, with its CLI line.
    assert.equal(list.split(ACTION.unarchive).length - 1, 1)
    assert.ok(list.includes(LIST.archived))
    assert.ok(list.includes(back))
    assert.ok(list.includes(ACTION.sameCommand))
    assert.doesNotMatch(list, / demo archive --run /)
    assert.match(
      html,
      new RegExp(`class="[^"]*bg-transparent[^"]*"[^>]*>${ACTION.unarchive}<`),
    )
    // While another run's action asks, this run's way back steps aside.
    const rows = new Map(runs.map((r) => [r.id, r]))
    const aside = (id: string | null) =>
      htmlText(
        renderToStaticMarkup(
          createElement(TaskRuns, {
            task: task as Task,
            rows,
            now,
            name: 'task',
            act: noAct,
            aside: id,
          }),
        ),
      )
    assert.ok(!aside(repair).includes(ACTION.unarchive))
    assert.ok(aside(first).includes(ACTION.unarchive))
  })

  it('writes cost, time and tokens as a person reads them, and unknown as 不明', () => {
    const runs = [
      row({}),
      row({
        id: '01K6D2Q7XB3M9RKT4WUNKNWN',
        leadTimeMs: null,
        costUsd: null,
      }),
    ]
    const data = {
      exists: true,
      db: '/tmp/x.db',
      now,
      runs,
      tasks: groupTasks(
        runs.map((r) => ({
          id: r.id,
          createdAt: r.createdAt,
          parentId: null,
          kind: 'finished',
          approved: true,
          leadTimeMs: r.leadTimeMs,
          costUsd: r.costUsd,
        })),
      ),
    } as unknown as RunsResponse
    const list = htmlText(
      renderToStaticMarkup(createElement(RunsScreen, { data, act: noAct })),
    )
    // Nothing waits: the top says so in so many words.
    assert.ok(list.includes(LIST.attentionEmpty))
    assert.match(list, /\$6\.44/)
    assert.match(list, /18分13秒/)
    assert.equal(list.match(/不明/g)?.length, 2)
    assert.ok(!list.includes('6.443984'))
    assert.doesNotMatch(list, /\d ?ms\b/)

    const usage = {
      invocations: 3,
      inputTokens: 4_100_000,
      cacheReadTokens: null,
      cacheWriteTokens: 0,
      outputTokens: 1_023_456,
      totalTokens: 5_123_456,
      costUsd: 6.443984,
      complete: true,
      costComplete: true,
    }
    const report = {
      summary: {
        conclusion: 'approved',
        leadTimeMs: 1_093_000,
        workMs: 0,
        humanWaitMs: null,
        totalTokens: 5_123_456,
        costUsd: 6.443984,
        repairs: 0,
        reviewRounds: 1,
      },
      triage: null,
      stageUsage: [{ ...usage, stage: 'code' }],
      roleUsage: [
        {
          ...usage,
          role: 'code',
          provider: 'codex',
          requestedModel: null,
          requestedEffort: null,
        },
      ],
    } as unknown as LoopReport
    const detail = htmlText(
      renderToStaticMarkup(createElement(SummaryPanel, { report })) +
        renderToStaticMarkup(createElement(UsagePanels, { report })),
    )
    assert.match(detail, /5\.1M/)
    assert.match(detail, /\$6\.44/)
    assert.match(detail, /18分13秒/)
    assert.match(detail, /0秒/)
    assert.ok(!detail.includes('5,123,456') && !detail.includes('5123456'))
    assert.doesNotMatch(detail, /\d ?ms\b/)
    // The unknown human wait and cache reads say so, never 0.
    assert.ok((detail.match(/不明/g)?.length ?? 0) >= 3)

    // A candidate's size, like every count, is written with separators.
    const changes = {
      files: 1204,
      additions: 12345,
      deletions: 6789,
      diffPath: '/tmp/d.diff',
      changedFilesPath: '/tmp/f.txt',
    }
    const records = htmlText(
      renderToStaticMarkup(
        createElement(RecordPanels, {
          report: {
            ...report,
            candidate: { id: 'c1', branch: null, commit: null, changes },
            candidates: [
              {
                id: 'c1',
                branch: null,
                commit: null,
                changes,
                iteration: 1,
                sequence: 3,
              },
            ],
            delivery: null,
            inputs: {
              task: null,
              spec: null,
              dispositions: null,
              findings: null,
            },
            notes: [],
          } as unknown as LoopReport,
        }),
      ),
    )
    assert.match(records, /1,204 ファイル、\+12,345 行、−6,789 行/)
    assert.ok(!records.includes('12345'))
  })
})

describe('web UI actions', { timeout: 300000 }, () => {
  it('acts through the CLI functions, and only for a POST with the page token and this origin', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ui-act-'))
    const stateRoot = join(home, '.local', 'state', 'local-agent-loop')
    const port = await freePort()
    const ui = await startUi(home, port)
    const origin = `http://127.0.0.1:${port}`
    const page = await get(port, '/')
    const token =
      /<meta name="loop-ui-token" content="([0-9a-f]{64})" \/>/.exec(
        page.body,
      )?.[1]
    assert.ok(token, page.body)
    const post = (
      path: string,
      body: unknown = {},
      headers: Record<string, string> = {
        origin,
        [TOKEN_HEADER]: token,
      },
      options: { host?: string; method?: string } = {},
    ) =>
      get(port, path, {
        method: 'POST',
        ...options,
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      })
    const archived = (id: string) => existsSync(archiveMarkerOf(stateRoot, id))
    let durably: ReturnType<typeof createAgentDurably> | undefined
    try {
      // Before the database exists an action finds no run and creates
      // nothing.
      assert.equal((await post('/api/runs/nope/archive')).status, 404)
      assert.equal(existsSync(stateRoot), false)
      durably = createAgentDurably({ stateRoot })
      const db = durably

      process.env.FAKE_FAIL_FIRST = '0'
      delete process.env.FAKE_REVIEW_SEQUENCE
      await db.migrate()
      const subject = async () =>
        (
          await db.jobs.agentLoop.trigger({
            provider: 'fake',
            target: { kind: 'subject' as const },
            maxIterations: 2,
            context: 'reuse',
          })
        ).id
      const toApprove = await subject()
      const toReject = await subject()
      await db.init()
      const waiting = async (id: string) =>
        (await db.getRun(id))?.status === 'waiting'
      await until(
        async () => (await waiting(toApprove)) && (await waiting(toReject)),
        'approval waits',
      )
      await db.stop()
      // A stop safe to repeat, and one that is not.
      const cancelled = await subject()
      await db.cancel(cancelled)
      const broken = await subject()
      await db.db
        .updateTable('durably_runs')
        .set({ status: 'failed', error: 'boom' })
        .where('id', '=', broken)
        .execute()
      const waitOf = async (id: string) => {
        const wait = (await db.getWaits(id))[0]
        assert.ok(wait)
        return wait
      }
      const approveWait = await waitOf(toApprove)
      const rejectWait = await waitOf(toReject)

      // Every guard answers before the action: nothing in the database or
      // among the archive markers changes.
      const target = `/api/runs/${cancelled}/archive`
      const before = snapshot(dbPath(stateRoot))
      const refused: [string, Promise<{ status: number }>, number][] = [
        ['no token', post(target, {}, { origin }), 403],
        [
          'wrong token',
          post(target, {}, { origin, [TOKEN_HEADER]: 'f'.repeat(64) }),
          403,
        ],
        ['no origin', post(target, {}, { [TOKEN_HEADER]: token }), 403],
        [
          'foreign origin',
          post(
            target,
            {},
            { origin: 'http://evil.example', [TOKEN_HEADER]: token },
          ),
          403,
        ],
        [
          'wrong host',
          post(
            target,
            {},
            { origin: `http://evil.example:${port}`, [TOKEN_HEADER]: token },
            { host: `evil.example:${port}` },
          ),
          403,
        ],
        [
          'GET',
          get(port, target, { headers: { origin, [TOKEN_HEADER]: token } }),
          405,
        ],
        [
          'HEAD',
          get(port, target, {
            method: 'HEAD',
            headers: { origin, [TOKEN_HEADER]: token },
          }),
          405,
        ],
        ['PUT', post(target, {}, undefined, { method: 'PUT' }), 405],
        // A read path takes no write, token or not.
        ['POST on a read', post(`/api/runs/${cancelled}`), 405],
      ]
      for (const [label, sent, status] of refused)
        assert.equal((await sent).status, status, label)
      // A malformed run ID is the request's fault, checked after the method,
      // and the server keeps answering after it.
      const malformed: [string, Promise<{ status: number }>, number][] = [
        ['GET', get(port, '/api/runs/%E0/archive'), 405],
        ['POST', post('/api/runs/%E0/archive'), 400],
        ['read', get(port, '/api/runs/%E0'), 400],
      ]
      for (const [label, sent, status] of malformed)
        assert.equal((await sent).status, status, `malformed ${label}`)
      assert.equal((await get(port, '/api/runs')).status, 200)
      // Another localhost origin cannot read the page that carries the token.
      const cross = await get(port, '/', {
        headers: { origin: 'http://localhost:5173' },
      })
      assert.equal(cross.status, 200)
      assert.equal(cross.headers['access-control-allow-origin'], undefined)
      assert.equal(snapshot(dbPath(stateRoot)), before)
      assert.equal(existsSync(join(stateRoot, 'archived')), false)

      // Archive: a marker, and not one change to the run.
      const done = await post(target)
      assert.equal(done.status, 200, done.body)
      // A subject run has no worktree to remove.
      assert.deepEqual(JSON.parse(done.body), {
        changed: true,
        worktreeRemoved: false,
        deletedBranches: [],
        warnings: [],
      })
      assert.ok(archived(cancelled))
      assert.equal(snapshot(dbPath(stateRoot)), before)
      const taskOf = (list: RunsResponse, id: string) =>
        list.tasks.find((t) => t.id === id)
      let list = await api<RunsResponse>(port, '/api/runs')
      assert.equal(taskOf(list, cancelled)?.attention, 'done')
      assert.equal(taskOf(list, cancelled)?.runs[0]?.archived, true)
      const row = list.runs.find((r) => r.id === cancelled)
      assert.equal(row?.archived, true)
      assert.equal(row?.diagnosis.kind, 'stopped')
      assert.match(row?.archiveCommand ?? '', / demo unarchive --run /)
      // `status` reads the same marker and the same grouping.
      const status = await demo(home, ['status', '--format', 'json'])
      assert.equal(status.code, 0, status.stderr)
      const cliTasks = (JSON.parse(status.stdout) as { tasks: Task[] }).tasks
      assert.deepEqual(
        cliTasks.map((t) => [t.id, t.attention]),
        list.tasks.map((t) => [t.id, t.attention]),
      )
      const text = await demo(home, ['status'])
      assert.doesNotMatch(
        text.stdout.split('stopped run(s) archived')[0] ?? '',
        new RegExp(cancelled),
      )
      assert.match(text.stdout, new RegExp(`demo unarchive --run ${cancelled}`))
      // Unarchived, it is where it was, with the same diagnosis.
      assert.equal((await post(`/api/runs/${cancelled}/unarchive`)).status, 200)
      assert.equal(archived(cancelled), false)
      list = await api<RunsResponse>(port, '/api/runs')
      assert.equal(taskOf(list, cancelled)?.attention, 'stop')
      assert.deepEqual(
        list.runs.find((r) => r.id === cancelled)?.diagnosis,
        row?.diagnosis,
      )
      // A run waiting on a decision is decided, not archived.
      const open = await post(`/api/runs/${toApprove}/archive`)
      assert.equal(open.status, 409)
      assert.match(JSON.parse(open.body).error, /not stopped; decide it/)
      assert.equal(archived(toApprove), false)

      // Decisions: bound to the candidate the wait names, refused for a wait
      // of another run, the wrong kind, or a second time.
      const wrong = await post(`/api/runs/${toReject}/reject`, {
        waitId: approveWait.id,
      })
      assert.equal(wrong.status, 409)
      assert.match(JSON.parse(wrong.body).error, /not a wait of run/)
      const notSpec = await post(`/api/runs/${toReject}/spec-revise`, {
        notes: 'tighten it',
      })
      assert.equal(notSpec.status, 409)
      assert.match(JSON.parse(notSpec.body).error, /not a spec-blocked wait/)
      assert.equal((await post(`/api/runs/nope/approve`, {})).status, 404)
      assert.equal(snapshot(dbPath(stateRoot)), before)
      const approved = await post(`/api/runs/${toApprove}/approve`, {
        waitId: approveWait.id,
      })
      assert.equal(approved.status, 200, approved.body)
      assert.deepEqual((await db.getWait(approveWait.id))?.payload, {
        candidateId: (approveWait.metadata as { candidateId: string })
          .candidateId,
        decision: 'approved',
      })
      const again = await post(`/api/runs/${toApprove}/approve`, {
        waitId: approveWait.id,
      })
      assert.equal(again.status, 409)
      assert.match(JSON.parse(again.body).error, /refusing a second decision/)
      const rejected = await post(`/api/runs/${toReject}/reject`, {
        waitId: rejectWait.id,
      })
      assert.equal(rejected.status, 200, rejected.body)
      const decided = (await db.getWait(rejectWait.id))?.payload as {
        decision?: string
      } | null
      assert.equal(decided?.decision, 'rejected')

      // Retrigger from the stored input: the page and the CLI start one run.
      const runCount = async () =>
        (await db.getRuns({ jobName: db.jobs.agentLoop.name })).length
      const count = await runCount()
      const retried = await post(`/api/runs/${cancelled}/retrigger`)
      assert.equal(retried.status, 200, retried.body)
      const next = JSON.parse(retried.body) as {
        runId: string
        disposition: string
      }
      assert.equal(next.disposition, 'created')
      const cli = await demo(home, ['retrigger', '--run', cancelled])
      assert.equal(cli.code, 0, cli.stderr)
      assert.match(
        cli.stdout,
        new RegExp(`already retriggered as ${next.runId}`),
      )
      const twice = JSON.parse(
        (await post(`/api/runs/${cancelled}/retrigger`)).body,
      ) as { runId: string; disposition: string }
      assert.deepEqual(twice, { runId: next.runId, disposition: 'idempotent' })
      // A stop the CLI refuses to repeat is refused here too.
      const unsafe = await post(`/api/runs/${broken}/retrigger`)
      assert.equal(unsafe.status, 409)
      assert.match(JSON.parse(unsafe.body).error, /refusing to retrigger/)
      assert.equal(await runCount(), count + 1)
      // No worker was started and no worker lock taken: the new run waits.
      assert.equal(existsSync(join(stateRoot, 'worker.lock')), false)
      assert.equal((await db.getRun(next.runId))?.status, 'pending')
    } finally {
      ui.child.kill('SIGTERM')
      await durably?.stop()
      await durably?.db.destroy()
      delete process.env.FAKE_FAIL_FIRST
    }

    // A new start makes a new token, and neither start printed its own.
    const port2 = await freePort()
    const ui2 = await startUi(home, port2)
    try {
      const other =
        /<meta name="loop-ui-token" content="([0-9a-f]{64})" \/>/.exec(
          (await get(port2, '/')).body,
        )?.[1]
      assert.ok(other)
      assert.notEqual(other, token)
      assert.equal(ui.output().includes(token), false)
      assert.equal(ui2.output().includes(other), false)
      // The first start's token is no good to the second.
      const stale = await get(port2, `/api/runs/nope/archive`, {
        method: 'POST',
        headers: { origin: `http://127.0.0.1:${port2}`, [TOKEN_HEADER]: token },
      })
      assert.equal(stale.status, 403)
    } finally {
      ui2.child.kill('SIGTERM')
    }
  })
})

describe('worktree cleanup on the page', { timeout: 300000 }, () => {
  it('shows an archived repository run as cleaned up, even from a cached detail, says why when git refuses, and prunes its branches only when asked', async () => {
    const home = await mkdtemp(join(tmpdir(), 'ui-worktree-'))
    const stateRoot = join(home, '.local', 'state', 'local-agent-loop')
    const git = async (cwd: string, args: string[]) => {
      const res = await runChild('git', args, { cwd, timeoutMs: 60000 })
      assert.equal(res.code, 0, res.stderr)
      return res.stdout
    }
    const repo = join(home, 'repo')
    await mkdir(join(repo, 'test'), { recursive: true })
    await writeFile(join(repo, 'package.json'), '{"type":"module"}\n')
    await writeFile(join(repo, 'test', 'noop.test.js'), '')
    await git(home, ['init', '--initial-branch=main', 'repo'])
    await git(repo, ['config', 'user.email', 'test@localhost'])
    await git(repo, ['config', 'user.name', 'test'])
    await git(repo, ['add', '-A'])
    await git(repo, ['commit', '-m', 'seed'])

    process.env.FAKE_FAIL_FIRST = '0'
    delete process.env.FAKE_REVIEW_SEQUENCE
    const durably = createAgentDurably({ stateRoot })
    let ui: Awaited<ReturnType<typeof startUi>> | undefined
    try {
      await durably.migrate()
      // A check that never passes: the run stops as verification-failed and
      // keeps its worktree for a person to look at.
      const { id } = await durably.jobs.agentLoop.trigger({
        provider: 'fake',
        target: {
          kind: 'repo' as const,
          repoPath: repo,
          baseRef: 'HEAD',
          task: 'Change nothing that passes.',
          spec: null,
          dispositions: null,
          inputFiles: { task: null, spec: null, dispositions: null },
          issue: null,
          checkCommand: ['sh', '-c', 'exit 1'],
          setupCommand: null,
          publish: false,
        },
        maxIterations: 1,
        context: 'reuse',
      })
      await durably.init()
      await until(
        async () => (await durably.getRun(id))?.status === 'completed',
        'repository run stops',
      )
      await durably.stop()
      const workdir = join(stateRoot, 'runs', id, 'work')
      const branch = `factory/${id}`
      assert.ok(existsSync(workdir))

      const port = await freePort()
      ui = await startUi(home, port)
      const origin = `http://127.0.0.1:${port}`
      const token =
        /<meta name="loop-ui-token" content="([0-9a-f]{64})" \/>/.exec(
          (await get(port, '/')).body,
        )?.[1]
      assert.ok(token)
      const detail = () => api<RunDetailResponse>(port, `/api/runs/${id}`)
      const shown = (data: RunDetailResponse) =>
        htmlText(
          renderToStaticMarkup(createElement(RunScreen, { act: noAct, data })),
        )
      // Served once while the worktree is there: the finished report is
      // cached from here on.
      const first = await detail()
      assert.equal(first.report.worktree?.present, true)
      assert.equal(first.diagnosis.worktree?.present, true)
      assert.ok(!shown(first).includes(DETAIL.worktreeRemoved))
      // An unarchived stop is not pruned.
      const none = await demo(home, ['prune', '--delete-branches'])
      assert.equal(none.code, 0, none.stderr)
      assert.match(none.stdout, /^0 worktree\(s\)/)
      assert.match(none.stdout, /branches of 0 archived run\(s\)/)

      const archive = () =>
        get(port, `/api/runs/${id}/archive`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin,
            [TOKEN_HEADER]: token,
          },
          body: '{}',
        })
      // A locked worktree: git refuses, the run is archived anyway, and the
      // answer carries git's reason, which the page's notice shows.
      await git(repo, ['worktree', 'lock', workdir])
      const refused = await archive()
      assert.equal(refused.status, 200, refused.body)
      const result = JSON.parse(refused.body) as {
        changed: boolean
        worktreeRemoved: boolean
        warnings: string[]
      }
      assert.equal(result.changed, true)
      assert.equal(result.worktreeRemoved, false)
      assert.equal(result.warnings.length, 1)
      assert.match(result.warnings[0] ?? '', /locked/)
      assert.ok(existsSync(workdir))
      const notice = htmlText(
        renderToStaticMarkup(
          createElement(ActionNotice, {
            outcome: {
              request: {
                runId: id,
                name: first.name,
                action: 'archive',
                label: ACTION.archive,
              },
              result,
            },
          }),
        ),
      )
      assert.ok(notice.includes(ACTION_DONE.archive))
      assert.ok(notice.includes(ACTION_DONE.worktreeLeft))
      // git's own words, as the page escapes them.
      assert.ok(
        notice
          .replaceAll('&#x27;', "'")
          .replaceAll('&quot;', '"')
          .replaceAll('&amp;', '&')
          .includes(result.warnings[0] ?? '-'),
        notice,
      )
      // The cached detail reads the worktree again: it is still there, and
      // the page says how to remove it.
      const left = await detail()
      assert.equal(left.archived, true)
      assert.equal(left.report.worktree?.present, true)
      assert.equal(
        left.diagnosis.cleanup,
        'pnpm --filter example-local-agent-loop demo prune --apply',
      )
      const leftText = shown(left)
      assert.ok(leftText.includes(DETAIL.worktreeLeft))
      assert.ok(leftText.includes(DETAIL.worktreeLeftNote))
      assert.ok(leftText.includes(COPY.cleanupPruneNote))
      assert.ok(!leftText.includes(DETAIL.worktreeRemoved))
      // `status` offers the same forced removal.
      const leftStatus = await demo(home, ['status', '--run', id])
      assert.equal(leftStatus.code, 0, leftStatus.stderr)
      assert.equal(
        (JSON.parse(leftStatus.stdout) as { diagnosis: Diagnosis }).diagnosis
          .cleanup,
        left.diagnosis.cleanup,
      )

      // Unlocked, archiving again removes it.
      await git(repo, ['worktree', 'unlock', workdir])
      const archived = await archive()
      assert.equal(archived.status, 200, archived.body)
      assert.deepEqual(JSON.parse(archived.body), {
        changed: false,
        worktreeRemoved: true,
        deletedBranches: [],
        warnings: [],
      })
      assert.equal(existsSync(workdir), false)
      assert.ok(existsSync(join(stateRoot, 'runs', id, 'candidates')))

      // The same detail, from the cache, now says the worktree is gone and
      // never offers its path.
      const after = await detail()
      assert.equal(after.report.worktree?.present, false)
      assert.equal(after.diagnosis.worktree?.present, false)
      assert.equal(after.diagnosis.cleanup, null)
      const text = shown(after)
      assert.ok(text.includes(DETAIL.worktreeRemoved))
      assert.ok(text.includes(DETAIL.worktreeKept))
      assert.ok(!text.includes(workdir))
      // `status` and `report` say the same.
      const status = await demo(home, ['status', '--run', id])
      assert.equal(status.code, 0, status.stderr)
      assert.equal(
        (JSON.parse(status.stdout) as { diagnosis: Diagnosis }).diagnosis
          .worktree?.present,
        false,
      )
      const report = await demo(home, ['report', '--run', id])
      assert.match(report.stdout, /## Worktree\n\n- removed; /)

      // Branches go only with --delete-branches, and only after the dry
      // run lists them.
      const kept = await demo(home, ['prune', '--apply'])
      assert.equal(kept.code, 0, kept.stderr)
      assert.ok(await branchOf(repo, branch))
      const dry = await demo(home, ['prune', '--delete-branches'])
      assert.equal(dry.code, 0, dry.stderr)
      assert.match(dry.stdout, /^0 worktree\(s\) .*, 0 bytes in total:/)
      assert.match(dry.stdout, new RegExp(`  ${id}  ${branch}\n`))
      assert.match(dry.stdout, /dry run: nothing was removed/)
      assert.ok(await branchOf(repo, branch))
      const applied = await demo(home, [
        'prune',
        '--delete-branches',
        '--apply',
      ])
      assert.equal(applied.code, 0, applied.stderr)
      assert.match(
        applied.stdout,
        new RegExp(`deleted 1 branch\\(es\\): ${branch}`),
      )
      assert.equal(await branchOf(repo, branch), null)
    } finally {
      ui?.child.kill('SIGTERM')
      await durably.stop()
      await durably.db.destroy()
      delete process.env.FAKE_FAIL_FIRST
    }
  })
})

/** The commit a local branch points at, or null. */
async function branchOf(repo: string, branch: string): Promise<string | null> {
  const res = await runChild(
    'git',
    ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
    { cwd: repo, timeoutMs: 60000 },
  )
  return res.code === 0 ? res.stdout.trim() : null
}
