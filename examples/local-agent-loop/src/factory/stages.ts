/**
 * Stage handlers own deterministic mechanics; the job only dispatches them.
 *
 * Nothing here knows what is being built. Where the agent edits, how work is
 * sealed, what counts as verified and what the human finally receives all come
 * from the run's `Target`, so the same stage graph drives the bundled sample
 * and a real repository.
 */
import { dirname, join } from 'node:path'

import type { JsonValue, StepAttemptContext } from '@coji/durably'

import type { ReviewCallSettings } from '../engine/providers/types.js'
import { runAgentCall } from '../engine/runner.js'
import type { ReviewSnapshots } from '../engine/types.js'
import { runVerificationStep } from '../engine/verification.js'
import {
  codePrompt,
  expandReviewCommand,
  LOCAL_INSTRUCTIONS_INPUT,
  localInstructions,
  parseFindingsOutput,
  parseReviewOutput,
  reviewPrompt,
} from './prompts.js'
import type { Delivery } from './target.js'
import {
  REVIEW_LENSES,
  reviewInvocationOf,
  separateRepairProfile,
  usesReviewMaterials,
  type FactoryOutcome,
  type ReviewLens,
  type ReviewVerdict,
  type SessionRef,
  type StageArgs,
  type StageHandler,
} from './types.js'

function requireCandidate(state: StageArgs['state']) {
  if (!state.candidate) throw new Error('stage requires a candidate')
  return state.candidate
}

function outcome(
  state: StageArgs['state'],
  conclusion: FactoryOutcome['conclusion'],
  delivery: Delivery | null,
  workdir: string,
): FactoryOutcome {
  return {
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
  // and the repair notes; a repair on the code profile continues as before.
  const repairOwn =
    role === 'repair' ? separateRepairProfile(state.setup) : null
  const separateRepair = repairOwn !== null
  const profile = repairOwn ?? state.setup.profiles.code
  const reuse = state.setup.contextMode === 'reuse' && !separateRepair
  // A repair run's first repair addresses the outside findings. It starts a
  // session of its own: at iteration 0 this run has no session to continue,
  // and the parent's is never carried over.
  const fromFindings = Boolean(state.setup.repairOf) && state.iteration === 0
  const continuedSession = reuse ? state.implementationSession : null
  // Only the code role's own provider, profile, cwd and instructions decide
  // whether its session may continue; the reviewers' profiles never do.
  if (
    continuedSession &&
    (continuedSession.provider !== profile.provider ||
      continuedSession.profileId !== profile.id ||
      continuedSession.cwd !== target.workdir ||
      continuedSession.instructionsVersion !== state.setup.instructionsVersion)
  ) {
    throw new Error('implementation session provenance no longer matches setup')
  }
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
          task: target.taskBrief(),
          rules: target.implementationRules(),
          untrusted: target.untrustedInputs('code'),
          newSession: separateRepair,
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
        session: continuedSession,
        requireSession: reuse,
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
  // record stays, and the next repair starts new again.
  const session: SessionRef | null = separateRepair
    ? state.implementationSession
    : reuse && call.sessionId
      ? {
          provider: profile.provider,
          nativeId: call.sessionId,
          profileId: profile.id,
          cwd: target.workdir,
          instructionsVersion: state.setup.instructionsVersion,
        }
      : null
  return { type: 'code.completed', role, candidate, session }
}

export const verifyStage: StageHandler = async ({
  step,
  state,
  key,
  services,
}) => {
  const target = services.target
  const candidate = requireCandidate(state)
  await target.assertIntact(candidate)
  const result = await step.run(`${key}:acceptance`, (signal, attempt) =>
    runVerificationStep(
      attempt,
      {
        provider: state.setup.profiles.code.provider,
        operationKey: `${step.runId}/${key}/acceptance`,
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
  // Whether any reviewer of the round reads the base and head trees and
  // works in a directory of its own.
  const materials = REVIEW_LENSES.some((lens) =>
    usesReviewMaterials(reviewInvocationOf(setup, lens)),
  )
  // The base and head trees, extracted once for both reviewers of this
  // round when either reads them, and only when a call is about to be made.
  let snapshots: Promise<ReviewSnapshots> | null = null
  const snapshotsFor = (signal: AbortSignal): Promise<ReviewSnapshots> => {
    if (!target.prepareReviewSnapshots || !target.prepareReviewWorkdir)
      throw new Error(
        'review: a reviewer command or local instructions need a target with review snapshots',
      )
    snapshots ??= target.prepareReviewSnapshots(candidate, signal)
    return snapshots
  }
  const round = state.reviewRounds + 1
  const reviewOnce = async (
    lens: ReviewLens,
    signal: AbortSignal,
    attempt: StepAttemptContext,
  ): Promise<ReviewVerdict> => {
    // Each reviewer has its own profile and provider, and always starts a
    // new session: two branches never share one.
    const profile = setup.profiles[lens]
    const role = lens === 'correctness' ? 'review-a' : 'review-b'
    const invocation = reviewInvocationOf(setup, lens)
    const output = invocation?.output ?? 'verdict'
    const commandMode = usesReviewMaterials(invocation)
    const trees = commandMode ? await snapshotsFor(signal) : null
    const context = reviewPrompt(
      lens,
      trustedContext,
      target.reviewRules(lens),
      target.untrustedInputs(lens),
      changes,
      Boolean(setup.repairOf),
      {
        output,
        snapshots: trees,
        // A command-mode reviewer works in a directory of its own, so it
        // is told where the candidate is.
        worktree: commandMode ? reviewCwd : null,
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
    const input = local
      ? (command ?? LOCAL_INSTRUCTIONS_INPUT)
      : command !== null
        ? `${command}\n\n${context}`
        : context
    // A command-mode reviewer runs in a working directory the factory made
    // for this call alone: the base commit's CLAUDE.md and .claude/, and its
    // own CLAUDE.local.md. The candidate is only read, as data.
    const workdir =
      trees && target.prepareReviewWorkdir
        ? await target.prepareReviewWorkdir(
            candidate,
            lens,
            local ? localInstructions(context) : null,
          )
        : reviewCwd
    const settings: ReviewCallSettings | null = invocation
      ? {
          command: command !== null,
          context: invocation.context,
          output,
          readableDirs:
            trees && changes
              ? [
                  reviewCwd,
                  dirname(changes.diffPath),
                  trees.baseDir,
                  trees.headDir,
                ]
              : [],
        }
      : null
    const result = await runAgentCall(signal, attempt, {
      provider: services.providers[lens],
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
      session: null,
      configVersion: setup.configVersion,
    })
    // Read only after the completed checkpoint, so a reply that cannot be
    // read stops the review and is never sent again.
    if (invocation && result.permissionDenials.length > 0)
      throw new Error(
        `review-incomplete (${lens}): ${result.permissionDenials.length} tool call(s) were refused: ${result.permissionDenials.join('; ').slice(0, 500)}`,
      )
    const parsed =
      output === 'findings-json'
        ? parseFindingsOutput(result.text)
        : parseReviewOutput(result.text)
    if (!parsed.ok)
      throw new Error(`review-incomplete (${lens}): ${parsed.error}`)
    return { lens, decision: parsed.decision, notes: parsed.notes }
  }
  const correctness = `${key}:correctness`
  const edgeCases = `${key}:edge-cases`
  let results
  try {
    results = await step.all({
      [correctness]: (signal, attempt) =>
        reviewOnce('correctness', signal, attempt),
      [edgeCases]: (signal, attempt) =>
        reviewOnce('edge-cases', signal, attempt),
    })
  } finally {
    // The candidate's tree and the reviewers' directories are read only
    // during its review, and removed however the round ends, a replay that
    // only reads checkpoints included: a worker that died after both
    // reviews were recorded left them. The base tree is kept for the next
    // candidate and removed with the run.
    if (materials) await target.releaseReviewSnapshots?.({ base: false })
  }
  await target.assertIntact(candidate)
  return {
    type: 'review.completed',
    targetId: candidate.id,
    reviews: [results[correctness], results[edgeCases]],
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
  return step.run(`${key}:result`, async () => ({
    type: 'factory.finished' as const,
    outcome: outcome(
      state,
      rejected ? 'rejected' : 'approved',
      delivery,
      target.workdir,
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
