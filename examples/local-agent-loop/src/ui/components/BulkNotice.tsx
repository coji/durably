import { formatCount } from '../../engine/format'
import { ACTION_DONE, BULK } from '../glossary'
import { BUTTON } from './button'
import { Notice } from './Notice'

/** One task or run a bulk action is for, with the name the notice repeats. */
export interface BulkItem {
  runId: string
  name: string
}

/**
 * The same action on several tasks or runs, one POST after another:
 * `archive-series` for a task by any of its runs, `unarchive` for a run.
 */
export interface BulkRequest {
  action: 'archive-series' | 'unarchive'
  items: BulkItem[]
}

/** Send a bulk action; resolves once every item has an answer. */
export type BulkAct = (request: BulkRequest) => Promise<void>

/** What one task's `archive-series` answered: its runs, and what failed. */
export interface SeriesResult {
  archived?: { runId: string; changed: boolean }[]
  errors?: string[]
}

export interface BulkOutcome {
  action: BulkRequest['action']
  /** The items done, each with the runs it newly archived. */
  done: { item: BulkItem; archived: string[] }[]
  /** The items refused, each with the CLI's own words. */
  failed: { item: BulkItem; error: string }[]
}

/**
 * The runs a bulk archive newly archived, as the items that bring each
 * back: the notice's way back, and nothing a person did not just archive.
 */
export function undoItems(outcome: BulkOutcome): BulkItem[] {
  return outcome.done.flatMap(({ item, archived }) =>
    archived.map((runId) => ({ runId, name: item.name })),
  )
}

/**
 * What a bulk action came to: how many it did, the way back from an
 * archive, and each item it could not do with why.
 */
export function BulkNotice({
  outcome,
  onUndo,
  onDismiss,
}: {
  outcome: BulkOutcome
  onUndo?: (request: BulkRequest) => void
  onDismiss?: () => void
}) {
  const { done, failed } = outcome
  const back = outcome.action === 'archive-series' ? undoItems(outcome) : []
  const title =
    outcome.action === 'archive-series'
      ? BULK.archived(formatCount(done.length))
      : BULK.unarchived(formatCount(done.length))
  return (
    <Notice
      tone={failed.length > 0 ? 'failed' : undefined}
      title={title}
      onDismiss={onDismiss}
    >
      <p>
        {outcome.action === 'archive-series'
          ? ACTION_DONE.archived
          : ACTION_DONE.unarchived}
      </p>
      {back.length > 0 && onUndo ? (
        <div>
          <button
            type="button"
            className={BUTTON}
            onClick={() => onUndo({ action: 'unarchive', items: back })}
          >
            {BULK.undo}
          </button>
        </div>
      ) : null}
      {failed.length > 0 ? (
        <>
          <p>{BULK.failed(formatCount(failed.length))}</p>
          <ul className="flex flex-col gap-1">
            {failed.map(({ item, error }) => (
              <li key={item.runId}>
                <p>{item.name}</p>
                <p className="font-code break-all">{error}</p>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </Notice>
  )
}
