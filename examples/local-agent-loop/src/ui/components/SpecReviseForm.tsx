import { useId, useState, type KeyboardEvent } from 'react'

import { ACTION, COMMAND_COPY } from '../glossary'
import { BUTTON, BUTTON_PRIMARY } from './button'
import { CopyAnnouncer, CopyButton, useCopy } from './copy'

/**
 * The notes a blocked spec is fixed with, typed here instead of in a file.
 * Escape or the other answer backs out; blank notes cannot be sent.
 */
export function SpecReviseForm({
  command,
  onSend,
  onCancel,
  focus = true,
}: {
  command: string
  onSend: (notes: string) => Promise<void>
  onCancel: () => void
  /** Take focus when opened; not on the design page, where it starts open. */
  focus?: boolean
}) {
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const id = useId()
  const { copied, copy } = useCopy()
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return
    e.preventDefault()
    onCancel()
  }
  return (
    <form
      onKeyDown={onKeyDown}
      onSubmit={(e) => {
        e.preventDefault()
        setBusy(true)
        void onSend(notes).finally(() => setBusy(false))
      }}
      className="border-line-strong bg-raised flex min-w-0 flex-col gap-2 rounded-md border p-3"
    >
      <label htmlFor={id} className="text-sm font-medium">
        {ACTION.notesLabel}
      </label>
      <textarea
        id={id}
        autoFocus={focus}
        rows={5}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        className="border-line-strong bg-canvas rounded-sm border px-2 py-1 text-sm"
      />
      <div className="flex flex-col gap-1">
        <span className="text-fg-2 text-xs">{ACTION.notesHint}</span>
        <div className="flex items-center gap-2">
          <code className="bg-sunken font-code block min-w-0 flex-1 overflow-x-auto rounded-sm px-2 py-1 text-xs whitespace-pre">
            {command}
          </code>
          <CopyButton
            text={command}
            label={COMMAND_COPY.other}
            copied={copied}
            onCopy={copy}
          />
          <CopyAnnouncer copied={copied} />
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="submit"
          disabled={busy || notes.trim() === ''}
          className={BUTTON_PRIMARY}
        >
          {busy ? ACTION.busy : ACTION.notesSubmit}
        </button>
        <button type="button" onClick={onCancel} className={BUTTON}>
          {ACTION.cancel}
        </button>
      </div>
    </form>
  )
}
