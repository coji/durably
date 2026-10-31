/**
 * Text written into Markdown the factory builds, such as a report or a
 * repair run's findings.
 */

/**
 * `text` as one fenced code block, its fence longer than any run of
 * backticks in it, so none of its lines reads as a heading of the document
 * around it or ends the block.
 */
export function fencedText(text: string): string[] {
  const longest = Math.max(
    0,
    ...(text.match(/`+/g) ?? []).map((run) => run.length),
  )
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return [fence, text.replace(/\n$/, ''), fence]
}
