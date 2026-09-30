/**
 * Where one run's files live under the state root. The job, the targets and
 * the cancel cleanup all read these, so moving a directory moves it for all
 * of them.
 */
import { dirname, join } from 'node:path'

/**
 * A run's own directory: worktree, checkpoints, candidates and delivery.
 * Only `removableRunPathsOf` names what may be removed from it.
 */
export function runRootOf(stateRoot: string, runId: string): string {
  return join(stateRoot, 'runs', runId)
}

/**
 * The baseline reuse index (ADR-0025): one directory per baseline identity
 * and in it one file per run whose check passed under it, each run writing
 * only its own file.
 */
export function baselineIndexDirOf(stateRoot: string): string {
  return join(stateRoot, 'baseline-index')
}

/**
 * The archive markers: one file per archived run, named by its ID. A run is
 * archived while its file exists; the database never records it, so
 * archiving changes nothing about the run itself.
 */
export function archiveDirOf(stateRoot: string): string {
  return join(stateRoot, 'archived')
}

/** One run's archive marker. */
export function archiveMarkerOf(stateRoot: string, runId: string): string {
  return join(archiveDirOf(stateRoot), runId)
}

/**
 * A repository run's worktree, where the agent edits and reviewers read.
 * With the review snapshots, it is all of a run's directory that is ever
 * removed while the run is kept (ADR-0028): after an approved delivery is
 * recorded, when a stopped run is archived, and by `demo prune --apply`.
 * The spec, checkpoints, logs, candidate diffs and delivery stay.
 */
export function repoWorkdirOf(runRoot: string): string {
  return join(runRoot, 'work')
}

/**
 * The run's agent output: one file per attempt that sent a call, written
 * while the call runs and read by the web UI. Kept with the run, like its
 * checkpoints: neither a worktree cleanup nor `demo prune` removes it.
 */
export function agentLogsDirOf(runRoot: string): string {
  return join(runRoot, 'agent-logs')
}

/**
 * The agent log directory of the run whose operation checkpoints are in
 * `checkpointsDir`, which setup always puts directly in the run's own
 * directory. The stages have the setup, not the state root.
 */
export function agentLogsDirBeside(checkpointsDir: string): string {
  return agentLogsDirOf(dirname(checkpointsDir))
}

/**
 * The paths of a finished repository run that may be removed, and nothing
 * else of the run: its worktree and its review snapshots.
 */
export function removableRunPathsOf(runRoot: string): {
  worktree: string
  reviewSnapshots: string
} {
  return {
    worktree: repoWorkdirOf(runRoot),
    reviewSnapshots: reviewSnapshotsDirOf(runRoot),
  }
}

/**
 * Written by the run itself, once its approved delivery is recorded and
 * right before it removes its worktree. A worker that dies before the run
 * is marked completed replays every step, and a replay must not ask the
 * removed worktree whether the sealed candidate is intact: while this file
 * exists, the target skips those checks. Every step it would guard is
 * already recorded by then.
 */
export function worktreeRetiredMarkerOf(runRoot: string): string {
  return join(runRoot, 'worktree-removed')
}

/**
 * Everything a configured reviewer reads that the factory makes for it,
 * outside the worktree: the base commit's tree, and per candidate its own
 * tree and one private working directory per reviewer. Only the worker
 * removes it: when a candidate's review round ends, before every stage that
 * is not a review, when the run fails, is cancelled or finishes, when setup
 * runs again, and at worker startup for runs that have already ended. The
 * worktree's removal takes whatever is left of it too.
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

/**
 * The run's own spec directory, outside the worktree. It holds the spec file
 * alone: a spec author or fixer works here and may write that file and
 * nothing else, and the spec reviewers and `checkFromSpec` read it here.
 */
export function specDirOf(runRoot: string): string {
  return join(runRoot, 'spec')
}

/** The run-owned spec file the spec stages write and the run confirms. */
export function specFileOf(runRoot: string): string {
  return join(specDirOf(runRoot), 'spec.md')
}

/**
 * The working directory of one configured spec review call: the base
 * commit's `CLAUDE.md` and `.claude/`, and the factory's `CLAUDE.local.md`,
 * one per reviewer and round. Removed with the round, like a candidate's.
 */
export function specReviewWorkdirOf(
  snapshotsDir: string,
  round: number,
  name: string,
): string {
  return join(snapshotsDir, `spec-${round}`, name, 'cwd')
}
