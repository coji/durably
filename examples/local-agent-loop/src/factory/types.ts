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
   * One fixed profile per role. Implementation uses `code`, and so does
   * repair unless `repair` is set; the two reviewers each have their own, so
   * a reviewer can run on a different provider or model than the code it
   * judges.
   */
  profiles: Record<ProfileRole, ResolvedProfile>
  /**
   * The repair profile the run named. Null or absent, or one that makes the
   * same call as `code` (see `executionKey`): repair runs on `code`,
   * continuing the implementation session in reuse mode, as before repair
   * profiles existed. Otherwise every repair runs on it in a new session.
   */
  repair?: ResolvedProfile | null
  /**
   * Optional shadow-triage profile. Its judgment is recorded only: no stage
   * or profile depends on it. A repair run records its parent's here and
   * never runs it.
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
   * Set on a run that repairs another run's approved candidate from outside
   * findings: its first code stage is a repair, not an implementation.
   * Absent on every other run.
   */
  repairOf?: RepairOrigin | null
  /**
   * Skip the human approval wait and deliver as soon as the reviews pass.
   * Appropriate when the delivery is itself reviewable, such as a draft pull
   * request the human still has to merge.
   */
  autoApprove: boolean
}

/** The run and candidate a repair run starts from. */
export interface RepairOrigin {
  runId: string
  /** The parent's last candidate commit: this run's base. */
  candidateCommit: string
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

/**
 * What makes two profiles the same call: provider, model and effort. The
 * requested model stands in for the fake provider's, whose effective model
 * is always the same label. Preflight checks each key once, and a repair
 * profile with the code profile's key is the code profile.
 */
export function executionKey(
  profile: Pick<
    ResolvedProfile,
    'provider' | 'requestedModel' | 'effectiveModel' | 'effectiveEffort'
  >,
): string {
  return [
    profile.provider,
    profile.requestedModel ?? profile.effectiveModel,
    profile.effectiveEffort,
  ].join('|')
}

/**
 * The repair profile when it makes a different call from `code`; null when
 * repair runs on `code`.
 */
export function separateRepairProfile(
  setup: Pick<FactorySetup, 'repair' | 'profiles'>,
): ResolvedProfile | null {
  const repair = setup.repair ?? null
  return repair && executionKey(repair) !== executionKey(setup.profiles.code)
    ? repair
    : null
}

export interface FactoryServices {
  /**
   * One provider per role, rebuilt from `setup.profiles` on every replay;
   * `repair` is `code`'s unless `separateRepairProfile(setup)` names one.
   */
  providers: Record<ProfileRole | 'repair', AgentProvider>
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
