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
 * Everything a configured reviewer reads that the factory makes for it,
 * outside the worktree: the base commit's tree, and per candidate its own
 * tree and one private working directory per reviewer. Only the worker
 * removes it: when a candidate's review round ends, before every stage that
 * is not a review, when the run fails, is cancelled or finishes, when setup
 * runs again, and at worker startup for runs that have already ended.
 */
export function reviewSnapshotsDirOf(runRoot: string): string {
  return join(runRoot, 'review-snapshots')
}

/** The base commit's tree, extracted once per run. */
export function reviewBaseTreeOf(snapshotsDir: string): string {
  return join(snapshotsDir, 'base')
}

/** One candidate's review materials: its tree and the reviewers' cwds. */
export function reviewCandidateDirOf(
  snapshotsDir: string,
  candidateId: string,
): string {
  return join(snapshotsDir, candidateId)
}

/** The candidate commit's tree. */
export function reviewHeadTreeOf(
  snapshotsDir: string,
  candidateId: string,
): string {
  return join(reviewCandidateDirOf(snapshotsDir, candidateId), 'head')
}

/**
 * The working directory of one configured review call: the base commit's
 * `CLAUDE.md` and `.claude/`, and the factory's `CLAUDE.local.md`. A lens
 * has its own, so the two reviewers never read each other's instructions.
 */
export function reviewWorkdirOf(
  snapshotsDir: string,
  candidateId: string,
  lens: string,
): string {
  return join(reviewCandidateDirOf(snapshotsDir, candidateId), lens, 'cwd')
}
