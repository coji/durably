/** Approve or reject a waiting candidate: shared by `demo approve|reject` and `demo seed`. */
import type { AgentLoopDurably } from './durably.js'

export type ApprovalDecision = 'approved' | 'rejected'

/**
 * Signal the wait with the candidate ID its metadata names, so an approval
 * can never land on a different candidate than the one reviewed.
 */
export async function signalApproval(
  durably: AgentLoopDurably,
  runId: string,
  waitId: string,
  decision: ApprovalDecision,
  log: (line: string) => void = () => {},
) {
  const pending = await durably.getWaits(runId)
  const target = pending.find((w) => w.id === waitId)?.metadata as {
    candidateId?: string
    sourceHash?: string
  } | null
  if (!target?.candidateId)
    throw new Error('wait metadata has no candidateId; refusing unbound signal')
  log(
    `binding approval to candidate ${target.candidateId} (${target.sourceHash?.slice(0, 12) ?? 'unknown hash'}).`,
  )
  const verb = decision === 'approved' ? 'approve' : 'reject'
  return durably.signal(
    waitId,
    { candidateId: target.candidateId, decision },
    { signalId: `local-${verb}-${Date.now()}` },
  )
}
