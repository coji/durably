/** Policy types for this factory: its stages, state, and terminal outcome. */

import type { StepContext } from '@coji/durably'

import {
  claudeEffortResumeEnvironment,
  claudeKeepsCacheAcrossEffort,
  isFullClaudeModelId,
} from '../engine/providers/claude.js'
import type {
  AgentProvider,
  ProviderName,
  SessionHandling,
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
   * session. The setup step records `repairSessionDecision`'s answer, which
   * has no `model`; the job confirms it with the models preflight saw
   * (`confirmRepairSession`) before the first stage, so the stages read a
   * confirmed decision. Set only when the repair profile differs from
   * `code`; absent on a run set up before it existed, which starts every
   * such repair new.
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

/** The parts of a profile that decide which call it makes. */
export type ExecutionProfile = Pick<
  ResolvedProfile,
  'provider' | 'requestedModel' | 'effectiveModel' | 'effectiveEffort'
>

/**
 * What makes two profiles the same call: provider, model and effort. The
 * requested model stands in for the fake provider's, whose effective model
 * is always the same label. Preflight checks each key once, and a repair
 * profile with the code profile's key is the code profile.
 */
export function executionKey(profile: ExecutionProfile): string {
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

/**
 * Whether a repair on its own profile continues the implementation session.
 *
 * Setup decides from the settings and the environment: `resume` true there
 * means nothing rules it out, but the model is not yet confirmed. Claude
 * Code resolves an alias such as `opus` itself, so the model a profile runs
 * is known only once preflight's minimal call reports it.
 * `confirmRepairSession` then sets `model`, the concrete model both
 * profiles run on, or turns `resume` off. A repair continues only on a
 * decision with `resume` and `model` both set.
 */
export interface RepairSessionDecision {
  resume: boolean
  /** Why, in one line. */
  reason: string
  /** The model preflight saw both profiles run on; set once confirmed. */
  model?: string | null
}

/** The policy value a resuming setup decision adds to the config version. */
export const EFFORT_RESUME_POLICY = 'resume-across-effort'

export interface RepairSessionInput {
  contextMode: ContextMode
  code: ExecutionProfile
  repair: ExecutionProfile
  /** The Claude Code version `resolveVersions` recorded; null when unknown. */
  claudeCliVersion: string | null
  env: Readonly<Record<string, string | undefined>>
  /**
   * Tests only: the fake provider stands in for a Claude Code that keeps the
   * cache across an effort change (`FakeScenario.claudeEffortResume`).
   */
  fakeEffortResume: boolean
}

const no = (reason: string): RepairSessionDecision => ({
  resume: false,
  reason,
})

/**
 * Decide at setup, from the settings and the environment alone, whether a
 * repair on its own profile may continue the implementation session.
 * Anything that cannot be confirmed starts a new session. A model named by
 * an alias is left to `confirmRepairSession`; two full model ids are judged
 * here, since Claude Code runs a full id as written.
 */
export function repairSessionDecision(
  input: RepairSessionInput,
): RepairSessionDecision {
  const { code, repair } = input
  if (input.contextMode !== 'reuse') return no('context is fresh')
  if (repair.provider !== code.provider)
    return no('repair runs on another provider')
  if (repair.effectiveEffort === code.effectiveEffort)
    return no(
      repair.effectiveModel === code.effectiveModel
        ? 'repair names the same model and effort as code in another spelling; only an effort change continues the session'
        : 'repair has the same effort as code; only an effort change continues the session',
    )
  if (code.provider === 'fake')
    return input.fakeEffortResume
      ? {
          resume: true,
          reason:
            'fake provider standing in for Claude Code; continues once preflight sees one model for both',
        }
      : no('the fake provider does not change effort mid-session')
  if (code.provider !== 'claude')
    return no(`${code.provider} does not continue a session at another effort`)
  const models = [code.effectiveModel ?? '', repair.effectiveModel ?? '']
  if (models.every(isFullClaudeModelId)) {
    const [codeModel = '', repairModel = ''] = models
    if (codeModel !== repairModel) return no('repair runs on another model')
    if (!claudeKeepsCacheAcrossEffort(codeModel))
      return no(`${codeModel} is not Opus 5.5 or Fable 5.1`)
  }
  const environment = claudeEffortResumeEnvironment(
    input.claudeCliVersion,
    input.env,
  )
  if (!environment.keeps) return no(environment.reason)
  return {
    resume: true,
    reason: `Claude Code ${environment.version} keeps the cache across an effort change on Opus 5.5 or Fable 5.1; continues once preflight sees both profiles run on one of them`,
  }
}

/**
 * Confirm a setup decision with the concrete model preflight saw each
 * profile run on. Continues only when both reported one model, and, on
 * Claude, one that keeps the cache across an effort change. A model that was
 * not reported, as on a run whose preflight predates the report, starts a
 * new session.
 */
export function confirmRepairSession(input: {
  decision: RepairSessionDecision | null | undefined
  provider: ProviderName
  codeModel: string | null
  repairModel: string | null
}): RepairSessionDecision | null {
  const { decision, codeModel, repairModel } = input
  if (!decision?.resume) return decision ?? null
  if (codeModel === null || repairModel === null)
    return no('preflight did not report the model a profile runs on')
  if (codeModel !== repairModel)
    return no(`code runs on ${codeModel} and repair on ${repairModel}`)
  if (input.provider === 'claude' && !claudeKeepsCacheAcrossEffort(codeModel))
    return no(`${codeModel} is not Opus 5.5 or Fable 5.1`)
  return {
    resume: true,
    reason: `${decision.reason}: preflight saw ${codeModel} for both`,
    model: codeModel,
  }
}

/**
 * How a code-stage call treats the recorded implementation session. Throws
 * when the session belongs to another provider, working directory or
 * instruction version, or to another profile the call may not continue.
 * `acrossEffortModel` is the confirmed model a repair may continue another
 * profile's session on; null when it may not. Such a session continues when
 * it recorded that model, and starts new when it recorded none.
 */
export function sessionHandlingOf(input: {
  recorded: SessionRef | null
  profile: Pick<ResolvedProfile, 'provider' | 'id'>
  cwd: string
  instructionsVersion: string
  acrossEffortModel: string | null
}): SessionHandling {
  const { recorded, profile, acrossEffortModel } = input
  if (!recorded) return 'fresh'
  const mismatch = new Error(
    'implementation session provenance no longer matches setup',
  )
  if (
    recorded.provider !== profile.provider ||
    recorded.cwd !== input.cwd ||
    recorded.instructionsVersion !== input.instructionsVersion
  )
    throw mismatch
  if (recorded.profileId === profile.id) return 'continued'
  if (acrossEffortModel === null) throw mismatch
  if (recorded.model == null) return 'fresh'
  if (recorded.model === acrossEffortModel) return 'continued-effort-change'
  throw mismatch
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
