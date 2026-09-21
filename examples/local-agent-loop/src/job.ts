/** Agent loop job: implement -> test (bounded) -> parallel reviews -> human approval. */
import { cp, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineJob, type JsonValue } from '@coji/durably'
import { z } from 'zod'

import {
  abandoned,
  approvalDecided,
  implemented,
  prepared,
  reviewsCollected,
  tested,
} from './events.js'
import { estimateCostUsd } from './pricing.js'
import {
  implementPrompt,
  parseVerdict,
  reviewPromptA,
  reviewPromptB,
} from './prompts.js'
import { createProvider } from './providers/index.js'
import type { AttemptMeasurement } from './providers/types.js'
import { reduce } from './reducer.js'
import { runLocalTests } from './test-runner.js'
import { initialState } from './types.js'
import type { ReviewVerdict } from './types.js'

const inputSchema = z.object({
  provider: z.enum(['codex', 'claude', 'fake']),
  maxIterations: z.number().int().min(1).max(3).default(2),
  model: z.string().optional(),
  effort: z.string().optional(),
})

const outputSchema = z.object({
  approved: z.boolean(),
  testsPassed: z.boolean(),
  iterations: z.number(),
  reviews: z.array(
    z.object({
      reviewer: z.string(),
      decision: z.string(),
      notes: z.string(),
    }),
  ),
  workdir: z.string(),
  fake: z.boolean(),
})

function measure(
  provider: 'codex' | 'claude' | 'fake',
  fake: boolean,
  model: string | null,
  effort: string | null,
  elapsedMs: number | null,
  usage: AttemptMeasurement['usage'],
  result: string | null,
  error: string | null,
): AttemptMeasurement {
  return {
    provider,
    fake,
    model,
    effort,
    elapsedMs,
    usage,
    costUsdEstimate: estimateCostUsd(model, usage),
    costBasis: usage ? 'api-equivalent-estimate' : null,
    result,
    error,
  }
}

function measureJson(...args: Parameters<typeof measure>): JsonValue {
  return measure(...args) as unknown as JsonValue
}

function workdirFor(runId: string): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '..', 'runs', runId, 'work')
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
    let state = initialState(input.maxIterations)
    const failures: string[] = []

    await step.run(
      'prepare-workdir',
      async () => {
        await mkdir(dirname(workdir), { recursive: true })
        await cp(subjectDir(), workdir, { recursive: true })
        return { workdir }
      },
      { metadata: { provider: input.provider, stage: 'prepare' } },
    )
    state = reduce(state, prepared())

    let testsPassed = false
    let iteration = 0
    for (let i = 1; i <= input.maxIterations; i++) {
      iteration = i
      const timeoutMs = parseInt(process.env.AGENT_TIMEOUT_MS ?? '300000', 10)
      const implementSummary = await step.run(
        `implement:${i}`,
        async (_signal, attempt) => {
          const started = Date.now()
          try {
            const res = await provider.call({
              prompt: implementPrompt(i, failures),
              workdir,
              timeoutMs,
              model: input.model,
              effort: input.effort,
              role: 'implement',
            })
            await attempt.setMetadata(
              measureJson(
                input.provider,
                provider.fake,
                res.model,
                res.effort,
                res.elapsedMs ?? Date.now() - started,
                res.usage,
                'implemented',
                null,
              ),
            )
            return { text: res.text }
          } catch (err) {
            await attempt.setMetadata(
              measureJson(
                input.provider,
                provider.fake,
                input.model ?? null,
                input.effort ?? null,
                Date.now() - started,
                null,
                'fail',
                err instanceof Error ? err.message : String(err),
              ),
            )
            throw err
          }
        },
        {
          metadata: {
            provider: input.provider,
            model: input.model ?? null,
            effort: input.effort ?? null,
            stage: 'implement',
            iteration: i,
          },
        },
      )
      state = reduce(
        state,
        implemented({
          summary: implementSummary.text.slice(0, 500),
          filesChanged: [],
        }),
      )

      const testTimeout = parseInt(process.env.TEST_TIMEOUT_MS ?? '120000', 10)
      const testOutcome = await step.run(
        `test:${i}`,
        async (_signal, attempt) => {
          const started = Date.now()
          const res = await runLocalTests(workdir, testTimeout)
          await attempt.setMetadata(
            measureJson(
              input.provider,
              provider.fake,
              null,
              null,
              res.elapsedMs ?? Date.now() - started,
              null,
              res.passed ? 'pass' : 'fail',
              res.passed ? null : res.stdout.slice(-2000),
            ),
          )
          return {
            passed: res.passed,
            stdout: res.stdout.slice(-4000),
            exitCode: res.exitCode,
          }
        },
        {
          metadata: {
            provider: input.provider,
            stage: 'test',
            iteration: i,
          },
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
        break
      }
      failures.push(`iteration ${i}: ${testOutcome.stdout.slice(-500)}`)
    }

    if (!testsPassed) {
      state = reduce(state, abandoned('tests failed after max iterations'))
      return {
        approved: false,
        testsPassed: false,
        iterations: iteration,
        reviews: [],
        workdir,
        fake: provider.fake,
      }
    }

    // Parallel reviews: same provider, two separate sessions (branches).
    const reviews = await step.all({
      'review-a': async (_signal, attempt) => {
        const started = Date.now()
        const timeoutMs = parseInt(process.env.AGENT_TIMEOUT_MS ?? '300000', 10)
        try {
          const res = await provider.call({
            prompt: reviewPromptA(),
            workdir,
            timeoutMs,
            model: input.model,
            effort: input.effort,
            role: 'review-a',
          })
          const v = parseVerdict(res.text, 'review-a')
          const verdict: ReviewVerdict = {
            reviewer: 'review-a',
            decision: v.decision,
            notes: v.notes,
          }
          await attempt.setMetadata(
            measureJson(
              input.provider,
              provider.fake,
              res.model,
              res.effort,
              res.elapsedMs ?? Date.now() - started,
              res.usage,
              v.decision,
              null,
            ),
          )
          attempt.log.info(`review-a: ${v.decision}`)
          return verdict
        } catch (err) {
          await attempt.setMetadata(
            measureJson(
              input.provider,
              provider.fake,
              input.model ?? null,
              input.effort ?? null,
              Date.now() - started,
              null,
              'fail',
              err instanceof Error ? err.message : String(err),
            ),
          )
          throw err
        }
      },
      'review-b': async (_signal, attempt) => {
        const started = Date.now()
        const timeoutMs = parseInt(process.env.AGENT_TIMEOUT_MS ?? '300000', 10)
        try {
          const res = await provider.call({
            prompt: reviewPromptB(),
            workdir,
            timeoutMs,
            model: input.model,
            effort: input.effort,
            role: 'review-b',
          })
          const v = parseVerdict(res.text, 'review-b')
          const verdict: ReviewVerdict = {
            reviewer: 'review-b',
            decision: v.decision,
            notes: v.notes,
          }
          await attempt.setMetadata(
            measureJson(
              input.provider,
              provider.fake,
              res.model,
              res.effort,
              res.elapsedMs ?? Date.now() - started,
              res.usage,
              v.decision,
              null,
            ),
          )
          attempt.log.info(`review-b: ${v.decision}`)
          return verdict
        } catch (err) {
          await attempt.setMetadata(
            measureJson(
              input.provider,
              provider.fake,
              input.model ?? null,
              input.effort ?? null,
              Date.now() - started,
              null,
              'fail',
              err instanceof Error ? err.message : String(err),
            ),
          )
          throw err
        }
      },
    })
    const reviewList = [reviews['review-a'], reviews['review-b']]
    state = reduce(state, reviewsCollected(reviewList))

    const wait = await step.prepareWait('human-approval', {
      metadata: {
        testsPassed,
        iterations: iteration,
        reviews: reviewList,
        workdir,
        provider: input.provider,
        fake: provider.fake,
      } as unknown as JsonValue,
    })
    const decision = await step.waitFor(wait)
    const approved =
      decision.type === 'signal' &&
      (decision.payload as { decision?: string })?.decision === 'approved'
    state = reduce(state, approvalDecided(approved ? 'approved' : 'rejected'))

    await step.run('finalize-report', async () => ({ approved, testsPassed }), {
      metadata: { stage: 'finalize', provider: input.provider },
    })
    return {
      approved,
      testsPassed,
      iterations: iteration,
      reviews: reviewList,
      workdir,
      fake: provider.fake,
    }
  },
})
