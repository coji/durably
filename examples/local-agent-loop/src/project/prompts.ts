/** Prompt builders — same provider, separate sessions for parallel reviews. */
import { z } from 'zod'

export function codePrompt(
  role: 'implement' | 'repair',
  iteration: number,
  repairNotes: string[],
): string {
  const feedback =
    repairNotes.length > 0
      ? `\nVerified feedback to address:\n${repairNotes.map((n) => `- ${n}`).join('\n')}`
      : ''
  return [
    `You are the implementation owner continuing the ${role} conversation (iteration ${iteration}).`,
    'Task: fix src/calc.js add() so decimal inputs are not truncated.',
    'Keep the change minimal; only edit files under src/.',
    'Do not modify files under test/ — acceptance tests are immutable and tampering fails the run.',
    'Do not run network commands. You may run `npm test` to check locally, but grading runs the pristine snapshot with a fixed command — rewriting the test script cannot fake a pass.',
    'Reply with a short summary of files changed.',
    feedback,
  ].join('\n')
}

export function reviewPrompt(
  lens: 'correctness' | 'edge-cases',
  baselineContext: string,
): string {
  if (lens === 'correctness') {
    return [
      'You are an independent correctness reviewer. READ ONLY — do not modify any file.',
      'Read src/calc.js and test/calc.test.js in the workdir.',
      'Check: does add() handle decimals, negatives, zero? Use the trusted baseline context below to confirm whether mul() was touched.',
      baselineContext,
      'Reply in exactly this shape:',
      'DECISION: pass | needsChanges',
      'NOTES: <one or two sentences>',
    ].join('\n')
  }
  return [
    'You are an independent edge-case reviewer. READ ONLY — do not modify any file.',
    'Inspect the Candidate using the trusted baseline context below.',
    'Check: minimal change, no extra deps, no unrelated edits, tests cover the fix.',
    baselineContext,
    'Reply in exactly this shape:',
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
    const m = /^\s*DECISION:\s*(.+?)\s*$/i.exec(line)
    if (m?.[1] !== undefined) values.push(m[1].toLowerCase())
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
