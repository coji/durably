import { useState } from 'react'

import { formatCount } from '../../engine/format'
import type { ReviewHighlights } from '../../engine/report'
import type { Diagnosis } from '../../engine/status'
import { ACTION, COMMON, REVIEW } from '../glossary'
import { commandText } from '../labels'
import { ActionButton, type ActionLook } from './ActionButton'
import type { Act, ActionName } from './ActionNotice'
import { BUTTON, BUTTON_PRIMARY } from './button'
import { Commands } from './Commands'
import { SpecReviseForm } from './SpecReviseForm'

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

/** Finding titles the approval question shows per group. */
const SHOWN = 3

/** The reviews in two or three lines, asked before an approval. */
function HighlightsBrief({ h }: { h: ReviewHighlights | null }) {
  if (!h || h.rounds === 0) return null
  const groups = (
    [
      [REVIEW.open, h.open],
      [REVIEW.left, h.left],
    ] as const
  ).filter(([, g]) => g.count > 0)
  return (
    <div className="flex flex-col gap-1">
      <p>
        {REVIEW.rounds(formatCount(h.rounds))}
        {COMMON.separator}
        {h.last === 'passed'
          ? REVIEW.passedLast
          : h.last === 'blocked'
            ? REVIEW.failedLast
            : REVIEW.incompleteLast}
      </p>
      {groups.map(([label, g]) => (
        <div key={label}>
          <p>
            {label} {COMMON.count(formatCount(g.count))}
          </p>
          <ul className="list-disc pl-4">
            {g.titles.slice(0, SHOWN).map((title, at) => (
              <li key={`${at}:${title}`}>{title}</li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  )
}

/**
 * The actions a run allows, each as the CLI line that does the same; null
 * where the run does not allow it. Only the CLI's own next commands are
 * offered, so the page never offers what `status` would not.
 */
function offered(run: ActionTarget) {
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

type Offered = ReturnType<typeof offered>
type Press = (
  action: ActionName,
  label: string,
  body?: object,
) => () => Promise<void>

/** Approve and reject, of a candidate or of a blocked spec. */
function DecisionButtons({
  run,
  can,
  first,
  press,
}: {
  run: ActionTarget
  can: Offered
  first: ActionLook
  press: Press
}) {
  const waitId = run.waitId ?? ''
  const approve = can.spec ? ACTION.specApprove : ACTION.approve
  return (
    <>
      {can.approve ? (
        <ActionButton
          label={approve}
          look={can.spec ? 'default' : first}
          onAction={press('approve', approve, { waitId })}
          confirm={{
            command: can.approve,
            details: can.spec ? (
              ACTION.specApproveNote
            ) : (
              <HighlightsBrief h={run.reviewHighlights} />
            ),
          }}
        />
      ) : null}
      {can.reject ? (
        <ActionButton
          label={ACTION.reject}
          look="quiet"
          onAction={press('reject', ACTION.reject, { waitId })}
          confirm={{
            command: can.reject,
            details: can.spec ? ACTION.specRejectNote : ACTION.rejectNote,
          }}
        />
      ) : null}
    </>
  )
}

/** Run a stop again, archive it, or bring an archived one back. */
function StopButtons({
  can,
  first,
  press,
}: {
  can: Offered
  first: ActionLook
  press: Press
}) {
  return (
    <>
      {can.retrigger ? (
        <ActionButton
          label={ACTION.retrigger}
          look={first}
          onAction={press('retrigger', ACTION.retrigger)}
        />
      ) : null}
      {can.archive ? (
        <ActionButton
          label={ACTION.archive}
          look="quiet"
          onAction={press('archive', ACTION.archive)}
          confirm={{ command: can.archive, details: ACTION.archiveNote }}
        />
      ) : null}
      {can.unarchive ? (
        <ActionButton
          label={ACTION.unarchive}
          onAction={press('unarchive', ACTION.unarchive)}
        />
      ) : null}
    </>
  )
}

/**
 * What a person can do to this run from the page, each through the same
 * function as its CLI command, which is shown beside it: decide an
 * approval or a blocked spec, run a safe stop again, or archive a stop.
 * `lead` sets the first action in ink, for the one screen it leads; reject
 * and archive stay quiet and ask first.
 */
export function RunActions({
  run,
  act,
  lead = false,
  initialRevising = false,
}: {
  run: ActionTarget
  act: Act
  lead?: boolean
  /** Start with the notes form open, for the design page. */
  initialRevising?: boolean
}) {
  const [revising, setRevising] = useState(initialRevising)
  const can = offered(run)
  const send = (action: ActionName, label: string, body?: object) =>
    act({ runId: run.id, name: run.name, action, label, body })
  // Awaited, so the button shows it is at work until the answer comes.
  const press: Press = (action, label, body) => async () => {
    await send(action, label, body)
  }
  const first: ActionLook = lead ? 'primary' : 'default'
  const any = Object.values(can).some((v) => typeof v === 'string')
  // An archived run offers only its way back; any other shows every next
  // command, with the archive command after them.
  const commands = can.unarchive
    ? [can.unarchive]
    : [...run.diagnosis.next, ...(can.archive ? [can.archive] : [])]
  return (
    <div className="flex flex-col gap-3">
      {any ? (
        <div className="flex flex-wrap items-start gap-2">
          {can.revise ? (
            <button
              type="button"
              aria-expanded={revising}
              onClick={() => setRevising((r) => !r)}
              className={lead ? BUTTON_PRIMARY : BUTTON}
            >
              {ACTION.specRevise}
            </button>
          ) : null}
          <DecisionButtons run={run} can={can} first={first} press={press} />
          <StopButtons can={can} first={first} press={press} />
        </div>
      ) : null}
      {revising && can.revise ? (
        <SpecReviseForm
          command={can.revise}
          focus={!initialRevising}
          onCancel={() => setRevising(false)}
          onSend={async (notes) => {
            if (await send('spec-revise', ACTION.specRevise, { notes }))
              setRevising(false)
          }}
        />
      ) : null}
      {commands.length > 0 ? (
        <div className="flex flex-col gap-1">
          {any ? (
            <span className="text-fg-2 text-xs">{ACTION.sameCommand}</span>
          ) : null}
          <Commands lines={commands} />
        </div>
      ) : null}
    </div>
  )
}
