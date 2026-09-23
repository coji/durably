/**
 * Why a run is where it is, and what a human does next. `demo status` and the
 * web UI both read this one function, so the two never describe the same run
 * differently or offer different commands.
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

/**
 * Where an open or stopped run stands. Only `approval`, `stopped` and
 * `other-wait` are waiting on a person; `running` is a healthy worker and
 * must never be shown as needing one.
 */
export type DiagnosisKind =
  | 'pending'
  | 'running'
  | 'lease-expired'
  | 'approval'
  | 'decided'
  | 'other-wait'
  | 'stopped'
  | 'finished'

const HUMAN_KINDS: readonly DiagnosisKind[] = [
  'approval',
  'stopped',
  'other-wait',
]

/** True when the next step is a person's decision, not a worker's. */
export function needsHuman(kind: DiagnosisKind): boolean {
  return HUMAN_KINDS.includes(kind)
}

export interface Diagnosis {
  kind: DiagnosisKind
  /** False for a run a human already decided, shown only for its cleanup. */
  needsAttention: boolean
  reason: string
  next: string[]
  /** Set only for a stopped run. */
  failure?: FailureClassification
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
  durably: Pick<AnyDurably, 'storage' | 'getStepAttempts' | 'getWaits'>,
  run: Run,
  now: number,
): Promise<Diagnosis> {
  const setup = (await durably.storage.getCompletedStep(run.id, 'setup'))
    ?.output as {
    target?: { kind?: string; repoPath?: string; workdir?: string }
    checkpointsDir?: string
  } | null
  const terminal = ['completed', 'failed', 'cancelled'].includes(run.status)
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
  const worker = `${DEMO} worker`
  if (run.status === 'pending')
    return {
      kind: 'pending',
      needsAttention: true,
      reason: 'queued; no worker has picked it up yet',
      next: [`${worker}  # if none is running`, show],
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
      if (uncertain.length > 0)
        return {
          kind: 'lease-expired',
          needsAttention: true,
          reason: `${reason}; an agent call it started has no completed checkpoint`,
          next: [
            `${worker}  # the reclaimed run stops at that call for a human to check`,
            show,
          ],
          cleanup,
        }
      return {
        kind: 'lease-expired',
        needsAttention: true,
        reason,
        next: [
          `${worker}  # a worker reclaims the run and resumes it from its checkpoints`,
          show,
        ],
        cleanup,
      }
    }
    return {
      kind: 'running',
      needsAttention: true,
      reason: `a worker is running it (lease held until ${run.leaseExpiresAt ?? 'unknown'})`,
      next: [show],
      cleanup,
    }
  }
  if (run.status === 'waiting') {
    const waits = await durably.getWaits(run.id)
    const wait = waits.find((w) => w.id === run.waitingOnWaitId)
    const candidateId = (
      wait?.metadata as { candidateId?: unknown } | null | undefined
    )?.candidateId
    if (wait && typeof candidateId === 'string') {
      // Approved or rejected, but no worker has picked the run up yet.
      if (wait.status === 'resolved') {
        const decision = (wait.payload as { decision?: unknown } | null)
          ?.decision
        return {
          kind: 'decided',
          needsAttention: true,
          reason: `the decision on candidate ${candidateId} is recorded (${typeof decision === 'string' ? decision : wait.outcome}); a worker resumes the run`,
          next: [`${worker}  # if none is running`, show],
          cleanup,
        }
      }
      if (wait.status === 'pending')
        return {
          kind: 'approval',
          needsAttention: true,
          reason: `waiting for human approval of candidate ${candidateId}`,
          next: [
            `${DEMO} report --run ${run.id}  # read the reviews first`,
            `${DEMO} approve --run ${run.id} --wait ${wait.id}`,
            `${DEMO} reject --run ${run.id} --wait ${wait.id}`,
          ],
          cleanup,
        }
    }
    return {
      kind: 'other-wait',
      needsAttention: true,
      reason: 'waiting on an input that is not a candidate approval',
      next: [`${DEMO} waits --run ${run.id}`],
      cleanup,
    }
  }
  const failure = await classifyRun(durably, run)
  if (failure)
    return {
      kind: 'stopped',
      needsAttention: true,
      reason: `${failure.kind}: ${failure.reason}`,
      next: failure.next,
      failure,
      // The worktree is evidence a human has to inspect first.
      cleanup: failure.kind === 'uncertain-invocation' ? null : cleanup,
    }
  const conclusion = (run.output as { conclusion?: string } | null)?.conclusion
  return {
    kind: 'finished',
    needsAttention: false,
    reason: `finished: ${conclusion ?? run.status}`,
    next: [],
    cleanup,
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
