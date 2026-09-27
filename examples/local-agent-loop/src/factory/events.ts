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
