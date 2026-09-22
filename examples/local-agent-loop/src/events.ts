/** Persistable stage results consumed by the pure reducer. */
import { z } from 'zod'

const candidateSchema = z.object({
  id: z.string(),
  snapshotDir: z.string(),
  sourceHash: z.string(),
  acceptanceHash: z.string(),
})

const sessionSchema = z.object({
  provider: z.enum(['codex', 'claude', 'fake']),
  nativeId: z.string(),
  profileId: z.string(),
  cwd: z.string(),
  instructionsVersion: z.string(),
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
    }),
  }),
])

export type FactoryEvent = z.infer<typeof FactoryEventSchema>
