/** Persistable stage results consumed by the pure reducer. */
import { z } from 'zod'

/** A repository candidate's diff files and size, written when it was sealed. */
export const candidateChangesSchema = z.object({
  diffPath: z.string(),
  changedFilesPath: z.string(),
  files: z.number(),
  additions: z.number(),
  deletions: z.number(),
})

export const candidateSchema = z.object({
  id: z.string(),
  snapshotDir: z.string(),
  sourceHash: z.string(),
  acceptanceHash: z.string(),
  branch: z.string().optional(),
  commit: z.string().optional(),
  changes: candidateChangesSchema.optional(),
})

/** Where one grading attempt left the check's full output. */
const verificationLogSchema = z.object({
  stdoutPath: z.string(),
  stderrPath: z.string(),
  exitCode: z.number().nullable(),
  writeError: z.string().optional(),
})

const sessionSchema = z.object({
  provider: z.enum(['codex', 'claude', 'fake']),
  nativeId: z.string(),
  profileId: z.string(),
  // Optional so a session recorded before it existed still parses. Such a
  // session is continued by its own profile only, never across an effort
  // change.
  model: z.string().nullable().optional(),
  cwd: z.string(),
  instructionsVersion: z.string(),
})

export const deliverySchema = z.object({
  kind: z.enum(['snapshot', 'patch', 'pull-request']),
  location: z.string(),
  summary: z.string(),
  // Defaulted so a delivery recorded before these fields existed still parses.
  branch: z.string().nullable().default(null),
  commit: z.string().nullable().default(null),
  squashedBranch: z.string().nullable().default(null),
  squashedCommit: z.string().nullable().default(null),
})

const reviewSchema = z.object({
  lens: z.enum(['correctness', 'edge-cases']),
  decision: z.enum(['pass', 'needsChanges']),
  notes: z.string(),
  // No findings: a review step returns them with its verdict, and parsing
  // strips them here, so the state, the approval wait's metadata and the
  // run output keep the verdicts only. The report reads the findings from
  // the review steps.
})

export const FactoryEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('code.completed'),
    role: z.enum(['implement', 'repair']),
    candidate: candidateSchema,
    session: sessionSchema.nullable(),
  }),
  z.object({
    type: z.literal('verify.completed'),
    targetId: z.string(),
    passed: z.boolean(),
    stdout: z.string(),
    exitCode: z.number().nullable(),
    // Optional so a verification recorded before logs existed still parses.
    log: verificationLogSchema.nullable().optional(),
  }),
  z.object({
    type: z.literal('review.completed'),
    targetId: z.string(),
    reviews: z.array(reviewSchema).length(2),
  }),
  z.object({
    type: z.literal('approval.completed'),
    targetId: z.string(),
    decision: z.enum(['approved', 'rejected']),
  }),
  z.object({
    type: z.literal('factory.finished'),
    outcome: z.object({
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
      reviews: z.array(reviewSchema),
      workdir: z.string(),
      fake: z.boolean(),
      delivery: deliverySchema.nullable(),
    }),
  }),
])

export type FactoryEvent = z.infer<typeof FactoryEventSchema>

const specVersionSchema = z.object({
  content: z.string(),
  sha256: z.string(),
})

const specFindingSchema = z.object({
  severity: z.enum(['blocker', 'non-blocker']),
  title: z.string(),
  body: z.string(),
  file: z.string().optional(),
  line: z.number().optional(),
})

const specReviewSchema = z.object({
  name: z.string(),
  decision: z.enum(['pass', 'needsChanges']),
  notes: z.string(),
  findings: z
    .object({
      blocker: z.array(specFindingSchema),
      nonBlocker: z.array(specFindingSchema),
      counts: z.object({ blocker: z.number(), nonBlocker: z.number() }),
    })
    .nullable(),
})

/**
 * The spec stages' stored results, consumed by `reduceSpec`: a version of
 * the spec written by the author or a fix, one review round of it, and a
 * person's decision on a spec still blocked after the last round.
 */
export const SpecEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('spec.authored'), version: specVersionSchema }),
  z.object({ type: z.literal('spec.fixed'), version: specVersionSchema }),
  z.object({
    type: z.literal('spec.reviewed'),
    sha256: z.string(),
    reviews: z.array(specReviewSchema).min(1),
  }),
  z.object({
    type: z.literal('spec.decided'),
    sha256: z.string(),
    decision: z.enum(['approved', 'rejected', 'revise']),
    notes: z.string().nullable(),
  }),
])

export type SpecEvent = z.infer<typeof SpecEventSchema>
