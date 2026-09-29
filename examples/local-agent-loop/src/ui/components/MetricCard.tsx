import type { ReactNode } from 'react'

import { UNKNOWN } from '../../engine/format'
import { PartialTag } from './KeyValue'

/**
 * One number worth a glance: its name, the value already formatted, and a
 * line under it. An unknown value is quieter than a known one, so a row of
 * cards never reads `不明` as a result.
 */
export function MetricCard({
  label,
  value,
  partial,
  note,
}: {
  label: string
  value: string
  /** Hover text for a value that covers only part of what it counts. */
  partial?: string
  note?: ReactNode
}) {
  return (
    <div className="border-line bg-raised flex min-w-0 flex-col gap-1 rounded-lg border px-4 py-3">
      <dt className="text-fg-2 text-xs">{label}</dt>
      <dd
        className={`font-code text-xl leading-tight font-semibold whitespace-nowrap ${value === UNKNOWN ? 'text-fg-3' : 'text-fg'}`}
      >
        {value}
        {partial ? <PartialTag title={partial} /> : null}
      </dd>
      {note ? <dd className="text-fg-2 text-xs">{note}</dd> : null}
    </div>
  )
}

/** Metric cards side by side, wrapping on a narrow screen. */
export function MetricGrid({ children }: { children: ReactNode }) {
  return <dl className="metric-grid">{children}</dl>
}
