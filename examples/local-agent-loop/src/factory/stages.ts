/**
 * Stage handlers own deterministic mechanics; the job only dispatches them.
 *
 * Nothing here knows what is being built. Where the agent edits, how work is
 * sealed, what counts as verified and what the human finally receives all come
 * from the run's `Target`, so the same stage graph drives the bundled sample
 * and a real repository.
 */
import { join } from 'node:path'

import type { JsonValue, StepAttemptContext } from '@coji/durably'

import { runAgentCall } from '../engine/runner.js'
import { runVerificationStep } from '../engine/verification.js'
import { codePrompt, parseReviewOutput, reviewPrompt } from './prompts.js'
import type { Delivery } from './target.js'
import type {
  FactoryOutcome,
  ReviewLens,
  ReviewVerdict,
  SessionRef,
  StageArgs,
  StageHandler,
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
  const profile = state.setup.profiles.code
  const target = services.target
  const continuedSession =
    state.setup.contextMode === 'reuse' ? state.implementationSession : null
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
        provider: services.providers.code,
        providerName: profile.provider,
        prompt: codePrompt({
          role,
          iteration,
          repairNotes: state.repairNotes,
          task: target.taskBrief(),
          rules: target.implementationRules(),
          untrusted: target.untrustedInputs('code'),
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
        requireSession: state.setup.contextMode === 'reuse',
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
    target.seal({ iteration, attemptId: attempt.id, signal }),
  )
  const session: SessionRef | null =
    state.setup.contextMode === 'reuse' && call.sessionId
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
  const review =
    (lens: ReviewLens) =>
    async (signal: AbortSignal, attempt: StepAttemptContext) => {
      // Each reviewer has its own profile and provider, and always starts a
      // new session: two branches run in parallel and never share one.
      const profile = state.setup.profiles[lens]
      const role = lens === 'correctness' ? 'review-a' : 'review-b'
      const result = await runAgentCall(signal, attempt, {
        provider: services.providers[lens],
        providerName: profile.provider,
        prompt: reviewPrompt(
          lens,
          trustedContext,
          target.reviewRules(lens),
          target.untrustedInputs(lens),
        ),
        workdir: reviewCwd,
        timeoutMs: state.setup.agentTimeoutMs,
        requestedModel: profile.requestedModel,
        requestedEffort: profile.requestedEffort,
        effectiveModel: profile.effectiveModel,
        effectiveEffort: profile.effectiveEffort,
        role,
        stage: `review:${lens}`,
        iteration: state.iteration,
        reviewRound: state.reviewRounds + 1,
        operationKey: `${step.runId}/${key}/${lens}`,
        checkpointsDir: state.setup.checkpointsDir,
        session: null,
        configVersion: state.setup.configVersion,
      })
      const parsed = parseReviewOutput(result.text)
      if (!parsed.ok)
        throw new Error(`review-incomplete (${lens}): ${parsed.error}`)
      const verdict: ReviewVerdict = {
        lens,
        decision: parsed.decision,
        notes: parsed.notes,
      }
      return verdict
    }
  const correctness = `${key}:correctness`
  const edgeCases = `${key}:edge-cases`
  const results = await step.all({
    [correctness]: review('correctness'),
    [edgeCases]: review('edge-cases'),
  })
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
