/** Durably job: persist a decision, dispatch its stage, reduce the event. */
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineJob, type JsonValue } from '@coji/durably'
import { z } from 'zod'

import { createProvider } from '../engine/providers/index.js'
import { configVersionOf } from '../engine/versions.js'
import {
  createTarget,
  prepareRepoTarget,
  prepareSubjectTarget,
} from '../targets/index.js'
import { FactoryEventSchema } from './events.js'
import { assertAllowedDecision, availableActions, decide } from './policy.js'
import { reduce } from './reducer.js'
import { stages } from './stages.js'
import type { TargetConfig } from './target.js'
import { initialState, type FactorySetup, type StageDecision } from './types.js'

const issueSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
})

const targetSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('subject') }),
    z.object({
      kind: z.literal('repo'),
      /** Any path inside the repository to work on. */
      repoPath: z.string().min(1),
      baseRef: z.string().default('HEAD'),
      task: z.string().min(1),
      issue: issueSchema.nullable().default(null),
      /** Pinned before the agent starts, so it cannot redefine grading. */
      checkCommand: z.array(z.string().min(1)).min(1),
      setupCommand: z.array(z.string().min(1)).nullable().default(null),
      /** Push the branch and open a draft pull request when approved. */
      publish: z.boolean().default(false),
    }),
  ])
  .default({ kind: 'subject' })

const inputSchema = z.object({
  provider: z.enum(['codex', 'claude', 'fake']),
  maxIterations: z.number().int().min(1).max(3).default(2),
  model: z.string().optional(),
  effort: z.string().optional(),
  context: z.enum(['reuse', 'fresh']).default('reuse'),
  target: targetSchema,
  /** Defaults to false for the sample and true for a repository target. */
  autoApprove: z.boolean().optional(),
})

const candidateSchema = z.object({
  id: z.string(),
  snapshotDir: z.string(),
  sourceHash: z.string(),
  acceptanceHash: z.string(),
})

const outputSchema = z.object({
  approved: z.boolean(),
  conclusion: z.enum([
    'approved',
    'rejected',
    'verification-failed',
    'review-cap-reached',
  ]),
  candidate: candidateSchema.nullable(),
  iterations: z.number(),
  reviewRounds: z.number(),
  reviews: z.array(
    z.object({
      lens: z.enum(['correctness', 'edge-cases']),
      decision: z.enum(['pass', 'needsChanges']),
      notes: z.string(),
    }),
  ),
  workdir: z.string(),
  fake: z.boolean(),
  delivery: z
    .object({
      kind: z.enum(['snapshot', 'patch', 'pull-request']),
      location: z.string(),
      summary: z.string(),
    })
    .nullable(),
})

/** Example package root (`src/factory/` -> `src/` -> package). */
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const runRoot = (runId: string) => join(packageRoot, 'runs', runId)
const subjectDir = () => join(packageRoot, 'subject')

function positiveTimeout(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer`)
  return value
}

function branchFor(
  runId: string,
  issue: { number: number } | null | undefined,
): string {
  return issue ? `factory/issue-${issue.number}-${runId}` : `factory/${runId}`
}

export const agentLoopJob = defineJob({
  name: 'local-factory.v2',
  input: inputSchema,
  output: outputSchema,
  run: async (step, input) => {
    const provider = createProvider(input.provider)
    const root = runRoot(step.runId)
    const setup = await step.run(
      'setup',
      async (signal) => {
        await mkdir(root, { recursive: true })
        const testTimeoutMs = positiveTimeout('TEST_TIMEOUT_MS', 120000)
        const target: TargetConfig =
          input.target.kind === 'subject'
            ? await prepareSubjectTarget({
                subjectDir: subjectDir(),
                root,
                testTimeoutMs,
              })
            : await prepareRepoTarget({
                repoPath: input.target.repoPath,
                baseRef: input.target.baseRef,
                branch: branchFor(step.runId, input.target.issue),
                root,
                task: input.target.task,
                issue: input.target.issue,
                checkCommand: input.target.checkCommand,
                setupCommand: input.target.setupCommand,
                checkTimeoutMs: testTimeoutMs,
                publish: input.target.publish,
                signal,
              })
        const resolved = provider.resolveExecution({
          requestedModel: input.model ?? null,
          requestedEffort: input.effort ?? null,
        })
        const profileId = [
          input.provider,
          resolved.model ?? 'provider-default',
          resolved.effort ?? 'provider-default',
        ].join(':')
        const instructionsVersion = 'local-factory.v2'
        const value: FactorySetup = {
          provider: input.provider,
          fake: provider.fake,
          contextMode: input.context,
          target,
          checkpointsDir: join(root, 'operation-checkpoints'),
          instructionsVersion,
          configVersion: configVersionOf({
            provider: input.provider,
            contextMode: input.context,
            instructionsVersion,
            maxIterations: input.maxIterations,
            target:
              target.kind === 'subject'
                ? 'subject'
                : `repo:${target.checkCommand.join(' ')}`,
            code: { model: resolved.model, effort: resolved.effort },
            review: { model: resolved.model, effort: resolved.effort },
          }),
          profiles: {
            code: {
              id: `${profileId}:code`,
              provider: input.provider,
              requestedModel: input.model ?? null,
              requestedEffort: input.effort ?? null,
              effectiveModel: resolved.model,
              effectiveEffort: resolved.effort,
            },
            review: {
              id: `${profileId}:review`,
              provider: input.provider,
              requestedModel: input.model ?? null,
              requestedEffort: input.effort ?? null,
              effectiveModel: resolved.model,
              effectiveEffort: resolved.effort,
            },
          },
          maxIterations: input.maxIterations,
          agentTimeoutMs: positiveTimeout('AGENT_TIMEOUT_MS', 300000),
          // A draft pull request is itself what the human reviews, so waiting
          // for a separate approval signal first would hold a worker for
          // nothing. The bundled sample keeps the wait: its human-wait timing
          // is part of what the example measures.
          autoApprove: input.autoApprove ?? target.kind === 'repo',
        }
        return value
      },
      {
        metadata: {
          stage: 'setup',
          provider: input.provider,
          context: input.context,
          target: input.target.kind,
        } as unknown as JsonValue,
      },
    )

    const target = createTarget(setup.target)
    let state = initialState(setup)
    try {
      for (let sequence = 0; state.outcome === null; sequence++) {
        const decision = await step.run(
          `decision:${sequence}`,
          async () => decide(state),
          {
            metadata: {
              stage: 'decision',
              sequence,
              candidates: availableActions(state),
            } as unknown as JsonValue,
          },
        )
        assertAllowedDecision(state, decision as StageDecision)
        const selected = decision as StageDecision
        const rawEvent = await stages[selected.stage]({
          step,
          state,
          decision: selected,
          key: `stage:${sequence}:${selected.stage}`,
          services: { provider, target },
        })
        state = reduce(state, FactoryEventSchema.parse(rawEvent))
      }
      return state.outcome
    } finally {
      await target.cleanup()
    }
  },
})
