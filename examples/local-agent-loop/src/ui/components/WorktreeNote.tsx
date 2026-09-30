import type { WorktreeState } from '../../engine/status'
import { COPY, DETAIL } from '../glossary'
import { Commands } from './Commands'

/**
 * A repository run's worktree once it is gone, or when the run could not
 * remove it after its delivery or when it was archived. Its recorded path
 * is never offered as a place to work.
 */
export function WorktreeNote({
  worktree,
  archived = false,
}: {
  worktree: WorktreeState | null
  /** The run is archived, so its worktree should be gone already. */
  archived?: boolean
}) {
  if (worktree && !worktree.present)
    return (
      <div className="text-sm">
        <p>{DETAIL.worktreeRemoved}</p>
        <p className="text-fg-2 text-xs">{DETAIL.worktreeKept}</p>
      </div>
    )
  if (worktree?.cleanupWarning)
    return (
      <div className="text-sm">
        <p>{DETAIL.worktreeWarning}</p>
        <p className="text-fg-2 text-xs">{DETAIL.worktreeWarningNote}</p>
        <p className="font-code text-fg-2 text-xs break-all">
          {worktree.cleanupWarning}
        </p>
      </div>
    )
  if (archived && worktree?.present)
    return (
      <div className="text-sm">
        <p>{DETAIL.worktreeLeft}</p>
        <p className="text-fg-2 text-xs">{DETAIL.worktreeLeftNote}</p>
      </div>
    )
  return null
}

/**
 * The command that removes a finished repository run's worktree: a plain
 * git removal, or `demo prune --apply` for one its delivered or archived
 * run should already have removed.
 */
export function CleanupCommand({ cleanup }: { cleanup: string | null }) {
  if (!cleanup) return null
  return (
    <div>
      <p className="text-fg-2 mb-2 text-xs">
        {cleanup.startsWith('git ') ? COPY.cleanupNote : COPY.cleanupPruneNote}
      </p>
      <Commands lines={[cleanup]} />
    </div>
  )
}
