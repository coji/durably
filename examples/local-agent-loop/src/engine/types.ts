/** Identities the engine tracks, independent of any one factory's policy. */
import type { ProviderName } from './providers/types.js'

/** Whether a repeated call continues one native session or starts a new one. */
export type ContextMode = 'reuse' | 'fresh'

/** Execution settings resolved before launch: requested vs actually applied. */
export interface ResolvedProfile {
  id: string
  provider: ProviderName
  requestedModel: string | null
  requestedEffort: string | null
  effectiveModel: string | null
  effectiveEffort: string | null
}

/**
 * A provider-native conversation, pinned together with everything that must
 * match before it may be resumed. Continuing a session whose model, working
 * directory or instruction set has changed would silently mix two setups.
 *
 * `profileId` names the profile of the call that last ran the session; the
 * same profile may always continue it. `model` lets a profile that differs
 * only in effort continue it too, when setup allowed that: provider, model,
 * working directory and instruction set still have to match. A session
 * recorded before `model` existed has none, and is never continued across
 * an effort change.
 */
export interface SessionRef {
  provider: ProviderName
  nativeId: string
  profileId: string
  /** The call's model, as `sessionModelOf` gives it; absent on older records. */
  model?: string | null
  cwd: string
  instructionsVersion: string
}

/**
 * The model a session runs on, for comparing two profiles. The requested
 * model stands in for the fake provider's, whose effective model is always
 * the same label, as in `executionKey`.
 */
export function sessionModelOf(
  profile: Pick<ResolvedProfile, 'requestedModel' | 'effectiveModel'>,
): string | null {
  return profile.requestedModel ?? profile.effectiveModel
}

/**
 * What a repository candidate changed against the recorded base commit,
 * written when it is sealed. The files live outside the worktree, so the
 * agent cannot edit what its reviewers read.
 */
export interface CandidateChanges {
  /** Full unified diff, base commit to candidate commit. */
  diffPath: string
  /** One `added:` / `modified:` / … line per changed file. */
  changedFilesPath: string
  files: number
  additions: number
  deletions: number
}

/**
 * The base commit's and a candidate commit's trees, extracted outside the
 * worktree for reviewers that read the candidate through their own command
 * or local instructions. They exist only while that candidate is reviewed.
 */
export interface ReviewSnapshots {
  baseDir: string
  headDir: string
}

/**
 * A sealed copy of the work at one point in time.
 *
 * Verification, review and approval all address the candidate by id, so they
 * cannot end up grading three different versions of the code. The hashes make
 * an unintended change detectable; this is a consistency boundary, not a
 * sandbox for hostile code.
 */
export interface CandidateRef {
  id: string
  snapshotDir: string
  sourceHash: string
  acceptanceHash: string
  /** Branch and commit holding a repository candidate; absent otherwise. */
  branch?: string
  commit?: string
  /** Size and diff files of a repository candidate; absent otherwise. */
  changes?: CandidateChanges
}
