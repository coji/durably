/**
 * Where one run's files live under the state root. The job, the targets and
 * the cancel cleanup all read these, so moving a directory moves it for all
 * of them.
 */
import { join } from 'node:path'

/** A run's own directory: worktree, checkpoints, candidates and delivery. */
export function runRootOf(stateRoot: string, runId: string): string {
  return join(stateRoot, 'runs', runId)
}

/** A repository run's worktree, where the agent edits and reviewers read. */
export function repoWorkdirOf(runRoot: string): string {
  return join(runRoot, 'work')
}

/**
 * The base and candidate commit trees a configured reviewer reads, outside
 * the worktree. Removed when a candidate's review ends and when the run
 * ends, is cancelled or sets up again.
 */
export function reviewSnapshotsDirOf(runRoot: string): string {
  return join(runRoot, 'review-snapshots')
}
