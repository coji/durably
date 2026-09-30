import { ACTION, ACTION_DONE } from '../glossary'
import { Notice } from './Notice'
import { runHref } from './RunLink'

/** A write the page can ask for, by the last segment of its path. */
export type ActionName =
  | 'approve'
  | 'reject'
  | 'spec-revise'
  | 'retrigger'
  | 'archive'
  | 'unarchive'

export interface ActionRequest {
  runId: string
  /** The task's name, which the notice repeats. */
  name: string
  action: ActionName
  /** The button's words, for the notice when the action is refused. */
  label: string
  body?: { waitId?: string; notes?: string }
}

/**
 * Send one action; resolves true once it is done. What happened is shown
 * as a notice either way.
 */
export type Act = (request: ActionRequest) => Promise<boolean>

/** What the server answered to an action. */
export interface ActionResult {
  /** `retrigger`: the run it started, or the one it had started before. */
  runId?: string
  disposition?: string
  /** `archive` / `unarchive`: false when nothing had to change. */
  changed?: boolean
  /**
   * `archive`: why git could not remove the worktree. The run is archived
   * either way.
   */
  warnings?: string[]
}

export type ActionOutcome =
  | { request: ActionRequest; result: ActionResult }
  | { request: ActionRequest; error: string }

function doneWords(
  action: ActionName,
  result: ActionResult,
): { title: string; body: string } {
  switch (action) {
    case 'approve':
    case 'reject':
    case 'spec-revise':
      return { title: ACTION_DONE[action], body: ACTION_DONE.decided }
    case 'retrigger':
      return {
        title:
          result.disposition === 'created'
            ? ACTION_DONE.retrigger
            : ACTION_DONE.retriggerAgain,
        body: ACTION_DONE.queued,
      }
    case 'archive':
      return {
        title: result.changed ? ACTION_DONE.archive : ACTION_DONE.archiveAgain,
        body: ACTION_DONE.archived,
      }
    case 'unarchive':
      return {
        title: result.changed
          ? ACTION_DONE.unarchive
          : ACTION_DONE.unarchiveAgain,
        body: ACTION_DONE.unarchived,
      }
  }
}

/**
 * What the last action came to, until it is closed or the page changes: the
 * task it was for and what happens next, or the CLI's own words when the
 * action was refused. The list itself changes on the next refresh.
 */
export function ActionNotice({
  outcome,
  onDismiss,
}: {
  outcome: ActionOutcome
  onDismiss?: () => void
}) {
  const { request } = outcome
  if ('error' in outcome)
    return (
      <Notice
        tone="failed"
        title={ACTION.failed(request.label)}
        onDismiss={onDismiss}
      >
        <p>{request.name}</p>
        <p className="font-code break-all">{outcome.error}</p>
      </Notice>
    )
  const words = doneWords(request.action, outcome.result)
  const next = outcome.result.runId
  const warnings = outcome.result.warnings ?? []
  return (
    <Notice title={words.title} onDismiss={onDismiss}>
      <p>{request.name}</p>
      <p>
        {words.body}
        {next ? (
          <>
            {' '}
            <a
              href={runHref(next)}
              className="text-fg underline underline-offset-2"
            >
              {ACTION.openRun}
            </a>
          </>
        ) : null}
      </p>
      {warnings.length > 0 ? (
        <>
          <p>{ACTION_DONE.worktreeLeft}</p>
          {warnings.map((warning) => (
            <p key={warning} className="font-code break-all">
              {warning}
            </p>
          ))}
        </>
      ) : null}
    </Notice>
  )
}
