import {
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'

import { ACTION, COMMAND_COPY } from '../glossary'
import { BUTTON, BUTTON_PRIMARY, BUTTON_QUIET } from './button'
import { CopyAnnouncer, CopyButton, useCopy } from './copy'

export type ActionStage = 'idle' | 'confirming' | 'busy'

/** The one action a screen leads with, the rest, and what takes away. */
export type ActionLook = 'primary' | 'default' | 'quiet'

const LOOK: Record<ActionLook, string> = {
  primary: BUTTON_PRIMARY,
  default: BUTTON,
  quiet: BUTTON_QUIET,
}

/**
 * An action on a run. With `confirm`, the first press only asks: the
 * question, the CLI command that does the same thing with its copy button,
 * and two answers. The action runs on the second press; Escape or the other
 * answer backs out. In a wrapping row of buttons the question takes a line
 * of its own. `onStageChange` tells the row, so it can set its other
 * actions aside while this one asks or works. `initialStage` starts the
 * button in a given stage, for the design page.
 */
export function ActionButton({
  label,
  onAction,
  confirm,
  look = 'default',
  disabled,
  initialStage = 'idle',
  onStageChange,
}: {
  label: string
  onAction: () => void | Promise<void>
  /**
   * Ask first, and show the CLI line that does the same; `details` says
   * what the action will do.
   */
  confirm?: { command: string; details?: ReactNode }
  look?: ActionLook
  disabled?: boolean
  initialStage?: ActionStage
  onStageChange?: (stage: ActionStage) => void
}) {
  const [stage, setStageState] = useState<ActionStage>(initialStage)
  const setStage = (next: ActionStage) => {
    setStageState(next)
    onStageChange?.(next)
  }
  // Set by a press, so a button shown already asking takes no focus; set by
  // backing out, so the button comes back with focus.
  const asked = useRef(false)
  const returning = useRef(false)
  const questionId = useId()
  const { copied, copy } = useCopy()

  const run = async () => {
    setStage('busy')
    try {
      await onAction()
    } finally {
      setStage('idle')
    }
  }
  const backOut = () => {
    returning.current = true
    setStage('idle')
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    backOut()
  }

  if (stage === 'confirming' && confirm)
    return (
      <div
        role="group"
        aria-labelledby={questionId}
        onKeyDown={onKeyDown}
        className="border-line-strong bg-raised flex min-w-0 basis-full flex-col gap-2 rounded-md border p-3"
      >
        <p id={questionId} className="text-sm font-medium">
          {ACTION.confirm(label)}
        </p>
        {confirm.details ? (
          <div className="text-fg-2 text-sm">{confirm.details}</div>
        ) : null}
        <div className="flex items-center gap-2">
          <code className="bg-sunken font-code block min-w-0 flex-1 overflow-x-auto rounded-sm px-2 py-1 text-xs whitespace-pre">
            {confirm.command}
          </code>
          <CopyButton
            text={confirm.command}
            label={COMMAND_COPY.other}
            copied={copied}
            onCopy={copy}
          />
          <CopyAnnouncer copied={copied} />
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => void run()}
            className={BUTTON_PRIMARY}
          >
            {ACTION.proceed}
          </button>
          {/* The safe answer takes focus, so Enter never runs the action. */}
          <button
            ref={(el) => {
              if (!el || !asked.current) return
              asked.current = false
              el.focus()
            }}
            type="button"
            onClick={backOut}
            className={BUTTON}
          >
            {ACTION.cancel}
          </button>
        </div>
      </div>
    )

  return (
    <button
      ref={(el) => {
        if (!el || !returning.current) return
        returning.current = false
        el.focus()
      }}
      type="button"
      disabled={disabled || stage === 'busy'}
      aria-busy={stage === 'busy' || undefined}
      onClick={() => {
        if (!confirm) return void run()
        asked.current = true
        setStage('confirming')
      }}
      className={LOOK[look]}
    >
      {stage === 'busy' ? ACTION.busy : label}
    </button>
  )
}
