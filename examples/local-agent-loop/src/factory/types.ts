/** Policy types for this factory: its stages, state, and terminal outcome. */

import type { StepContext } from '@coji/durably'

import type { AgentProvider, ProviderName } from '../engine/providers/types.js'
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

export interface FactorySetup {
  provider: ProviderName
  fake: boolean
  contextMode: ContextMode
  /** What this run is pointed at; rebuilt into a live Target on every replay. */
  target: TargetConfig
  checkpointsDir: string
  instructionsVersion: string
  /** Hash of the fixed profile; equal across runs that are fair to compare. */
  configVersion: string
  profiles: {
    code: ResolvedProfile
    review: ResolvedProfile
  }
  maxIterations: number
  agentTimeoutMs: number
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
  provider: AgentProvider
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
