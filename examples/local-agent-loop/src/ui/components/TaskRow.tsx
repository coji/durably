import { useId, useState, type ReactNode } from 'react'

import { formatCost, formatDuration } from '../../engine/format'
import type { DiagnosisKind, TaskRun } from '../../engine/status'
import { TERMINAL_STATUSES } from '../../engine/terminal'
import { COMMON, LIST } from '../glossary'
import { Chevron } from './Layout'
import { IdSuffix } from './RunLink'
import { conclusionStatus, kindStatus, type Status } from './status'
import { StatusBadge } from './StatusBadge'

/**
 * One state per run, never a state and a result side by side: an open run
 * by where it stands, a finished one by how it ended. A finished run that
 * stopped for a person reads as failed; one a later repair made moot, or
 * one a person archived, does not ask for attention.
 */
export function runState(run: {
  status: string
  kind: DiagnosisKind
  conclusion: string | null
  superseded?: boolean
  archived?: boolean
}): Status {
  if (!TERMINAL_STATUSES.includes(run.status)) return kindStatus(run.kind)
  const ended = conclusionStatus(run.conclusion ?? run.status)
  if (run.superseded || run.archived) return { ...ended, tone: 'done' }
  return run.kind === 'stopped' ? { ...ended, tone: 'failed' } : ended
}

/** A run by its place in its task: the first run, or which repair. */
export function runRole(run: Pick<TaskRun, 'repair'>): string {
  return run.repair === null ? LIST.firstRun : LIST.repairRun(run.repair)
}

/**
 * One task in a list: its state, its name as a link to the run that shows
 * it, and a few facts on one line; below the md width the name takes up to
 * two lines and the facts a line of their own. The chevron opens what is below: the
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
              className="text-fg decoration-line-strong line-clamp-2 min-w-0 text-sm font-medium hover:underline hover:underline-offset-2 md:block md:truncate"
            >
              {name}
            </a>
          ) : (
            <span className="line-clamp-2 min-w-0 text-sm font-medium md:block md:truncate">
              {name}
            </span>
          )}
          <span className="shrink-0 whitespace-nowrap">
            <IdSuffix id={id} />
          </span>
        </span>
        {meta ? (
          <span className="text-fg-2 flex basis-full flex-wrap items-center gap-x-3 pl-11 text-xs tabular-nums md:ml-auto md:basis-auto md:pl-0">
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

/**
 * A task's time and cost, over every run it took; labelled as a total when
 * it took more than one.
 */
export function TaskTotal({
  total,
  several,
}: {
  total: { leadTimeMs: number | null; costUsd: number | null }
  several: boolean
}) {
  return (
    <span className="inline-flex items-baseline gap-2">
      {several ? <span title={LIST.totalTitle}>{LIST.total}</span> : null}
      <span className="font-code">{formatDuration(total.leadTimeMs)}</span>
      <span className="font-code" title={COMMON.costNote}>
        {formatCost(total.costUsd)}
      </span>
    </span>
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
