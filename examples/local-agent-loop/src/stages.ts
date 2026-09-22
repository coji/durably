/** Stage handlers own deterministic mechanics; the job only dispatches them. */
import { join } from 'node:path'

import type { JsonValue, StepAttemptContext } from '@coji/durably'

import {
  assertCandidateIntact,
  candidatesDirFor,
  createCandidate,
} from './candidate.js'
import { codePrompt, parseReviewOutput, reviewPrompt } from './prompts.js'
import { runAgentCall } from './runner.js'
import { runAgentTestStep } from './test-step.js'
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
): FactoryOutcome {
  return {
    approved: conclusion === 'approved',
    conclusion,
    candidate: state.candidate,
    iterations: state.iteration,
    reviewRounds: state.reviewRounds,
    reviews: state.reviews,
    workdir: state.setup.workdir,
    fake: state.setup.fake,
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
  const continuedSession =
    state.setup.contextMode === 'reuse' ? state.implementationSession : null
  const call = await step.run(
    `${key}:agent`,
    (signal, attempt) =>
      runAgentCall(signal, attempt, {
        provider: services.provider,
        providerName: state.setup.provider,
        prompt: codePrompt(role, iteration, state.repairNotes),
        workdir: state.setup.workdir,
        timeoutMs: state.setup.agentTimeoutMs,
        requestedModel: profile.model,
        requestedEffort: profile.effort,
        role,
        stage: role,
        iteration,
        operationKey: `${step.runId}/${key}/agent`,
        checkpointsDir: state.setup.checkpointsDir,
        session: continuedSession,
      }),
    {
      metadata: {
        stage: role,
        operationKey: `${step.runId}/${key}/agent`,
      } as unknown as JsonValue,
    },
  )
  const candidate = await step.run(`${key}:candidate`, (_signal, attempt) =>
    createCandidate({
      workdir: state.setup.workdir,
      candidatesDir: candidatesDirFor(state.setup.workdir),
      iteration,
      acceptanceHash: state.setup.acceptanceHash,
      attemptId: attempt.id,
    }),
  )
  const session: SessionRef | null =
    state.setup.contextMode === 'reuse' && call.sessionId
      ? {
          provider: state.setup.provider,
          nativeId: call.sessionId,
          profileId: profile.id,
          cwd: state.setup.workdir,
          instructionsVersion: state.setup.instructionsVersion,
        }
      : null
  if (state.setup.contextMode === 'reuse' && !session) {
    throw new Error(
      `${state.setup.provider} did not report a native session id; refusing to label this run as context reuse`,
    )
  }
  return { type: 'code.completed', role, candidate, session }
}

export const verifyStage: StageHandler = async ({ step, state, key }) => {
  const target = requireCandidate(state)
  await assertCandidateIntact(target)
  const result = await step.run(`${key}:acceptance`, (signal, attempt) =>
    runAgentTestStep(
      attempt,
      {
        provider: state.setup.provider,
        workdir: target.snapshotDir,
        acceptanceHash: target.acceptanceHash,
        acceptanceDir: state.setup.acceptanceDir,
        scratchDir: join(
          state.setup.workdir,
          '..',
          'verification-scratch',
          target.id,
        ),
        pidFile: join(
          state.setup.workdir,
          '..',
          `verification-${target.id}.pid`,
        ),
        timeoutMs: state.setup.testTimeoutMs,
        stage: 'verify',
        iteration: state.iteration,
      },
      signal,
    ),
  )
  return {
    type: 'verify.completed',
    targetId: target.id,
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
  const target = requireCandidate(state)
  if (!state.verification?.passed || state.verification.targetId !== target.id)
    throw new Error('review requires the same verified candidate')
  await assertCandidateIntact(target)
  const review =
    (lens: ReviewLens) =>
    async (_signal: AbortSignal, attempt: StepAttemptContext) => {
      const signal = _signal
      const profile = state.setup.profiles.review
      const role = lens === 'correctness' ? 'review-a' : 'review-b'
      const result = await runAgentCall(signal, attempt, {
        provider: services.provider,
        providerName: state.setup.provider,
        prompt: reviewPrompt(lens),
        workdir: target.snapshotDir,
        timeoutMs: state.setup.agentTimeoutMs,
        requestedModel: profile.model,
        requestedEffort: profile.effort,
        role,
        stage: `review:${lens}`,
        iteration: state.iteration,
        operationKey: `${step.runId}/${key}/${lens}`,
        checkpointsDir: state.setup.checkpointsDir,
        session: null,
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
  return {
    type: 'review.completed',
    targetId: target.id,
    reviews: [results[correctness], results[edgeCases]],
  }
}

export const approvalStage: StageHandler = async ({ step, state, key }) => {
  const target = requireCandidate(state)
  await assertCandidateIntact(target)
  const wait = await step.prepareWait(`${key}:${target.id}`, {
    metadata: {
      candidateId: target.id,
      snapshotDir: target.snapshotDir,
      sourceHash: target.sourceHash,
      reviews: state.reviews,
    } as unknown as JsonValue,
  })
  const result = await step.waitFor(wait)
  await assertCandidateIntact(target)
  const payload =
    result.type === 'signal' &&
    result.payload &&
    typeof result.payload === 'object'
      ? (result.payload as { candidateId?: string; decision?: string })
      : null
  if (payload?.candidateId !== target.id)
    throw new Error(`approval candidate mismatch: expected ${target.id}`)
  if (payload.decision !== 'approved' && payload.decision !== 'rejected')
    throw new Error(`invalid approval decision for ${target.id}`)
  return {
    type: 'approval.completed',
    targetId: target.id,
    decision: payload.decision,
  }
}

export const finishStage: StageHandler = async ({ step, state, key }) => {
  const target = requireCandidate(state)
  await assertCandidateIntact(target)
  return step.run(`${key}:result`, async () => ({
    type: 'factory.finished' as const,
    outcome: outcome(
      state,
      state.approval === 'approved' ? 'approved' : 'rejected',
    ),
  }))
}

export const stopStage: StageHandler = async ({ step, state, key }) =>
  step.run(`${key}:result`, async () => ({
    type: 'factory.finished' as const,
    outcome: outcome(
      state,
      state.verification?.passed ? 'review-cap-reached' : 'verification-failed',
    ),
  }))

export const stages = {
  code: codeStage,
  verify: verifyStage,
  review: reviewStage,
  approve: approvalStage,
  finish: finishStage,
  stop: stopStage,
} satisfies Record<StageArgs['decision']['stage'], StageHandler>
