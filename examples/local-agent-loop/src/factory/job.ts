/** Durably job: persist a decision, dispatch its stage, reduce the event. */
import { mkdir, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  defineJob,
  type JsonValue,
  type StepAttemptContext,
  type StepContext,
} from '@coji/durably'
import { z } from 'zod'

import { MAX_TIMEOUT_MS } from '../engine/child.js'
import {
  BASELINE_FAILED_MESSAGE,
  CANDIDATE_MOVED_MESSAGE,
  PREFLIGHT_FAILED_MESSAGE,
} from '../engine/failure-reasons.js'
import {
  FAKE_REVIEW_DECISIONS,
  FAKE_TRIAGE_KINDS,
  FakeRun,
} from '../engine/providers/fake.js'
import { createProvider } from '../engine/providers/index.js'
import type {
  AgentProvider,
  AvailabilityCheck,
  ProviderName,
} from '../engine/providers/types.js'
import {
  TRIAGE_JUDGMENTS,
  triageCalibration,
  type ReportTriage,
} from '../engine/report.js'
import {
  RejectedInvocationError,
  runAgentCall,
  UncertainInvocationError,
} from '../engine/runner.js'
import type { ResolvedProfile } from '../engine/types.js'
import { runVerificationStep } from '../engine/verification.js'
import {
  cliIdentityOf,
  configVersionOf,
  resolveVersions,
} from '../engine/versions.js'
import {
  createTarget,
  prepareRepoTarget,
  prepareSubjectTarget,
} from '../targets/index.js'
import {
  assertCandidateUnmoved,
  assertSetupLeftNoUntracked,
  checkFingerprint,
  RepoTarget,
} from '../targets/repo.js'
import {
  candidateSchema,
  deliverySchema,
  FactoryEventSchema,
} from './events.js'
import { assertAllowedDecision, availableActions, decide } from './policy.js'
import { parseTriageOutput, triagePrompt } from './prompts.js'
import { reduce } from './reducer.js'
import { triageThatRuns } from './repair.js'
import { stages } from './stages.js'
import {
  DEFAULT_COMMIT_SETTINGS,
  type Target,
  type TargetConfig,
} from './target.js'
import {
  executionKey,
  initialState,
  separateRepairProfile,
  type FactorySetup,
  type ProfileRole,
  type StageDecision,
} from './types.js'

const issueSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
})

/** Non-empty text, whitespace alone included in what is refused. */
export const nonBlank = z
  .string()
  .refine((value) => value.trim().length > 0, 'must not be empty')

/** How the run's commits are made, as `factory.json`'s `commit` resolved at trigger. */
const commitSettingsSchema = z
  .object({
    authorName: nonBlank.nullable().default(null),
    authorEmail: nonBlank.nullable().default(null),
    messageTemplate: nonBlank.nullable().default(null),
    publishSquashed: z.boolean().default(false),
  })
  .strict()

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
      /**
       * Commit author, message template and which branch to publish. Absent
       * on a run stored before it existed: the defaults apply.
       */
      commit: commitSettingsSchema.optional(),
      /** Run the pinned check on the base commit before any agent call. */
      baselineCheck: z.boolean().optional(),
    }),
  ])
  .default({ kind: 'subject' })

/** Milliseconds, positive and exact: what a timeout may be. */
export const timeoutMsSchema = z.number().int().positive().max(MAX_TIMEOUT_MS)

/**
 * Each target's timeouts when neither `factory.json` nor the trigger's
 * environment names one. A real repository needs far more room than the
 * bundled sample. The sample is a one-line fix graded by a two-file suite; a
 * repository task means reading the code base and running its whole check,
 * and the first real run of this factory died on a five minute agent timeout
 * before it had finished reading.
 */
const DEFAULT_TIMEOUTS = {
  subject: { checkTimeoutMs: 120000, agentTimeoutMs: 300000 },
  repo: { checkTimeoutMs: 900000, agentTimeoutMs: 1800000 },
} as const

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
type RequestedProfile = z.infer<typeof requestedProfileSchema>

/** A role's settings as resolved at setup, id included. */
const resolvedProfileSchema = z
  .object({
    id: z.string().min(1),
    provider: providerSchema,
    requestedModel: z.string().min(1).nullable(),
    requestedEffort: z.string().min(1).nullable(),
    effectiveModel: z.string().min(1).nullable(),
    effectiveEffort: z.string().min(1).nullable(),
  })
  .strict()

/**
 * A run that repairs another run's approved candidate from outside findings.
 * Built by `demo repair` from the parent's stored input and setup; the
 * worker never resolves these profiles again.
 */
const repairOfSchema = z
  .object({
    runId: z.string().min(1),
    /** The parent's last candidate commit, which is also its delivery. */
    candidateCommit: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
    candidateBranch: z.string().min(1),
    /** Stored once at trigger; its SHA-256 is taken from this content. */
    findings: nonBlank,
    findingsFile: inputFileSchema,
    /** The effective profiles the parent recorded at setup. */
    profiles: z
      .object({
        code: resolvedProfileSchema,
        correctness: resolvedProfileSchema,
        'edge-cases': resolvedProfileSchema,
        repair: resolvedProfileSchema.nullable(),
        /**
         * Kept so the child records the parent's settings and config
         * version; a repair run never calls it.
         */
        triage: resolvedProfileSchema.nullable(),
      })
      .strict(),
  })
  .strict()

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
        /** Repair's own settings. Absent: repair runs on `code`. */
        repair: requestedProfileSchema.optional(),
      })
      .optional(),
    target: targetSchema,
    /** Defaults to false for the sample and true for a repository target. */
    autoApprove: z.boolean().optional(),
    /**
     * Fixed at trigger. Absent only on a run stored before they were, which
     * still reads `TEST_TIMEOUT_MS` / `AGENT_TIMEOUT_MS` in the worker.
     */
    checkTimeoutMs: timeoutMsSchema.optional(),
    agentTimeoutMs: timeoutMsSchema.optional(),
    /**
     * The Codex CLI file to launch, resolved and checked at trigger. Null or
     * absent: the bundled CLI first, then `codex` on PATH.
     */
    codexPath: z.string().min(1).nullable().optional(),
    /**
     * Repository runs: the config file the settings came from (null: none)
     * and the flags that won over it, for `retrigger --reload-config`. The
     * worker never reads it.
     */
    configSource: z
      .object({
        path: z.string().min(1).nullable(),
        explicit: z.boolean().optional(),
        flags: z
          .object({
            provider: z.string().optional(),
            check: z.string().optional(),
            setup: z.string().optional(),
            base: z.string().optional(),
          })
          .strict(),
      })
      .optional(),
    /**
     * Demo and test only: per-run behavior of the fake provider, for seeding
     * runs that behave differently in one worker. Refused unless every role is
     * fake, and left out of `configVersion`.
     */
    fakeScenario: fakeScenarioSchema.optional(),
    /** Set only on a repair run; see `repairOfSchema`. */
    repairOf: repairOfSchema.optional(),
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
  // A repair run starts from the parent's candidate, with the settings the
  // parent resolved; nothing about it is left for the worker to decide.
  .refine(
    (input) =>
      !input.repairOf ||
      (input.target.kind === 'repo' &&
        input.target.baseRef === input.repairOf.candidateCommit &&
        input.checkTimeoutMs !== undefined &&
        input.agentTimeoutMs !== undefined),
    {
      message:
        'a repair run needs a repository target based on the parent candidate commit, and fixed timeouts',
      path: ['repairOf'],
    },
  )

/** A run input as a caller passes it, before defaults are applied. */
export type AgentLoopInput = z.input<typeof inputSchema>

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
      /** Measured from the stored task and spec; null where unknown. */
      calibration: z
        .object({
          taskChars: z.number().int().nullable(),
          specChars: z.number().int().nullable(),
          acceptanceCriteria: z.number().int().nullable(),
          plannedFiles: z.number().int().nullable(),
        })
        .optional(),
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

/**
 * A timeout environment variable as milliseconds, or `fallback` when it is
 * unset. Held to `timeoutMsSchema`, as a config value is: `0`, a sign, a
 * fraction, `NaN`, `Infinity` and values past `MAX_TIMEOUT_MS` are refused.
 */
function positiveTimeout(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN
  if (!timeoutMsSchema.safeParse(value).success)
    throw new Error(
      `${name} must be a positive integer of at most ${MAX_TIMEOUT_MS} ms`,
    )
  return value
}

/**
 * A run's two timeouts: each fixed value first, then `TEST_TIMEOUT_MS` /
 * `AGENT_TIMEOUT_MS` in this process's environment, then the target default.
 */
export function resolveTimeouts(
  kind: keyof typeof DEFAULT_TIMEOUTS,
  fixed: { checkTimeoutMs?: number; agentTimeoutMs?: number } | null,
): { checkTimeoutMs: number; agentTimeoutMs: number } {
  const defaults = DEFAULT_TIMEOUTS[kind]
  return {
    checkTimeoutMs:
      fixed?.checkTimeoutMs ??
      positiveTimeout('TEST_TIMEOUT_MS', defaults.checkTimeoutMs),
    agentTimeoutMs:
      fixed?.agentTimeoutMs ??
      positiveTimeout('AGENT_TIMEOUT_MS', defaults.agentTimeoutMs),
  }
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
 * on replay, an explicit refusal by the provider, and a lost lease or cancel.
 *
 * The record carries the calibration measured from the stored task and spec,
 * whatever the judgment, so a later comparison can set the two side by side.
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
  const stored = setup.target.kind === 'repo' ? setup.target : null
  const calibration = triageCalibration(
    stored ? stored.task : target.taskBrief(),
    stored ? stored.spec : null,
  )
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
      ? { judgment: parsed.judgment, reason: parsed.reason, calibration }
      : {
          judgment: 'unknown',
          reason: `malformed triage: ${parsed.error}`,
          calibration,
        }
  } catch (error) {
    if (
      error instanceof UncertainInvocationError ||
      error instanceof RejectedInvocationError ||
      signal.aborted
    )
      throw error
    const message = error instanceof Error ? error.message : String(error)
    return {
      judgment: 'unknown',
      reason: `triage call failed: ${message.slice(0, 500)}`,
      calibration,
    }
  }
}

const TRIAGE_TIMEOUT_MS = 300_000

type ProviderFor = (
  profile: Pick<ResolvedProfile, 'provider' | 'requestedModel'>,
) => AgentProvider

/** A reply of one word: the call proves the settings work, and no more. */
const PREFLIGHT_PROMPT =
  'This is a connectivity check. Reply with the single word OK. Do not read files or run tools.'
const PREFLIGHT_TIMEOUT_MS = 120_000

/** One distinct provider, model and effort, and every role that uses it. */
export interface PreflightCheck {
  roles: string[]
  provider: ProviderName
  requestedModel: string | null
  model: string | null
  effort: string | null
  /** The CLI file this check and the role's calls launch; null for fake. */
  cliPath: string | null
  cliVersion: string | null
  /** The free check's answer; `unknown` leads to a minimal call. */
  free: AvailabilityCheck
}

/** What a minimal call proved about one `PreflightCheck`. */
export interface PreflightCallResult {
  verdict: 'available' | 'unavailable'
  detail: string
}

function describeCheck(check: PreflightCheck): string {
  return `${check.roles.join(', ')} (${check.provider} ${check.model ?? 'provider-default'}, effort ${check.effort ?? 'provider-default'})`
}

/**
 * Prove every role's provider, model and effort usable before the first
 * agent call. Each distinct setting is checked once, for all its roles. The
 * free checks run in one step; a setting they cannot decide gets one minimal
 * call, in its own step through the common checkpoint and measurement path,
 * so a replay reads the answer back and an unanswered call stops the run as
 * uncertain. The first unusable setting stops the run before anything else
 * is sent.
 */
async function runPreflight(
  step: StepContext,
  setup: FactorySetup,
  target: Target,
  providerFor: ProviderFor,
): Promise<void> {
  const triage = triageThatRuns(setup, setup.triage)
  const roles: [string, ResolvedProfile][] = [
    ...Object.entries(byRole((role) => setup.profiles[role])),
    ...(setup.repair
      ? [['repair', setup.repair] as [string, ResolvedProfile]]
      : []),
    ...(triage ? [['triage', triage] as [string, ResolvedProfile]] : []),
  ]
  const plan = await step.run(
    'preflight',
    async () => {
      const distinct = new Map<string, [string[], ResolvedProfile]>()
      for (const [role, profile] of roles) {
        const key = executionKey(profile)
        const entry = distinct.get(key)
        if (entry) entry[0].push(role)
        else distinct.set(key, [[role], profile])
      }
      // Free checks send nothing, so they run side by side.
      const checks = await Promise.all(
        [...distinct.values()].map(
          async ([names, profile]): Promise<PreflightCheck> => {
            const provider = providerFor(profile)
            const [versions, free] = await Promise.all([
              resolveVersions(profile.provider, provider.cliPath),
              provider.checkAvailability({
                requestedModel: profile.requestedModel,
                model: profile.effectiveModel,
                effort: profile.effectiveEffort,
              }),
            ])
            const cli = cliIdentityOf(profile.provider, versions)
            return {
              roles: names,
              provider: profile.provider,
              requestedModel: profile.requestedModel,
              model: profile.effectiveModel,
              effort: profile.effectiveEffort,
              cliPath: cli?.path ?? null,
              cliVersion: cli?.version ?? null,
              free,
            }
          },
        ),
      )
      return { checks }
    },
    { metadata: { stage: 'preflight' } as unknown as JsonValue },
  )
  const refused = plan.checks.find((c) => c.free.verdict === 'unavailable')
  if (refused)
    throw new Error(
      `${PREFLIGHT_FAILED_MESSAGE}: ${describeCheck(refused)} is not usable; ${refused.free.method}: ${refused.free.detail}`,
    )
  for (const [index, check] of plan.checks.entries()) {
    if (check.free.verdict !== 'unknown') continue
    const operationKey = `${step.runId}/preflight/call:${index}`
    const answer: PreflightCallResult = await step.run(
      `preflight:call:${index}`,
      async (signal, attempt) => {
        const call = await runAgentCall(signal, attempt, {
          provider: providerFor(check),
          providerName: check.provider,
          prompt: PREFLIGHT_PROMPT,
          workdir: target.workdir,
          timeoutMs: Math.min(setup.agentTimeoutMs, PREFLIGHT_TIMEOUT_MS),
          requestedModel: check.requestedModel,
          requestedEffort: check.effort,
          effectiveModel: check.model,
          effectiveEffort: check.effort,
          role: 'preflight',
          stage: 'preflight',
          iteration: 0,
          operationKey,
          checkpointsDir: setup.checkpointsDir,
          session: null,
          configVersion: setup.configVersion,
          acceptRejection: true,
        })
        return call.rejection === null
          ? { verdict: 'available', detail: 'the minimal call was answered' }
          : { verdict: 'unavailable', detail: call.rejection }
      },
      {
        metadata: { stage: 'preflight', operationKey } as unknown as JsonValue,
      },
    )
    if (answer.verdict === 'unavailable')
      throw new Error(
        `${PREFLIGHT_FAILED_MESSAGE}: ${describeCheck(check)} is not usable; minimal call refused: ${answer.detail}`,
      )
  }
}

/**
 * Resolve each role's requested settings from a run input to what will
 * actually be applied, with the profile ids the run records.
 */
function resolveInputProfiles(input: {
  provider: ProviderName
  model?: string | undefined
  effort?: string | undefined
  profiles?:
    | (Record<ProfileRole, RequestedProfile> & {
        triage?: RequestedProfile | undefined
        repair?: RequestedProfile | undefined
      })
    | undefined
}): {
  profiles: Record<ProfileRole, ResolvedProfile>
  triage: ResolvedProfile | null
  repair: ResolvedProfile | null
} {
  const fixRequested = (requested: RequestedProfile) =>
    fixProfile({
      provider: requested.provider,
      model: requested.requestedModel,
      effort: requested.requestedEffort,
    })
  const fixed = byRole((role) => {
    const requested = input.profiles?.[role]
    return requested
      ? fixRequested(requested)
      : fixProfile({
          provider: input.provider,
          model: input.model ?? null,
          effort: input.effort ?? null,
        })
  })
  const requestedTriage = input.profiles?.triage
  const requestedRepair = input.profiles?.repair
  const resolve = (role: string, profile: FixedProfile): ResolvedProfile => ({
    id: [
      profile.provider,
      profile.effectiveModel ?? 'provider-default',
      profile.effectiveEffort ?? 'provider-default',
      role,
    ].join(':'),
    ...profile,
  })
  return {
    profiles: byRole((role) => resolve(role, fixed[role])),
    triage: requestedTriage
      ? resolve('triage', fixRequested(requestedTriage))
      : null,
    repair: requestedRepair
      ? resolve('repair', fixRequested(requestedRepair))
      : null,
  }
}

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
          const repairOf = input.repairOf ?? null
          const { profiles, triage, repair } = repairOf
            ? // A repair run takes the profiles its parent resolved, as they
              // were. It records the parent's triage profile but never runs
              // triage.
              {
                profiles: byRole((role) => repairOf.profiles[role]),
                triage: repairOf.profiles.triage,
                repair: repairOf.profiles.repair,
              }
            : resolveInputProfiles(input)
          assertSingleMode({
            ...profiles,
            ...(triage ? { triage } : {}),
            ...(repair ? { repair } : {}),
          })
          // A repair profile that makes the same call as code is code: the
          // run keeps its session and its config version.
          const ownRepair = separateRepairProfile({ repair, profiles })
          // A run triggered from the CLI carries both timeouts. Only a run
          // stored before they were fixed reads the worker's environment.
          // Both are read before anything is created, so a bad value leaves
          // no run directory, worktree or branch behind.
          const { checkTimeoutMs: testTimeoutMs, agentTimeoutMs } =
            resolveTimeouts(input.target.kind, input)
          const codexPath = input.codexPath ?? null
          // The path and version of every real CLI the roles launch, so runs
          // on different builds never share a config version. A repair run
          // never launches the triage CLI, so it is not probed.
          const cli: Record<string, string | null> = {}
          const triageRuns = triageThatRuns(input, triage)
          const used = new Set(
            [
              ...Object.values(profiles),
              ...(triageRuns ? [triageRuns] : []),
              ...(ownRepair ? [ownRepair] : []),
            ].map((p) => p.provider),
          )
          await Promise.all(
            [...used].map(async (provider) => {
              // Only the Codex version reads the pinned path.
              const versions = await resolveVersions(provider, codexPath)
              const identity = cliIdentityOf(provider, versions)
              if (!identity) return
              cli[`${provider}CliPath`] = identity.path
              cli[`${provider}Cli`] = identity.version
            }),
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
                  // A repair run's branch never carries the issue number,
                  // so it cannot be taken for the parent's.
                  branch: repairOf
                    ? `factory/${step.runId}`
                    : branchFor(step.runId, input.target.issue),
                  root,
                  task: input.target.task,
                  spec: input.target.spec,
                  dispositions: input.target.dispositions,
                  issue: input.target.issue,
                  checkCommand: input.target.checkCommand,
                  setupCommand: input.target.setupCommand,
                  checkTimeoutMs: testTimeoutMs,
                  publish: input.target.publish,
                  commit: input.target.commit ?? DEFAULT_COMMIT_SETTINGS,
                  repairOf: repairOf
                    ? { runId: repairOf.runId, findings: repairOf.findings }
                    : null,
                  // The parent's candidate is checked again here, not only
                  // by `demo repair`: its branch can move after that check,
                  // and a retrigger never makes it. The check runs after a
                  // replayed setup has discarded its earlier worktree and
                  // branch and right before the new ones are cut, so a
                  // refused repair leaves neither, nor a run directory.
                  ...(repairOf
                    ? {
                        beforeCreate: (repo: string) =>
                          assertCandidateUnmoved(
                            repo,
                            repairOf.candidateCommit,
                            repairOf.candidateBranch,
                          ).catch(async (error: unknown) => {
                            await rm(root, { recursive: true, force: true })
                            throw new Error(
                              `${CANDIDATE_MOVED_MESSAGE}: ${error instanceof Error ? error.message : String(error)}; the repair of ${repairOf.runId} stopped without a worktree, branch or run directory and before any agent call`,
                            )
                          }),
                      }
                    : {}),
                  signal,
                })
          const baselineCheck =
            input.target.kind === 'repo' && input.target.baselineCheck === true
          // A passing baseline removes every untracked file .gitignore does
          // not cover, so setup must not leave any. Checked here, in the
          // step that ran setup, so a resumed baseline never mistakes the
          // check's own output for setup's.
          if (baselineCheck && target.kind === 'repo')
            await assertSetupLeftNoUntracked(target.workdir, signal)
          const instructionsVersion = 'local-factory.v3'
          const value: FactorySetup = {
            fake: profiles.code.provider === 'fake',
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
              repair: ownRepair,
              correctness: profiles.correctness,
              edgeCases: profiles['edge-cases'],
              triage,
              cli,
              commit: target.kind === 'repo' ? (target.commit ?? null) : null,
            }),
            profiles,
            repair,
            triage,
            maxIterations: input.maxIterations,
            agentTimeoutMs,
            baselineCheck,
            codexPath,
            ...(repairOf
              ? {
                  repairOf: {
                    runId: repairOf.runId,
                    candidateCommit: repairOf.candidateCommit,
                  },
                }
              : {}),
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
      // The pinned check must pass on the base commit, or no candidate could
      // be graded: stop before paying for any agent call. The same checkpoint
      // pair as verification, so a completed result is read back on resume
      // and an interrupted check is graded again.
      if (setup.baselineCheck && target instanceof RepoTarget) {
        const baseline = await step.run('baseline', (signal, attempt) =>
          runVerificationStep(
            attempt,
            {
              provider: setup.profiles.code.provider,
              operationKey: `${step.runId}/baseline`,
              checkpointsDir: setup.checkpointsDir,
              stage: 'baseline',
              iteration: 0,
              grade: (graderSignal) =>
                target.gradeBase({
                  // Keyed by the step attempt, as a verification log is.
                  logDir: join(
                    setup.checkpointsDir,
                    '..',
                    'baseline-logs',
                    attempt.id,
                  ),
                  signal: graderSignal,
                }),
            },
            signal,
          ),
        )
        if (!baseline.passed && setup.target.kind === 'repo')
          throw new Error(
            `${BASELINE_FAILED_MESSAGE}: \`${checkFingerprint(setup.target.checkCommand)}\` failed on the base commit ${setup.target.baseCommit.slice(0, 12)} (exit code ${baseline.exitCode ?? 'unknown'}) before any agent call`,
          )
      }
      // One per run, shared by every role. Review verdicts are read by round
      // and lens, so replaying completed rounds shifts nothing.
      const fakeRun = input.fakeScenario
        ? new FakeRun(input.fakeScenario)
        : null
      // Every provider launches the run's pinned Codex CLI, if it has one.
      const providerFor: ProviderFor = (profile) =>
        createProvider(profile.provider, {
          run: fakeRun,
          requestedModel: profile.requestedModel,
          codexPath: setup.codexPath ?? null,
        })
      await runPreflight(step, setup, target, providerFor)
      const roleProviders = byRole((role) => providerFor(setup.profiles[role]))
      const ownRepair = separateRepairProfile(setup)
      const providers = {
        ...roleProviders,
        repair: ownRepair ? providerFor(ownRepair) : roleProviders.code,
      }
      // Shadow mode: the judgment is recorded and nothing below reads it.
      const triageProfile = triageThatRuns(setup, setup.triage)
      const triageKey = `${step.runId}/triage/agent`
      const triage = triageProfile
        ? await step.run(
            'triage',
            (signal, attempt) =>
              runTriage(signal, attempt, {
                operationKey: triageKey,
                setup,
                profile: triageProfile,
                provider: providerFor(triageProfile),
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
