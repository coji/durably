/**
 * Static data for the design page. Task names, IDs, commands and review
 * notes here are data, as the API would return them; the page's own words
 * still come from the glossary. Nothing here is read from the API.
 */
import type { UsageTotals } from '../../../engine/report'
import { PIPELINE_WORDS } from '../../glossary'
import { stageName } from '../../labels'
import type {
  LineageRun,
  Pipeline,
  PipelineStage,
  PipelineState,
} from '../../server'

export const NOW = '2026-09-30T09:24:00.000Z'
export const ORIGIN = Date.parse('2026-09-30T09:00:00.000Z')

export const TASKS = [
  {
    id: '01K6D2Q7XB3M9RKT4WAPPROV',
    name: '#261 レポートの費用を小数2桁で出す',
  },
  {
    id: '01K6D2Q7XB3M9RKT4WSTOPPD',
    name: '検証コマンドの時間切れを設定できるようにする',
  },
  {
    id: '01K6D2Q7XB3M9RKT4WRUNNNG',
    name: '#258 ワーカーのロックを state root ごとにする',
  },
  { id: '01K6D2Q7XB3M9RKT4WFINISH', name: '同梱題材: calc の add を直す' },
] as const

export const COMMANDS = [
  'pnpm demo approve --run 01K6D2Q7XB3M9RKT4WAPPROV --wait 01K6D2R0000000000000WAIT1',
  'pnpm demo report --run 01K6D2Q7XB3M9RKT4WAPPROV  # read the reviews first',
  'pnpm demo retrigger --run 01K6D2Q7XB3M9RKT4WSTOPPD --reload-config',
]

const ORDER = [
  'setup',
  'baseline',
  'triage',
  'code',
  'verify',
  'review',
  'approve',
  'finish',
]

/** A pipeline at `at` in `state`, every earlier stage done once. */
function pipeline(
  at: string | null,
  state: PipelineState,
  repeats: Record<string, number> = {},
): Pipeline {
  const index = at === null ? ORDER.length : ORDER.indexOf(at)
  const stages: PipelineStage[] = ORDER.map((stage, i) => ({
    stage,
    state: i < index ? 'done' : i === index ? state : 'not-reached',
    count: i <= index ? (repeats[stage] ?? 1) : 0,
  }))
  const name = at === null ? '' : stageName(at)
  const last =
    at === null
      ? PIPELINE_WORDS.finished
      : state === 'stopped'
        ? PIPELINE_WORDS.stoppedAt(name)
        : state === 'running'
          ? PIPELINE_WORDS.runningAt(name)
          : state === 'waiting'
            ? PIPELINE_WORDS.waitingAt(name)
            : PIPELINE_WORDS.at(name)
  return { stages, label: PIPELINE_WORDS.sentence([last]) }
}

export const PIPELINES = {
  waiting: pipeline('approve', 'waiting', { code: 2, verify: 2, review: 2 }),
  stopped: pipeline('verify', 'stopped', { code: 3, verify: 3 }),
  running: pipeline('code', 'running'),
  current: pipeline('triage', 'current'),
  done: pipeline(null, 'done'),
  autoApproved: autoApproved(),
}

/** A finished run whose settings approved it, so approval had no wait. */
function autoApproved(): Pipeline {
  const done = pipeline(null, 'done')
  return {
    stages: done.stages.map((s) =>
      s.stage === 'approve' ? { ...s, state: 'auto', count: 0 } : s,
    ),
    label: PIPELINE_WORDS.sentence([
      PIPELINE_WORDS.autoApproved,
      PIPELINE_WORDS.finished,
    ]),
  }
}

/** A first run stopped at review, a repair replaced, and one approved. */
export const LINEAGE: LineageRun[] = [
  {
    id: TASKS[1].id,
    parentId: null,
    kind: 'finished',
    approved: true,
    repair: null,
    superseded: false,
    attention: 'done',
    status: 'completed',
    conclusion: 'approved',
    createdAt: '2026-09-29T09:00:00.000Z',
  },
  {
    id: '01K6D2Q7XB3M9RKT4WREPAR1',
    parentId: TASKS[1].id,
    kind: 'stopped',
    approved: false,
    repair: 1,
    superseded: true,
    attention: 'done',
    status: 'completed',
    conclusion: 'review-cap-reached',
    createdAt: '2026-09-30T08:10:00.000Z',
  },
  {
    id: '01K6D2Q7XB3M9RKT4WREPAR2',
    parentId: TASKS[1].id,
    kind: 'finished',
    approved: true,
    repair: 2,
    superseded: false,
    attention: 'done',
    status: 'completed',
    conclusion: 'approved',
    createdAt: '2026-09-30T08:52:00.000Z',
  },
]

function usage(
  total: number,
  cost: number | null,
  complete = true,
): UsageTotals {
  return {
    invocations: 2,
    inputTokens: Math.round(total * 0.8),
    cacheReadTokens: Math.round(total * 0.6),
    cacheWriteTokens: null,
    outputTokens: Math.round(total * 0.2),
    totalTokens: total,
    costUsd: cost,
    complete,
    costComplete: cost !== null,
  }
}

export const USAGE = {
  known: usage(5_123_456, 6.443984),
  partial: usage(812_400, 0.91, false),
  unknown: {
    ...usage(0, null, false),
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
  },
}
