import { useId, useState, type ReactNode } from 'react'

import {
  formatCost,
  formatCount,
  formatDuration,
  UNKNOWN,
} from '../../engine/format'
import type { DiagnosisKind, TaskRun } from '../../engine/status'
import { TERMINAL_STATUSES } from '../../engine/terminal'
import { COMMON, LIST } from '../glossary'
import { Chevron } from './Layout'
import { conclusionStatus, kindStatus, type Status } from './status'
import { StatusBadge } from './StatusBadge'
import { Ago } from './Time'

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
 * Whether a row shows its body: as a person last set it, or else as the
 * list wants it now.
 */
export function openNow(toggled: boolean | null, wanted: boolean): boolean {
  return toggled ?? wanted
}

/**
 * One task in a list: its state, its name as a link to the run that shows
 * it, and its facts in aligned columns. A summary line,
 * such as why it stopped, stays under the name while closed, cut to one
 * line, and shows whole when open. The chevron opens what is below: the
 * next step and every run the task took. The name leads; the ID is a quiet
 * suffix, and marks such as アーカイブ済み sit beside it.
 */
export function TaskRow({
  status,
  name,
  href,
  marks,
  meta,
  summary,
  toggleLabel,
  defaultOpen,
  children,
}: {
  status: Status
  name: string
  /** Where the name leads; the row is plain text without one. */
  href?: string
  /** Quiet words beside the name, such as アーカイブ済み. */
  marks?: ReactNode
  /** The facts at the end of the line, from `TaskMeta`. */
  meta?: ReactNode
  /** One line under the name: why it stopped, or where it is now. */
  summary?: ReactNode
  /** What the chevron button says to a screen reader. */
  toggleLabel: string
  defaultOpen?: boolean
  children: ReactNode
}) {
  // Only a person's own toggle is held; until then the row follows
  // `defaultOpen` on every render, so the list can open or close it later.
  const [toggled, setToggled] = useState<boolean | null>(null)
  const open = openNow(toggled, defaultOpen ?? false)
  const bodyId = useId()
  return (
    <li className="task-row py-2 pr-4 pl-2">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        aria-label={toggleLabel}
        onClick={() => setToggled(!open)}
        className="hover:bg-sunken inline-flex size-8 shrink-0 items-center justify-center rounded-md"
      >
        <Chevron open={open} />
      </button>
      <div className="flex min-h-8 min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
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
          {marks ? (
            <span className="inline-flex shrink-0 items-baseline gap-2 whitespace-nowrap">
              {marks}
            </span>
          ) : null}
        </span>
        {meta}
      </div>
      {summary && open ? (
        <div className="text-fg-2 col-start-2 min-w-0 text-sm">{summary}</div>
      ) : null}
      <div
        id={bodyId}
        hidden={!open}
        className="col-start-2 flex min-w-0 flex-col gap-3 pt-2 pb-2"
      >
        {/* Drawn only when open: most rows of a long list stay closed. */}
        {open ? children : null}
      </div>
    </li>
  )
}

/** A duration or a cost: quieter when it is not known. */
function MetaValue({ value, title }: { value: string; title?: string }) {
  return (
    <span
      title={title}
      className={`font-code ${value === UNKNOWN ? 'text-fg-3' : ''}`}
    >
      {value}
    </span>
  )
}

/**
 * A row's facts in fixed columns, so the numbers of every row line up: how
 * many runs, the time and the cost, and when. With more than one run the
 * time and cost are the task's total, as their hover says; a run's own row
 * leaves the count column empty.
 */
export function TaskMeta({
  runs,
  leadTimeMs,
  costUsd,
  at,
  now,
}: {
  /** The task's run count; the time and cost are its total above 1. */
  runs?: number
  /** Left blank when undefined: an open run has none settled yet. */
  leadTimeMs?: number | null
  costUsd?: number | null
  at: string
  now: string
}) {
  const several = runs !== undefined && runs > 1
  const total = several ? LIST.totalTitle : undefined
  return (
    <span className="task-meta text-fg-2 basis-full text-xs tabular-nums md:basis-auto">
      <span>{several ? LIST.runs(formatCount(runs)) : null}</span>
      {several ? <span className="sr-only">{LIST.total}</span> : null}
      {leadTimeMs === undefined ? (
        <span />
      ) : (
        <MetaValue value={formatDuration(leadTimeMs)} title={total} />
      )}
      {costUsd === undefined ? (
        <span />
      ) : (
        <MetaValue
          value={formatCost(costUsd)}
          title={total ? `${total}\n${COMMON.costNote}` : COMMON.costNote}
        />
      )}
      <Ago iso={at} now={now} />
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
