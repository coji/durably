import { useEffect, useState } from 'react'

import type { ReviewHighlights } from '../../engine/report'
import { ACTION } from '../glossary'
import { ActionButton, type ActionLook, type ActionStage } from './ActionButton'
import type { Act, ActionName } from './ActionNotice'
import { BUTTON, BUTTON_PRIMARY } from './button'
import { Commands } from './Commands'
import {
  commandLines,
  lineOf,
  offered,
  only,
  type ActionTarget,
  type Offered,
} from './offered'
import { ReviewHighlightsBody } from './ReviewHighlights'
import { SpecReviseForm } from './SpecReviseForm'

export type { ActionTarget }

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
 * Which action of the row is asking, and the hooks its button reports to;
 * `onChange` hears it too, so a list can set its other rows' actions aside.
 * `offerOf` names what the run offers for an action now: once a poll shows
 * the asked action gone or on another wait, decided elsewhere, the question
 * closes and the refreshed next steps show.
 */
function useAsking(
  initial: ActionName | undefined,
  offerOf: (name: ActionName) => string | null,
  onChange?: (name: ActionName | null) => void,
) {
  const [asked, setAsked] = useState(() =>
    initial ? { name: initial, offer: offerOf(initial) } : null,
  )
  const setAsking = (name: ActionName | null) => {
    setAsked(name ? { name, offer: offerOf(name) } : null)
    onChange?.(name)
  }
  const gone = asked !== null && offerOf(asked.name) !== asked.offer
  useEffect(() => {
    if (gone) setAsking(null)
  })
  const ask: Ask = (name) => ({
    initialStage: initial === name ? 'confirming' : 'idle',
    onStageChange: (stage) => setAsking(stage === 'idle' ? null : name),
  })
  return { asking: gone ? null : (asked?.name ?? null), setAsking, ask }
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
          key={`approve-${waitId}`}
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
          key={`reject-${waitId}`}
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
  back,
  press,
  ask,
}: {
  can: Offered
  first: ActionLook
  /** How the way back from an archive looks. */
  back: ActionLook
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
          confirm={{ command: can.retrigger, details: ACTION.retriggerNote }}
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
          look={back}
          onAction={press('unarchive', ACTION.unarchive)}
          {...ask('unarchive')}
        />
      ) : null}
    </>
  )
}

/**
 * How the row's actions look: the first in ink where it leads, all quiet
 * and beside their commands in a task's list of runs.
 */
function looks(
  lead: boolean,
  compact: boolean,
): { first: ActionLook; back: ActionLook; frame: string } {
  if (compact)
    return {
      first: 'quiet',
      back: 'quiet',
      frame: 'flex flex-wrap items-start gap-x-3 gap-y-1',
    }
  return {
    first: lead ? 'primary' : 'default',
    back: 'default',
    frame: 'flex flex-col gap-2',
  }
}

/**
 * What a person can do to this run from the page, each through the same
 * function as its CLI command: decide an approval or a blocked spec, run a
 * safe stop again, or archive a stop. `lead` sets the first action in ink,
 * for the one screen it leads; reject and archive stay quiet. Approve,
 * reject, retrigger and archive ask first; spec revision takes notes first.
 * While one action asks, works, or takes notes, the others step aside. The
 * CLI commands, the report and status ones among them, wait in one closed
 * disclosure below the buttons; with no button to press they are the next
 * step and stay in view. `compact`, for a run in a task's list of runs, sets
 * the buttons quiet and the disclosure beside them.
 */
export function RunActions({
  run,
  act,
  lead = false,
  compact = false,
  initialAsking,
  onAsking,
}: {
  run: ActionTarget
  act: Act
  lead?: boolean
  compact?: boolean
  /**
   * Start with this action asking, or with the notes form open for
   * `spec-revise`, for the design page.
   */
  initialAsking?: ActionName
  /** Hears which action asks, works, or takes notes, and null after. */
  onAsking?: (name: ActionName | null) => void
}) {
  const offer = offered(run)
  const { asking, setAsking, ask } = useAsking(
    initialAsking,
    (name) => `${lineOf(offer, name) ?? ''} ${run.waitId ?? ''}`,
    onAsking,
  )
  const can = only(offer, asking)
  const send = (action: ActionName, label: string, body?: object) =>
    act({ runId: run.id, name: run.name, action, label, body })
  // Awaited, so the button shows it is at work until the answer comes.
  const press: Press = (action, label, body) => async () => {
    await send(action, label, body)
  }
  const look = looks(lead, compact)
  const any = Object.values(offer).some((v) => typeof v === 'string')
  const revising = asking === 'spec-revise'
  return (
    <div className={look.frame}>
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
          first={look.first}
          press={press}
          ask={ask}
        />
        <StopButtons
          can={can}
          first={look.first}
          back={look.back}
          press={press}
          ask={ask}
        />
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
          lines={commandLines(run, offer)}
          summary={any ? ACTION.sameCommand : undefined}
        />
      ) : null}
    </div>
  )
}
