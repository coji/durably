/**
 * Two runs' timelines for the design page: one still implementing, one
 * waiting on a person. Between them every row state appears once. Then an
 * agent log as it is written, once it has ended, and once its file is gone.
 */
import type { LogView } from '../../components/trace/AttemptLog'
import { COMMON, DESIGN, TRACE_WORDS } from '../../glossary'
import { lensName, stageName } from '../../labels'
import type { Trace, TraceNode } from '../../server'
import { ORIGIN, STOPPED_CANDIDATE, USAGE } from './fixtures'

const min = (m: number) => m * 60_000
const at = (ms: number | null) =>
  ms === null ? null : new Date(ORIGIN + ms).toISOString()

type Spec = Partial<TraceNode> &
  Pick<TraceNode, 'id' | 'kind' | 'label' | 'state'>

function node(p: Spec): TraceNode {
  const startMs = p.startMs ?? null
  const endMs = p.endMs ?? null
  return {
    stage: null,
    iteration: null,
    open: false,
    startedAt: at(startMs),
    endedAt: at(endMs),
    durationMs: startMs !== null && endMs !== null ? endMs - startMs : null,
    attempts: 1,
    leaseGeneration: null,
    interruptionReason: null,
    timedOut: null,
    profile: null,
    usage: null,
    checkpoint: null,
    review: null,
    candidate: null,
    verificationLog: null,
    logAttemptId: null,
    agentLog: null,
    wait: null,
    children: [],
    ...p,
    startMs,
    endMs,
  }
}

const codex = {
  provider: 'codex',
  model: 'gpt-5.6-sol',
  effort: 'high',
  reportedModel: null,
}

const entry = (
  stage: string,
  iteration: number,
  from: number,
  to: number | null,
  extra: Partial<Spec> = {},
) =>
  node({
    id: `${stage}#${iteration}`,
    kind: 'entry',
    label: stageName(stage),
    stage,
    iteration,
    state: to === null ? 'running' : 'done',
    open: to === null,
    startMs: min(from),
    endMs: to === null ? null : min(to),
    checkpoint: to === null ? 'running' : 'completed',
    ...extra,
  })

const firstPass = node({
  id: 'iteration:1',
  kind: 'iteration',
  label: COMMON.nth(1),
  iteration: 1,
  state: 'done',
  startMs: min(3),
  endMs: min(14),
  children: [
    entry('code', 1, 3, 9, { profile: codex, usage: USAGE.known }),
    entry('verify', 1, 9, 11, {
      state: 'failed',
      attempts: 2,
      verificationLog: {
        stdoutPath: '/runs/01K6D2Q7/verify-1/stdout.log',
        stderrPath: '/runs/01K6D2Q7/verify-1/stderr.log',
        exitCode: 1,
      },
      children: [
        node({
          id: 'attempt:v1a',
          kind: 'attempt',
          label: TRACE_WORDS.attempt(1),
          stage: 'verify',
          iteration: 1,
          state: 'lost',
          startMs: min(9),
          endMs: null,
          leaseGeneration: 1,
          interruptionReason: 'lease-lost',
        }),
        node({
          id: 'attempt:v1b',
          kind: 'attempt',
          label: TRACE_WORDS.attempt(2),
          stage: 'verify',
          iteration: 1,
          state: 'failed',
          startMs: min(10),
          endMs: min(11),
          leaseGeneration: 2,
        }),
      ],
    }),
    // Beside the failing check: the review it ended (ADR-0029).
    entry('review', 1, 9, 10, {
      id: 'review#1-beside',
      label: lensName('edge-cases'),
      usage: USAGE.known,
      review: {
        lens: 'edge-cases',
        decision: '',
        notes: '',
        findings: null,
        status: 'cancelled',
        reason: 'superseded-by-verify',
      },
    }),
    node({
      id: 'idle#1',
      kind: 'entry',
      label: stageName('review'),
      stage: 'review',
      iteration: 1,
      state: 'interrupted',
      startMs: min(11),
      endMs: min(12),
      interruptionReason: 'cancelled',
    }),
    entry('review', 1, 12, 14, {
      label: lensName('correctness'),
      usage: USAGE.partial,
      review: {
        lens: 'correctness',
        decision: 'needsChanges',
        notes: 'formatCost が 0.004 を $0.00 と出している。',
        findings: {
          blocker: [
            {
              severity: 'blocker',
              title: '1セント未満の費用が 0 に見える',
              body: '',
            },
          ],
          nonBlocker: [],
          counts: { blocker: 1, nonBlocker: 2 },
        },
      },
    }),
  ],
})

const setup = entry('setup', 0, 0, 1, { iteration: null })

/** The second pass while its implementation is still running. */
const secondPassRunning = node({
  id: 'iteration:2',
  kind: 'iteration',
  label: COMMON.nth(2),
  iteration: 2,
  state: 'running',
  open: true,
  startMs: min(14),
  children: [
    node({
      id: 'gap#2',
      kind: 'entry',
      label: stageName('policy'),
      stage: 'policy',
      iteration: 2,
      state: 'idle',
      startMs: min(14),
      endMs: min(15),
    }),
    entry('code', 2, 15, null, {
      profile: codex,
      usage: USAGE.unknown,
      logAttemptId: 'code-2',
      agentLog: { path: '/runs/01K6D2Q7/agent-logs/01K6D2S9.log' },
    }),
  ],
})

/** The second pass once review passed, waiting for a person to approve. */
const secondPassWaiting = node({
  id: 'iteration:2',
  kind: 'iteration',
  label: COMMON.nth(2),
  iteration: 2,
  state: 'waiting',
  open: true,
  startMs: min(14),
  children: [
    // A repair stopped at its idle limit, whose unfinished work was sealed.
    entry('code', 2, 14, 18, {
      profile: codex,
      usage: USAGE.known,
      timedOut: STOPPED_CANDIDATE.timedOut,
      candidate: STOPPED_CANDIDATE,
    }),
    entry('verify', 2, 18, 19),
    entry('review', 2, 19, 21, { label: lensName('edge-cases') }),
    node({
      id: 'approve#2',
      kind: 'entry',
      label: stageName('approve'),
      stage: 'approve',
      iteration: 2,
      state: 'waiting',
      open: true,
      startMs: min(21),
      attempts: 0,
      wait: { outcome: null, inputWaitMs: null, executionSlotWaitMs: null },
    }),
  ],
})

function trace(state: 'running' | 'waiting', pass: TraceNode): Trace {
  return {
    startedAt: at(0) as string,
    spanMs: min(24),
    open: true,
    root: node({
      id: 'run',
      kind: 'run',
      label: TRACE_WORDS.run,
      state,
      open: true,
      startMs: 0,
      attempts: 0,
      children: [setup, firstPass, pass],
    }),
  }
}

export const TRACES = {
  running: trace('running', secondPassRunning),
  waiting: trace('waiting', secondPassWaiting),
}

export const TOTALS = {
  leadTimeMs: null,
  invocations: 6,
  totalTokens: 5_935_856,
  costUsd: 7.353984,
  complete: false,
}

const LOG_TEXT = [
  'formatCost が 1 セント未満を $0.00 と出している箇所を探します。',
  '> exec_command rg -n "formatCost" src',
  '1 セント未満は有効数字 2 桁で出すように直します。',
  '> apply_patch src/engine/format.ts',
  '> exec_command pnpm test -- format\n',
].join('\n')

/** An agent log as the inspector shows it: live, ended, and gone. */
export const LOG_VIEWS: { label: string; view: LogView }[] = [
  {
    label: DESIGN.state.logLive,
    view: { text: LOG_TEXT, state: 'live', trimmed: false },
  },
  {
    label: DESIGN.state.logDone,
    view: {
      text: `${LOG_TEXT}テストが通りました。1 セント未満の費用も読めます。\n`,
      state: 'done',
      trimmed: false,
    },
  },
  {
    label: DESIGN.state.logMissing,
    view: { text: '', state: 'missing', trimmed: false },
  },
]
