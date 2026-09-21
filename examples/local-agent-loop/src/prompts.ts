/** Prompt builders — same provider, separate sessions for parallel reviews. */
export function implementPrompt(iteration: number, failures: string[]): string {
  const history =
    failures.length > 0
      ? `\nPrevious test failures:\n${failures.map((f) => `- ${f}`).join('\n')}\nFix them.`
      : ''
  return [
    `You are working in the execution workdir (cwd). Task: fix src/calc.js add() so decimal inputs are not truncated (iteration ${iteration}).`,
    'Keep the change minimal; only edit files under src/.',
    'Do not run network commands. You may run `npm test` to check.',
    'Reply with a short summary of files changed.',
    history,
  ].join('\n')
}

export function reviewPromptA(): string {
  return [
    'You are reviewer A (correctness). Read src/calc.js and test/calc.test.js in the workdir.',
    'Check: does add() handle decimals, negatives, zero? Is mul() untouched?',
    'Reply in exactly this shape:',
    'DECISION: pass | needsChanges',
    'NOTES: <one or two sentences>',
  ].join('\n')
}

export function reviewPromptB(): string {
  return [
    'You are reviewer B (edge cases + minimal diff). Read src/calc.js diff vs the pristine template intent.',
    'Check: minimal change, no extra deps, no unrelated edits, tests cover the fix.',
    'Reply in exactly this shape:',
    'DECISION: pass | needsChanges',
    'NOTES: <one or two sentences>',
  ].join('\n')
}

export function parseVerdict(
  text: string,
  reviewer: 'review-a' | 'review-b',
): { decision: 'pass' | 'needsChanges'; notes: string } {
  const m = text.match(/DECISION:\s*(pass|needsChanges)/i)
  const decision =
    m?.[1]?.toLowerCase() === 'needsChanges' ? 'needsChanges' : 'pass'
  const notes =
    text
      .match(/NOTES:\s*(.+)/i)?.[1]
      ?.trim()
      .slice(0, 500) ?? text.slice(0, 200)
  return { decision, notes: reviewer === 'review-a' ? notes : notes }
}
