import type { FailureClassification } from '../../../engine/failure-reasons'
import type { Diagnosis, Task } from '../../../engine/status'
import {
  ActionNotice,
  type Act,
  type ActionName,
} from '../../components/ActionNotice'
import { RunActions, type ActionTarget } from '../../components/RunActions'
import { ArchivedMark } from '../../components/SupersededMark'
import { ACTION, DESIGN } from '../../glossary'
import type { RunRow } from '../../server'
import { TaskRuns } from '../list/TaskRuns'
import { NOW, PIPELINES, TASKS } from './fixtures'
import { State } from './Specimen'

/** The design page sends nothing: every action only says it is done. */
const act: Act = async () => true

const DEMO = 'pnpm --filter example-local-agent-loop demo'
const WAIT = '01K6D2R0000000000000WAIT1'
const [approval, stopped] = TASKS

const diagnosis = (
  kind: Diagnosis['kind'],
  next: string[],
  failure?: Pick<FailureClassification, 'kind' | 'retryable'>,
): Diagnosis => ({
  kind,
  reason: '',
  next,
  cleanup: null,
  worktree: null,
  ...(failure
    ? {
        failure: {
          ...failure,
          reason: '',
          humanCheck: '',
          next,
          details: [],
          reload: 'none',
          setupUntracked: false,
        },
      }
    : {}),
})

const target = (
  task: (typeof TASKS)[number],
  over: Partial<ActionTarget> & Pick<ActionTarget, 'diagnosis'>,
): ActionTarget => ({
  id: task.id,
  name: task.name,
  archived: false,
  archiveCommand: null,
  waitId: null,
  reviewHighlights: null,
  ...over,
})

const decide = (id: string) => [
  `${DEMO} report --run ${id}  # read the reviews first`,
  `${DEMO} approve --run ${id} --wait ${WAIT}`,
  `${DEMO} reject --run ${id} --wait ${WAIT}`,
]

const approvalRun = target(approval, {
  diagnosis: diagnosis('approval', decide(approval.id)),
  waitId: WAIT,
  reviewHighlights: {
    rounds: 2,
    last: 'passed',
    lastPasses: [],
    earlier: {
      count: 1,
      titles: ['The cost column still prints six decimals'],
      verdicts: [],
    },
    left: {
      count: 1,
      titles: ['Name the rounding rule in the README'],
      verdicts: [],
    },
    open: { count: 0, titles: [], verdicts: [] },
  },
})

const stoppedRun = target(stopped, {
  diagnosis: diagnosis(
    'stopped',
    [
      `${DEMO} report --run ${stopped.id} --format json`,
      `${DEMO} retrigger --run ${stopped.id}`,
    ],
    { kind: 'verification-failed', retryable: true },
  ),
  archiveCommand: `${DEMO} archive --run ${stopped.id}`,
})

const RUNS: [keyof typeof DESIGN.state, ActionTarget, ActionName?][] = [
  ['approval', approvalRun],
  ['approveAsking', approvalRun, 'approve'],
  [
    'specApproval',
    target(approval, {
      diagnosis: diagnosis('spec-approval', [
        ...decide(approval.id),
        `${DEMO} spec-revise --run ${approval.id} --notes-file <file>  # fix it once more with your notes`,
      ]),
      waitId: WAIT,
    }),
  ],
  [
    'specRevise',
    target(approval, {
      diagnosis: diagnosis('spec-approval', [
        ...decide(approval.id),
        `${DEMO} spec-revise --run ${approval.id} --notes-file <file>`,
      ]),
      waitId: WAIT,
    }),
    'spec-revise',
  ],
  ['stopped', stoppedRun],
  ['retriggerAsking', stoppedRun, 'retrigger'],
  ['archiveAsking', stoppedRun, 'archive'],
  [
    'stoppedNoRetry',
    target(stopped, {
      diagnosis: diagnosis('stopped', [`${DEMO} status --run ${stopped.id}`], {
        kind: 'uncertain-invocation',
        retryable: false,
      }),
      archiveCommand: `${DEMO} archive --run ${stopped.id}`,
    }),
  ],
  [
    'archived',
    target(stopped, {
      diagnosis: diagnosis('stopped', [], {
        kind: 'uncertain-invocation',
        retryable: false,
      }),
      archived: true,
      archiveCommand: `${DEMO} unarchive --run ${stopped.id}`,
    }),
  ],
]

/**
 * A task whose first run stopped and was archived, and whose repair
 * finished: the archived run offers its way back in the task's runs.
 */
const REPAIR = '01K6D2Q7XB3M9RKT4WREPAR1'
const runRow = (over: Partial<RunRow> & Pick<RunRow, 'id'>): RunRow => ({
  ...target(stopped, { diagnosis: diagnosis('finished', []) }),
  status: 'completed',
  createdAt: '2026-09-30T09:02:00.000Z',
  uncertainCall: false,
  needsHuman: false,
  live: null,
  conclusion: 'approved',
  leadTimeMs: 1_104_000,
  costUsd: 3.12,
  pipeline: PIPELINES.done,
  ...over,
})
const ARCHIVED_ROWS = new Map(
  [
    runRow({
      ...stoppedRun,
      diagnosis: diagnosis('stopped', [], {
        kind: 'verification-failed',
        retryable: true,
      }),
      archived: true,
      archiveCommand: `${DEMO} unarchive --run ${stopped.id}`,
      status: 'failed',
      conclusion: null,
      createdAt: '2026-09-30T08:31:00.000Z',
      leadTimeMs: 408_000,
      costUsd: 1.25,
    }),
    runRow({ id: REPAIR }),
  ].map((r) => [r.id, r]),
)
const taskRun = (id: string, repair: number | null, archived: boolean) => ({
  id,
  parentId: repair === null ? null : stopped.id,
  kind: archived ? ('stopped' as const) : ('finished' as const),
  approved: !archived,
  repair,
  superseded: false,
  archived,
  attention: 'done' as const,
})
const ARCHIVED_TASK: Task = {
  id: stopped.id,
  attention: 'done',
  representative: REPAIR,
  runs: [taskRun(stopped.id, null, true), taskRun(REPAIR, 1, false)],
  fake: false,
  latestAt: '2026-09-30T09:02:00.000Z',
  total: { leadTimeMs: 1_512_000, costUsd: 4.37 },
}

/**
 * Each run's actions as the detail page leads with them, an archived run's
 * way back among its task's runs, then what an action came to, an archive
 * that left the worktree, and what a refused one says.
 */
export function RunActionStates() {
  return (
    <>
      {RUNS.map(([state, run, asking]) => (
        <State key={state} label={DESIGN.state[state]}>
          <div className="flex flex-col gap-2">
            {run.archived ? <ArchivedMark /> : null}
            <RunActions run={run} act={act} lead initialAsking={asking} />
          </div>
        </State>
      ))}
      <State label={DESIGN.state.archivedRun}>
        <TaskRuns
          task={ARCHIVED_TASK}
          rows={ARCHIVED_ROWS}
          now={NOW}
          name={stopped.name}
          act={act}
        />
      </State>
      <State label={DESIGN.state.result}>
        <ActionNotice
          outcome={{
            request: {
              runId: stopped.id,
              name: stopped.name,
              action: 'archive',
              label: ACTION.archive,
            },
            result: { changed: true },
          }}
          onDismiss={() => {}}
        />
      </State>
      <State label={DESIGN.state.archiveWarning}>
        <ActionNotice
          outcome={{
            request: {
              runId: stopped.id,
              name: stopped.name,
              action: 'archive',
              label: ACTION.archive,
            },
            result: {
              changed: true,
              warnings: [
                `worktree /Users/me/.local/state/local-agent-loop/runs/${stopped.id}/work: git worktree remove --force failed with code 128: fatal: cannot remove a locked working tree`,
              ],
            },
          }}
          onDismiss={() => {}}
        />
      </State>
      <State label={DESIGN.state.failed}>
        <ActionNotice
          outcome={{
            request: {
              runId: approval.id,
              name: approval.name,
              action: 'approve',
              label: ACTION.approve,
            },
            error: `run ${approval.id} is not waiting on wait ${WAIT} (the wait is resolved); refusing a second decision`,
          }}
          onDismiss={() => {}}
        />
      </State>
    </>
  )
}
