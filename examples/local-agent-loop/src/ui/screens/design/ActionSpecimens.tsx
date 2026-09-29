import type { FailureClassification } from '../../../engine/failure-reasons'
import type { Diagnosis } from '../../../engine/status'
import {
  ActionNotice,
  type Act,
  type ActionName,
} from '../../components/ActionNotice'
import { RunActions, type ActionTarget } from '../../components/RunActions'
import { ArchivedMark } from '../../components/SupersededMark'
import { ACTION, DESIGN } from '../../glossary'
import { TASKS } from './fixtures'
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
 * Each run's actions as the detail page leads with them, then what an
 * action came to and what a refused one says.
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
