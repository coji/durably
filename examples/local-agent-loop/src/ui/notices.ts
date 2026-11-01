/**
 * The notices the page keeps of its actions, apart from how they are
 * shown: the last single-run action's, and one for each bulk action, which
 * changes only by its own progress and answer. A bulk action can take
 * minutes, so a person may act on one run, or start another bulk action,
 * while it runs; each keeps its own notice instead of taking over another's.
 */
import type { ActionOutcome } from './components/ActionNotice'
import type { BulkOutcome, BulkRequest } from './components/BulkNotice'

export type NoticeOutcome =
  | { kind: 'one'; outcome: ActionOutcome }
  | {
      kind: 'progress'
      action: BulkRequest['action']
      done: number
      total: number
    }
  | { kind: 'bulk'; outcome: BulkOutcome }

/** One notice, with the page it was made on, which alone shows it. */
export interface NoticeEntry {
  id: number
  page: string
  outcome: NoticeOutcome
}

/**
 * `entries` with `entry` in place of the one with its ID, where that one
 * was, or else added last. A new single-run notice replaces the last one,
 * and a new notice of any kind drops the answered ones of other pages,
 * since a person who acts here has left them; a bulk action still running
 * keeps its notice wherever it was started.
 */
export function withNotice(
  entries: NoticeEntry[],
  entry: NoticeEntry,
): NoticeEntry[] {
  if (entries.some((e) => e.id === entry.id))
    return entries.map((e) => (e.id === entry.id ? entry : e))
  return [
    ...entries.filter(
      (e) =>
        !(entry.outcome.kind === 'one' && e.outcome.kind === 'one') &&
        (e.page === entry.page || e.outcome.kind === 'progress'),
    ),
    entry,
  ]
}

/** `entries` without the one with `id`, as when it is closed. */
export function withoutNotice(
  entries: NoticeEntry[],
  id: number,
): NoticeEntry[] {
  return entries.filter((e) => e.id !== id)
}

/** The notices `page` shows, oldest first. */
export function noticesOn(entries: NoticeEntry[], page: string): NoticeEntry[] {
  return entries.filter((e) => e.page === page)
}
