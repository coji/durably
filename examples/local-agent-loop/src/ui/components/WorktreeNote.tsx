import type { WorktreeState } from '../../engine/status'
import { DETAIL } from '../glossary'

/**
 * A repository run's worktree once it is gone, or when the run could not
 * remove it after its delivery. Its recorded path is never offered as a
 * place to work.
 */
export function WorktreeNote({ worktree }: { worktree: WorktreeState | null }) {
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
  return null
}
