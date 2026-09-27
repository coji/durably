/** Policy types for this factory: its stages, state, and terminal outcome. */

import type { StepContext } from '@coji/durably'

import type {
  AgentProvider,
  VerificationLog,
} from '../engine/providers/types.js'
import {
  type CandidateRef,
  type ContextMode,
  type ResolvedProfile,
  type SessionRef,
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

export const REVIEW_LENSES: readonly ReviewLens[] = [
  'correctness',
  'edge-cases',
]

export const REVIEW_CONTEXTS = ['prompt', 'local-instructions'] as const
/** Where a reviewer finds its review context. */
export type ReviewContext = (typeof REVIEW_CONTEXTS)[number]
export const REVIEW_OUTPUTS = ['verdict', 'findings-json'] as const
/** How a reviewer's reply is read. */
export type ReviewOutput = (typeof REVIEW_OUTPUTS)[number]

/**
 * How one reviewer is called and read, fixed at trigger from `factory.json`.
 * `command` is the input sent in place of the factory's review prompt, with
 * its placeholders still unexpanded; null keeps the prompt. A lens without
 * one of these uses the prompt and the verdict, as before they existed.
 */
export interface ReviewInvocation {
  command: string | null
  context: ReviewContext
  output: ReviewOutput
}

/**
 * Whether a reviewer reads the candidate through its own command or local
 * instructions: it then gets the base and head snapshots, and a Claude
 * reviewer runs with the command-mode settings.
 */
export function usesReviewMaterials(
  invocation: ReviewInvocation | null,
): boolean {
  return (
    invocation !== null &&
    (invocation.command !== null || invocation.context === 'local-instructions')
  )
}

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
   * profiles existed. Otherwise every repair runs on it, in a new session
   * unless `repairSession` allows continuing across an effort change.
   */
  repair?: ResolvedProfile | null
  /**
   * Whether a repair on its own profile may continue the implementation
   * session, decided once at setup by `repairSessionDecision` and fixed for
   * the run. Set only when the repair profile differs from `code`; absent on
   * a run set up before it existed, which starts every such repair new.
   */
  repairSession?: RepairSessionDecision | null
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
  /**
   * The reviewers `factory.json` gave a command, context or output. A lens
   * left out is called and read as before these existed; absent on a run
   * that configured none.
   */
  review?: Partial<Record<ReviewLens, ReviewInvocation>> | null
}

/** A lens's fixed invocation; null when it uses the defaults. */
export function reviewInvocationOf(
  setup: Pick<FactorySetup, 'review'>,
  lens: ReviewLens,
): ReviewInvocation | null {
  return setup.review?.[lens] ?? null
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

/** Claude Code builds that keep the prompt cache when a session resumes at another effort. */
export const EFFORT_RESUME_MIN_CLAUDE_CLI = [2, 1, 260] as const

/** Models whose cache Claude Code keeps across an effort change. */
const EFFORT_RESUME_MODELS = /^claude-(opus-5-5|fable-5-1)(?![0-9])/i

/**
 * Environment variables that route Claude Code through Bedrock or Vertex,
 * or turn off its experimental betas. With any of them set, resuming at
 * another effort is not known to keep the cache, so the repair starts new.
 */
export const EFFORT_RESUME_BLOCKING_ENV = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
] as const

/**
 * Whether a repair on its own profile continues the implementation session.
 * `resume` is true only when the repair differs from code in effort alone
 * and the environment is known to keep the cache across that change.
 */
export interface RepairSessionDecision {
  resume: boolean
  /** Why, in one line, for the setup record. */
  reason: string
}

/** The policy value a resuming decision adds to the config version. */
export const EFFORT_RESUME_POLICY = 'resume-across-effort'

export interface RepairSessionInput {
  contextMode: ContextMode
  code: Pick<
    ResolvedProfile,
    'provider' | 'requestedModel' | 'effectiveModel' | 'effectiveEffort'
  >
  repair: Pick<
    ResolvedProfile,
    'provider' | 'requestedModel' | 'effectiveModel' | 'effectiveEffort'
  >
  /** The Claude Code version `resolveVersions` recorded; null when unknown. */
  claudeCliVersion: string | null
  env: Readonly<Record<string, string | undefined>>
  /**
   * Tests only: the fake provider stands in for a Claude Code that keeps the
   * cache across an effort change (`FakeScenario.claudeEffortResume`).
   */
  fakeEffortResume: boolean
}

/** `major.minor.patch` from a version line such as `2.1.280 (Claude Code)`. */
export function parseCliVersion(
  line: string | null,
): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(line ?? '')
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

function atLeast(
  version: readonly number[],
  minimum: readonly number[],
): boolean {
  for (const [i, min] of minimum.entries()) {
    const v = version[i] ?? 0
    if (v !== min) return v > min
  }
  return true
}

const no = (reason: string): RepairSessionDecision => ({
  resume: false,
  reason,
})

/**
 * Decide, from the settings and the environment alone, whether a repair on
 * its own profile continues the implementation session. Anything that
 * cannot be confirmed starts a new session.
 */
export function repairSessionDecision(
  input: RepairSessionInput,
): RepairSessionDecision {
  const { code, repair } = input
  if (input.contextMode !== 'reuse') return no('context is fresh')
  if (repair.provider !== code.provider)
    return no('repair runs on another provider')
  // The effective model decides: two spellings of one model are the same
  // model, and one spelling that resolves to two models is not.
  if (repair.effectiveModel !== code.effectiveModel)
    return no('repair runs on another model')
  if (repair.effectiveEffort === code.effectiveEffort)
    return no('repair differs from code in more than effort')
  if (code.provider === 'fake')
    return input.fakeEffortResume
      ? { resume: true, reason: 'fake provider standing in for Claude Code' }
      : no('the fake provider does not change effort mid-session')
  if (code.provider !== 'claude')
    return no(`${code.provider} does not continue a session at another effort`)
  const model = code.effectiveModel ?? ''
  if (!EFFORT_RESUME_MODELS.test(model))
    return no(`${model || 'the default model'} is not Opus 5.5 or Fable 5.1`)
  const version = parseCliVersion(input.claudeCliVersion)
  const minimum = EFFORT_RESUME_MIN_CLAUDE_CLI.join('.')
  if (!version)
    return no(`Claude Code version unknown; ${minimum} or later is needed`)
  if (!atLeast(version, EFFORT_RESUME_MIN_CLAUDE_CLI))
    return no(`Claude Code ${version.join('.')} is older than ${minimum}`)
  const blocking = EFFORT_RESUME_BLOCKING_ENV.find((name) =>
    Boolean(input.env[name]),
  )
  if (blocking) return no(`${blocking} is set`)
  return {
    resume: true,
    reason: `Claude Code ${version.join('.')} on ${model} keeps the cache across an effort change`,
  }
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
