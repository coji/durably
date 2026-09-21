/**
 * Agent loop job, driven as Policy -> Stage -> Event.
 *
 * - Every stage runs behind a `policy:<n>` step that persists the Policy
 *   decision; recovery replays the recorded decision instead of re-deriving.
 * - implement -> test -> parallel reviews -> aggregate; adopted review
 *   findings route back to implement with the target invalidated
 *   (prior tests/reviews cleared, notes carried forward).
 * - Reviews are strict: only an explicit well-formed `pass` counts. Garbled,
 *   missing, or contradictory verdicts are review-incomplete (execution
 *   failure), and are NEVER confused with `needsChanges` (fixable) or `pass`.
 * - Human approval binds to the reviewed target hash; a changed target after
 *   review rejects the approval instead of reusing it.
 */
import { cp, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  defineJob,
  type JsonValue,
  type StepAttemptContext,
} from '@coji/durably'
import { z } from 'zod'

import { hashDir, snapshotAcceptance } from './acceptance.js'
import {
  abandoned,
  approvalDecided,
  finalized,
  implemented,
  prepared,
  reviewsCollected,
  tested,
  fixRequested,
} from './events.js'
import { decideNext, type NextAction } from './policy.js'
import {
  implementPrompt,
  parseReviewOutput,
  reviewPromptA,
  reviewPromptB,
} from './prompts.js'
import { createProvider } from './providers/index.js'
import { reduce } from './reducer.js'
import { runAgentCall } from './runner.js'
import { runAgentTestStep } from './test-step.js'
import { initialState, type ReviewVerdict } from './types.js'

const inputSchema = z.object({
  provider: z.enum(['codex', 'claude', 'fake']),
  maxIterations: z.number().int().min(1).max(3).default(2),
  model: z.string().optional(),
  effort: z.string().optional(),
})

const outputSchema = z.object({
  approved: z.boolean(),
  conclusion: z.enum([
    'approved',
    'rejected',
    'tests-failed',
    'review-cap-reached',
    'abandoned',
  ]),
  testsPassed: z.boolean(),
  iterations: z.number(),
  reviewRounds: z.number(),
  reviews: z.array(
    z.object({
      reviewer: z.string(),
      decision: z.string(),
      notes: z.string(),
    }),
  ),
  workdir: z.string(),
  targetHash: z.string().nullable(),
  fake: z.boolean(),
})

function workdirFor(runId: string): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '..', 'runs', runId, 'work')
}

function acceptanceDirFor(runId: string): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '..', 'runs', runId, 'acceptance')
}

function snapshotDirFor(runId: string, iteration: number): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '..', 'runs', runId, `review-snapshot-${iteration}`)
}

function subjectDir(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '..', 'subject')
}

export const agentLoopJob = defineJob({
  name: 'agent-loop',
  input: inputSchema,
  output: outputSchema,
  run: async (step, input) => {
    const provider = createProvider(input.provider)
    const workdir = workdirFor(step.runId)
    const acceptanceDir = acceptanceDirFor(step.runId)
    const agentTimeoutMs = parseInt(
      process.env.AGENT_TIMEOUT_MS ?? '300000',
      10,
    )
    const testTimeoutMs = parseInt(process.env.TEST_TIMEOUT_MS ?? '120000', 10)
    let state = initialState(input.maxIterations)
    const failures: string[] = []
    let policySeq = 0

    const recordPolicy = (action: NextAction) => {
      policySeq += 1
      return step.run(`policy:${policySeq}`, async () => ({ action }), {
        metadata: { stage: 'policy', seq: policySeq } as unknown as JsonValue,
      })
    }

    // prepare: copy subject, snapshot immutable acceptance tests.
    const prep = await step.run(
      'prepare-workdir',
      async () => {
        await mkdir(dirname(workdir), { recursive: true })
        await cp(subjectDir(), workdir, { recursive: true })
        const snap = await snapshotAcceptance(
          join(subjectDir(), 'test'),
          acceptanceDir,
        )
        return {
          workdir,
          acceptanceHash: snap.hash,
          acceptanceFiles: snap.files,
        }
      },
      {
        metadata: {
          provider: input.provider,
          stage: 'prepare',
        } as unknown as JsonValue,
      },
    )
    state = reduce(state, prepared())

    let testsPassed = false
    let approvalTargetHash: string | null = null

    for (;;) {
      const action = (await recordPolicy(decideNext(state)))
        .action as NextAction

      if (action.action === 'implement') {
        const i = action.iteration
        const notes = [...state.pendingReviewNotes]
        const { text } = await step.run(
          `implement:${i}`,
          (signal, attempt) =>
            runAgentCall(signal, attempt, {
              provider,
              providerName: input.provider,
              prompt: implementPrompt(i, failures, notes),
              workdir,
              timeoutMs: agentTimeoutMs,
              requestedModel: input.model ?? null,
              requestedEffort: input.effort ?? null,
              role: 'implement',
              stage: 'implement',
              iteration: i,
            }).then((r) => ({ text: r.text })),
          {
            metadata: {
              provider: input.provider,
              stage: 'implement',
              iteration: i,
            } as unknown as JsonValue,
          },
        )
        state = reduce(
          state,
          implemented({ summary: text.slice(0, 500), filesChanged: [] }),
        )

        const testOutcome = await step.run(
          `test:${i}`,
          (signal, attempt) =>
            runAgentTestStep(
              attempt,
              {
                provider: input.provider,
                workdir,
                acceptanceHash: prep.acceptanceHash,
                timeoutMs: testTimeoutMs,
                stage: 'test',
                iteration: i,
              },
              signal,
            ),
          {
            metadata: {
              provider: input.provider,
              stage: 'test',
              iteration: i,
            } as unknown as JsonValue,
          },
        )
        state = reduce(
          state,
          tested({
            passed: testOutcome.passed,
            stdout: testOutcome.stdout.slice(-1000),
            exitCode: testOutcome.exitCode,
          }),
        )
        if (testOutcome.passed) {
          testsPassed = true
        } else {
          failures.push(`iteration ${i}: ${testOutcome.stdout.slice(-500)}`)
        }
        continue
      }

      if (action.action === 'review') {
        const i = state.iteration
        // Freeze the reviewed target: both reviewers read the same snapshot.
        await step.run(
          `review-snapshot:${i}`,
          async () => {
            await mkdir(snapshotDirFor(step.runId, i), { recursive: true })
            const dir = snapshotDirFor(step.runId, i)
            await cp(join(workdir, 'src'), join(dir, 'src'), {
              recursive: true,
            })
            await cp(join(workdir, 'test'), join(dir, 'test'), {
              recursive: true,
            })
            await cp(join(workdir, 'package.json'), join(dir, 'package.json'))
            const hash = await hashDir(dir)
            return { snapshotDir: dir, hash }
          },
          {
            metadata: {
              provider: input.provider,
              stage: 'review-snapshot',
              iteration: i,
            } as unknown as JsonValue,
          },
        )
        const snapshotDir = snapshotDirFor(step.runId, i)
        // Parallel reviews: same provider, two separate sessions (branches).
        // Both branches must report before the policy decides; a branch that
        // throws (CLI crash/timeout/cancel) fails the run — it is distinct
        // from a `needsChanges` verdict, which routes back to implement.
        const runReview =
          (reviewer: 'review-a' | 'review-b', prompt: string) =>
          async (signal: AbortSignal, attempt: StepAttemptContext) => {
            const { text } = await runAgentCall(signal, attempt, {
              provider,
              providerName: input.provider,
              prompt,
              workdir: snapshotDir,
              timeoutMs: agentTimeoutMs,
              requestedModel: input.model ?? null,
              requestedEffort: input.effort ?? null,
              role: reviewer,
              stage: reviewer,
              iteration: i,
            })
            const parsed = parseReviewOutput(text)
            if (!parsed.ok) {
              throw new Error(
                `review-incomplete (${reviewer}): ${parsed.error}`,
              )
            }
            const verdict: ReviewVerdict = {
              reviewer,
              decision: parsed.decision,
              notes: parsed.notes,
            }
            attempt.log.info(`${reviewer}: ${parsed.decision}`)
            return verdict
          }
        const reviews = await step.all({
          [`review-a:${i}`]: runReview('review-a', reviewPromptA()),
          [`review-b:${i}`]: runReview('review-b', reviewPromptB()),
        })
        const reviewList = [reviews[`review-a:${i}`], reviews[`review-b:${i}`]]
        state = reduce(state, reviewsCollected(reviewList))
        if (reviewList.some((r) => r.decision === 'needsChanges')) {
          const notes = reviewList
            .filter((r) => r.decision === 'needsChanges')
            .map((r) => `${r.reviewer}: ${r.notes}`)
          state = reduce(state, fixRequested(notes))
        }
        continue
      }

      if (action.action === 'requestApproval') {
        // Bind the approval to the exact reviewed target.
        approvalTargetHash = await hashDir(workdir)
        const wait = await step.prepareWait('human-approval', {
          metadata: {
            testsPassed,
            iterations: state.iteration,
            reviewRounds: state.reviewHistory.length,
            reviews: state.reviews,
            workdir,
            targetHash: approvalTargetHash,
            provider: input.provider,
            fake: provider.fake,
          } as unknown as JsonValue,
        })
        const outcome = await step.waitFor(wait)
        const approved =
          outcome.type === 'signal' &&
          (outcome.payload as { decision?: string })?.decision === 'approved'
        if (approved) {
          // The approval is bound to the reviewed target: re-hash and
          // refuse to reuse it for a different implementation.
          const current = await hashDir(workdir)
          if (current !== approvalTargetHash) {
            state = reduce(state, approvalDecided('rejected'))
            state = reduce(state, finalized('rejected'))
            return {
              approved: false,
              conclusion: 'rejected' as const,
              testsPassed,
              iterations: state.iteration,
              reviewRounds: state.reviewHistory.length,
              reviews: state.reviews,
              workdir,
              targetHash: current,
              fake: provider.fake,
            }
          }
        }
        state = reduce(
          state,
          approvalDecided(approved ? 'approved' : 'rejected'),
        )
        state = reduce(state, finalized(approved ? 'approved' : 'rejected'))
        await step.run(
          'finalize-report',
          async () => ({ approved, testsPassed }),
          {
            metadata: {
              stage: 'finalize',
              provider: input.provider,
            } as unknown as JsonValue,
          },
        )
        return {
          approved,
          conclusion: (approved ? 'approved' : 'rejected') as
            | 'approved'
            | 'rejected',
          testsPassed,
          iterations: state.iteration,
          reviewRounds: state.reviewHistory.length,
          reviews: state.reviews,
          workdir,
          targetHash: approvalTargetHash,
          fake: provider.fake,
        }
      }

      if (action.action === 'finalize') {
        // Reached without approval: tests exhausted or review cap hit.
        // Never presented as success and never routed to approval.
        const conclusion = action.conclusion
        state = reduce(state, finalized(conclusion))
        await step.run(
          'finalize-report',
          async () => ({ approved: false, testsPassed, conclusion }),
          {
            metadata: {
              stage: 'finalize',
              provider: input.provider,
            } as unknown as JsonValue,
          },
        )
        return {
          approved: false,
          conclusion,
          testsPassed,
          iterations: state.iteration,
          reviewRounds: state.reviewHistory.length,
          reviews: state.reviews,
          workdir,
          targetHash: approvalTargetHash,
          fake: provider.fake,
        }
      }

      // 'wait' only occurs for prepare/test/approval mid-states that the
      // loop above already handles inline; treat as terminal abandonment.
      state = reduce(
        state,
        abandoned(`unexpected policy wait at ${state.stage}`),
      )
      return {
        approved: false,
        conclusion: 'abandoned' as const,
        testsPassed,
        iterations: state.iteration,
        reviewRounds: state.reviewHistory.length,
        reviews: state.reviews,
        workdir,
        targetHash: approvalTargetHash,
        fake: provider.fake,
      }
    }
  },
})
