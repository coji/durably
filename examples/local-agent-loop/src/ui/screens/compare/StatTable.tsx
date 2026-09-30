import type { Stat } from '../../../engine/compare'
import { formatCount, UNKNOWN } from '../../../engine/format'
import { Td, Th } from '../../components/DataTable'
import { COLUMN, COMPARE } from '../../glossary'

export type Formatter = (v: number | null) => string

export function StatRow({
  label,
  stat,
  f,
}: {
  label: string
  stat: Stat
  f: Formatter
}) {
  return (
    <tr>
      <Td>{label}</Td>
      <Td num>{f(stat.median)}</Td>
      <Td num>{f(stat.min)}</Td>
      <Td num>{f(stat.max)}</Td>
      <Td num>{formatCount(stat.n)}</Td>
      <Td num>{formatCount(stat.unknown)}</Td>
    </tr>
  )
}

export const STAT_HEAD = (
  <>
    <Th>{COLUMN.metric}</Th>
    <Th num>{COLUMN.median}</Th>
    <Th num>{COLUMN.min}</Th>
    <Th num>{COLUMN.max}</Th>
    <Th num>{COLUMN.runs}</Th>
    <Th num>{COLUMN.unknown}</Th>
  </>
)

/** `median [min–max]` in one cell; unknown when no run knew the value. */
export function statRange(stat: Stat, f: Formatter): string {
  return stat.median === null
    ? UNKNOWN
    : `${f(stat.median)} [${f(stat.min)}–${f(stat.max)}]`
}

/**
 * A median with how many runs or tasks did not know the value, under it: a
 * median over fewer than the row counts says so. A task's value is unknown
 * when any of its runs' is.
 */
export function MedianCell({ stat, f }: { stat: Stat; f: Formatter }) {
  return (
    <span className="flex flex-col items-end">
      <span className={stat.median === null ? 'text-fg-3' : undefined}>
        {f(stat.median)}
      </span>
      {stat.unknown > 0 ? (
        <span className="text-fg-2 text-xs">
          {COMPARE.unknownCount(formatCount(stat.unknown))}
        </span>
      ) : null}
    </span>
  )
}

/**
 * One number of a summary, its note beside it on the same line, so four
 * fit a short block. An unknown value is quieter than a known one.
 */
export function Figure({
  label,
  value,
  note,
}: {
  label: string
  value: string
  note: string
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 px-4 py-2">
      <dt className="text-fg-2 text-xs">{label}</dt>
      <dd className="flex flex-wrap items-baseline gap-x-2">
        <span
          className={`font-code text-xl leading-tight font-semibold ${value === UNKNOWN ? 'text-fg-3' : 'text-fg'}`}
        >
          {value}
        </span>
        <span className="text-fg-2 text-xs">{note}</span>
      </dd>
    </div>
  )
}
