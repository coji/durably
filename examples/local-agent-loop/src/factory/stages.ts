/**
 * Stage handlers own deterministic mechanics; the job only dispatches them.
 *
 * Nothing here knows what is being built. Where the agent edits, how work is
 * sealed, what counts as verified and what the human finally receives all come
 * from the run's `Target`, so the same stage graph drives the bundled sample
 * and a real repository.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import type { JsonValue, StepAttemptContext, StepContext } from '@coji/durably'
import { z } from 'zod'

import { runChild } from '../engine/child.js'
import { SPEC_CHECK_FAILED_MESSAGE } from '../engine/failure-reasons.js'
import {
  boundedDenials,
  type AgentProvider,
  type ReviewCallSettings,
} from '../engine/providers/types.js'
import { checkpointPaths, runAgentCall } from '../engine/runner.js'
import type { CandidateRef, ReviewSnapshots } from '../engine/types.js'
import {
  runVerificationStep,
  type VerificationOutcome,
} from '../engine/verification.js'
import { SpecEventSchema, type SpecEvent } from './events.js'
import { agentLogsDirBeside } from './layout.js'
import { specAction } from './policy.js'
import {
  codePrompt,
  expandReviewCommand,
  LOCAL_INSTRUCTIONS_INPUT,
  localInstructions,
  parseFindingsOutput,
  parseReviewOutput,
  reviewLocations,
  reviewPrompt,
  specAuthorPrompt,
  specBlockerText,
  specFixPrompt,
  specReviewLocations,
  specReviewPrompt,
} from './prompts.js'
import {
  initialSpecState,
  reduceSpec,
  specBlockers,
  type SpecState,
} from './reducer.js'
import type {
  Delivery,
  RepairParentConclusion,
  Target,
  UntrustedInput,
} from './target.js'
import {
  REVIEW_CANCEL_REASON,
  REVIEW_LENSES,
  reviewInvocationOf,
  separateRepairProfile,
  sessionHandlingOf,
  SPEC_AUTHOR_STEP,
  SPEC_CHECK_STEP,
  SPEC_FINAL_STEP,
  specFixStep,
  specReviewStep,
  specWaitName,
  usesReviewMaterials,
  type BaselineIdentity,
  type ParallelReviewStepResult,
  type FactoryOutcome,
  type FactorySetup,
  type ReviewFinding,
  type ReviewInvocation,
  type ReviewLens,
  type ReviewStepResult,
  type SessionRef,
  type SpecCheckRecord,
  type SpecRecord,
  type SpecReviewer,
  type SpecReviewResult,
  type SpecSetup,
  type SpecVersion,
  type StageArgs,
  type StageHandler,
} from './types.js'

function requireCandidate(state: StageArgs['state']) {
  if (!state.candidate) throw new Error('stage requires a candidate')
  return state.candidate
}

/**
 * How a repair run's parent ended; a run set up before it was kept repairs an
 * approved parent. Null on every other run.
 */
function repairParentConclusion(
  setup: FactorySetup,
): RepairParentConclusion | null {
  return setup.repairOf ? (setup.repairOf.parentConclusion ?? 'approved') : null
}

function outcome(
  state: StageArgs['state'],
  conclusion: FactoryOutcome['conclusion'],
  delivery: Delivery | null,
  workdir: string,
  worktreeCleanupWarning?: string | null,
): FactoryOutcome {
  return {
    ...(worktreeCleanupWarning !== undefined ? { worktreeCleanupWarning } : {}),
    approved: conclusion === 'approved',
    conclusion,
    candidate: state.candidate,
    iterations: state.iteration,
    reviewRounds: state.reviewRounds,
    reviews: state.reviews,
    workdir,
    fake: state.setup.fake,
    delivery,
  }
}

export const codeStage: StageHandler = async ({
  step,
  state,
  decision,
  key,
  services,
}) => {
  const role = decision.role
  if (!role) throw new Error('code stage requires a role')
  const iteration = state.iteration + 1
  const target = services.target
  // A repair on its own profile starts a new session with the task, the spec
  // and the repair notes, unless setup found it differs from code in effort
  // alone on a Claude Code that keeps the cache across that change and
  // preflight saw both run on one model: it then continues the
  // implementation session at its own effort. A repair on the code profile
  // continues as before.
  const repairOwn =
    role === 'repair' ? separateRepairProfile(state.setup) : null
  const separateRepair = repairOwn !== null
  // The model preflight confirmed code and repair both run on, when a repair
  // may continue the implementation session across an effort change.
  const repairSession = state.repairSession
  const effortResumeModel = repairSession?.continues
    ? repairSession.model
    : null
  const acrossEffort = separateRepair && effortResumeModel !== null
  const profile = repairOwn ?? state.setup.profiles.code
  const reuse =
    state.setup.contextMode === 'reuse' && (!separateRepair || acrossEffort)
  // A repair run's first repair addresses the outside findings. It starts a
  // session of its own: at iteration 0 this run has no session to continue,
  // and the parent's is never carried over.
  const fromFindings =
    state.iteration === 0 ? repairParentConclusion(state.setup) : null
  // Only the code role's own provider, profile, cwd and instructions decide
  // whether its session may continue; the reviewers' profiles never do.
  const recorded = reuse && !fromFindings ? state.implementationSession : null
  const choice = sessionHandlingOf({
    recorded,
    profile,
    cwd: target.workdir,
    instructionsVersion: state.setup.instructionsVersion,
    acrossEffortModel: acrossEffort ? effortResumeModel : null,
  })
  const continuedSession = choice.handling === 'fresh' ? null : recorded
  const call = await step.run(
    `${key}:agent`,
    (signal, attempt) =>
      runAgentCall(signal, attempt, {
        provider: separateRepair
          ? services.providers.repair
          : services.providers.code,
        providerName: profile.provider,
        prompt: codePrompt({
          role,
          iteration,
          repairNotes: state.repairNotes,
          failedCheckReviews: state.failedCheckReviews,
          task: target.taskBrief(),
          rules: target.implementationRules(),
          untrusted: target.untrustedInputs('code'),
          // Told it starts a new session only when it does. A repair on the
          // code profile keeps the prompt it always had.
          newSession: separateRepair && continuedSession === null,
          fromFindings,
        }),
        workdir: target.workdir,
        timeoutMs: state.setup.agentTimeoutMs,
        requestedModel: profile.requestedModel,
        requestedEffort: profile.requestedEffort,
        effectiveModel: profile.effectiveModel,
        effectiveEffort: profile.effectiveEffort,
        role,
        stage: 'code',
        iteration,
        operationKey: `${step.runId}/${key}/agent`,
        checkpointsDir: state.setup.checkpointsDir,
        agentLogsDir: agentLogsDirBeside(state.setup.checkpointsDir),
        session: continuedSession,
        requireSession: reuse,
        ...(role === 'repair'
          ? {
              sessionHandling: choice.handling,
              // A repair on its own profile that may not continue says why
              // preflight or setup refused it.
              sessionReason: fromFindings
                ? "a repair run's first repair never continues the parent's session"
                : reuse
                  ? choice.reason
                  : (repairSession?.reason ?? 'context is fresh'),
            }
          : {}),
        configVersion: state.setup.configVersion,
      }),
    {
      metadata: {
        stage: role,
        operationKey: `${step.runId}/${key}/agent`,
      } as unknown as JsonValue,
    },
  )
  const candidate = await step.run(`${key}:candidate`, (signal, attempt) =>
    target.seal({
      iteration,
      runId: step.runId,
      attemptId: attempt.id,
      signal,
    }),
  )
  // A separate repair session is not the implementation session: the one on
  // record stays, and the next repair starts new again. A repair that may
  // continue across an effort change records the session it returned, as
  // the code profile does.
  const session: SessionRef | null =
    separateRepair && !acrossEffort
      ? state.implementationSession
      : reuse && call.sessionId
        ? {
            provider: profile.provider,
            nativeId: call.sessionId,
            profileId: profile.id,
            // The model this call reported running, as Claude Code resolves
            // an alias, so a repair continues it only when it ran the model
            // preflight confirmed; the effective model when none was
            // reported, which an alias never matches.
            model: call.observedModel ?? profile.effectiveModel,
            cwd: target.workdir,
            instructionsVersion: state.setup.instructionsVersion,
          }
        : null
  return { type: 'code.completed', role, candidate, session }
}

export const verifyStage: StageHandler = async (args) => {
  const { step, state, key, services } = args
  // With `parallelReview`, the candidate is reviewed while it is verified.
  if (state.setup.parallelReview) return verifyReviewStage(args)
  const target = services.target
  const candidate = requireCandidate(state)
  await target.assertIntact(candidate)
  const result = await step.run(`${key}:acceptance`, (signal, attempt) =>
    verifyCandidate(
      state,
      target,
      candidate,
      `${step.runId}/${key}/acceptance`,
      signal,
      attempt,
    ),
  )
  await target.assertIntact(candidate)
  return {
    type: 'verify.completed',
    targetId: candidate.id,
    passed: result.passed,
    stdout: result.stdout,
    exitCode: result.exitCode,
    log: result.log ?? null,
  }
}

export const reviewStage: StageHandler = async ({
  step,
  state,
  key,
  services,
}) => {
  const target = services.target
  const candidate = requireCandidate(state)
  if (
    !state.verification?.passed ||
    state.verification.targetId !== candidate.id
  )
    throw new Error('review requires the same verified candidate')
  await target.assertIntact(candidate)
  const round = await reviewRoundOf({
    step,
    state,
    key,
    target,
    providers: services.providers,
    candidate,
    snapshotOnly: false,
  })
  const correctness = `${key}:correctness`
  const edgeCases = `${key}:edge-cases`
  let results
  try {
    results = await step.all({
      [correctness]: (signal, attempt) =>
        round.reviewOnce('correctness', signal, attempt),
      [edgeCases]: (signal, attempt) =>
        round.reviewOnce('edge-cases', signal, attempt),
    })
  } finally {
    // The candidate's tree and the reviewers' directories are read only
    // during its review, and removed however the round ends, a replay that
    // only reads checkpoints included: a worker that died after both
    // reviews were recorded left them. The base tree is kept for the next
    // candidate and removed with the run.
    await round.release()
  }
  await target.assertIntact(candidate)
  return {
    type: 'review.completed',
    targetId: candidate.id,
    reviews: [results[correctness], results[edgeCases]].map((r) => {
      // Only a review beside verification is ever cancelled.
      if ('status' in r) throw new Error(`review ${r.lens} was ${r.status}`)
      return r
    }),
  }
}

/**
 * Verification and review of one sealed candidate, started together in one
 * `step.all` (ADR-0029). The steps keep the names the two stages give them
 * one after the other, so a report reads them the same way. The reviewers
 * read the candidate's sealed tree and diff, never the worktree the check
 * runs in. A failed check ends the reviews still running: each call is
 * settled as cancelled with the usage it had reported, and a review that
 * already answered is kept on record but not counted: its verdict and
 * findings go to the next repair, after the check failure. The stage ends
 * once every branch has.
 */
const verifyReviewStage: StageHandler = async (args) => {
  const { step, state, key, services } = args
  const target = services.target
  const candidate = requireCandidate(state)
  await target.assertIntact(candidate)
  const reviewKey = key.replace(/:verify$/, ':review')
  const round = await reviewRoundOf({
    step,
    state,
    key: reviewKey,
    target,
    providers: services.providers,
    candidate,
    snapshotOnly: true,
  })
  // One controller for the round: a failed check ends both reviewers.
  const superseded = new AbortController()
  const acceptance = `${key}:acceptance`
  const correctness = `${reviewKey}:correctness`
  const edgeCases = `${reviewKey}:edge-cases`
  let results
  try {
    results = await step.all({
      [acceptance]: async (
        signal: AbortSignal,
        attempt: StepAttemptContext,
      ) => {
        const result = await verifyCandidate(
          state,
          target,
          candidate,
          `${step.runId}/${key}/acceptance`,
          signal,
          attempt,
        )
        if (!result.passed)
          superseded.abort(new Error('the candidate failed verification'))
        return result
      },
      [correctness]: (signal: AbortSignal, attempt: StepAttemptContext) =>
        round.reviewOnce('correctness', signal, attempt, superseded.signal),
      [edgeCases]: (signal: AbortSignal, attempt: StepAttemptContext) =>
        round.reviewOnce('edge-cases', signal, attempt, superseded.signal),
    })
  } finally {
    await round.release()
  }
  await target.assertIntact(candidate)
  const verification = results[acceptance] as VerificationOutcome
  const reviews = [
    results[correctness],
    results[edgeCases],
  ] as ParallelReviewStepResult[]
  // A cancelled review has no verdict and hands the repair nothing. Parsing
  // the event strips the findings from a passing round's reviews.
  const completed = reviews.flatMap((r) =>
    'status' in r
      ? []
      : [
          {
            lens: r.lens,
            decision: r.decision,
            notes: r.notes,
            findings: r.findings,
          },
        ],
  )
  return {
    type: 'verify-review.completed',
    targetId: candidate.id,
    passed: verification.passed,
    stdout: verification.stdout,
    exitCode: verification.exitCode,
    log: verification.log ?? null,
    ...(verification.passed
      ? { reviews: completed }
      : { reviews: null, failedCheckReviews: completed }),
  }
}

/** Grade one sealed candidate through the verification checkpoint pair. */
function verifyCandidate(
  state: StageArgs['state'],
  target: Target,
  candidate: CandidateRef,
  operationKey: string,
  signal: AbortSignal,
  attempt: StepAttemptContext,
) {
  return runVerificationStep(
    attempt,
    {
      provider: state.setup.profiles.code.provider,
      operationKey,
      checkpointsDir: state.setup.checkpointsDir,
      stage: 'verify',
      iteration: state.iteration,
      // What "verified" means belongs to the target. The engine only owns
      // the checkpointing, the measurement, and the signal.
      grade: (graderSignal) =>
        target.grade({
          candidate,
          scratchDir: join(
            state.setup.checkpointsDir,
            '..',
            'verification-scratch',
            candidate.id,
            attempt.id,
          ),
          // Keyed by the step attempt: a worker that dies mid-grading
          // leaves its partial log, and the re-grade writes a new one.
          logDir: join(
            state.setup.checkpointsDir,
            '..',
            'verification-logs',
            candidate.id,
            attempt.id,
          ),
          signal: graderSignal,
        }),
    },
    signal,
  )
}

/**
 * One review round on `candidate`: each lens's call, and the removal of
 * what the round extracted. With `snapshotOnly`, on a target with review
 * snapshots, every reviewer reads the candidate's sealed tree and diff and
 * nothing else of it: a prompt review works in that tree, a command review
 * in its own directory, and neither is shown the worktree.
 */
async function reviewRoundOf(args: {
  step: StageArgs['step']
  state: StageArgs['state']
  key: string
  target: Target
  providers: StageArgs['services']['providers']
  candidate: CandidateRef
  snapshotOnly: boolean
}) {
  const { step, state, key, target, candidate } = args
  const trustedContext = await target.reviewContext(candidate)
  const reviewCwd = target.reviewCwd(candidate)
  // Both reviewers read the same candidate's diff and changed-file list, and
  // may read those two files even though they sit outside the review cwd.
  const changes = candidate.changes ?? null
  const readableFiles = changes
    ? [changes.diffPath, changes.changedFilesPath]
    : []
  const setup = state.setup
  const baseCommit =
    setup.target.kind === 'repo' ? setup.target.baseCommit : null
  // Only a target with review snapshots has a worktree to keep reviewers
  // out of; the sample's candidate is already a sealed copy.
  const snapshotOnly =
    args.snapshotOnly && target.prepareReviewSnapshots !== undefined
  // Whether any reviewer of the round reads the base and head trees.
  const materials =
    snapshotOnly ||
    REVIEW_LENSES.some((lens) =>
      usesReviewMaterials(reviewInvocationOf(setup, lens)),
    )
  // The base and head trees, extracted once for both reviewers of this
  // round when either reads them, and only when a call is about to be made.
  let snapshots: Promise<ReviewSnapshots> | null = null
  const materialsFor = async (signal: AbortSignal) => {
    const { prepareReviewSnapshots, prepareReviewWorkdir } = target
    if (!prepareReviewSnapshots || !prepareReviewWorkdir)
      throw new Error(
        'review: a reviewer command or local instructions need a target with review snapshots',
      )
    snapshots ??= prepareReviewSnapshots.call(target, candidate, signal)
    return {
      trees: await snapshots,
      workdir: (lens: ReviewLens, localFile: string) =>
        prepareReviewWorkdir.call(target, candidate, lens, localFile),
    }
  }
  const round = state.reviewRounds + 1
  const reviewOnce = async (
    lens: ReviewLens,
    signal: AbortSignal,
    attempt: StepAttemptContext,
    superseded?: AbortSignal,
  ): Promise<ParallelReviewStepResult> => {
    // Each reviewer has its own profile and provider, and always starts a
    // new session: two branches never share one.
    const profile = setup.profiles[lens]
    const role = lens === 'correctness' ? 'review-a' : 'review-b'
    const invocation = reviewInvocationOf(setup, lens)
    const output = invocation?.output ?? 'verdict'
    const commandMode = usesReviewMaterials(invocation)
    // A failed check ends the extraction too. Then nothing is sent: the
    // call below records it as not sent, in the directory it never uses.
    const own =
      commandMode || snapshotOnly
        ? await materialsFor(
            superseded ? AbortSignal.any([signal, superseded]) : signal,
          ).catch((error: unknown) => {
            if (superseded?.aborted && !signal.aborted) return null
            throw error
          })
        : null
    const trees = own?.trees ?? null
    const context = reviewPrompt(
      lens,
      trustedContext,
      target.reviewRules(lens),
      target.untrustedInputs(lens),
      changes,
      repairParentConclusion(setup),
      {
        output,
        // A prompt review in the sealed tree is shown that tree alone.
        snapshots: commandMode ? trees : null,
        // A command-mode reviewer works in a directory of its own, so it
        // is told where the candidate is: the worktree, or the sealed tree
        // when the check runs in the worktree beside it.
        worktree: commandMode && !snapshotOnly ? reviewCwd : null,
        candidateTree: !commandMode && trees ? trees.headDir : null,
      },
    )
    // `{base}` and `{head}` are the run's base commit and this candidate's.
    const command =
      invocation?.command != null
        ? expandReviewCommand(invocation.command, {
            effort: profile.effectiveEffort,
            base: baseCommit,
            head: candidate.commit ?? null,
          })
        : null
    const local = invocation?.context === 'local-instructions'
    const input = reviewInputOf(local, command, context)
    // A command-mode reviewer runs in a working directory the factory made
    // for this call alone: the base commit's CLAUDE.md and .claude/, and its
    // own CLAUDE.local.md. That file carries the whole review context, or,
    // when the context travels in the prompt, where the candidate is, so a
    // subagent that never sees the prompt still finds the code. The
    // candidate is only read, as data. A prompt review beside the check
    // works in the candidate's sealed tree.
    const workdir =
      own && commandMode
        ? await own.workdir(
            lens,
            local
              ? localInstructions(context)
              : reviewLocations({
                  worktree: snapshotOnly ? null : reviewCwd,
                  changes,
                  snapshots: own.trees,
                }),
          )
        : trees
          ? trees.headDir
          : snapshotOnly
            ? setup.checkpointsDir
            : reviewCwd
    const settings: ReviewCallSettings | null = invocation
      ? {
          command: command !== null,
          context: invocation.context,
          output,
          readableDirs:
            trees && changes
              ? [
                  ...(snapshotOnly ? [] : [reviewCwd]),
                  dirname(changes.diffPath),
                  trees.baseDir,
                  trees.headDir,
                ]
              : [],
        }
      : null
    const result = await runAgentCall(signal, attempt, {
      provider: args.providers[lens],
      providerName: profile.provider,
      prompt: input,
      workdir,
      readableFiles,
      ...(settings ? { review: settings } : {}),
      timeoutMs: setup.agentTimeoutMs,
      requestedModel: profile.requestedModel,
      requestedEffort: profile.requestedEffort,
      effectiveModel: profile.effectiveModel,
      effectiveEffort: profile.effectiveEffort,
      role,
      stage: `review:${lens}`,
      iteration: state.iteration,
      reviewRound: round,
      operationKey: `${step.runId}/${key}/${lens}`,
      checkpointsDir: setup.checkpointsDir,
      agentLogsDir: agentLogsDirBeside(setup.checkpointsDir),
      session: null,
      configVersion: setup.configVersion,
      ...(superseded
        ? { supersede: { signal: superseded, reason: REVIEW_CANCEL_REASON } }
        : {}),
    })
    if (result.cancelled)
      return { lens, status: 'cancelled', reason: REVIEW_CANCEL_REASON }
    // The findings are kept with the verdict in this completed step, so a
    // report reads them back without calling the reviewer or reading the
    // checkpoint again. The review event drops them before the state.
    return { lens, ...readReviewReply(output, result, lens) }
  }
  return {
    reviewOnce,
    release: async () => {
      if (materials) await target.releaseReviewSnapshots?.({ base: false })
    },
  }
}

export const approvalStage: StageHandler = async ({
  step,
  state,
  key,
  services,
}) => {
  const target = services.target
  const candidate = requireCandidate(state)
  await target.assertIntact(candidate)
  const wait = await step.prepareWait(`${key}:${candidate.id}`, {
    metadata: {
      candidateId: candidate.id,
      snapshotDir: candidate.snapshotDir,
      sourceHash: candidate.sourceHash,
      reviews: state.reviews,
    } as unknown as JsonValue,
  })
  const result = await step.waitFor(wait)
  await target.assertIntact(candidate)
  if (result.type === 'timeout') {
    // Nobody answered. Saying so is not the same as saying the candidate
    // changed under us, which is what the mismatch check below reports.
    throw new Error(
      `approval timed out for ${candidate.id}; no decision was signalled`,
    )
  }
  const payload =
    result.type === 'signal' &&
    result.payload &&
    typeof result.payload === 'object'
      ? (result.payload as { candidateId?: string; decision?: string })
      : null
  if (payload?.candidateId !== candidate.id)
    throw new Error(`approval candidate mismatch: expected ${candidate.id}`)
  if (payload.decision !== 'approved' && payload.decision !== 'rejected')
    throw new Error(`invalid approval decision for ${candidate.id}`)
  return {
    type: 'approval.completed',
    targetId: candidate.id,
    decision: payload.decision,
  }
}

export const finishStage: StageHandler = async ({
  step,
  state,
  key,
  services,
}) => {
  const target = services.target
  const candidate = requireCandidate(state)
  await target.assertIntact(candidate)
  const rejected = state.approval === 'rejected'
  // Delivery is outward-facing (it may push a branch and open a pull request),
  // so it is its own step: a replay reads the recorded result instead of
  // publishing twice.
  const delivery = rejected
    ? null
    : await step.run(`${key}:deliver`, (signal) =>
        target.deliver({
          candidate,
          iteration: state.iteration,
          runId: step.runId,
          reviews: state.reviews,
          signal,
        }),
      )
  // Once the delivery is recorded, the worktree has served its purpose: a
  // later fix starts a new run from the recorded commit and branch. Its
  // removal is a step of its own, so a replay reads what it came to rather
  // than removing again, and a failure is only a warning on the result.
  // From here on the target no longer asks for the worktree (ADR-0028).
  const retire = target.retireWorktree
  const cleanup =
    delivery && retire
      ? await step.run(`${key}:worktree`, async () => ({
          warning: await retire.call(target),
        }))
      : null
  return step.run(`${key}:result`, async () => ({
    type: 'factory.finished' as const,
    outcome: outcome(
      state,
      rejected ? 'rejected' : 'approved',
      delivery,
      target.workdir,
      cleanup ? cleanup.warning : undefined,
    ),
  }))
}

export const stopStage: StageHandler = async ({
  step,
  state,
  key,
  services,
}) => {
  const target = services.target
  if (state.candidate) await target.assertIntact(state.candidate)
  return step.run(`${key}:result`, async () => ({
    type: 'factory.finished' as const,
    outcome: outcome(
      state,
      state.verification?.passed ? 'review-cap-reached' : 'verification-failed',
      null,
      target.workdir,
    ),
  }))
}

export const stages = {
  code: codeStage,
  verify: verifyStage,
  review: reviewStage,
  approve: approvalStage,
  finish: finishStage,
  stop: stopStage,
} satisfies Record<StageArgs['decision']['stage'], StageHandler>

// ---------------------------------------------------------------- spec stages

/** The providers the spec stages call, one per role and reviewer. */
export interface SpecProviders {
  author: AgentProvider
  fix: AgentProvider
  /** By reviewer name. */
  reviewers: Record<string, AgentProvider>
}

export interface SpecStageArgs {
  step: StepContext
  /** The run's setup as the calls after preflight see it. */
  setup: FactorySetup
  spec: SpecSetup
  target: Target
  providers: SpecProviders
}

/** How the spec stages ended: a spec to go on with, or a person's no. */
export type SpecOutcome =
  | { kind: 'confirmed'; record: SpecRecord }
  | { kind: 'rejected'; version: SpecVersion }

const sha256Of = (text: string) =>
  createHash('sha256').update(text).digest('hex')

/** The payload a spec-blocked wait accepts; see `signalApproval`. */
const specSignalSchema = z.object({
  kind: z.literal('spec'),
  runId: z.string(),
  specSha256: z.string(),
  decision: z.enum(['approved', 'rejected', 'revise']),
  notes: z.string().nullable().optional(),
})

/**
 * What a reviewer is sent: with local instructions, its command or the fixed
 * instruction; otherwise its command, if any, before the review context.
 */
function reviewInputOf(
  local: boolean,
  command: string | null,
  context: string,
): string {
  if (local) return command ?? LOCAL_INSTRUCTIONS_INPUT
  return command !== null ? `${command}\n\n${context}` : context
}

/**
 * A reviewer's verdict, read only after the completed checkpoint, so a reply
 * that cannot be read stops the review and is never sent again. `who` names
 * the reviewer in the error. A tool call the guard refused does not stop it:
 * the guard refuses only what is outside the candidate, its trees and the
 * review's own directory, so the refusal is kept with the verdict instead
 * (ADR-0023).
 */
function readReviewReply(
  output: ReviewInvocation['output'],
  result: { text: string; permissionDenials: string[] },
  who: string,
): Pick<
  ReviewStepResult,
  'decision' | 'notes' | 'findings' | 'permissionDenials'
> {
  const parsed =
    output === 'findings-json'
      ? parseFindingsOutput(result.text)
      : parseReviewOutput(result.text)
  if (!parsed.ok) throw new Error(`review-incomplete (${who}): ${parsed.error}`)
  const denials = boundedDenials(result.permissionDenials)
  return {
    decision: parsed.decision,
    notes: parsed.notes,
    findings: parsed.findings ?? null,
    ...(denials ? { permissionDenials: denials } : {}),
  }
}

/**
 * Remove every entry of the spec directory other than the spec file, and
 * name what was removed. A Codex writer's workspace-write sandbox is the
 * whole spec directory, so it can leave files beside the spec; this is
 * where the spec-file-only rule is enforced for it. A Claude writer is held
 * to the file by its tool guard, so for it this finds nothing.
 */
export async function removeBesideSpec(specPath: string): Promise<string[]> {
  const keep = basename(specPath)
  const dir = dirname(specPath)
  // A call swept on its failure path may never have reached the point that
  // creates the spec directory (for example, one refused before it starts
  // because an earlier attempt's checkpoint is uncertain); that is nothing
  // to sweep, not a sweep failure that should hide the original error.
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const extra = entries.filter((name) => name !== keep).sort()
  for (const name of extra)
    await rm(join(dir, name), { recursive: true, force: true })
  return extra
}

/**
 * Sweeps spec-directory siblings after a writer call, without ever letting
 * a cleanup failure replace or hide the call's own error. Pass the call's
 * error when the call failed: cleanup still runs, but its own failure is
 * swallowed and `callError` is rethrown unchanged. Pass `undefined` when
 * the call succeeded: a cleanup failure is reported as `cleanupWarning`
 * instead of thrown, since a call that already succeeded must not fail the
 * step over cleanup.
 */
export async function cleanupSpecWriteSiblings(
  specPath: string,
  callError?: unknown,
): Promise<{ removed: string[]; cleanupWarning: string | null }> {
  if (callError !== undefined) {
    await removeBesideSpec(specPath).catch(() => {})
    throw callError
  }
  try {
    return { removed: await removeBesideSpec(specPath), cleanupWarning: null }
  } catch (cleanupError) {
    return {
      removed: [],
      cleanupWarning: `failed to remove files beside ${basename(specPath)}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
    }
  }
}

/**
 * Fails the step when the spec file a writer left is not a regular file —
 * for example a symlink, which later reads and writes would follow. The
 * entry is removed first, so nothing else in the run can point through it.
 */
async function assertSpecIsRegularFile(specPath: string): Promise<void> {
  const stat = await lstat(specPath).catch(() => null)
  if (stat && !stat.isFile()) {
    await rm(specPath, { force: true })
    throw new Error('spec.md must be a regular file')
  }
}

/**
 * The spec stages: the author writes the run's spec file, the named
 * reviewers review it side by side, a fix answers their blockers and the
 * next round reviews again, until a round has no blocker or `maxRounds` is
 * spent; then a person decides through a durable wait. Each call goes
 * through the common checkpoint path, and each result is a stored step or
 * wait, so a replay reads the same results and resends nothing. The pure
 * `reduceSpec` and `specAction` decide every transition.
 */
export async function runSpecStages(args: SpecStageArgs): Promise<SpecOutcome> {
  const { step, setup, spec, target } = args
  const specDir = dirname(spec.specPath)
  let state = initialSpecState(spec.maxRounds)
  const apply = (event: SpecEvent) => {
    state = reduceSpec(state, SpecEventSchema.parse(event))
  }
  // Every stage that reads the spec file first puts the version it works
  // on there: a replay passes completed steps without writing anything.
  const put = async (content: string) => {
    await mkdir(specDir, { recursive: true })
    await writeFile(spec.specPath, content, 'utf8')
  }
  const task = target
    .untrustedInputs('code')
    .filter((input) => input.label === 'TASK')

  const write = async (role: 'author' | 'fix'): Promise<SpecVersion> => {
    const name = role === 'author' ? SPEC_AUTHOR_STEP : specFixStep(state.round)
    const operationKey = `${step.runId}/${name}`
    const profile = role === 'author' ? spec.author : spec.fix
    // The spec this call starts from, taken before the step runs.
    const start =
      role === 'author' ? (spec.template ?? '') : (state.version?.content ?? '')
    const feedback: UntrustedInput[] =
      role === 'author'
        ? []
        : [
            {
              label: 'SPEC_FINDINGS' as const,
              content: specBlockers(state)
                .map((r) => `${r.name}:\n${specBlockerText(r)}`)
                .join('\n\n'),
            },
            ...(state.settled.length > 0
              ? [
                  {
                    label: 'SETTLED_FINDINGS' as const,
                    content: state.settled.join('\n'),
                  },
                ]
              : []),
            ...(state.reviseNotes
              ? [{ label: 'HUMAN_NOTES' as const, content: state.reviseNotes }]
              : []),
          ].filter((input) => input.content.trim().length > 0)
    const base = {
      worktree: target.workdir,
      specPath: spec.specPath,
      template: spec.template,
      untrusted: task,
    }
    return step.run(
      name,
      async (signal, attempt) => {
        // Written only before the call starts: once it has, the file holds
        // whatever the call wrote, and a completed checkpoint is read back.
        const { started } = checkpointPaths(setup.checkpointsDir, operationKey)
        if (!existsSync(started)) await put(start)
        // Swept whether the call succeeds or fails, so a writer that errors
        // or times out also leaves nothing beside the spec file; see
        // `cleanupSpecWriteSiblings` for how a sweep failure is handled on
        // each path.
        try {
          await runAgentCall(signal, attempt, {
            provider: args.providers[role],
            providerName: profile.provider,
            prompt:
              role === 'author'
                ? specAuthorPrompt(base)
                : specFixPrompt({ ...base, feedback }),
            // The spec's own directory: the file alone is writable.
            workdir: specDir,
            specWrite: {
              writableFile: spec.specPath,
              readableDirs: [target.workdir],
            },
            timeoutMs: setup.agentTimeoutMs,
            requestedModel: profile.requestedModel,
            requestedEffort: profile.requestedEffort,
            effectiveModel: profile.effectiveModel,
            effectiveEffort: profile.effectiveEffort,
            role: role === 'author' ? 'spec-author' : 'spec-fix',
            stage: 'spec',
            iteration: 0,
            operationKey,
            checkpointsDir: setup.checkpointsDir,
            agentLogsDir: agentLogsDirBeside(setup.checkpointsDir),
            session: null,
            configVersion: setup.configVersion,
          })
        } catch (callError) {
          // A sibling-cleanup failure on this path must never replace the
          // call's own error; `cleanupSpecWriteSiblings` rethrows it.
          await cleanupSpecWriteSiblings(spec.specPath, callError)
        }
        // The call succeeded: a cleanup failure must not fail this step, so
        // it is recorded as a warning in the step output instead of thrown.
        const { removed, cleanupWarning } = await cleanupSpecWriteSiblings(
          spec.specPath,
        )
        await assertSpecIsRegularFile(spec.specPath)
        const content = await readFile(spec.specPath, 'utf8')
        if (content.trim().length === 0)
          throw new Error(
            `spec-incomplete: the spec ${role} left ${spec.specPath} empty`,
          )
        return {
          content,
          sha256: sha256Of(content),
          ...(removed.length > 0
            ? {
                removed,
                warning: `the spec ${role} left ${removed.join(', ')} beside ${basename(spec.specPath)}; removed`,
              }
            : {}),
          ...(cleanupWarning ? { cleanupWarning } : {}),
        }
      },
      {
        metadata: { stage: 'spec', operationKey } as unknown as JsonValue,
      },
    )
  }

  const baseCommit =
    setup.target.kind === 'repo' ? setup.target.baseCommit : null
  // The base tree, extracted once and shared by every reviewer of every
  // round that runs a command or local instructions: extraction is not
  // safe to race, and the base commit never changes across the run.
  let specBaseTree: Promise<string> | null = null
  const reviewOnce = async (
    reviewer: SpecReviewer,
    round: number,
    signal: AbortSignal,
    attempt: StepAttemptContext,
  ): Promise<SpecReviewResult> => {
    const { name, profile, invocation } = reviewer
    const output = invocation?.output ?? 'verdict'
    const commandMode = usesReviewMaterials(invocation)
    const context = specReviewPrompt({
      name,
      worktree: target.workdir,
      specPath: spec.specPath,
      reviewTemplate: spec.reviewTemplate,
      untrusted: task,
      output,
    })
    // `{effort}` and `{base}` only: no candidate exists yet, and trigger
    // refuses `{head}`.
    const command =
      invocation?.command != null
        ? expandReviewCommand(invocation.command, {
            effort: profile.effectiveEffort,
            base: baseCommit,
            head: null,
          })
        : null
    const local = invocation?.context === 'local-instructions'
    const input = reviewInputOf(local, command, context)
    let workdir = target.workdir
    if (commandMode) {
      if (!target.prepareSpecReviewWorkdir || !target.prepareSpecReviewBase)
        throw new Error(
          `spec review (${name}): a reviewer command or local instructions need a target with review snapshots`,
        )
      specBaseTree ??= target.prepareSpecReviewBase.call(target, signal)
      await specBaseTree
      workdir = await target.prepareSpecReviewWorkdir(
        round,
        name,
        local
          ? localInstructions(context)
          : specReviewLocations({
              worktree: target.workdir,
              specPath: spec.specPath,
            }),
      )
    }
    const settings: ReviewCallSettings | null = invocation
      ? {
          command: command !== null,
          context: invocation.context,
          output,
          readableDirs: commandMode ? [target.workdir, specDir] : [],
        }
      : null
    const stepName = specReviewStep(round, name)
    const result = await runAgentCall(signal, attempt, {
      provider: args.providers.reviewers[name] as AgentProvider,
      providerName: profile.provider,
      prompt: input,
      workdir,
      readableFiles: [spec.specPath],
      ...(settings ? { review: settings } : {}),
      specReviewer: name,
      timeoutMs: setup.agentTimeoutMs,
      requestedModel: profile.requestedModel,
      requestedEffort: profile.requestedEffort,
      effectiveModel: profile.effectiveModel,
      effectiveEffort: profile.effectiveEffort,
      role: 'spec-review',
      stage: 'spec-review',
      iteration: 0,
      reviewRound: round,
      operationKey: `${step.runId}/${stepName}`,
      checkpointsDir: setup.checkpointsDir,
      agentLogsDir: agentLogsDirBeside(setup.checkpointsDir),
      session: null,
      configVersion: setup.configVersion,
    })
    return {
      name,
      ...readReviewReply(output, result, `spec ${name}`),
    }
  }

  const reviewRound = async (version: SpecVersion) => {
    const round = state.round + 1
    await put(version.content)
    const materials = spec.reviewers.some((r) =>
      usesReviewMaterials(r.invocation),
    )
    let results: Record<string, SpecReviewResult>
    try {
      results = await step.all(
        Object.fromEntries(
          spec.reviewers.map((reviewer) => [
            specReviewStep(round, reviewer.name),
            (signal: AbortSignal, attempt: StepAttemptContext) =>
              reviewOnce(reviewer, round, signal, attempt),
          ]),
        ),
      )
    } finally {
      // Each reviewer's directory is read during its review only.
      if (materials) await target.releaseReviewSnapshots?.({ base: false })
    }
    return spec.reviewers.map(
      (r) => results[specReviewStep(round, r.name)] as SpecReviewResult,
    )
  }

  const decide = async (version: SpecVersion): Promise<SpecEvent> => {
    const wait = await step.prepareWait(specWaitName(state.waits + 1), {
      metadata: {
        kind: 'spec-blocked',
        runId: step.runId,
        specSha256: version.sha256,
        round: state.round,
        blockers: specBlockers(state).map((r) => ({
          name: r.name,
          notes: r.notes,
        })),
      } as unknown as JsonValue,
    })
    const result = await step.waitFor(wait)
    if (result.type === 'timeout')
      throw new Error(
        `spec decision timed out for spec ${version.sha256.slice(0, 12)}; no decision was signalled`,
      )
    const payload = specSignalSchema.safeParse(result.payload)
    if (
      !payload.success ||
      payload.data.runId !== step.runId ||
      payload.data.specSha256 !== version.sha256
    )
      throw new Error(
        `spec decision mismatch: expected run ${step.runId} and spec ${version.sha256.slice(0, 12)}`,
      )
    const notes = payload.data.notes ?? null
    if (payload.data.decision === 'revise' && !notes?.trim())
      throw new Error('spec decision: a revise carries no notes')
    return {
      type: 'spec.decided',
      sha256: version.sha256,
      decision: payload.data.decision,
      notes,
    }
  }

  for (;;) {
    const action = specAction(state)
    const version = state.version
    // `specAction` authors exactly when there is no version yet.
    if (action === 'author' || !version) {
      apply({ type: 'spec.authored', version: await write('author') })
      continue
    }
    if (action === 'fix')
      apply({ type: 'spec.fixed', version: await write('fix') })
    else if (action === 'review')
      apply({
        type: 'spec.reviewed',
        sha256: version.sha256,
        reviews: await reviewRound(version),
      })
    else if (action === 'wait') apply(await decide(version))
    else if (action === 'reject') return { kind: 'rejected', version }
    else {
      const record = await step.run(
        SPEC_FINAL_STEP,
        async (): Promise<SpecRecord> => ({
          ...version,
          round: state.round,
          // Approved over its blockers, not merely waited on: a revise
          // that a later round passed is the reviewers' confirmation.
          blocked: state.decision === 'approved',
          advice: specAdvice(state),
        }),
        { metadata: { stage: 'spec' } as unknown as JsonValue },
      )
      await put(record.content)
      return { kind: 'confirmed', record }
    }
  }
}

/**
 * The confirming round's advice: every non-blocking finding, and, when a
 * person approved the spec over them, its blockers too.
 */
function specAdvice(state: SpecState): ReviewFinding[] {
  const approvedOver = state.decision === 'approved'
  return state.reviews.flatMap((r) => [
    ...(r.findings?.nonBlocker ?? []),
    ...(approvedOver
      ? r.findings
        ? r.findings.blocker
        : r.decision === 'needsChanges'
          ? [{ severity: 'blocker' as const, title: r.name, body: r.notes }]
          : []
      : []),
  ])
}

/** The advice as the implementer's untrusted SPEC_ADVICE block. */
export function specAdviceText(advice: ReviewFinding[]): string | null {
  if (advice.length === 0) return null
  return advice
    .map(
      (f) =>
        `- [${f.severity}]${f.file ? ` ${f.file}${f.line !== undefined ? `:${f.line}` : ''}` : ''} ${f.title} — ${f.body}`,
    )
    .join('\n')
}

/** What `checkFromSpec` must print on success. */
const checkOutputSchema = z
  .object({
    check: z.array(z.string().min(1)).min(1),
    notes: z.string().optional(),
  })
  .strict()

/**
 * Run `checkFromSpec` once on the run's fixed spec, in the worktree, within
 * the check timeout, and record the check it chose and the baseline identity
 * with that check. The script is local, so an interrupted attempt runs it
 * again; a completed step is read back and never run again. Every failure,
 * a timeout, output that is not the expected JSON and an empty check
 * included, stops the run as `spec-check-failed` before the baseline and
 * any implementation call.
 */
export async function runCheckFromSpec(
  step: StepContext,
  args: {
    command: string[]
    specPath: string
    spec: string
    workdir: string
    timeoutMs: number
    identityOf: (check: string[]) => Promise<BaselineIdentity | null>
  },
): Promise<SpecCheckRecord> {
  return step.run(
    SPEC_CHECK_STEP,
    async (signal) => {
      const [command, ...rest] = args.command
      if (!command) throw new Error(`${SPEC_CHECK_FAILED_MESSAGE}: no command`)
      await mkdir(dirname(args.specPath), { recursive: true })
      await writeFile(args.specPath, args.spec, 'utf8')
      const shown = [...args.command, args.specPath].join(' ')
      const stop = (why: string) =>
        new Error(
          `${SPEC_CHECK_FAILED_MESSAGE}: \`${shown}\` ${why}; stopped before the baseline check and any implementation call`,
        )
      let res
      try {
        res = await runChild(command, [...rest, args.specPath], {
          cwd: args.workdir,
          timeoutMs: args.timeoutMs,
          maxOutputChars: 256 * 1024,
          signal,
        })
      } catch (error) {
        if (signal.aborted || (error as Error).name === 'SpawnCancelledError')
          throw error
        throw stop(`could not run (${(error as Error).message})`)
      }
      if (res.code !== 0)
        throw stop(
          `exited with ${res.code ?? 'no exit code'}: ${res.stderr.slice(-500).trim()}`,
        )
      let raw: unknown
      try {
        raw = JSON.parse(res.stdout)
      } catch {
        throw stop(`printed no JSON: ${res.stdout.slice(0, 200).trim()}`)
      }
      const parsed = checkOutputSchema.safeParse(raw)
      if (!parsed.success)
        throw stop(
          `printed JSON that is not { "check": [non-empty strings], "notes"?: string }: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
        )
      const record: SpecCheckRecord = {
        check: parsed.data.check,
        notes: parsed.data.notes?.trim() ? parsed.data.notes : null,
        baselineIdentity: await args.identityOf(parsed.data.check),
      }
      return record
    },
    { metadata: { stage: 'spec-check' } as unknown as JsonValue },
  )
}
