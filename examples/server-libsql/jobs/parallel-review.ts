import { defineJob } from '@coji/durably'
import { z } from 'zod'

export const parallelReviewJob = defineJob({
  name: 'parallel-review',
  input: z.object({ changeId: z.string() }),
  output: z.object({ staticReview: z.string(), behaviorReview: z.string() }),
  run: async (step, input) =>
    step.all({
      staticReview: async (_signal, attempt) => {
        attempt.log.info(`Checking code for ${input.changeId}`)
        return 'approved'
      },
      behaviorReview: async (_signal, attempt) => {
        attempt.log.info(`Checking behavior for ${input.changeId}`)
        return 'approved'
      },
    }),
})
