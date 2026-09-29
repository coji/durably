import { useState } from 'react'

import { ActionButton } from '../../components/ActionButton'
import { Commands } from '../../components/Commands'
import { CopyButton, useCopy } from '../../components/copy'
import { EmptyState } from '../../components/EmptyState'
import { Notice } from '../../components/Notice'
import { kindStatus, TONES } from '../../components/status'
import { StatusBadge } from '../../components/StatusBadge'
import { COPY, DESIGN, KIND_NAME, REFRESH } from '../../glossary'
import { commandText } from '../../labels'
import { COMMANDS, TASKS } from './fixtures'
import { State } from './Specimen'

const KINDS = Object.keys(KIND_NAME) as (keyof typeof KIND_NAME)[]

export function BadgeStates() {
  return (
    <div className="flex flex-wrap gap-2">
      {KINDS.map((kind) => {
        const s = kindStatus(kind)
        return <StatusBadge key={kind} label={s.label} tone={s.tone} />
      })}
    </div>
  )
}

/**
 * Actions that only say they did nothing: the design page never writes. A
 * confirmed action shows its question and command, then the same notice.
 */
export function ActionStates() {
  const [pressed, setPressed] = useState(false)
  const done = () => setPressed(true)
  const approve = commandText(COMMANDS[0] as string)
  const retrigger = commandText(COMMANDS[2] as string)
  return (
    <>
      <State label={DESIGN.state.plain}>
        <div className="flex flex-wrap gap-2">
          <ActionButton label={DESIGN.sample.refresh} onAction={done} />
        </div>
      </State>
      <State label={DESIGN.state.confirm}>
        <div className="flex flex-wrap gap-2">
          <ActionButton
            label={DESIGN.sample.approve}
            onAction={done}
            confirm={{ command: approve }}
          />
          <ActionButton
            label={DESIGN.sample.reject}
            onAction={done}
            confirm={{ command: approve.replace(' approve ', ' reject ') }}
          />
        </div>
      </State>
      <State label={DESIGN.state.confirming}>
        <ActionButton
          label={DESIGN.sample.retrigger}
          onAction={done}
          confirm={{ command: retrigger }}
          initialStage="confirming"
        />
      </State>
      <State label={DESIGN.state.busy}>
        <div className="flex flex-wrap gap-2">
          <ActionButton
            label={DESIGN.sample.refresh}
            onAction={done}
            initialStage="busy"
          />
        </div>
      </State>
      <State label={DESIGN.state.disabled}>
        <div className="flex flex-wrap gap-2">
          <ActionButton
            label={DESIGN.sample.approve}
            onAction={done}
            disabled
          />
        </div>
      </State>
      {pressed ? <Notice title={DESIGN.sample.done} /> : null}
    </>
  )
}

export function CopyStates() {
  const { copied, copy } = useCopy()
  const id = TASKS[0].id
  return (
    <>
      <State label={DESIGN.state.idle}>
        <div className="flex flex-wrap gap-2">
          <CopyButton
            text={id}
            label={COPY.runId}
            copied={copied}
            onCopy={copy}
          />
        </div>
      </State>
      <State label={DESIGN.state.copied}>
        <div className="flex flex-wrap gap-2 pb-8">
          <CopyButton
            text={id}
            label={COPY.runId}
            copied={{ text: id }}
            onCopy={copy}
          />
        </div>
      </State>
      <State label={DESIGN.state.commands}>
        <Commands lines={COMMANDS} />
      </State>
    </>
  )
}

export function EmptyStates() {
  return (
    <>
      <State label={DESIGN.state.empty}>
        <EmptyState>{DESIGN.sample.empty}</EmptyState>
      </State>
      <State label={DESIGN.state.loading}>
        <EmptyState kind="loading">{REFRESH.loading}</EmptyState>
      </State>
      <State label={DESIGN.state.error}>
        <EmptyState kind="error">{REFRESH.loadFailed('HTTP 500')}</EmptyState>
      </State>
    </>
  )
}

export function NoticeStates() {
  return (
    <div className="flex flex-col gap-2">
      {TONES.map((tone) => (
        <Notice
          key={tone}
          tone={tone}
          title={
            tone === 'waiting'
              ? DESIGN.sample.waitingTitle
              : tone === 'failed'
                ? REFRESH.failed
                : tone === 'running'
                  ? DESIGN.sample.runningTitle
                  : DESIGN.sample.doneTitle
          }
        >
          {tone === 'waiting'
            ? DESIGN.sample.waitingBody
            : tone === 'failed'
              ? REFRESH.staleAt('09:24:00')
              : null}
        </Notice>
      ))}
    </div>
  )
}
