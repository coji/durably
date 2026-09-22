/** Local factory v2: persisted decisions dispatch executable stage handlers. */
import { cp, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineJob, type JsonValue } from '@coji/durably'
import { z } from 'zod'

import { hashDir, snapshotAcceptance } from './acceptance.js'
import { makeTreeReadOnly } from './candidate.js'
import { FactoryEventSchema } from './events.js'
import { assertAllowedDecision, availableActions, decide } from './policy.js'
import { createProvider } from './providers/index.js'
import { reduce } from './reducer.js'
import { stages } from './stages.js'
import { initialState, type FactorySetup, type StageDecision } from './types.js'

const inputSchema = z.object({
  provider: z.enum(['codex', 'claude', 'fake']),
  maxIterations: z.number().int().min(1).max(3).default(2),
  model: z.string().optional(),
  effort: z.string().optional(),
  context: z.enum(['reuse', 'fresh']).default('reuse'),
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
})

const here = dirname(fileURLToPath(import.meta.url))
const runRoot = (runId: string) => join(here, '..', 'runs', runId)
const subjectDir = () => join(here, '..', 'subject')

function positiveTimeout(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer`)
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive integer`)
  return value
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
      async () => {
        const workdir = join(root, 'work')
        const acceptanceDir = join(root, 'acceptance')
        const baselineDir = join(root, 'baseline')
        await mkdir(root, { recursive: true })
        await cp(subjectDir(), workdir, { recursive: true })
        await cp(subjectDir(), baselineDir, { recursive: true })
        await makeTreeReadOnly(baselineDir)
        const baselineHash = await hashDir(baselineDir)
        const acceptance = await snapshotAcceptance(
          join(subjectDir(), 'test'),
          acceptanceDir,
        )
        const resolved = provider.resolveExecution({
          requestedModel: input.model ?? null,
          requestedEffort: input.effort ?? null,
        })
        const profileId = [
          input.provider,
          resolved.model ?? 'provider-default',
          resolved.effort ?? 'provider-default',
        ].join(':')
        const value: FactorySetup = {
          provider: input.provider,
          fake: provider.fake,
          contextMode: input.context,
          workdir,
          acceptanceDir,
          acceptanceHash: acceptance.hash,
          baselineDir,
          baselineHash,
          checkpointsDir: join(root, 'operation-checkpoints'),
          instructionsVersion: 'local-factory.v2',
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
          testTimeoutMs: positiveTimeout('TEST_TIMEOUT_MS', 120000),
        }
        return value
      },
      {
        metadata: {
          stage: 'setup',
          provider: input.provider,
          context: input.context,
        } as unknown as JsonValue,
      },
    )

    let state = initialState(setup)
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
        services: { provider },
      })
      state = reduce(state, FactoryEventSchema.parse(rawEvent))
    }
    return state.outcome
  },
})
