/** Durably job: persist a decision, dispatch its stage, reduce the event. */
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  defineJob,
  type JsonValue,
  type StepAttemptContext,
} from '@coji/durably'
import { z } from 'zod'

import {
  FAKE_REVIEW_DECISIONS,
  FAKE_TRIAGE_KINDS,
  FakeRun,
} from '../engine/providers/fake.js'
import { createProvider } from '../engine/providers/index.js'
import type { AgentProvider, ProviderName } from '../engine/providers/types.js'
import { TRIAGE_JUDGMENTS, type ReportTriage } from '../engine/report.js'
import { runAgentCall, UncertainInvocationError } from '../engine/runner.js'
import type { ResolvedProfile } from '../engine/types.js'
import { configVersionOf } from '../engine/versions.js'
import {
  createTarget,
  prepareRepoTarget,
  prepareSubjectTarget,
} from '../targets/index.js'
import {
  candidateSchema,
  deliverySchema,
  FactoryEventSchema,
} from './events.js'
import { assertAllowedDecision, availableActions, decide } from './policy.js'
import { parseTriageOutput, triagePrompt } from './prompts.js'
import { reduce } from './reducer.js'
import { stages } from './stages.js'
import type { Target, TargetConfig } from './target.js'
import {
  initialState,
  type FactorySetup,
  type ProfileRole,
  type StageDecision,
} from './types.js'

const issueSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
})

/** Where an input came from. Its hash is taken from the stored content. */
const inputFileSchema = z.object({ path: z.string().min(1) })

const targetSchema = z
  .discriminatedUnion('kind', [
    z.object({ kind: z.literal('subject') }),
    z.object({
      kind: z.literal('repo'),
      /** Any path inside the repository to work on. */
      repoPath: z.string().min(1),
      baseRef: z.string().default('HEAD'),
      task: z.string().min(1),
      /** Handed to the implementer and both reviewers. */
      spec: z.string().min(1).nullable().default(null),
      /** Handed to the reviewers only. */
      dispositions: z.string().min(1).nullable().default(null),
      /** Where each input came from, when it was read from a file. */
      inputFiles: z
        .object({
          task: inputFileSchema.nullable().default(null),
          spec: inputFileSchema.nullable().default(null),
          dispositions: inputFileSchema.nullable().default(null),
        })
        .default({ task: null, spec: null, dispositions: null }),
      issue: issueSchema.nullable().default(null),
      /** Pinned before the agent starts, so it cannot redefine grading. */
      checkCommand: z.array(z.string().min(1)).min(1),
      setupCommand: z.array(z.string().min(1)).nullable().default(null),
      /** Push the branch and open a draft pull request when approved. */
      publish: z.boolean().default(false),
    }),
  ])
  .default({ kind: 'subject' })

const providerSchema = z.enum(['codex', 'claude', 'fake'])

const fakeScenarioSchema = z
  .object({
    failIterations: z.number().int().min(0).optional(),
    reviewSequence: z.array(z.enum(FAKE_REVIEW_DECISIONS)).optional(),
    reviewNotes: z.array(z.string()).optional(),
    triage: z.array(z.enum(FAKE_TRIAGE_KINDS)).optional(),
    triageReason: z.string().min(1).max(500).optional(),
    latencyMs: z
      .object({
        min: z.number().int().min(0),
        max: z.number().int().min(0),
      })
      .refine((l) => l.max >= l.min, 'latencyMs.max must be >= min')
      .optional(),
    usage: z.enum(['none', 'realistic']).optional(),
    summary: z.string().optional(),
    changes: z.record(z.string().min(1), z.string()).optional(),
  })
  .strict()

/**
 * One role's requested settings. What is actually applied is resolved from
 * these in the setup step, never taken from the caller.
 */
const requestedProfileSchema = z.object({
  provider: providerSchema,
  requestedModel: z.string().min(1).nullable(),
  requestedEffort: z.string().min(1).nullable(),
})

const inputSchema = z
  .object({
    /** The code role's provider; also every role's when `profiles` is absent. */
    provider: providerSchema,
    maxIterations: z.number().int().min(1).max(3).default(2),
    model: z.string().optional(),
    effort: z.string().optional(),
    context: z.enum(['reuse', 'fresh']).default('reuse'),
    /**
     * Per-role requested settings. When absent, every role uses `provider`,
     * `model` and `effort`. Either way they are resolved in the setup step.
     */
    profiles: z
      .object({
        code: requestedProfileSchema,
        correctness: requestedProfileSchema,
        'edge-cases': requestedProfileSchema,
        /** Shadow triage before the code stage. Absent: no triage call. */
        triage: requestedProfileSchema.optional(),
      })
      .optional(),
    target: targetSchema,
    /** Defaults to false for the sample and true for a repository target. */
    autoApprove: z.boolean().optional(),
    /**
     * Demo and test only: per-run behavior of the fake provider, for seeding
     * runs that behave differently in one worker. Refused unless every role is
     * fake, and left out of `configVersion`.
     */
    fakeScenario: fakeScenarioSchema.optional(),
  })
  // Refused at trigger, so a real run is never stored with a demo scenario.
  .refine(
    (input) =>
      !input.fakeScenario ||
      [input.provider, ...Object.values(input.profiles ?? {})].every(
        (p) => (typeof p === 'string' ? p : p?.provider) === 'fake',
      ),
    {
      message: 'fakeScenario is only for runs where every role is fake',
      path: ['fakeScenario'],
    },
  )

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
  delivery: deliverySchema.nullable(),
  /** Null when the run had no triage profile. */
  triage: z
    .object({
      judgment: z.enum(TRIAGE_JUDGMENTS),
      reason: z.string(),
    })
    .nullable(),
})

/** Example package root (`src/factory/` -> `src/` -> package). */
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const subjectDir = () => join(packageRoot, 'subject')

/** Build one value per role. */
function byRole<T>(f: (role: ProfileRole) => T): Record<ProfileRole, T> {
  return {
    code: f('code'),
    correctness: f('correctness'),
    'edge-cases': f('edge-cases'),
  }
}

/** A role's settings before a profile id is attached. */
export type FixedProfile = Omit<ResolvedProfile, 'id'>

/**
 * Resolve one role's requested settings to what will actually be applied.
 * Throws for an unsupported effort, so a bad profile fails when the run is
 * triggered rather than part way through it.
 */
export function fixProfile(request: {
  provider: ProviderName
  model: string | null
  effort: string | null
}): FixedProfile {
  const resolved = createProvider(request.provider).resolveExecution({
    requestedModel: request.model,
    requestedEffort: request.effort,
  })
  return {
    provider: request.provider,
    requestedModel: request.model,
    requestedEffort: request.effort,
    effectiveModel: resolved.model,
    effectiveEffort: resolved.effort,
  }
}

/**
 * A run is either a fake rehearsal or a real one. Mixing the two would leave
 * `fake` meaning neither, and a report could present fake review verdicts as
 * part of a real loop.
 */
export function assertSingleMode(
  profiles: Record<string, { provider: ProviderName }>,
): void {
  const roles = Object.entries(profiles)
  const fakes = roles
    .filter(([, profile]) => profile.provider === 'fake')
    .map(([role]) => role)
  if (fakes.length > 0 && fakes.length < roles.length)
    throw new Error(
      `roles cannot mix the fake provider with a real one (fake: ${fakes.join(', ')})`,
    )
}

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

/**
 * One read-only triage call in a fresh session, through the same checkpoint
 * and measurement path as every other LLM call.
 *
 * Shadow triage must never be why a run fails. A malformed answer, a provider
 * error or a timeout is recorded as `unknown` and the run carries on; the call
 * is not resent, because this step completes with that record. Only what the
 * other calls also stop on still stops the run: a start-only checkpoint met
 * on replay, and a lost lease or cancel.
 */
async function runTriage(
  signal: AbortSignal,
  attempt: StepAttemptContext,
  args: {
    operationKey: string
    setup: FactorySetup
    profile: ResolvedProfile
    provider: AgentProvider
    target: Target
  },
): Promise<ReportTriage> {
  const { setup, profile, target } = args
  try {
    const call = await runAgentCall(signal, attempt, {
      provider: args.provider,
      providerName: profile.provider,
      // The task and spec as stored, fenced as data; dispositions are for
      // reviewers and are not sent.
      prompt: triagePrompt(target.taskBrief(), target.untrustedInputs('code')),
      workdir: target.workdir,
      // A one-line judgment; a hung call should not hold the code stage for
      // the full repository agent timeout.
      timeoutMs: Math.min(setup.agentTimeoutMs, TRIAGE_TIMEOUT_MS),
      requestedModel: profile.requestedModel,
      requestedEffort: profile.requestedEffort,
      effectiveModel: profile.effectiveModel,
      effectiveEffort: profile.effectiveEffort,
      role: 'triage',
      stage: 'triage',
      iteration: 0,
      operationKey: args.operationKey,
      checkpointsDir: setup.checkpointsDir,
      session: null,
      configVersion: setup.configVersion,
    })
    const parsed = parseTriageOutput(call.text)
    return parsed.ok
      ? { judgment: parsed.judgment, reason: parsed.reason }
      : { judgment: 'unknown', reason: `malformed triage: ${parsed.error}` }
  } catch (error) {
    if (error instanceof UncertainInvocationError || signal.aborted) throw error
    const message = error instanceof Error ? error.message : String(error)
    return {
      judgment: 'unknown',
      reason: `triage call failed: ${message.slice(0, 500)}`,
    }
  }
}

const TRIAGE_TIMEOUT_MS = 300_000

export interface AgentLoopJobOptions {
  /** Directory every run's worktree, checkpoints and delivery live under. */
  stateRoot: string
}

export function createAgentLoopJob(options: AgentLoopJobOptions) {
  const runRoot = (runId: string) => join(options.stateRoot, 'runs', runId)
  return defineJob({
    name: 'local-factory.v2',
    input: inputSchema,
    output: outputSchema,
    run: async (step, input) => {
      const root = runRoot(step.runId)
      const setup = await step.run(
        'setup',
        async (signal) => {
          // Profiles first: a bad profile fails before any worktree or branch
          // exists in the target repository.
          const fixed = byRole((role) => {
            const requested = input.profiles?.[role]
            return fixProfile(
              requested
                ? {
                    provider: requested.provider,
                    model: requested.requestedModel,
                    effort: requested.requestedEffort,
                  }
                : {
                    provider: input.provider,
                    model: input.model ?? null,
                    effort: input.effort ?? null,
                  },
            )
          })
          const requestedTriage = input.profiles?.triage
          const fixedTriage = requestedTriage
            ? fixProfile({
                provider: requestedTriage.provider,
                model: requestedTriage.requestedModel,
                effort: requestedTriage.requestedEffort,
              })
            : null
          assertSingleMode({
            ...fixed,
            ...(fixedTriage ? { triage: fixedTriage } : {}),
          })
          const resolve = (
            role: string,
            profile: FixedProfile,
          ): ResolvedProfile => ({
            id: [
              profile.provider,
              profile.effectiveModel ?? 'provider-default',
              profile.effectiveEffort ?? 'provider-default',
              role,
            ].join(':'),
            ...profile,
          })
          const profiles = byRole((role) => resolve(role, fixed[role]))
          const triage = fixedTriage ? resolve('triage', fixedTriage) : null
          // A real repository needs far more room than the bundled sample. The
          // sample is a one-line fix graded by a two-file suite; a repository
          // task means reading the code base and running its whole check, and
          // the first real run of this factory died on a five minute agent
          // timeout before it had finished reading.
          const isRepo = input.target.kind === 'repo'
          const testTimeoutMs = positiveTimeout(
            'TEST_TIMEOUT_MS',
            isRepo ? 900000 : 120000,
          )
          // Both timeouts are read before anything is created, so a bad value
          // leaves no run directory, worktree or branch behind.
          const agentTimeoutMs = positiveTimeout(
            'AGENT_TIMEOUT_MS',
            isRepo ? 1800000 : 300000,
          )
          await mkdir(root, { recursive: true })
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
                  spec: input.target.spec,
                  dispositions: input.target.dispositions,
                  issue: input.target.issue,
                  checkCommand: input.target.checkCommand,
                  setupCommand: input.target.setupCommand,
                  checkTimeoutMs: testTimeoutMs,
                  publish: input.target.publish,
                  signal,
                })
          const instructionsVersion = 'local-factory.v3'
          const value: FactorySetup = {
            fake: fixed.code.provider === 'fake',
            contextMode: input.context,
            target,
            checkpointsDir: join(root, 'operation-checkpoints'),
            instructionsVersion,
            configVersion: configVersionOf({
              contextMode: input.context,
              instructionsVersion,
              maxIterations: input.maxIterations,
              target:
                target.kind === 'subject'
                  ? 'subject'
                  : `repo:${target.checkCommand.join(' ')}`,
              agentTimeoutMs,
              checkTimeoutMs: testTimeoutMs,
              code: profiles.code,
              correctness: profiles.correctness,
              edgeCases: profiles['edge-cases'],
              triage,
            }),
            profiles,
            triage,
            maxIterations: input.maxIterations,
            agentTimeoutMs,
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
      // One per run, shared by every role. Review verdicts are read by round
      // and lens, so replaying completed rounds shifts nothing.
      const fakeRun = input.fakeScenario
        ? new FakeRun(input.fakeScenario)
        : null
      const providers = byRole((role) =>
        createProvider(setup.profiles[role].provider, {
          run: fakeRun,
          requestedModel: setup.profiles[role].requestedModel,
        }),
      )
      // Shadow mode: the judgment is recorded and nothing below reads it.
      const triageProfile = setup.triage
      const triageKey = `${step.runId}/triage/agent`
      const triage = triageProfile
        ? await step.run(
            'triage',
            (signal, attempt) =>
              runTriage(signal, attempt, {
                operationKey: triageKey,
                setup,
                profile: triageProfile,
                provider: createProvider(triageProfile.provider, {
                  run: fakeRun,
                  requestedModel: triageProfile.requestedModel,
                }),
                target,
              }),
            {
              metadata: {
                stage: 'triage',
                operationKey: triageKey,
              } as unknown as JsonValue,
            },
          )
        : null
      let state = initialState(setup)
      // Deliberately not a `finally`: `step.waitFor` suspends by throwing, so a
      // finally block would run cleanup every time the run parks on the human
      // approval wait, and a target that really removes its worktree would
      // destroy the work mid-approval.
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
          services: { providers, target },
        })
        state = reduce(state, FactoryEventSchema.parse(rawEvent))
      }
      await target.cleanup()
      return { ...state.outcome, triage }
    },
  })
}
