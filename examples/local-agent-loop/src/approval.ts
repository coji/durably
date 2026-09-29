/**
 * Approve or reject a waiting candidate, or decide on a spec the spec
 * reviewers still block: shared by `demo approve|reject|spec-revise` and
 * `demo seed`.
 */
import type { AgentLoopDurably } from './durably.js'

export type ApprovalDecision = 'approved' | 'rejected'

/** A decision on a blocked spec: `approve`, `reject`, or `spec-revise`. */
export type SpecWaitDecision = ApprovalDecision | 'revise'

/** What a spec-blocked wait's metadata names. */
interface SpecWaitMetadata {
  kind?: unknown
  runId?: unknown
  specSha256?: unknown
}

/** Whether a wait's metadata is a spec-blocked wait's. */
export function isSpecWait(metadata: unknown): metadata is SpecWaitMetadata {
  return (metadata as SpecWaitMetadata | null)?.kind === 'spec-blocked'
}

/** The verb each decision's signal ID names. */
const VERBS: Record<SpecWaitDecision, string> = {
  approved: 'approve',
  rejected: 'reject',
  revise: 'revise',
}

/**
 * Signal the wait with the candidate ID its metadata names, so an approval
 * can never land on a different candidate than the one reviewed. A
 * spec-blocked wait is signalled with the run and the spec version its
 * metadata names instead, so a decision can never land on another run or on
 * a spec other than the one the reviewers blocked.
 */
export async function signalApproval(
  durably: AgentLoopDurably,
  runId: string,
  waitId: string,
  decision: ApprovalDecision,
  log: (line: string) => void = () => {},
) {
  const pending = await durably.getWaits(runId)
  const metadata = pending.find((w) => w.id === waitId)?.metadata
  if (isSpecWait(metadata))
    return signalSpecWait(durably, runId, waitId, metadata, decision, null, log)
  const target = metadata as {
    candidateId?: string
    sourceHash?: string
  } | null
  if (!target?.candidateId)
    throw new Error('wait metadata has no candidateId; refusing unbound signal')
  log(
    `binding approval to candidate ${target.candidateId} (${target.sourceHash?.slice(0, 12) ?? 'unknown hash'}).`,
  )
  return durably.signal(
    waitId,
    { candidateId: target.candidateId, decision },
    { signalId: `local-${VERBS[decision]}-${Date.now()}` },
  )
}

/**
 * Decide on a spec-blocked wait: approve the spec as it is, reject it and
 * stop the run, or revise it with `notes`, which the signal carries so the
 * run reads the same notes on every replay. Refused for any other wait, a
 * wait of another run, and a revise without notes.
 */
export async function signalSpecDecision(
  durably: AgentLoopDurably,
  runId: string,
  waitId: string,
  decision: SpecWaitDecision,
  notes: string | null,
  log: (line: string) => void = () => {},
) {
  const pending = await durably.getWaits(runId)
  const metadata = pending.find((w) => w.id === waitId)?.metadata
  if (!isSpecWait(metadata))
    throw new Error(
      `wait ${waitId} of run ${runId} is not a spec-blocked wait; refusing unbound signal`,
    )
  return signalSpecWait(durably, runId, waitId, metadata, decision, notes, log)
}

async function signalSpecWait(
  durably: AgentLoopDurably,
  runId: string,
  waitId: string,
  metadata: SpecWaitMetadata,
  decision: SpecWaitDecision,
  notes: string | null,
  log: (line: string) => void,
) {
  if (metadata.runId !== runId || typeof metadata.specSha256 !== 'string')
    throw new Error(
      'wait metadata names no run or spec version; refusing unbound signal',
    )
  if (decision === 'revise' && !notes?.trim())
    throw new Error('a spec revise needs notes (--notes-file <path>)')
  log(
    `binding the spec decision to run ${runId} and spec ${metadata.specSha256.slice(0, 12)}.`,
  )
  return durably.signal(
    waitId,
    {
      kind: 'spec',
      runId,
      specSha256: metadata.specSha256,
      decision,
      notes: decision === 'revise' ? notes : null,
    },
    { signalId: `local-spec-${VERBS[decision]}-${Date.now()}` },
  )
}
