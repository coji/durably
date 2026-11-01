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
  archived?: { runId: string; changed: boolean; warnings?: string[] }[]
  errors?: string[]
}

/**
 * What one item came to: the runs it newly archived and why git left a
 * worktree or a branch behind, if it did.
 */
export interface BulkItemResult {
  item: BulkItem
  archived: string[]
  warnings: string[]
}

export interface BulkOutcome {
  action: BulkRequest['action']
  /** The items done. */
  done: BulkItemResult[]
  /**
   * The items refused, each with the CLI's own words. A task whose
   * `archive-series` archived some of its runs and failed on others keeps
   * the runs it archived and their warnings here too.
   */
  failed: (BulkItemResult & { error: string })[]
}

/**
 * One item's answer as the notice reads it: the runs a task's
 * `archive-series` newly archived, every warning its runs carry, and its
 * errors as one, if any.
 */
export function seriesOutcome(
  answer: SeriesResult,
): Omit<BulkItemResult, 'item'> & { error?: string } {
  const runs = answer.archived ?? []
  const errors = answer.errors ?? []
  return {
    archived: runs.filter((r) => r.changed).map((r) => r.runId),
    warnings: runs.flatMap((r) => r.warnings ?? []),
    ...(errors.length > 0 ? { error: errors.join('\n') } : {}),
  }
}

/**
 * Send a bulk action's items one after another, as the CLI does them, and
 * tell `onProgress` how many have their answer after each. A failed item
 * does not stop the rest.
 */
export async function sendEach(
  request: BulkRequest,
  send: (item: BulkItem) => Promise<ReturnType<typeof seriesOutcome>>,
  onProgress: (done: number) => void,
): Promise<BulkOutcome> {
  const outcome: BulkOutcome = {
    action: request.action,
    done: [],
    failed: [],
  }
  for (const [i, item] of request.items.entries()) {
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- One at a time, so each answer moves the count.
    const { error, ...result } = await send(item)
    if (error === undefined) outcome.done.push({ item, ...result })
    else outcome.failed.push({ item, ...result, error })
    onProgress(i + 1)
  }
  return outcome
}

/** How far a bulk action has come, while it runs. */
export function BulkProgress({
  action,
  done,
  total,
}: {
  action: BulkRequest['action']
  done: number
  total: number
}) {
  const archive = action === 'archive-series'
  const progress = archive ? BULK.archiving : BULK.unarchiving
  return (
    <Notice
      tone="running"
      title={progress(formatCount(done), formatCount(total))}
    >
      {archive ? <p>{BULK.archivingNote}</p> : null}
    </Notice>
  )
}

/**
 * The runs a bulk archive newly archived, as the items that bring each
 * back: the notice's way back, and nothing a person did not just archive.
 */
export function undoItems(outcome: BulkOutcome): BulkItem[] {
  return [...outcome.done, ...outcome.failed].flatMap(({ item, archived }) =>
    archived.map((runId) => ({ runId, name: item.name })),
  )
}

/**
 * What a bulk action came to: how many it did, the way back from an
 * archive, each item whose cleanup git refused with why, and each item it
 * could not do with why.
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
  const left = [...done, ...failed].filter((d) => d.warnings.length > 0)
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
      {left.length > 0 ? (
        <>
          <p>{ACTION_DONE.worktreeLeft}</p>
          <ul className="flex flex-col gap-1">
            {left.map(({ item, warnings }) => (
              <li key={item.runId}>
                <p>{item.name}</p>
                {warnings.map((warning) => (
                  <p key={warning} className="font-code break-all">
                    {warning}
                  </p>
                ))}
              </li>
            ))}
          </ul>
        </>
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
