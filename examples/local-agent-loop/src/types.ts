/** Domain types for the local factory sample. */

import type { StepContext } from '@coji/durably'

import type { FactoryEvent } from './events.js'
import type { AgentProvider, ProviderName } from './providers/types.js'

export type StageName =
  | 'code'
  | 'verify'
  | 'review'
  | 'approve'
  | 'finish'
  | 'stop'

export type ContextMode = 'reuse' | 'fresh'
export type CodeRole = 'implement' | 'repair'
export type ReviewLens = 'correctness' | 'edge-cases'

export interface ResolvedProfile {
  id: string
  provider: ProviderName
  model: string | null
  effort: string | null
}

export interface SessionRef {
  provider: ProviderName
  nativeId: string
  profileId: string
  cwd: string
  instructionsVersion: string
}

export interface CandidateRef {
  id: string
  snapshotDir: string
  sourceHash: string
  acceptanceHash: string
}

export interface FactorySetup {
  provider: ProviderName
  fake: boolean
  contextMode: ContextMode
  workdir: string
  acceptanceDir: string
  acceptanceHash: string
  checkpointsDir: string
  instructionsVersion: string
  profiles: {
    code: ResolvedProfile
    review: ResolvedProfile
  }
  maxIterations: number
  agentTimeoutMs: number
  testTimeoutMs: number
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
}

export interface StageArgs {
  step: StepContext
  state: FactoryState
  decision: StageDecision
  key: string
  services: FactoryServices
}

export type StageHandler = (args: StageArgs) => Promise<FactoryEvent>
