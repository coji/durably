import { useState } from 'react'

import type { ReviewHighlights } from '../../engine/report'
import type { Diagnosis } from '../../engine/status'
import { ACTION } from '../glossary'
import { commandText } from '../labels'
import { ActionButton, type ActionLook, type ActionStage } from './ActionButton'
import type { Act, ActionName } from './ActionNotice'
import { BUTTON, BUTTON_PRIMARY } from './button'
import { Commands } from './Commands'
import { ReviewHighlightsBody } from './ReviewHighlights'
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

/** How a button starts, and what it tells the row when its stage changes. */
type Ask = (name: ActionName) => {
  initialStage: ActionStage
  onStageChange: (stage: ActionStage) => void
}

/**
 * The offered actions with every one but the asking one set aside, so the
 * row holds one decision while an action asks, works, or takes notes.
 */
function only(can: Offered, asking: ActionName | null): Offered {
  if (asking === null) return can
  const keep = (name: ActionName, line: string | null) =>
    asking === name ? line : null
  return {
    spec: can.spec,
    approve: keep('approve', can.approve),
    reject: keep('reject', can.reject),
    revise: keep('spec-revise', can.revise),
    retrigger: keep('retrigger', can.retrigger),
    archive: keep('archive', can.archive),
    unarchive: keep('unarchive', can.unarchive),
  }
}

/** Which action of the row is asking, and the hooks its button reports to. */
function useAsking(initial: ActionName | undefined) {
  const [asking, setAsking] = useState<ActionName | null>(initial ?? null)
  const ask: Ask = (name) => ({
    initialStage: initial === name ? 'confirming' : 'idle',
    onStageChange: (stage) => setAsking(stage === 'idle' ? null : name),
  })
  return { asking, setAsking, ask }
}

/** What approving says first: the reviews in short, or what a spec approval skips. */
function ApproveDetails({
  spec,
  h,
}: {
  spec: boolean
  h: ReviewHighlights | null
}) {
  if (spec) return ACTION.specApproveNote
  if (!h || h.rounds === 0) return null
  return <ReviewHighlightsBody h={h} compact />
}

/** Approve and reject, of a candidate or of a blocked spec. */
function DecisionButtons({
  run,
  can,
  first,
  press,
  ask,
}: {
  run: ActionTarget
  can: Offered
  first: ActionLook
  press: Press
  ask: Ask
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
          {...ask('approve')}
          confirm={{
            command: can.approve,
            details: (
              <ApproveDetails spec={can.spec} h={run.reviewHighlights} />
            ),
          }}
        />
      ) : null}
      {can.reject ? (
        <ActionButton
          label={ACTION.reject}
          look="quiet"
          onAction={press('reject', ACTION.reject, { waitId })}
          {...ask('reject')}
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
  ask,
}: {
  can: Offered
  first: ActionLook
  press: Press
  ask: Ask
}) {
  return (
    <>
      {can.retrigger ? (
        <ActionButton
          label={ACTION.retrigger}
          look={first}
          onAction={press('retrigger', ACTION.retrigger)}
          {...ask('retrigger')}
        />
      ) : null}
      {can.archive ? (
        <ActionButton
          label={ACTION.archive}
          look="quiet"
          onAction={press('archive', ACTION.archive)}
          {...ask('archive')}
          confirm={{ command: can.archive, details: ACTION.archiveNote }}
        />
      ) : null}
      {can.unarchive ? (
        <ActionButton
          label={ACTION.unarchive}
          onAction={press('unarchive', ACTION.unarchive)}
          {...ask('unarchive')}
        />
      ) : null}
    </>
  )
}

/**
 * What a person can do to this run from the page, each through the same
 * function as its CLI command: decide an approval or a blocked spec, run a
 * safe stop again, or archive a stop. `lead` sets the first action in ink,
 * for the one screen it leads; reject and archive stay quiet and ask first.
 * While one action asks, works, or takes notes, the others step aside. The
 * CLI commands, the report and status ones among them, wait in one closed
 * disclosure below the buttons; with no button to press they are the next
 * step and stay in view.
 */
export function RunActions({
  run,
  act,
  lead = false,
  initialAsking,
}: {
  run: ActionTarget
  act: Act
  lead?: boolean
  /**
   * Start with this action asking, or with the notes form open for
   * `spec-revise`, for the design page.
   */
  initialAsking?: ActionName
}) {
  const { asking, setAsking, ask } = useAsking(initialAsking)
  const offer = offered(run)
  const can = only(offer, asking)
  const send = (action: ActionName, label: string, body?: object) =>
    act({ runId: run.id, name: run.name, action, label, body })
  // Awaited, so the button shows it is at work until the answer comes.
  const press: Press = (action, label, body) => async () => {
    await send(action, label, body)
  }
  const first: ActionLook = lead ? 'primary' : 'default'
  const any = Object.values(offer).some((v) => typeof v === 'string')
  // An archived run offers only its way back; any other shows every next
  // command, with the archive command after them.
  const commands = offer.unarchive
    ? [offer.unarchive]
    : [...run.diagnosis.next, ...(offer.archive ? [offer.archive] : [])]
  const revising = asking === 'spec-revise'
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-start gap-2 empty:hidden">
        {can.revise ? (
          <button
            type="button"
            aria-expanded={revising}
            onClick={() => setAsking(revising ? null : 'spec-revise')}
            className={lead ? BUTTON_PRIMARY : BUTTON}
          >
            {ACTION.specRevise}
          </button>
        ) : null}
        <DecisionButtons
          run={run}
          can={can}
          first={first}
          press={press}
          ask={ask}
        />
        <StopButtons can={can} first={first} press={press} ask={ask} />
      </div>
      {revising && can.revise ? (
        <SpecReviseForm
          command={can.revise}
          focus={initialAsking !== 'spec-revise'}
          onCancel={() => setAsking(null)}
          onSend={async (notes) => {
            if (await send('spec-revise', ACTION.specRevise, { notes }))
              setAsking(null)
          }}
        />
      ) : null}
      {asking === null ? (
        <Commands
          lines={commands}
          summary={any ? ACTION.sameCommand : undefined}
        />
      ) : null}
    </div>
  )
}
