/**
 * Why a run is where it is, and what a human does next. `demo status` and the
 * web UI both read this one function, so the two describe a run the same way.
 * Only the CLI looks for a worker: it leaves out the advice to start one
 * while one runs, which the web UI always offers.
 */
import { existsSync } from 'node:fs'

import type { AnyDurably, Run } from '@coji/durably'

import {
  classifyRun,
  DEMO,
  retryText,
  uncertainCheckpoints,
  type FailureClassification,
} from './failure-reasons.js'
import { TERMINAL_STATUSES } from './terminal.js'

/**
 * Where an open or stopped run stands. Only `approval` (a candidate),
 * `spec-approval` (a spec the spec reviewers still block), `stopped` and
 * `other-wait` are waiting on a person; `running` is a healthy worker and
 * must never be shown as needing one.
 */
export type DiagnosisKind =
  | 'pending'
  | 'running'
  | 'lease-expired'
  | 'approval'
  | 'spec-approval'
  | 'decided'
  | 'other-wait'
  | 'stopped'
  | 'finished'

const HUMAN_KINDS: readonly DiagnosisKind[] = [
  'approval',
  'spec-approval',
  'stopped',
  'other-wait',
]

/** True when the next step is a person's decision, not a worker's. */
export function needsHuman(kind: DiagnosisKind): boolean {
  return HUMAN_KINDS.includes(kind)
}

/**
 * Where a task stands, from its runs: a person decides (`decision`), a run
 * stopped and nothing replaced it (`stop`), a worker has it or will
 * (`active`), or nothing is left to do (`done`). In that order a task list
 * shows them.
 */
export type TaskAttention = 'decision' | 'stop' | 'active' | 'done'

const ATTENTION_ORDER: readonly TaskAttention[] = [
  'decision',
  'stop',
  'active',
  'done',
]

/** Only a decision or an unresolved stop puts a task at the top of the list. */
export function needsAttention(attention: TaskAttention): boolean {
  return attention === 'decision' || attention === 'stop'
}

/** One run as the task list reads it. */
export interface TaskRunInput {
  id: string
  createdAt: string
  /** The run it repairs, from `repairParentId`; null for a first run. */
  parentId: string | null
  kind: DiagnosisKind
  /** The run's `summary.success`: completed with its candidate approved. */
  approved: boolean
}

export interface TaskRun {
  id: string
  parentId: string | null
  kind: DiagnosisKind
  approved: boolean
  /**
   * A repair run that did not get approved while a later repair of the same
   * parent did: it no longer needs a person.
   */
  superseded: boolean
  attention: TaskAttention
}

/**
 * A first run and every repair run below it: one piece of work, however
 * many runs it took. `demo status` and the web UI's list both read tasks
 * from `groupTasks`, so they agree on the task, its run and its place.
 */
export interface Task {
  /** The first run's ID. */
  id: string
  attention: TaskAttention
  /** The run that shows the task's state and next step. */
  representative: string
  /** Oldest first, so the first run leads. */
  runs: TaskRun[]
  /** When the task's newest run was created. */
  latestAt: string
}

const OPEN_KINDS: readonly DiagnosisKind[] = [
  'pending',
  'running',
  'lease-expired',
  'decided',
]

function attentionOf(kind: DiagnosisKind, superseded: boolean): TaskAttention {
  if (superseded) return 'done'
  if (kind === 'stopped') return 'stop'
  if (needsHuman(kind)) return 'decision'
  if (OPEN_KINDS.includes(kind)) return 'active'
  return 'done'
}

const newestFirst = (x: { createdAt: string }, y: { createdAt: string }) =>
  Date.parse(y.createdAt) - Date.parse(x.createdAt)

/**
 * Runs as tasks, in the order a list shows them: decisions, then unresolved
 * stops, then open work, then the rest, each newest first. A run whose
 * parent is not among `runs` starts a task of its own.
 */
export function groupTasks(runs: TaskRunInput[]): Task[] {
  const byId = new Map(runs.map((r) => [r.id, r]))
  const rootOf = (run: TaskRunInput): string => {
    const seen = new Set<string>()
    let at = run
    while (at.parentId && byId.has(at.parentId) && !seen.has(at.id)) {
      seen.add(at.id)
      at = byId.get(at.parentId) as TaskRunInput
    }
    return at.id
  }
  const superseded = (run: TaskRunInput): boolean =>
    run.parentId !== null &&
    !run.approved &&
    !OPEN_KINDS.includes(run.kind) &&
    runs.some(
      (other) =>
        other.parentId === run.parentId &&
        other.approved &&
        Date.parse(other.createdAt) > Date.parse(run.createdAt),
    )
  const groups = new Map<string, TaskRunInput[]>()
  for (const run of runs) {
    const root = rootOf(run)
    groups.set(root, [...(groups.get(root) ?? []), run])
  }
  const tasks = [...groups].map(([id, list]): Task => {
    const ordered = [...list].sort((x, y) => -newestFirst(x, y))
    const taskRuns = ordered.map((run) => {
      const replaced = superseded(run)
      return {
        id: run.id,
        parentId: run.parentId,
        kind: run.kind,
        approved: run.approved,
        superseded: replaced,
        attention: attentionOf(run.kind, replaced),
      }
    })
    const attention =
      ATTENTION_ORDER.find((a) => taskRuns.some((r) => r.attention === a)) ??
      'done'
    const newest = [...ordered].reverse()
    const representative =
      newest.find((run) =>
        taskRuns.some(
          (r) =>
            r.id === run.id &&
            r.attention === attention &&
            (attention !== 'done' || !r.superseded),
        ),
      ) ??
      newest[0] ??
      ordered[0]
    return {
      id,
      attention,
      representative: representative?.id ?? id,
      runs: taskRuns,
      latestAt: newest[0]?.createdAt ?? '',
    }
  })
  return tasks.sort(
    (x, y) =>
      ATTENTION_ORDER.indexOf(x.attention) -
        ATTENTION_ORDER.indexOf(y.attention) ||
      newestFirst({ createdAt: x.latestAt }, { createdAt: y.latestAt }) ||
      (x.id < y.id ? 1 : -1),
  )
}

export interface Diagnosis {
  kind: DiagnosisKind
  reason: string
  next: string[]
  /** Set only for a stopped run. */
  failure?: FailureClassification
  /** Set only for a decided run: the decision its approval wait recorded. */
  decision?: string
  /** A non-forcing worktree removal, for a finished repo run's worktree. */
  cleanup: string | null
}

/** Quote for a POSIX shell, so a printed command pastes safely. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * Say why a run is where it is and what to do next. Open runs are described
 * from their status, lease and approval wait; stopped runs from the failure
 * table. Nothing here runs a command or changes the run.
 */
export async function diagnose(
  durably: DiagnoseSource,
  run: Run,
  now: number,
  worker?: WorkerSeen,
): Promise<Diagnosis> {
  return (await diagnoseRun(durably, run, now, undefined, worker)).diagnosis
}

/**
 * Whether a worker holds the state root's lock. Left out, the diagnosis does
 * not know, and says what to do either way.
 */
export interface WorkerSeen {
  /** Null when the lock could not be read: treated as not known to run. */
  running: boolean | null
}

/**
 * When the worker last renewed this run's lease: the lease's end less its
 * length. Only a leased run with a lease still in force has one; a pending,
 * waiting or finished run has none, even while a worker is up, because an
 * idle worker renews nothing.
 */
export function lastLeaseRenewal(
  run: Pick<Run, 'status' | 'leaseExpiresAt'>,
  now: number,
  leaseMs: number,
): string | null {
  if (run.status !== 'leased' || !run.leaseExpiresAt) return null
  const expires = Date.parse(run.leaseExpiresAt)
  if (!Number.isFinite(expires) || expires < now) return null
  return new Date(expires - leaseMs).toISOString()
}

type DiagnoseSource = Pick<AnyDurably, 'getStepAttempts' | 'getWaits'> & {
  storage: Pick<AnyDurably['storage'], 'getCompletedStep'>
}

/**
 * `diagnose`, plus the fact behind a lease-expired reason that the web UI
 * words for itself: whether an agent call is left without a completion.
 * `failure` skips classifying the run again when the caller already has it.
 */
export async function diagnoseRun(
  durably: DiagnoseSource,
  run: Run,
  now: number,
  known?: { failure: FailureClassification | null },
  worker?: WorkerSeen,
): Promise<{ diagnosis: Diagnosis; uncertainCall: boolean }> {
  let uncertainCall = false
  const diagnosis = await describe()
  return { diagnosis, uncertainCall }

  async function describe(): Promise<Diagnosis> {
    const setup = (await durably.storage.getCompletedStep(run.id, 'setup'))
      ?.output as {
      target?: { kind?: string; repoPath?: string; workdir?: string }
      checkpointsDir?: string
    } | null
    const terminal = TERMINAL_STATUSES.includes(run.status)
    const target = setup?.target
    // Only the worktree the setup step recorded, and only when it is still
    // there: a subject run has none, and a run that failed before setup
    // finished has no record to trust.
    const cleanup =
      terminal &&
      target?.kind === 'repo' &&
      target.repoPath &&
      target.workdir &&
      existsSync(target.workdir)
        ? `git -C ${shellQuote(target.repoPath)} worktree remove ${shellQuote(target.workdir)}`
        : null
    const show = `${DEMO} status --run ${run.id}`
    const startCmd = `${DEMO} worker`
    // Offered unless a worker is known to run; the words stay those the
    // web UI, which does not look for a worker, prints too.
    const startWorker = worker?.running
      ? []
      : [`${startCmd}  # if none is running`]
    if (run.status === 'pending')
      return {
        kind: 'pending',
        reason: 'queued; no worker has picked it up yet',
        next: [...startWorker, show],
        cleanup,
      }
    if (run.status === 'leased') {
      const expires = run.leaseExpiresAt ? Date.parse(run.leaseExpiresAt) : NaN
      if (Number.isFinite(expires) && expires < now) {
        const reason = `lease expired at ${run.leaseExpiresAt}; the worker holding it stopped or lost contact`
        // A reclaimed run refuses an agent call that started without a
        // completion, so it will stop there rather than resume past it.
        const uncertain = uncertainCheckpoints(
          setup?.checkpointsDir ?? null,
          await durably.getStepAttempts(run.id),
        )
        const stuck = uncertain.length > 0
        uncertainCall = stuck
        return {
          kind: 'lease-expired',
          reason: stuck
            ? `${reason}; an agent call it started has no completed checkpoint`
            : reason,
          next: [
            // The running worker reclaims it on its own; only an absent one
            // has to be started.
            ...(worker?.running
              ? []
              : [
                  stuck
                    ? `${startCmd}  # the reclaimed run stops at that call for a human to check`
                    : `${startCmd}  # a worker reclaims the run and resumes it from its checkpoints`,
                ]),
            show,
          ],
          cleanup,
        }
      }
      return {
        kind: 'running',
        reason: `a worker is running it (lease held until ${run.leaseExpiresAt ?? 'unknown'})`,
        next: [show],
        cleanup,
      }
    }
    if (run.status === 'waiting') {
      const waits = await durably.getWaits(run.id)
      const wait = waits.find((w) => w.id === run.waitingOnWaitId)
      // Approved or rejected, but no worker has picked the run up yet.
      const decided = (w: NonNullable<typeof wait>, subject: string) => {
        const decision = (w.payload as { decision?: unknown } | null)?.decision
        return {
          kind: 'decided' as const,
          ...(typeof decision === 'string' ? { decision } : {}),
          reason: `the decision on ${subject} is recorded (${typeof decision === 'string' ? decision : w.outcome}); a worker resumes the run`,
          next: [...startWorker, show],
          cleanup,
        }
      }
      const candidateId = (
        wait?.metadata as { candidateId?: unknown } | null | undefined
      )?.candidateId
      if (wait && typeof candidateId === 'string') {
        if (wait.status === 'resolved')
          return decided(wait, `candidate ${candidateId}`)
        if (wait.status === 'pending')
          return {
            kind: 'approval',
            reason: `waiting for human approval of candidate ${candidateId}`,
            next: [
              `${DEMO} report --run ${run.id}  # read the reviews first`,
              `${DEMO} approve --run ${run.id} --wait ${wait.id}`,
              `${DEMO} reject --run ${run.id} --wait ${wait.id}`,
            ],
            cleanup,
          }
      }
      const spec = wait?.metadata as {
        kind?: unknown
        specSha256?: unknown
        round?: unknown
      } | null
      if (wait && spec?.kind === 'spec-blocked') {
        const version =
          typeof spec.specSha256 === 'string'
            ? spec.specSha256.slice(0, 12)
            : 'unknown'
        if (wait.status === 'resolved') return decided(wait, `spec ${version}`)
        if (wait.status === 'pending')
          return {
            kind: 'spec-approval',
            reason: `the spec reviewers still block spec ${version} after round ${typeof spec.round === 'number' ? spec.round : 'unknown'}; waiting for a human decision on it`,
            next: [
              `${DEMO} report --run ${run.id}  # read the spec reviews first`,
              `${DEMO} approve --run ${run.id} --wait ${wait.id}  # go on with the spec as it is`,
              `${DEMO} spec-revise --run ${run.id} --notes-file <file>  # fix it once more with your notes`,
              `${DEMO} reject --run ${run.id} --wait ${wait.id}  # stop before any implementation`,
            ],
            cleanup,
          }
      }
      return {
        kind: 'other-wait',
        reason: 'waiting on an input that is not a candidate approval',
        next: [`${DEMO} waits --run ${run.id}`],
        cleanup,
      }
    }
    const failure = known ? known.failure : await classifyRun(durably, run)
    if (failure)
      return {
        kind: 'stopped',
        reason: `${failure.kind}: ${failure.reason}`,
        next: failure.next,
        failure,
        // The worktree is evidence a human has to inspect first.
        cleanup: failure.kind === 'uncertain-invocation' ? null : cleanup,
      }
    const conclusion = (run.output as { conclusion?: string } | null)
      ?.conclusion
    return {
      kind: 'finished',
      reason: `finished: ${conclusion ?? run.status}`,
      next: [],
      cleanup,
    }
  }
}

export function diagnosisLines(run: Run, d: Diagnosis): string[] {
  const lines = [`${run.id}  ${run.status}  (created ${run.createdAt})`]
  lines.push(`  reason:  ${d.reason}`)
  if (d.failure) {
    lines.push(`  retry:   ${retryText(d.failure.retryable)}`)
    lines.push(`  check:   ${d.failure.humanCheck}`)
    for (const detail of d.failure.details) lines.push(`  detail:  ${detail}`)
  }
  d.next.forEach((n, i) =>
    lines.push(`  ${i === 0 ? 'next:' : '     '}    ${n}`),
  )
  if (d.cleanup)
    lines.push(
      `  cleanup: ${d.cleanup}  # keeps the branch; refuses a worktree with changes`,
    )
  return lines
}
