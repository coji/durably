/** Prompt builders — same provider, separate sessions for parallel reviews. */
import { z } from 'zod'

export function implementPrompt(
  iteration: number,
  failures: string[],
  reviewNotes: string[] = [],
): string {
  const history =
    failures.length > 0
      ? `\nPrevious test failures:\n${failures.map((f) => `- ${f}`).join('\n')}\nFix them.`
      : ''
  const reviews =
    reviewNotes.length > 0
      ? `\nPrevious review findings to address:\n${reviewNotes.map((n) => `- ${n}`).join('\n')}`
      : ''
  return [
    `You are working in the execution workdir (cwd). Task: fix src/calc.js add() so decimal inputs are not truncated (iteration ${iteration}).`,
    'Keep the change minimal; only edit files under src/.',
    'Do not modify files under test/ — acceptance tests are immutable and tampering fails the run.',
    'Do not run network commands. You may run `npm test` to check.',
    'Reply with a short summary of files changed.',
    history,
    reviews,
  ].join('\n')
}

export function reviewPromptA(): string {
  return [
    'You are reviewer A (correctness). READ ONLY — do not modify any file.',
    'Read src/calc.js and test/calc.test.js in the workdir.',
    'Check: does add() handle decimals, negatives, zero? Is mul() untouched?',
    'Reply in exactly this shape:',
    'DECISION: pass | needsChanges',
    'NOTES: <one or two sentences>',
  ].join('\n')
}

export function reviewPromptB(): string {
  return [
    'You are reviewer B (edge cases + minimal diff). READ ONLY — do not modify any file.',
    'Read src/calc.js diff vs the pristine template intent.',
    'Check: minimal change, no extra deps, no unrelated edits, tests cover the fix.',
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

const DECISION_RE = /DECISION:\s*(pass|needschanges)/gi

/**
 * Strict review-output parser.
 *
 * - Exactly one DECISION line with a known value is required.
 * - Empty output, missing/garbled decisions, and contradictory doubles
 *   (e.g. both `pass` and `needsChanges`) are review-incomplete, never `pass`.
 */
export function parseReviewOutput(text: string): ParsedReview {
  if (!text || text.trim().length === 0) {
    return { ok: false, error: 'empty review output' }
  }
  const found = [...text.matchAll(DECISION_RE)].map((m) =>
    (m[1] ?? '').toLowerCase(),
  )
  const normalized = found.map((d) =>
    d === 'needschanges' ? 'needsChanges' : 'pass',
  )
  if (normalized.length === 0) {
    return { ok: false, error: 'no DECISION line in review output' }
  }
  if (normalized.length > 1) {
    return {
      ok: false,
      error: `contradictory review output: ${normalized.length} DECISION lines`,
    }
  }
  const decision = normalized[0] as 'pass' | 'needsChanges'
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
