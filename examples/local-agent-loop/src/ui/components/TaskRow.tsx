import type { ReactNode } from 'react'

import { Chevron } from './Layout'
import { IdSuffix } from './RunLink'
import type { Status } from './status'
import { StatusBadge } from './StatusBadge'

/**
 * One task in a list: its state, its name and a few facts on one line,
 * opening to what happened. The name leads; the ID is a quiet suffix.
 */
export function TaskRow({
  status,
  name,
  id,
  meta,
  defaultOpen,
  children,
}: {
  status: Status
  name: string
  id: string
  /** Short facts at the end of the line, such as when and how much. */
  meta?: ReactNode
  defaultOpen?: boolean
  children: ReactNode
}) {
  return (
    <li>
      <details open={defaultOpen} className="group">
        <summary className="hover:bg-sunken/60 flex min-h-8 cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 [&::-webkit-details-marker]:hidden">
          <Chevron />
          <StatusBadge label={status.label} tone={status.tone} />
          <span className="flex min-w-0 items-baseline gap-2">
            <span className="truncate text-sm font-medium">{name}</span>
            <IdSuffix id={id} />
          </span>
          {meta ? (
            <span className="text-fg-2 ml-auto flex items-center gap-3 text-xs">
              {meta}
            </span>
          ) : null}
        </summary>
        <div className="flex flex-col gap-2 px-4 pb-4 pl-8">{children}</div>
      </details>
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
