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
 */
export interface SessionRef {
  provider: ProviderName
  nativeId: string
  profileId: string
  cwd: string
  instructionsVersion: string
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
}
