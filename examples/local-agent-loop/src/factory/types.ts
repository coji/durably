/** Policy types for this factory: its stages, state, and terminal outcome. */

import type { StepContext } from '@coji/durably'

import type {
  AgentProvider,
  VerificationLog,
} from '../engine/providers/types.js'
import type {
  CandidateRef,
  ContextMode,
  ResolvedProfile,
  SessionRef,
} from '../engine/types.js'
import type { FactoryEvent } from './events.js'
import type { Delivery, Target, TargetConfig } from './target.js'

export type { CandidateRef, ContextMode, ResolvedProfile, SessionRef }
export type { Delivery, TargetConfig }

export type StageName =
  | 'code'
  | 'verify'
  | 'review'
  | 'approve'
  | 'finish'
  | 'stop'

export type CodeRole = 'implement' | 'repair'
export type ReviewLens = 'correctness' | 'edge-cases'
/** The three roles that each get their own provider and profile. */
export type ProfileRole = 'code' | ReviewLens
export const PROFILE_ROLES: readonly ProfileRole[] = [
  'code',
  'correctness',
  'edge-cases',
]

export interface FactorySetup {
  /** True when every role runs the fake provider. Roles never mix the two. */
  fake: boolean
  contextMode: ContextMode
  /** What this run is pointed at; rebuilt into a live Target on every replay. */
  target: TargetConfig
  checkpointsDir: string
  instructionsVersion: string
  /** Hash of the fixed profile; equal across runs that are fair to compare. */
  configVersion: string
  /**
   * One fixed profile per role. Implementation and repair share `code`; the
   * two reviewers each have their own, so a reviewer can run on a different
   * provider or model than the code it judges.
   */
  profiles: Record<ProfileRole, ResolvedProfile>
  /**
   * Optional shadow-triage profile. Its judgment is recorded only: no stage
   * or profile depends on it.
   */
  triage?: ResolvedProfile | null
  maxIterations: number
  agentTimeoutMs: number
  /**
   * Run the pinned check once on the base commit before any agent call.
   * Repository targets only; absent on a run set up before it existed.
   */
  baselineCheck?: boolean
  /**
   * The Codex CLI file the run pinned at trigger. Null or absent: the bundled
   * CLI first, then `codex` on PATH, as before `codexPath` existed.
   */
  codexPath?: string | null
  /**
   * Skip the human approval wait and deliver as soon as the reviews pass.
   * Appropriate when the delivery is itself reviewable, such as a draft pull
   * request the human still has to merge.
   */
  autoApprove: boolean
}

export interface VerificationResult {
  targetId: string
  passed: boolean
  stdout: string
  exitCode: number | null
  /** The grading attempt's full output; null when none was recorded. */
  log: VerificationLog | null
}

export interface ReviewVerdict {
  lens: ReviewLens
  decision: 'pass' | 'needsChanges'
  notes: string
}

export interface FactoryOutcome {
  approved: boolean
  conclusion:
    | 'approved'
    | 'rejected'
    | 'verification-failed'
    | 'review-cap-reached'
  candidate: CandidateRef | null
  iterations: number
  reviewRounds: number
  reviews: ReviewVerdict[]
  workdir: string
  fake: boolean
  /** What the human receives; null when the run produced nothing to act on. */
  delivery: Delivery | null
}

export interface FactoryState {
  setup: FactorySetup
  iteration: number
  candidate: CandidateRef | null
  verification: VerificationResult | null
  reviews: ReviewVerdict[]
  reviewRounds: number
  implementationSession: SessionRef | null
  repairNotes: string[]
  approval: 'approved' | 'rejected' | null
  outcome: FactoryOutcome | null
}

export function initialState(setup: FactorySetup): FactoryState {
  return {
    setup,
    iteration: 0,
    candidate: null,
    verification: null,
    reviews: [],
    reviewRounds: 0,
    implementationSession: null,
    repairNotes: [],
    approval: null,
    outcome: null,
  }
}

export interface StageDecision {
  stage: StageName
  role?: CodeRole
  reason: string
}

export interface FactoryServices {
  /** One provider per role, rebuilt from `setup.profiles` on every replay. */
  providers: Record<ProfileRole, AgentProvider>
  /** Rebuilt from `setup.target` on every replay. */
  target: Target
}

export interface StageArgs {
  step: StepContext
  state: FactoryState
  decision: StageDecision
  key: string
  services: FactoryServices
}

export type StageHandler = (args: StageArgs) => Promise<FactoryEvent>
