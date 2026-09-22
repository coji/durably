/** Prompt builders — same provider, separate sessions for parallel reviews. */
import { z } from 'zod'

export interface CodePromptArgs {
  role: 'implement' | 'repair'
  iteration: number
  repairNotes: string[]
  /** What to accomplish. Supplied by the target, not by this factory. */
  task: string
  /** Target-specific constraints, such as which files may be edited. */
  rules: string[]
}

export function codePrompt(args: CodePromptArgs): string {
  const feedback =
    args.repairNotes.length > 0
      ? `\nVerified feedback to address:\n${args.repairNotes.map((n) => `- ${n}`).join('\n')}`
      : ''
  return [
    `You are the implementation owner continuing the ${args.role} conversation (iteration ${args.iteration}).`,
    '',
    'TASK:',
    args.task,
    '',
    'RULES:',
    ...args.rules.map((rule) => `- ${rule}`),
    '',
    'Reply with a short summary of files changed.',
    feedback,
  ].join('\n')
}

export function reviewPrompt(
  lens: 'correctness' | 'edge-cases',
  trustedContext: string,
  rules: string[],
): string {
  const role =
    lens === 'correctness'
      ? 'an independent correctness reviewer'
      : 'an independent edge-case reviewer'
  return [
    `You are ${role}. READ ONLY — do not modify any file.`,
    '',
    'CHECK:',
    ...rules.map((rule) => `- ${rule}`),
    '',
    trustedContext,
    '',
    'Reply in exactly this shape, with DECISION on a line of its own:',
    'DECISION: pass | needsChanges',
    'NOTES: <one or two sentences>',
  ].join('\n')
}

/** Validated review verdict. Only an explicit, well-formed `pass` counts. */
export const reviewVerdictSchema = z.object({
  decision: z.enum(['pass', 'needsChanges']),
  notes: z.string().min(1).max(500),
})

export type ParsedReview =
  | { ok: true; decision: 'pass' | 'needsChanges'; notes: string }
  | { ok: false; error: string }

/**
 * Strict review-output parser.
 *
 * - Exactly one DECISION line with an exact known value is required. The
 *   value is validated whole (`pass` / `needschanges`, case-insensitive) —
 *   prefix matches such as `passage` or `pass | needsChanges` are
 *   review-incomplete, never `pass`.
 * - Empty output, missing/garbled decisions, and contradictory doubles
 *   (e.g. both `pass` and `needsChanges`) are review-incomplete, never `pass`.
 */
export function parseReviewOutput(text: string): ParsedReview {
  if (!text || text.trim().length === 0) {
    return { ok: false, error: 'empty review output' }
  }
  const values: string[] = []
  for (const line of text.split('\n')) {
    // `DECISION:` does not have to start the line. A real reviewer often
    // writes a sentence about what it is checking and then the verdict on the
    // same line. What follows the marker is still taken whole and validated
    // whole, so an echoed `DECISION: pass | needsChanges` template stays
    // review-incomplete rather than reading as a pass.
    const m = /DECISION:\s*(.*)$/i.exec(line)
    if (m?.[1] !== undefined) values.push(m[1].trim().toLowerCase())
  }
  if (values.length === 0) {
    return { ok: false, error: 'no DECISION line in review output' }
  }
  if (values.length > 1) {
    return {
      ok: false,
      error: `contradictory review output: ${values.length} DECISION lines`,
    }
  }
  const raw = values[0] as string
  if (raw !== 'pass' && raw !== 'needschanges') {
    return { ok: false, error: `invalid DECISION value: ${values[0]}` }
  }
  const decision = raw === 'needschanges' ? 'needsChanges' : 'pass'
  const notes =
    text
      .match(/NOTES:\s*(.+)/i)?.[1]
      ?.trim()
      .slice(0, 500) ?? ''
  if (notes.length === 0) {
    return { ok: false, error: 'missing NOTES line in review output' }
  }
  const verdict = reviewVerdictSchema.safeParse({ decision, notes })
  if (!verdict.success) {
    return {
      ok: false,
      error: `invalid review verdict: ${verdict.error.message}`,
    }
  }
  return { ok: true, decision, notes }
}
