/** Policy types for this factory: its stages, state, and terminal outcome. */

import type { StepContext } from '@coji/durably'

import {
  claudeEffortResumeEnvironment,
  claudeKeepsCacheAcrossEffort,
  EFFORT_RESUME_MODELS_LABEL,
  isFullClaudeModelId,
} from '../engine/providers/claude.js'
import type {
  AgentProvider,
  ProviderName,
  SessionHandling,
  VerificationLog,
} from '../engine/providers/types.js'
import type { ReportFinding, ReportReviewFindings } from '../engine/report.js'
import type {
  CandidateRef,
  ContextMode,
  ResolvedProfile,
  SessionRef,
} from '../engine/types.js'
import type { VerificationOutcome } from '../engine/verification.js'
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
   * Setup's answer to whether a repair on its own profile may continue the
   * implementation session (`repairSessionDecision`). Never read as a
   * continuation: the job confirms it with the models preflight saw and the
   * stages read `FactoryState.repairSession`. Set only when the repair
   * profile differs from `code`; absent on a run set up before it existed,
   * which starts every such repair new.
   */
  repairSession?: RepairSessionSetup | null
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
   * How long a passing baseline result of another run may be used instead
   * of running the check, fixed at trigger. Null or absent: every run with
   * the baseline check runs it. Read only when `baselineCheck` is on.
   */
  baselineReuse?: BaselineReuse | null
  /**
   * What a baseline result must match to be used by, or taken from, this
   * run: recorded once at setup, so a replay compares the same values. Null
   * when a value could not be resolved, which rules reuse out both ways;
   * absent without the baseline check and on a run set up before it existed.
   */
  baselineIdentity?: BaselineIdentity | null
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
  /**
   * The spec stages, fixed at trigger: set only on a repository run whose
   * `factory.json` configures them and that was given no `--spec-file`.
   * Absent: the run starts from the spec it was given, as before.
   */
  spec?: SpecSetup | null
  /**
   * Verify each sealed candidate and review it at the same time, fixed at
   * trigger from `factory.json`. The reviewers then read the candidate's
   * sealed tree and diff, never the worktree the check runs in. Absent or
   * false: review follows a passing verification, as before (ADR-0029).
   */
  parallelReview?: boolean
}

/** One named spec reviewer, as setup resolved it. */
export interface SpecReviewer {
  name: string
  profile: ResolvedProfile
  /** Its command, context and output; null uses the prompt and the verdict. */
  invocation: ReviewInvocation | null
}

/**
 * The spec stages of a run: who writes, fixes and reviews the spec, how many
 * review rounds run before a person decides, and the templates read at
 * trigger. The worker never reads a template file again.
 */
export interface SpecSetup {
  author: ResolvedProfile
  /** The author's profile when `factory.json` names none for the fix. */
  fix: ResolvedProfile
  reviewers: SpecReviewer[]
  maxRounds: number
  /** The spec template's content; null when none was configured. */
  template: string | null
  /** The review instruction template's content; null when none. */
  reviewTemplate: string | null
  /** The run-owned spec file, outside the worktree (`specFileOf`). */
  specPath: string
}

/** The spec author's step; the first call of the spec stages. */
export const SPEC_AUTHOR_STEP = 'spec:author'
/** The spec fix after review round `round`. */
export const specFixStep = (round: number) => `spec:fix:${round}`
/** One reviewer's review in round `round`. */
export const specReviewStep = (round: number, name: string) =>
  `spec-review:${round}:${name}`
/** The `n`th wait for a person's decision on a spec still blocked. */
export const specWaitName = (n: number) => `spec-wait:${n}`
/** The step recording the confirmed spec. */
export const SPEC_FINAL_STEP = 'spec:final'
/** The step running `checkFromSpec` and recording the check it chose. */
export const SPEC_CHECK_STEP = 'spec-check'

/** One version of the spec file, as an author or fix step stores it. */
export interface SpecVersion {
  content: string
  sha256: string
}

/** What a spec reviewer's step stores: the verdict and its findings. */
export interface SpecReviewResult {
  name: string
  decision: 'pass' | 'needsChanges'
  notes: string
  findings: ReviewFindings | null
}

/** What `SPEC_FINAL_STEP` stores: the spec the run goes on with. */
export interface SpecRecord extends SpecVersion {
  /** The review round that confirmed it. */
  round: number
  /** A person approved it through the spec-blocked wait. */
  blocked: boolean
  /**
   * The advice the implementer is given as untrusted data: the confirming
   * round's non-blocking findings, and its blockers when a person approved
   * the spec over them. Empty when there is none.
   */
  advice: ReviewFinding[]
}

/** What `SPEC_CHECK_STEP` stores. */
export interface SpecCheckRecord {
  /** The check the run grades with, from `checkFromSpec`. */
  check: string[]
  /** The script's notes, handed to the implementer as untrusted data. */
  notes: string | null
  /**
   * The baseline identity with this check, resolved here and never again;
   * null without the baseline check or when a value could not be resolved.
   */
  baselineIdentity: BaselineIdentity | null
}

/** A lens's fixed invocation; null when it uses the defaults. */
export function reviewInvocationOf(
  setup: Pick<FactorySetup, 'review'>,
  lens: ReviewLens,
): ReviewInvocation | null {
  return setup.review?.[lens] ?? null
}

/** `factory.json`'s `baselineReuse`, fixed at trigger. */
export interface BaselineReuse {
  /** How old a passing result may be, from the completion of its check. */
  maxAgeMs: number
}

/**
 * What a baseline result is valid for. Deliberately narrow: the repository,
 * the base commit, the pinned setup and check with the check's timeout, and
 * the Node.js version, platform, architecture and check executable the
 * worker resolved. Nothing else in the machine's environment is compared.
 */
export interface BaselineIdentity {
  /** The repository root with symbolic links resolved. */
  repoPath: string
  baseCommit: string
  checkCommand: string[]
  setupCommand: string[] | null
  checkTimeoutMs: number
  node: string
  platform: string
  arch: string
  /**
   * The file the check's first word runs, with symbolic links resolved; a
   * file inside the worktree is named relative to it, as `./<path>`.
   */
  checkExecutable: string
}

/** The step that runs the pinned check on the base commit, or reuses it. */
export const BASELINE_STEP = 'baseline'

/** What `BASELINE_STEP` stores. */
export interface BaselineRecord extends VerificationOutcome {
  /** `measured`: the check ran in this run; `reused`: another run's result. */
  source: 'measured' | 'reused'
  /** The identity this result was compared by; null when none resolved. */
  identity: BaselineIdentity | null
  /**
   * Set on a measured result: when the check completed, from its completed
   * checkpoint, so a step saved later on a resume does not move it.
   */
  checkedAt?: string
  /** Set on a reused result: the run whose measured result it is. */
  reusedFrom?: {
    runId: string
    /**
     * When that run's check completed (its step's completion on a record
     * from before that was kept): the result's age starts here.
     */
    checkedAt: string
    /** That run read its verdict back from its checkpoint. */
    recovered: boolean
  }
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

/** One finding of a `findings-json` review, as validated. */
export type ReviewFinding = ReportFinding

/** The findings of a `findings-json` review as the report keeps them. */
export type ReviewFindings = ReportReviewFindings

/**
 * A reviewer's verdict as the state and the run output keep it. The
 * findings are not part of it: they stay in the review's completed step
 * (`ReviewStepResult`), where the report reads them, so the approval wait's
 * metadata and the run output carry the verdicts only.
 */
export interface ReviewVerdict {
  lens: ReviewLens
  decision: 'pass' | 'needsChanges'
  notes: string
}

/** What a review step stores: the verdict and its findings. */
export interface ReviewStepResult extends ReviewVerdict {
  /** A `findings-json` review's findings; null for a verdict review. */
  findings: ReviewFindings | null
}

/** Why a review that ran beside verification was ended before its verdict. */
export const REVIEW_CANCEL_REASON = 'superseded-by-verify' as const

/** Why a review with a verdict was left out: its candidate failed the check. */
export const REVIEW_DISCARD_REASON = 'verify-failed' as const

/**
 * What a review step running beside verification stores when the check
 * failed first: no verdict, and the call settled as cancelled.
 */
export interface CancelledReviewStepResult {
  lens: ReviewLens
  status: 'cancelled'
  reason: typeof REVIEW_CANCEL_REASON
}

/** What a review step stores in a run with `parallelReview`. */
export type ParallelReviewStepResult =
  | ReviewStepResult
  | CancelledReviewStepResult

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
  /**
   * Why the worktree could not be removed after the approved delivery was
   * recorded; null when it was. Absent when there was nothing to remove.
   */
  worktreeCleanupWarning?: string | null
}

export interface FactoryState {
  setup: FactorySetup
  iteration: number
  candidate: CandidateRef | null
  verification: VerificationResult | null
  reviews: ReviewVerdict[]
  reviewRounds: number
  implementationSession: SessionRef | null
  /**
   * Whether a repair on its own profile continues the implementation
   * session, confirmed after preflight; null when repair runs on `code`.
   */
  repairSession: ConfirmedRepairSession | null
  repairNotes: string[]
  approval: 'approved' | 'rejected' | null
  outcome: FactoryOutcome | null
}

export function initialState(
  setup: FactorySetup,
  repairSession: ConfirmedRepairSession | null = null,
): FactoryState {
  return {
    setup,
    repairSession,
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
 * Setup's answer to whether a repair on its own profile may continue the
 * implementation session, from the settings and the environment alone.
 * It is never a continuation by itself: Claude Code resolves an alias such
 * as `opus` itself, so the model a profile runs is known only once
 * preflight's minimal call reports it. `confirmRepairSession` turns it into
 * the `ConfirmedRepairSession` the stages read.
 */
export interface RepairSessionSetup {
  /** Nothing in the settings or environment rules it out; preflight decides. */
  eligible: boolean
  /** Why, in one line. */
  reason: string
  /**
   * The config version the run takes once preflight confirms the
   * continuation; set only when `eligible`. The run keeps `configVersion`
   * otherwise, so a setting that never continues keeps the version it had
   * before the policy existed.
   */
  confirmedConfigVersion?: string
}

/**
 * Whether a repair on its own profile continues the implementation session,
 * confirmed with the model preflight saw each profile run on.
 */
export type ConfirmedRepairSession =
  | {
      continues: true
      /** The model preflight saw both profiles run on. */
      model: string
      reason: string
    }
  | { continues: false; reason: string }

/**
 * The step, in the preflight stage, that records the confirmed decision and
 * the config version the run takes with it, next to setup's answer, so a
 * replay reads the same and a report can show why.
 */
export const REPAIR_SESSION_STEP = 'preflight:repair-session'

/** What `REPAIR_SESSION_STEP` stores. */
export interface RepairSessionRecord {
  setup: RepairSessionSetup | null
  confirmed: ConfirmedRepairSession
  /** The config version the run's calls after preflight carry. */
  configVersion: string
}

/** The policy value a confirmed continuation adds to the config version. */
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

const ineligible = (reason: string): RepairSessionSetup => ({
  eligible: false,
  reason,
})
const refused = (reason: string): ConfirmedRepairSession => ({
  continues: false,
  reason,
})

/**
 * Decide at setup, from the settings and the environment alone, whether a
 * repair on its own profile may continue the implementation session.
 * Anything that cannot be confirmed starts a new session. Claude Code runs a
 * full model id as written, so a full id on either side that is not listed,
 * or two different full ids, rule it out here; a model named by an alias is
 * left to `confirmRepairSession`. The returned answer has no
 * `confirmedConfigVersion`: the setup step adds it.
 */
export function repairSessionDecision(
  input: RepairSessionInput,
): RepairSessionSetup {
  const { code, repair } = input
  if (input.contextMode !== 'reuse') return ineligible('context is fresh')
  if (repair.provider !== code.provider)
    return ineligible('repair runs on another provider')
  if (repair.effectiveEffort === code.effectiveEffort)
    return ineligible(
      repair.effectiveModel === code.effectiveModel
        ? 'repair names the same model and effort as code in another spelling; only an effort change continues the session'
        : 'repair has the same effort as code; only an effort change continues the session',
    )
  if (code.provider === 'fake')
    return input.fakeEffortResume
      ? {
          eligible: true,
          reason:
            'fake provider standing in for Claude Code; continues once preflight sees one model for both',
        }
      : ineligible('the fake provider does not change effort mid-session')
  if (code.provider !== 'claude')
    return ineligible(
      `${code.provider} does not continue a session at another effort`,
    )
  const codeModel = code.effectiveModel ?? ''
  const repairModel = repair.effectiveModel ?? ''
  const unlisted = [codeModel, repairModel].find(
    (m) => isFullClaudeModelId(m) && !claudeKeepsCacheAcrossEffort(m),
  )
  if (unlisted !== undefined)
    return ineligible(`${unlisted} is not ${EFFORT_RESUME_MODELS_LABEL}`)
  if (
    isFullClaudeModelId(codeModel) &&
    isFullClaudeModelId(repairModel) &&
    codeModel !== repairModel
  )
    return ineligible('repair runs on another model')
  const environment = claudeEffortResumeEnvironment(
    input.claudeCliVersion,
    input.env,
  )
  if (!environment.keeps) return ineligible(environment.reason)
  return {
    eligible: true,
    reason: `Claude Code ${environment.version} keeps the cache across an effort change on ${EFFORT_RESUME_MODELS_LABEL}; continues once preflight sees both profiles run on one of them`,
  }
}

/**
 * Confirm setup's answer with the concrete model preflight saw each profile
 * run on. Continues only when setup found it eligible and both reported one
 * model, on Claude one that keeps the cache across an effort change. A model
 * that was not reported, as on a run whose preflight predates the report,
 * starts a new session; so does a run set up before setup answered.
 */
export function confirmRepairSession(input: {
  setup: RepairSessionSetup | null | undefined
  provider: ProviderName
  codeModel: string | null
  repairModel: string | null
}): ConfirmedRepairSession {
  const { setup, codeModel, repairModel } = input
  if (!setup) return refused('the run was set up before repairs could continue')
  if (setup.eligible !== true) return refused(setup.reason)
  if (codeModel === null || repairModel === null)
    return refused('preflight did not report the model a profile runs on')
  if (codeModel !== repairModel)
    return refused(`code runs on ${codeModel} and repair on ${repairModel}`)
  if (input.provider === 'claude' && !claudeKeepsCacheAcrossEffort(codeModel))
    return refused(`${codeModel} is not ${EFFORT_RESUME_MODELS_LABEL}`)
  return {
    continues: true,
    reason: `${setup.reason}: preflight saw ${codeModel} for both`,
    model: codeModel,
  }
}

/** How a code-stage call treats the recorded session, and why. */
export interface SessionChoice {
  handling: SessionHandling
  reason: string
}

/**
 * How a code-stage call treats the recorded implementation session. Throws
 * when the session belongs to another provider, working directory or
 * instruction version, or to another profile the call may not continue.
 * `acrossEffortModel` is the confirmed model a repair may continue another
 * profile's session on; null when it may not. Such a session continues when
 * the call that last ran it reported that model, and starts new, with the
 * reason, when it recorded none or another one: the CLI can resolve an
 * alias differently between preflight and that call.
 */
export function sessionHandlingOf(input: {
  recorded: SessionRef | null
  profile: Pick<ResolvedProfile, 'provider' | 'id'>
  cwd: string
  instructionsVersion: string
  acrossEffortModel: string | null
}): SessionChoice {
  const { recorded, profile, acrossEffortModel } = input
  if (!recorded)
    return {
      handling: 'fresh',
      reason: 'no implementation session to continue',
    }
  const mismatch = new Error(
    'implementation session provenance no longer matches setup',
  )
  if (
    recorded.provider !== profile.provider ||
    recorded.cwd !== input.cwd ||
    recorded.instructionsVersion !== input.instructionsVersion
  )
    throw mismatch
  if (recorded.profileId === profile.id)
    return { handling: 'continued', reason: 'the same profile ran the session' }
  if (acrossEffortModel === null) throw mismatch
  if (recorded.model == null)
    return {
      handling: 'fresh',
      reason: 'the implementation session recorded no model',
    }
  if (recorded.model !== acrossEffortModel)
    return {
      handling: 'fresh',
      reason: `the implementation session ran on ${recorded.model}, not the confirmed ${acrossEffortModel}`,
    }
  return {
    handling: 'continued-effort-change',
    reason: `the implementation session ran on the confirmed ${acrossEffortModel}`,
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
