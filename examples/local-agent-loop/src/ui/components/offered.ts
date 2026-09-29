import type { ReviewHighlights } from '../../engine/report'
import type { Diagnosis } from '../../engine/status'
import { commandText } from '../labels'
import type { ActionName } from './ActionNotice'

/** What the actions of one run read: the list row or the detail page. */
export interface ActionTarget {
  id: string
  name: string
  diagnosis: Diagnosis
  archived: boolean
  archiveCommand: string | null
  waitId: string | null
  reviewHighlights: ReviewHighlights | null
}

/**
 * The actions a run allows, each as the CLI line that does the same; null
 * where the run does not allow it. Only the CLI's own next commands are
 * offered, so the page never offers what `status` would not.
 */
export function offered(run: ActionTarget) {
  const { kind, next } = run.diagnosis
  const line = (sub: RegExp) =>
    next.map(commandText).find((c) => sub.test(c)) ?? null
  const decides = kind === 'approval' || kind === 'spec-approval'
  return {
    spec: kind === 'spec-approval',
    approve: decides ? line(/ demo approve /) : null,
    reject: decides ? line(/ demo reject /) : null,
    revise: kind === 'spec-approval' ? line(/ demo spec-revise /) : null,
    retrigger:
      kind === 'stopped' && !run.archived
        ? line(/ demo retrigger (?!.*--reload-config)/)
        : null,
    archive: run.archived ? null : run.archiveCommand,
    unarchive: run.archived ? run.archiveCommand : null,
  }
}

export type Offered = ReturnType<typeof offered>

/**
 * The CLI lines beside the actions. An archived run offers only its way
 * back; any other shows every next command, with the archive command after
 * them.
 */
export function commandLines(run: ActionTarget, offer: Offered): string[] {
  if (offer.unarchive) return [offer.unarchive]
  return [...run.diagnosis.next, ...(offer.archive ? [offer.archive] : [])]
}

/** The CLI line an action is offered as; null where the run does not offer it. */
export function lineOf(can: Offered, name: ActionName): string | null {
  const lines: Record<ActionName, string | null> = {
    approve: can.approve,
    reject: can.reject,
    'spec-revise': can.revise,
    retrigger: can.retrigger,
    archive: can.archive,
    unarchive: can.unarchive,
  }
  return lines[name]
}

/**
 * The offered actions with every one but the asking one set aside, so the
 * row holds one decision while an action asks, works, or takes notes.
 */
export function only(can: Offered, asking: ActionName | null): Offered {
  if (asking === null) return can
  const keep = (name: ActionName) =>
    asking === name ? lineOf(can, name) : null
  return {
    spec: can.spec,
    approve: keep('approve'),
    reject: keep('reject'),
    revise: keep('spec-revise'),
    retrigger: keep('retrigger'),
    archive: keep('archive'),
    unarchive: keep('unarchive'),
  }
}
