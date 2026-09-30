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
  FAKE_SPEC_REVIEWS,
  FAKE_TRIAGE_KINDS,
  FakeRun,
} from '../engine/providers/fake.js'
import {
  createProvider,
  type ProviderOptions,
} from '../engine/providers/index.js'
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
import { runTimedVerificationStep } from '../engine/verification.js'
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
  BASELINE_INDEX_PRUNE_AGE_MS,
  baselineIdentityOf,
  recordBaselineInIndex,
  reusedBaseline,
  type BaselineStore,
} from './baseline-reuse.js'
import {
  candidateSchema,
  deliverySchema,
  FactoryEventSchema,
} from './events.js'
import {
  agentLogsDirBeside,
  runRootOf,
  reviewSnapshotsDirOf,
  specFileOf,
} from './layout.js'
import {
  assertAllowedDecision,
  availableActions,
  decide,
  reviewCanFollow,
} from './policy.js'
import {
  parseTriageOutput,
  reviewCommandPlaceholders,
  triagePrompt,
} from './prompts.js'
import { reduce } from './reducer.js'
import { triageThatRuns } from './repair.js'
import {
  runCheckFromSpec,
  runSpecStages,
  specAdviceText,
  stages,
} from './stages.js'
import {
  DEFAULT_COMMIT_SETTINGS,
  type Target,
  type TargetConfig,
} from './target.js'
import {
  BASELINE_STEP,
  EFFORT_RESUME_POLICY,
  executionKey,
  initialState,
  REVIEW_CONTEXTS,
  REVIEW_LENSES,
  REVIEW_OUTPUTS,
  confirmRepairSession,
  REPAIR_SESSION_STEP,
  repairSessionDecision,
  separateRepairProfile,
  usesReviewMaterials,
  type BaselineRecord,
  type FactorySetup,
  type RepairSessionRecord,
  type ProfileRole,
  type SpecSetup,
  type ReviewContext,
  type ReviewInvocation,
  type ReviewLens,
  type ReviewOutput,
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

/**
 * How old a reused baseline result may be: a positive integer of
 * milliseconds, at most `BASELINE_INDEX_PRUNE_AGE_MS` (7 days) — the
 * horizon beyond which index entries are pruned, so a longer setting could
 * never actually hold.
 */
export const baselineMaxAgeMsSchema = z
  .number()
  .int()
  .positive()
  .max(BASELINE_INDEX_PRUNE_AGE_MS, 'the maximum is 7 days')

/** `baselineReuse` in a target and in factory.json. */
export const baselineReuseSchema = z
  .object({ maxAgeMs: baselineMaxAgeMsSchema })
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
      /**
       * Pinned before the agent starts, so it cannot redefine grading. Null
       * only with `checkFromSpec`, whose script names the check.
       */
      checkCommand: z.array(z.string().min(1)).min(1).nullable(),
      /**
       * Run once on the run's fixed spec before the baseline; the check it
       * prints replaces `checkCommand`. Needs a spec: `spec`, or spec stages.
       */
      checkFromSpec: z.array(z.string().min(1)).min(1).nullable().optional(),
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
      /**
       * Use another run's passing baseline result of at most this age
       * instead of running the check. Read only with `baselineCheck`.
       */
      baselineReuse: baselineReuseSchema.nullable().optional(),
      /**
       * Verify and review each candidate side by side (ADR-0029). Absent:
       * off, as on a run stored before it existed. Not part of the config
       * version: it changes when the reviews run, not what they are.
       */
      parallelReview: z.boolean().optional(),
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
    reviewOutputs: z.array(z.string()).optional(),
    reviewDenials: z.array(z.string()).optional(),
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
    claudeEffortResume: z.boolean().optional(),
    specText: z.string().min(1).optional(),
    specStray: z
      .array(
        z
          .string()
          .regex(/^[^/\\]+$/)
          .refine((n) => n !== 'spec.md'),
      )
      .optional(),
    specFails: z.boolean().optional(),
    specSymlink: z.boolean().optional(),
    specReviews: z
      .record(z.string().min(1), z.array(z.enum(FAKE_SPEC_REVIEWS)))
      .optional(),
    output: z
      .object({
        chunks: z.array(z.string()),
        intervalMs: z.number().int().min(0),
      })
      .strict()
      .optional(),
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

/** One reviewer's invocation, every field fixed at trigger. */
const reviewInvocationSchema = z
  .object({
    command: nonBlank.nullable(),
    context: z.enum(REVIEW_CONTEXTS),
    output: z.enum(REVIEW_OUTPUTS),
  })
  .strict()

/** The reviewers that were given one; a lens left out uses the defaults. */
const reviewInvocationsSchema = z
  .object({
    correctness: reviewInvocationSchema.optional(),
    'edge-cases': reviewInvocationSchema.optional(),
  })
  .strict()

/** A reviewer's invocation as `factory.json` names it: every field optional. */
export interface RequestedReviewInvocation {
  command?: string | null | undefined
  context?: ReviewContext | undefined
  output?: ReviewOutput | undefined
}

/**
 * Why a reviewer on `provider` cannot run this invocation, or null when it
 * can: a Codex reviewer runs neither a command nor local instructions. The
 * CLI, the job's input schema and setup all refuse through this one check.
 */
export function unsupportedReviewSettings(
  invocation: RequestedReviewInvocation,
  provider: ProviderName,
): string | null {
  if (provider !== 'codex') return null
  const unsupported = [
    ...((invocation.command ?? null) !== null ? ['command'] : []),
    ...(invocation.context === 'local-instructions'
      ? ['context: local-instructions']
      : []),
  ]
  return unsupported.length > 0
    ? `a codex reviewer does not support ${unsupported.join(' or ')}; use a claude reviewer, or leave ${unsupported.length > 1 ? 'them' : 'it'} out`
    : null
}

/**
 * The provider a role runs on, as a run input names it: the parent's for a
 * repair run, otherwise the role's own profile or the run's provider. Setup
 * resolves each role's profile from the same place.
 */
function inputProviderOf(
  input: {
    provider: ProviderName
    profiles?:
      | Partial<Record<ProfileRole, { provider: ProviderName } | undefined>>
      | undefined
    repairOf?:
      | { profiles: Record<ProfileRole, { provider: ProviderName }> }
      | undefined
  },
  role: ProfileRole,
): ProviderName {
  return input.repairOf
    ? input.repairOf.profiles[role].provider
    : (input.profiles?.[role]?.provider ?? input.provider)
}

/**
 * Fix each reviewer's invocation, and refuse what cannot run before any LLM
 * call: a blank command, a placeholder other than `{effort}`, `{base}` and
 * `{head}` or a brace outside one, `{effort}` on a role that resolves no
 * effort, and a command or local instructions on a Codex reviewer. A lens
 * that names none of the three fields is left out and keeps the prompt and
 * the verdict; one that names any gets all three, defaults filled in.
 */
export function fixReviewInvocations(
  requested:
    | Partial<Record<ReviewLens, RequestedReviewInvocation | undefined>>
    | null
    | undefined,
  profiles: Record<
    ReviewLens,
    { provider: ProviderName; effectiveEffort: string | null }
  >,
  where = 'profiles.review',
): Partial<Record<ReviewLens, ReviewInvocation>> {
  const fixed: Partial<Record<ReviewLens, ReviewInvocation>> = {}
  for (const lens of REVIEW_LENSES) {
    const invocation = fixReviewInvocation(
      requested?.[lens],
      profiles[lens],
      `${where}.${lens}`,
    )
    if (invocation) fixed[lens] = invocation
  }
  return fixed
}

/**
 * One reviewer's invocation, checked as `fixReviewInvocations` checks a
 * lens's; null when it names none of the three fields. A spec reviewer
 * passes `spec`: no candidate exists yet, so `{head}` is refused too.
 */
export function fixReviewInvocation(
  r: RequestedReviewInvocation | null | undefined,
  profile: { provider: ProviderName; effectiveEffort: string | null },
  where: string,
  options: { spec?: boolean } = {},
): ReviewInvocation | null {
  if (
    !r ||
    ((r.command ?? null) === null &&
      r.context === undefined &&
      r.output === undefined)
  )
    return null
  const invocation: ReviewInvocation = {
    command: r.command ?? null,
    context: r.context ?? 'prompt',
    output: r.output ?? 'verdict',
  }
  const refuse = (why: string) => new Error(`${where}: ${why}`)
  if (invocation.command !== null && invocation.command.trim() === '')
    throw refuse('command must not be empty')
  const unsupported = unsupportedReviewSettings(invocation, profile.provider)
  if (unsupported) throw refuse(unsupported)
  if (invocation.command !== null) {
    const used = reviewCommandPlaceholders(invocation.command)
    if (!used.ok) throw refuse(`command: ${used.error}`)
    if (options.spec && used.names.has('head'))
      throw refuse(
        'command: {head} names a candidate commit, and a spec review runs before any exists (allowed: {effort}, {base})',
      )
    if (used.names.has('effort') && profile.effectiveEffort === null)
      throw refuse(
        'command uses {effort}, but the role resolves no effort; set "effort" for it',
      )
  }
  return invocation
}

/**
 * A run that repairs another run's last candidate from outside findings: an
 * approved, delivered one, or one that stopped failing the check (ADR-0030).
 * Built by `demo repair` from the parent's stored input and setup; the
 * worker never resolves these profiles again.
 */
const repairOfSchema = z
  .object({
    runId: z.string().min(1),
    /**
     * The parent's last candidate commit; for an approved parent, also its
     * delivery.
     */
    candidateCommit: z.string().regex(/^[0-9a-f]{40}([0-9a-f]{24})?$/),
    candidateBranch: z.string().min(1),
    /** Absent on a run stored before it was kept: an approved parent. */
    parentConclusion: z.enum(['approved', 'verification-failed']).optional(),
    /** Stored once at trigger; its SHA-256 is taken from this content. */
    findings: nonBlank,
    /**
     * The findings file, or the parent run when the findings were built
     * from its stored check failure.
     */
    findingsFile: z.union([
      inputFileSchema,
      z.object({ parentRun: z.string().min(1) }),
    ]),
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

/**
 * How many spec review rounds run before a person decides: a positive safe
 * integer. `0`, a sign, a fraction, `NaN`, `Infinity` and values past
 * `Number.MAX_SAFE_INTEGER` are refused.
 */
export const specMaxRoundsSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER)

/** The rounds a run allows when `factory.json` names none. */
export const DEFAULT_SPEC_MAX_ROUNDS = 3

/** A spec reviewer's name: it names a step, a directory and a report row. */
export const specReviewerNameSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9-]{0,39}$/,
    'a spec reviewer name is 1-40 lowercase letters, digits or hyphens, starting with a letter or digit',
  )

/**
 * The spec stages of a run, fixed at trigger with the templates' contents.
 * Only on a repository run given no spec.
 */
const specStagesSchema = z
  .object({
    author: requestedProfileSchema,
    /** Null: the fix runs on the author's profile. */
    fix: requestedProfileSchema.nullable(),
    reviewers: z
      .array(
        z
          .object({
            name: specReviewerNameSchema,
            profile: requestedProfileSchema,
            invocation: reviewInvocationSchema.nullable(),
          })
          .strict(),
      )
      .min(1),
    maxRounds: specMaxRoundsSchema.default(DEFAULT_SPEC_MAX_ROUNDS),
    template: z.string().min(1).nullable(),
    reviewTemplate: z.string().min(1).nullable(),
    /** Where each template came from; the worker never reads them. */
    templateFiles: z
      .object({
        template: inputFileSchema.nullable(),
        reviewTemplate: inputFileSchema.nullable(),
      })
      .strict()
      .default({ template: null, reviewTemplate: null }),
  })
  .strict()
  .refine(
    (spec) =>
      new Set(spec.reviewers.map((r) => r.name)).size === spec.reviewers.length,
    { message: 'spec reviewers need distinct names', path: ['reviewers'] },
  )

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
     * absent: `codex` on PATH first, then the bundled CLI.
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
    /**
     * Reviewers with their own command, context or output, fixed at
     * trigger. Absent, or a lens left out: the prompt and the verdict.
     */
    review: reviewInvocationsSchema.optional(),
    /**
     * The spec stages, fixed at trigger. Absent: the run starts from the
     * spec it was given, if any, as before.
     */
    spec: specStagesSchema.optional(),
  })
  // Refused at trigger, so a real run is never stored with a demo scenario.
  .refine(
    (input) =>
      !input.fakeScenario ||
      [
        input.provider,
        ...Object.values(input.profiles ?? {}),
        ...(input.spec
          ? [
              input.spec.author,
              input.spec.fix,
              ...input.spec.reviewers.map((r) => r.profile),
            ]
          : []),
      ].every(
        (p) =>
          p === null || (typeof p === 'string' ? p : p?.provider) === 'fake',
      ),
    {
      message: 'fakeScenario is only for runs where every role is fake',
      path: ['fakeScenario'],
    },
  )
  // Refused at trigger, like `demo run` refuses it from `factory.json`, so
  // a direct trigger is never stored with a reviewer that cannot run it.
  .superRefine((input, ctx) => {
    for (const lens of REVIEW_LENSES) {
      const r = input.review?.[lens]
      const unsupported = r
        ? unsupportedReviewSettings(r, inputProviderOf(input, lens))
        : null
      if (unsupported)
        ctx.addIssue({
          code: 'custom',
          message: `review.${lens}: ${unsupported}`,
          path: ['review', lens],
        })
    }
  })
  // The spec stages write the spec, so a run given one has none; and a
  // check chosen from the spec needs a spec to read.
  .superRefine((input, ctx) => {
    const target = input.target
    if (input.spec && (target.kind !== 'repo' || target.spec !== null))
      ctx.addIssue({
        code: 'custom',
        message:
          'spec stages need a repository target without a spec (--spec-file)',
        path: ['spec'],
      })
    for (const [index, r] of (input.spec?.reviewers ?? []).entries()) {
      const unsupported = r.invocation
        ? unsupportedReviewSettings(r.invocation, r.profile.provider)
        : null
      if (unsupported)
        ctx.addIssue({
          code: 'custom',
          message: `spec.review.${r.name}: ${unsupported}`,
          path: ['spec', 'reviewers', index],
        })
    }
    if (target.kind !== 'repo') return
    if (target.checkFromSpec && !input.spec && target.spec === null)
      ctx.addIssue({
        code: 'custom',
        message:
          'checkFromSpec needs a spec: pass --spec-file, or configure the spec stages',
        path: ['target', 'checkFromSpec'],
      })
    if (!target.checkCommand && !target.checkFromSpec)
      ctx.addIssue({
        code: 'custom',
        message: 'a repository target needs checkCommand or checkFromSpec',
        path: ['target', 'checkCommand'],
      })
  })
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
  // Findings built from the parent's check failure name that parent, and
  // only a parent that stopped on the check has one.
  .refine(
    (input) =>
      !input.repairOf ||
      !('parentRun' in input.repairOf.findingsFile) ||
      (input.repairOf.findingsFile.parentRun === input.repairOf.runId &&
        input.repairOf.parentConclusion === 'verification-failed'),
    {
      message:
        "findings built from a run's check failure must name the parent run, which stopped verification-failed",
      path: ['repairOf', 'findingsFile'],
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
  /**
   * Why the worktree could not be removed after the approved delivery was
   * recorded; null when it was removed, absent when there was none to
   * remove. The run is approved and delivered either way.
   */
  worktreeCleanupWarning: z.string().nullable().optional(),
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
export function fixProfile(
  request: {
    provider: ProviderName
    model: string | null
    effort: string | null
  },
  options?: ProviderOptions,
): FixedProfile {
  const resolved = createProvider(request.provider, options).resolveExecution({
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
      agentLogsDir: agentLogsDirBeside(setup.checkpointsDir),
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
  /**
   * The concrete model the call reported running, as Claude Code resolves an
   * alias such as `opus`; null when it reported none. Absent on a call
   * recorded before it existed.
   */
  model?: string | null
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
 * is sent. Returns the concrete model each minimal call reported, by
 * `executionKey`; a setting the free check decided has none.
 */
async function runPreflight(
  step: StepContext,
  setup: FactorySetup,
  target: Target,
  providerFor: ProviderFor,
): Promise<Map<string, string | null>> {
  const triage = triageThatRuns(setup, setup.triage)
  const roles: [string, ResolvedProfile][] = [
    ...Object.entries(byRole((role) => setup.profiles[role])),
    ...(setup.repair
      ? [['repair', setup.repair] as [string, ResolvedProfile]]
      : []),
    ...(triage ? [['triage', triage] as [string, ResolvedProfile]] : []),
    // The spec roles, so none is found unusable after the spec work began.
    ...(setup.spec ? specRoleEntries(setup.spec) : []),
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
  const observed = new Map<string, string | null>()
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
          agentLogsDir: agentLogsDirBeside(setup.checkpointsDir),
          session: null,
          configVersion: setup.configVersion,
          acceptRejection: true,
        })
        return call.rejection === null
          ? {
              verdict: 'available',
              detail: 'the minimal call was answered',
              model: call.observedModel,
            }
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
    observed.set(
      executionKey({
        provider: check.provider,
        requestedModel: check.requestedModel,
        effectiveModel: check.model,
        effectiveEffort: check.effort,
      }),
      answer.model ?? null,
    )
  }
  return observed
}

/**
 * Resolve each role's requested settings from a run input to what will
 * actually be applied, with the profile ids the run records.
 */
function resolveInputProfiles(input: {
  provider: ProviderName
  model?: string | undefined
  effort?: string | undefined
  fakeScenario?: z.infer<typeof fakeScenarioSchema> | undefined
  profiles?:
    | (Record<ProfileRole, RequestedProfile> & {
        triage?: RequestedProfile | undefined
        repair?: RequestedProfile | undefined
      })
    | undefined
  spec?: z.infer<typeof specStagesSchema> | undefined
}): {
  profiles: Record<ProfileRole, ResolvedProfile>
  triage: ResolvedProfile | null
  repair: ResolvedProfile | null
  spec: ReturnType<typeof resolveSpecProfiles>
} {
  // A scenario can make the fake provider honour the requested effort.
  const fake = input.fakeScenario
    ? { run: new FakeRun(input.fakeScenario) }
    : undefined
  const fixRequested = (requested: RequestedProfile) =>
    fixProfile(
      {
        provider: requested.provider,
        model: requested.requestedModel,
        effort: requested.requestedEffort,
      },
      fake,
    )
  const fixed = byRole((role) =>
    fixRequested(
      input.profiles?.[role] ?? {
        provider: input.provider,
        requestedModel: input.model ?? null,
        requestedEffort: input.effort ?? null,
      },
    ),
  )
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
    spec: resolveSpecProfiles(input.spec, (role, requested) =>
      resolve(role, fixRequested(requested)),
    ),
  }
}

/**
 * The spec stages with their roles' profiles resolved: the author's, the
 * fix's (the author's when the run names none) and each reviewer's, with the
 * profile ids the run records. Reviewer invocations are fixed by setup.
 */
function resolveSpecProfiles(
  spec: z.infer<typeof specStagesSchema> | undefined,
  resolve: (role: string, requested: RequestedProfile) => ResolvedProfile,
) {
  if (!spec) return null
  const author = resolve('spec-author', spec.author)
  return {
    author,
    fix: spec.fix ? resolve('spec-fix', spec.fix) : author,
    reviewers: spec.reviewers.map((r) => ({
      name: r.name,
      profile: resolve(`spec-review:${r.name}`, r.profile),
      invocation: r.invocation,
    })),
    maxRounds: spec.maxRounds,
    template: spec.template,
    reviewTemplate: spec.reviewTemplate,
  }
}

/**
 * Each spec role with its profile, named as the run records it. The fix is
 * left out when it runs on the author's profile.
 */
function specRoleEntries(
  spec: Pick<SpecSetup, 'author' | 'fix'> & {
    reviewers: { name: string; profile: ResolvedProfile }[]
  },
): [string, ResolvedProfile][] {
  return [
    ['spec-author', spec.author],
    ...(spec.fix === spec.author
      ? []
      : [['spec-fix', spec.fix] as [string, ResolvedProfile]]),
    ...spec.reviewers.map((r): [string, ResolvedProfile] => [
      `spec-review:${r.name}`,
      r.profile,
    ]),
  ]
}

/** The job's name, as its runs are stored. */
export const AGENT_LOOP_JOB_NAME = 'local-factory.v2'

export interface AgentLoopJobOptions {
  /** Directory every run's worktree, checkpoints and delivery live under. */
  stateRoot: string
  /**
   * Reads of the state database a baseline reuse decision makes, about the
   * one run the reuse index names. Absent: every baseline check runs,
   * whatever `baselineReuse` says.
   */
  baselineStore?: BaselineStore
}

export function createAgentLoopJob(options: AgentLoopJobOptions) {
  const runRoot = (runId: string) => runRootOf(options.stateRoot, runId)
  return defineJob({
    name: AGENT_LOOP_JOB_NAME,
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
          const {
            profiles,
            triage,
            repair,
            spec: specProfiles,
          } = repairOf
            ? // A repair run takes the profiles its parent resolved, as they
              // were. It records the parent's triage profile but never runs
              // triage.
              {
                profiles: byRole((role) => repairOf.profiles[role]),
                triage: repairOf.profiles.triage,
                repair: repairOf.profiles.repair,
                spec: null,
              }
            : resolveInputProfiles(input)
          assertSingleMode({
            ...profiles,
            ...(triage ? { triage } : {}),
            ...(repair ? { repair } : {}),
            ...(specProfiles
              ? Object.fromEntries(specRoleEntries(specProfiles))
              : {}),
          })
          // Checked again here, as at trigger, before anything exists.
          const review = fixReviewInvocations(input.review, profiles, 'review')
          if (Object.keys(review).length > 0 && input.target.kind !== 'repo')
            throw new Error(
              'review: a reviewer command, context or output needs a repository target',
            )
          const specReviewers = (specProfiles?.reviewers ?? []).map((r) => ({
            ...r,
            invocation: fixReviewInvocation(
              r.invocation,
              r.profile,
              `spec.review.${r.name}`,
              { spec: true },
            ),
          }))
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
              ...(specProfiles
                ? specRoleEntries(specProfiles).map(([, p]) => p)
                : []),
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
          const prepared: TargetConfig =
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
                  // With `checkFromSpec`, the script names the check later.
                  checkCommand: input.target.checkFromSpec
                    ? []
                    : (input.target.checkCommand ?? []),
                  checkFromSpec: input.target.checkFromSpec ?? null,
                  setupCommand: input.target.setupCommand,
                  checkTimeoutMs: testTimeoutMs,
                  publish: input.target.publish,
                  commit: input.target.commit ?? DEFAULT_COMMIT_SETTINGS,
                  repairOf: repairOf
                    ? {
                        runId: repairOf.runId,
                        findings: repairOf.findings,
                        parentConclusion: repairOf.parentConclusion,
                      }
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
          // Only a reviewer with its own command or local instructions reads
          // the base and head trees, or every reviewer when reviews run
          // beside the check, so only then are they extracted. Trees an
          // earlier attempt of this setup left are discarded with its
          // worktree.
          const parallelReview =
            input.target.kind === 'repo' && input.target.parallelReview === true
          const snapshotsDir = reviewSnapshotsDirOf(root)
          await rm(snapshotsDir, { recursive: true, force: true })
          const target: TargetConfig =
            prepared.kind === 'repo' &&
            (parallelReview ||
              [
                ...Object.values(review),
                ...specReviewers.map((r) => r.invocation),
              ].some((r) => usesReviewMaterials(r ?? null)))
              ? { ...prepared, reviewSnapshotsDir: snapshotsDir }
              : prepared
          const baselineCheck =
            input.target.kind === 'repo' && input.target.baselineCheck === true
          // A passing baseline removes every untracked file .gitignore does
          // not cover, so setup must not leave any. Checked here, in the
          // step that ran setup, so a resumed baseline never mistakes the
          // check's own output for setup's.
          // A repair of a verification-failed parent keeps the setting for
          // its own children but never runs the baseline (ADR-0030).
          const runsBaseline =
            baselineCheck &&
            input.repairOf?.parentConclusion !== 'verification-failed'
          if (runsBaseline && target.kind === 'repo')
            await assertSetupLeftNoUntracked(target.workdir, signal)
          // Resolved here, in the worktree setup prepared, and never again:
          // a replay compares the values this run was set up with. A check
          // chosen from the spec is resolved in its own step instead.
          const baselineIdentity =
            runsBaseline && target.kind === 'repo' && !target.checkFromSpec
              ? await baselineIdentityOf(target)
              : null
          const spec: SpecSetup | null = specProfiles
            ? {
                ...specProfiles,
                reviewers: specReviewers,
                specPath: specFileOf(root),
              }
            : null
          const instructionsVersion = 'local-factory.v3'
          // Fixed here with the CLI version just recorded, so a restarted
          // worker with another environment never changes how this run's
          // repairs treat the implementation session.
          const repairSession = ownRepair
            ? repairSessionDecision({
                contextMode: input.context,
                code: profiles.code,
                repair: ownRepair,
                claudeCliVersion: cli['claudeCli'] ?? null,
                env: process.env,
                fakeEffortResume:
                  input.fakeScenario?.claudeEffortResume === true,
              })
            : null
          // The version the run takes only once preflight confirms the
          // continuation; every other run keeps `configVersion`.
          const versionWith = (policy: string | null) =>
            configVersionOf({
              contextMode: input.context,
              instructionsVersion,
              maxIterations: input.maxIterations,
              target:
                target.kind === 'subject'
                  ? 'subject'
                  : target.checkFromSpec
                    ? `repo:from-spec:${target.checkFromSpec.join(' ')}`
                    : `repo:${target.checkCommand.join(' ')}`,
              agentTimeoutMs,
              checkTimeoutMs: testTimeoutMs,
              code: profiles.code,
              repair: ownRepair,
              repairSession: policy,
              correctness: profiles.correctness,
              edgeCases: profiles['edge-cases'],
              triage,
              cli,
              commit: target.kind === 'repo' ? (target.commit ?? null) : null,
              review,
              spec,
            })
          const value: FactorySetup = {
            fake: profiles.code.provider === 'fake',
            contextMode: input.context,
            target,
            checkpointsDir: join(root, 'operation-checkpoints'),
            instructionsVersion,
            configVersion: versionWith(null),
            profiles,
            repair,
            ...(repairSession
              ? {
                  repairSession: repairSession.eligible
                    ? {
                        ...repairSession,
                        confirmedConfigVersion:
                          versionWith(EFFORT_RESUME_POLICY),
                      }
                    : repairSession,
                }
              : {}),
            triage,
            maxIterations: input.maxIterations,
            agentTimeoutMs,
            baselineCheck,
            // Null, not absent, without the check, so a repair run does not
            // take the value from this run's input instead.
            baselineReuse:
              baselineCheck && input.target.kind === 'repo'
                ? (input.target.baselineReuse ?? null)
                : null,
            ...(baselineCheck ? { baselineIdentity } : {}),
            codexPath,
            ...(Object.keys(review).length > 0 ? { review } : {}),
            ...(spec ? { spec } : {}),
            // Only when on, so a run without it keeps the setup it had.
            ...(parallelReview ? { parallelReview } : {}),
            ...(repairOf
              ? {
                  repairOf: {
                    runId: repairOf.runId,
                    candidateCommit: repairOf.candidateCommit,
                    parentConclusion: repairOf.parentConclusion,
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

      let target = createTarget(setup.target)
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
      const specStages = setup.spec ?? null
      const ownRepair = separateRepairProfile(setup)
      // Every role's settings are proven usable before its first call, and
      // the repair session decision the stages read is confirmed with what
      // preflight saw. With spec stages this comes first, before the spec
      // author's call; otherwise after the baseline, as before.
      const preflightAndConfirm = async () => {
        const observedModels = await runPreflight(
          step,
          setup,
          target,
          providerFor,
        )
        // Setup could not know the model an alias runs; preflight saw it.
        // The stages read this confirmed decision, and every call after
        // preflight carries the config version it gives. Recorded in its
        // own step, next to setup's answer, so a report can show why a
        // repair starts new.
        const observedModelOf = (profile: ResolvedProfile) =>
          observedModels.get(executionKey(profile)) ?? null
        return ownRepair
          ? await step.run(REPAIR_SESSION_STEP, async () => {
              const confirmed = confirmRepairSession({
                setup: setup.repairSession,
                provider: setup.profiles.code.provider,
                codeModel: observedModelOf(setup.profiles.code),
                repairModel: observedModelOf(ownRepair),
              })
              const record: RepairSessionRecord = {
                setup: setup.repairSession ?? null,
                confirmed,
                configVersion:
                  (confirmed.continues
                    ? setup.repairSession?.confirmedConfigVersion
                    : undefined) ?? setup.configVersion,
              }
              return record
            })
          : null
      }
      let repairSession = specStages ? await preflightAndConfirm() : null
      let runSetup: FactorySetup = repairSession
        ? { ...setup, configVersion: repairSession.configVersion }
        : setup
      // The spec stages write, review and fix the run's spec, and fix the
      // one the run goes on with; a person's rejection ends the run here,
      // before any implementation call.
      // From the spec stages through triage, a failure or cancel leaves no
      // review snapshots behind: whichever of these steps throws, the base
      // tree extracted for spec review must not wait for the worker's
      // startup sweep. A suspension on the spec wait is not a failure and
      // is left alone by the `LeaseLostError` exemption below.
      let roleProviders!: Record<ProfileRole, AgentProvider>
      let providers!: Record<ProfileRole, AgentProvider> & {
        repair: AgentProvider
      }
      let triage: Awaited<ReturnType<typeof runTriage>> | null
      try {
        if (specStages && runSetup.target.kind === 'repo') {
          const outcome = await runSpecStages({
            step,
            setup: runSetup,
            spec: specStages,
            target,
            providers: {
              author: providerFor(specStages.author),
              fix: providerFor(specStages.fix),
              reviewers: Object.fromEntries(
                specStages.reviewers.map((r) => [
                  r.name,
                  providerFor(r.profile),
                ]),
              ),
            },
          })
          if (outcome.kind === 'rejected') {
            await target.cleanup()
            return {
              approved: false,
              conclusion: 'rejected' as const,
              candidate: null,
              iterations: 0,
              reviewRounds: 0,
              reviews: [],
              workdir: target.workdir,
              fake: setup.fake,
              delivery: null,
              triage: null,
            }
          }
          runSetup = {
            ...runSetup,
            target: {
              ...runSetup.target,
              spec: outcome.record.content,
              specAdvice: specAdviceText(outcome.record.advice),
            },
          }
        }
        // A check chosen from the fixed spec: run once, before the baseline,
        // and used by the baseline and every verification after it.
        const repoTarget = runSetup.target
        if (
          repoTarget.kind === 'repo' &&
          repoTarget.checkFromSpec &&
          repoTarget.spec !== null &&
          target instanceof RepoTarget
        ) {
          const fixed = await runCheckFromSpec(step, {
            command: repoTarget.checkFromSpec,
            specPath: specFileOf(root),
            spec: repoTarget.spec,
            workdir: repoTarget.workdir,
            timeoutMs: repoTarget.checkTimeoutMs,
            identityOf: (check) =>
              runSetup.baselineCheck
                ? baselineIdentityOf({ ...repoTarget, checkCommand: check })
                : Promise.resolve(null),
          })
          runSetup = {
            ...runSetup,
            target: {
              ...repoTarget,
              checkCommand: fixed.check,
              checkNotes: fixed.notes,
            },
            ...(runSetup.baselineCheck
              ? { baselineIdentity: fixed.baselineIdentity }
              : {}),
          }
        }
        if (runSetup !== setup) target = createTarget(runSetup.target)
        // The pinned check must pass on the base commit, or no candidate could
        // be graded: stop before paying for any agent call. The same checkpoint
        // pair as verification, so a completed result is read back on resume
        // and an interrupted check is graded again. With `baselineReuse`, a
        // matching passing result of another run is used instead, once the
        // worktree is proven to be as the check would need it. The choice is
        // this step's output, so a replay never looks again. A repair of a
        // verification-failed parent skips it: its base is the candidate the
        // check failed on, and that failure is its findings (ADR-0030).
        if (
          runSetup.baselineCheck &&
          runSetup.repairOf?.parentConclusion !== 'verification-failed' &&
          target instanceof RepoTarget &&
          runSetup.target.kind === 'repo'
        ) {
          const baselineTarget = target
          const checkCommand = runSetup.target.checkCommand
          const baseCommit = runSetup.target.baseCommit
          const operationKey = `${step.runId}/baseline`
          const reuse = runSetup.baselineReuse ?? null
          const store = options.baselineStore
          const baseline = await step.run(
            BASELINE_STEP,
            async (signal, attempt): Promise<BaselineRecord> => {
              const reused =
                reuse && store
                  ? await reusedBaseline({
                      stateRoot: options.stateRoot,
                      runId: step.runId,
                      setup: runSetup,
                      reuse,
                      store,
                      operationKey,
                    })
                  : null
              if (reused) {
                await baselineTarget.assertReadyForBase(signal)
                return reused
              }
              const measured = await runTimedVerificationStep(
                attempt,
                {
                  provider: runSetup.profiles.code.provider,
                  operationKey,
                  checkpointsDir: runSetup.checkpointsDir,
                  stage: 'baseline',
                  iteration: 0,
                  grade: (graderSignal) =>
                    baselineTarget.gradeBase({
                      // Keyed by the step attempt, as a verification log is.
                      logDir: join(
                        runSetup.checkpointsDir,
                        '..',
                        'baseline-logs',
                        attempt.id,
                      ),
                      signal: graderSignal,
                    }),
                },
                signal,
              )
              return {
                ...measured.result,
                source: 'measured',
                identity: runSetup.baselineIdentity ?? null,
                // The check's own completion, which a resume that read the
                // verdict back from the checkpoint does not move.
                checkedAt: measured.completedAt,
              }
            },
          )
          // Also on a replay, so an index write lost to a crash after the
          // step completed is made up. Each run writes only its own entry.
          await recordBaselineInIndex({
            stateRoot: options.stateRoot,
            runId: step.runId,
            record: baseline,
          })
          if (!baseline.passed)
            throw new Error(
              `${BASELINE_FAILED_MESSAGE}: \`${checkFingerprint(checkCommand)}\` failed on the base commit ${baseCommit.slice(0, 12)} (exit code ${baseline.exitCode ?? 'unknown'}) before any agent call`,
            )
        }
        if (!specStages) {
          repairSession = await preflightAndConfirm()
          if (repairSession)
            runSetup = {
              ...runSetup,
              configVersion: repairSession.configVersion,
            }
        }
        roleProviders = byRole((role) => providerFor(setup.profiles[role]))
        providers = {
          ...roleProviders,
          repair: ownRepair ? providerFor(ownRepair) : roleProviders.code,
        }
        // Shadow mode: the judgment is recorded and nothing below reads it.
        const triageProfile = triageThatRuns(setup, setup.triage)
        const triageKey = `${step.runId}/triage/agent`
        triage = triageProfile
          ? await step.run(
              'triage',
              (signal, attempt) =>
                runTriage(signal, attempt, {
                  operationKey: triageKey,
                  setup: runSetup,
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
      } catch (error) {
        // As the stage loop below does: a suspension on the spec wait, a
        // failure or a cancel leaves no review snapshots behind.
        if (!(error instanceof Error && error.name === 'LeaseLostError'))
          await target.releaseReviewSnapshots?.({ base: true })
        throw error
      }
      let state = initialState(runSetup, repairSession?.confirmed ?? null)
      // Deliberately not a `finally`: `step.waitFor` suspends by throwing, so a
      // finally block would run cleanup every time the run parks on the human
      // approval wait, and a target that really removes its worktree would
      // destroy the work mid-approval. The `catch` below removes only the
      // review snapshots, which were already removed before the approval stage.
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
          // The review stage removes each round's candidate tree and
          // reviewer directories itself, on replay too. Once no review can
          // follow, the base tree goes as well, so none waits with the run
          // for a human.
          if (!reviewCanFollow(selected.stage))
            await target.releaseReviewSnapshots?.({ base: true })
          const rawEvent = await stages[selected.stage]({
            step,
            state,
            decision: selected,
            key: `stage:${sequence}:${selected.stage}`,
            services: { providers, target },
          })
          state = reduce(state, FactoryEventSchema.parse(rawEvent))
        }
      } catch (error) {
        // A failed or cancelled run never runs again, so its review
        // snapshots go now, before the failure is recorded. A lost lease is
        // left alone: the run may be picked up again and read them. A
        // suspension for approval finds none left.
        if (!(error instanceof Error && error.name === 'LeaseLostError'))
          await target.releaseReviewSnapshots?.({ base: true })
        throw error
      }
      await target.cleanup()
      return { ...state.outcome, triage }
    },
  })
}
