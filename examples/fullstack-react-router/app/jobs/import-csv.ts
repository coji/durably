/**
 * CSV Import Job
 *
 * Processes CSV rows with progress reporting.
 */

import { defineJob } from '@coji/durably'
import { z } from 'zod'

const csvRowSchema = z.object({
  id: z.number(),
  name: z.string(),
  email: z.string(),
  amount: z.number(),
})

/** Output schema for type inference */
const outputSchema = z.object({ imported: z.number(), failed: z.number() })

/** Output type for use in components */
export type ImportCsvOutput = z.infer<typeof outputSchema>

export const importCsvJob = defineJob({
  name: 'import-csv',
  input: z.object({
    filename: z.string(),
    rows: z.array(csvRowSchema),
  }),
  output: outputSchema,
  run: async (step, payload) => {
    step.log.info(
      `Starting import of ${payload.filename} (${payload.rows.length} rows)`,
    )

    let imported = 0

    for (let i = 0; i < payload.rows.length; i++) {
      const row = payload.rows[i]
      const result = await step.run(`row-${i}`, async () => {
        // Simulate processing with validation
        await new Promise((r) => setTimeout(r, 100))

        // Simulate occasional failures (negative amounts)
        if (row.amount < 0) {
          throw new Error(`Invalid amount for ${row.name}: ${row.amount}`)
        }

        return { processed: true, id: row.id }
      })

      if (result.processed) {
        imported++
        step.log.info(`Imported: ${row.name} (${row.email}) - $${row.amount}`)
      }

      step.progress(i + 1, payload.rows.length, `Processing ${row.name}`)
    }

    step.log.info(`Import completed: ${imported} rows`)
    return { imported, failed: 0 }
  },
})
