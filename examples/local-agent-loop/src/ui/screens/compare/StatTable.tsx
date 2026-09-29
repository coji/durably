import type { Stat } from '../../../engine/compare'
import { UNKNOWN } from '../../../engine/format'
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
      <Td num>{stat.n}</Td>
      <Td num>{stat.unknown}</Td>
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

/** A calibration median with how many runs did not know the value. */
export function CalibrationStat({ stat, f }: { stat: Stat; f: Formatter }) {
  return (
    <span className="flex flex-col items-end">
      <span>{f(stat.median)}</span>
      {stat.unknown > 0 ? (
        <span className="text-fg-2 text-xs">
          {COMPARE.unknownCount(stat.unknown)}
        </span>
      ) : null}
    </span>
  )
}
