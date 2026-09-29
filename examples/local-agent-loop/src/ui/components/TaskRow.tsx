import { useId, useState, type ReactNode } from 'react'

import type { DiagnosisKind } from '../../engine/status'
import { TERMINAL_STATUSES } from '../../engine/terminal'
import { Chevron } from './Layout'
import { IdSuffix } from './RunLink'
import { conclusionStatus, kindStatus, type Status } from './status'
import { StatusBadge } from './StatusBadge'

/**
 * One state per run, never a state and a result side by side: an open run
 * by where it stands, a finished one by how it ended. A finished run that
 * stopped for a person reads as failed; one a later repair made moot does
 * not ask for attention.
 */
export function runState(run: {
  status: string
  kind: DiagnosisKind
  conclusion: string | null
  superseded?: boolean
}): Status {
  if (!TERMINAL_STATUSES.includes(run.status)) return kindStatus(run.kind)
  const ended = conclusionStatus(run.conclusion ?? run.status)
  if (run.superseded) return { ...ended, tone: 'done' }
  return run.kind === 'stopped' ? { ...ended, tone: 'failed' } : ended
}

/**
 * One task in a list: its state, its name as a link to the run that shows
 * it, and a few facts on one line. The chevron opens what is below: the
 * reason, the next step, and every run the task took. The name leads; the
 * ID is a quiet suffix.
 */
export function TaskRow({
  status,
  name,
  href,
  id,
  meta,
  toggleLabel,
  defaultOpen,
  children,
}: {
  status: Status
  name: string
  /** Where the name leads; the row is plain text without one. */
  href?: string
  id: string
  /** Short facts at the end of the line, such as when and how much. */
  meta?: ReactNode
  /** What the chevron button says to a screen reader. */
  toggleLabel: string
  defaultOpen?: boolean
  children: ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen ?? false)
  const bodyId = useId()
  return (
    <li>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 pr-4 pl-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          aria-label={toggleLabel}
          onClick={() => setOpen((o) => !o)}
          className="hover:bg-sunken inline-flex size-8 shrink-0 items-center justify-center rounded-md"
        >
          <Chevron open={open} />
        </button>
        <StatusBadge label={status.label} tone={status.tone} />
        <span className="flex min-w-0 flex-1 basis-48 items-baseline gap-2">
          {href ? (
            <a
              href={href}
              className="text-fg decoration-line-strong min-w-0 truncate text-sm font-medium hover:underline hover:underline-offset-2"
            >
              {name}
            </a>
          ) : (
            <span className="min-w-0 truncate text-sm font-medium">{name}</span>
          )}
          <span className="shrink-0 whitespace-nowrap">
            <IdSuffix id={id} />
          </span>
        </span>
        {meta ? (
          <span className="text-fg-2 ml-auto flex flex-wrap items-center gap-x-3 text-xs tabular-nums">
            {meta}
          </span>
        ) : null}
      </div>
      <div
        id={bodyId}
        hidden={!open}
        className="flex flex-col gap-3 pr-4 pb-4 pl-12"
      >
        {children}
      </div>
    </li>
  )
}

/** Task rows as one list, a hairline between each. */
export function TaskList({ children }: { children: ReactNode }) {
  return (
    <ul className="divide-line border-line bg-raised divide-y rounded-lg border">
      {children}
    </ul>
  )
}
