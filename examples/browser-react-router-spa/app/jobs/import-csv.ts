/**
 * CSV Import Job
 *
 * Demonstrates separation of steps (resumable units) and progress (UI feedback).
 * - Steps: validate, import, finalize (3 resumable checkpoints)
 * - Progress: fine-grained row-level feedback within each step
 */

import { defineJob } from '@coji/durably'
import { z } from 'zod'

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

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

    // Step 1: Validate all rows
    const validRows = await step.run('validate', async () => {
      const valid: typeof payload.rows = []
      const invalid: { row: (typeof payload.rows)[0]; reason: string }[] = []

      for (let i = 0; i < payload.rows.length; i++) {
        const row = payload.rows[i]
        step.progress(i + 1, payload.rows.length, `Validating ${row.name}...`)
        await delay(50)

        if (row.amount < 0) {
          invalid.push({ row, reason: `Invalid amount: ${row.amount}` })
          step.log.warn(`Validation failed for ${row.name}: negative amount`)
        } else {
          valid.push(row)
        }
      }

      step.log.info(
        `Validation complete: ${valid.length} valid, ${invalid.length} invalid`,
      )
      return { valid, invalidCount: invalid.length }
    })

    // Step 2: Import valid rows
    const importResult = await step.run('import', async () => {
      let imported = 0

      for (let i = 0; i < validRows.valid.length; i++) {
        const row = validRows.valid[i]
        step.progress(i + 1, validRows.valid.length, `Importing ${row.name}...`)
        await delay(80)

        // Simulate import
        imported++
        step.log.info(`Imported: ${row.name} (${row.email}) - $${row.amount}`)
      }

      return { imported }
    })

    // Step 3: Finalize
    await step.run('finalize', async () => {
      step.progress(1, 1, 'Finalizing...')
      await delay(200)
      step.log.info('Import finalized')
    })

    return {
      imported: importResult.imported,
      failed: validRows.invalidCount,
    }
  },
})
