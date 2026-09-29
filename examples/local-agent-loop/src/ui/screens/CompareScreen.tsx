import type { Stat, TrendCell } from '../../engine/compare'
import {
  formatCost,
  formatCount,
  formatDuration,
  formatPercent,
  formatWeek,
} from '../../engine/format'
import { DataTable, Td, Th } from '../components/DataTable'
import { EmptyState } from '../components/EmptyState'
import { Panel } from '../components/Layout'
import { COMMON, COMPARE, TREND } from '../glossary'
import type { CompareResponse, TrendResponse } from '../server'
import { GroupPanel } from './compare/GroupPanel'
import { MedianCell, type Formatter } from './compare/StatTable'

export type CompareView = 'trend' | 'config'

/** The two ways to read the finished runs, as a pair of pressed buttons. */
function ViewSwitch({
  view,
  onView,
}: {
  view: CompareView
  onView: (view: CompareView) => void
}) {
  const option = (value: CompareView, label: string) => (
    <button
      type="button"
      aria-pressed={view === value}
      onClick={() => onView(value)}
      className={`inline-flex min-h-8 items-center rounded-sm px-3 text-sm ${view === value ? 'bg-raised text-fg border-line-strong border font-medium' : 'text-fg-2 hover:text-fg border border-transparent'}`}
    >
      {label}
    </button>
  )
  return (
    <div
      role="group"
      aria-label={COMPARE.view}
      className="bg-sunken inline-flex self-start rounded-md p-1"
    >
      {option('trend', COMPARE.trendTab)}
      {option('config', COMPARE.configTab)}
    </div>
  )
}

/** A week's or the window's numbers; a row without runs says so once. */
function TrendRow({
  label,
  cell,
  max,
  strong,
}: {
  label: string
  cell: TrendCell
  /** The longest weekly median lead time in the group, for the bar. */
  max: number
  strong?: boolean
}) {
  const empty = cell.runs === 0
  const dash = <span className="text-fg-3">{TREND.noRuns}</span>
  const median = (stat: Stat, f: Formatter) =>
    empty ? dash : <MedianCell stat={stat} f={f} />
  const lead = cell.leadTimeMs.median
  return (
    <tr className={strong ? 'font-medium' : undefined}>
      <Td>{label}</Td>
      <Td num>{formatCount(cell.runs)}</Td>
      <Td num>{empty ? dash : formatPercent(cell.approvalRate)}</Td>
      <Td num>
        {median(cell.leadTimeMs, formatDuration)}
        {!empty && lead !== null && !strong ? (
          <span aria-hidden className="bg-sunken mt-1 block h-1 rounded-sm">
            <span
              className="bg-fg-3/60 ml-auto block h-full rounded-sm"
              style={{ width: `${(lead / max) * 100}%` }}
            />
          </span>
        ) : null}
      </Td>
      <Td num>{median(cell.costUsd, formatCost)}</Td>
      <Td num>{median(cell.repairs, formatCount)}</Td>
    </tr>
  )
}

function TrendGroupPanel({
  group: g,
  days,
}: {
  group: TrendResponse['groups'][number]
  days: number
}) {
  const max = Math.max(1, ...g.weeks.map((w) => w.leadTimeMs.median ?? 0))
  return (
    <Panel
      title={`${g.model ?? COMMON.defaultSetting}${COMMON.separator}${g.effort ?? COMMON.defaultSetting}`}
    >
      <p className="text-fg-2 -mt-2 mb-2 text-xs">
        {TREND.groupRuns(
          formatCount(g.total.runs),
          formatPercent(g.total.approvalRate),
        )}
      </p>
      <DataTable
        head={
          <>
            <Th>{TREND.week}</Th>
            <Th num>{TREND.runs}</Th>
            <Th num>{TREND.approvalRate}</Th>
            <Th num>{TREND.leadTime}</Th>
            <Th num title={COMMON.costNote}>
              {TREND.cost}
            </Th>
            <Th num>{TREND.repairs}</Th>
          </>
        }
      >
        {g.weeks.map((w) => (
          <TrendRow
            key={w.week}
            label={formatWeek(w.week)}
            cell={w}
            max={max}
          />
        ))}
        <TrendRow label={TREND.total(days)} cell={g.total} max={max} strong />
      </DataTable>
    </Panel>
  )
}

/**
 * Whether the factory gets better: the finished runs of the last 30 days,
 * week by week, one panel per model and effort the code stage ran on.
 */
export function TrendScreen({
  data,
  onView,
}: {
  data: TrendResponse
  onView: (view: CompareView) => void
}) {
  return (
    <div className="flex flex-col gap-4">
      <ViewSwitch view="trend" onView={onView} />
      {data.groups.length === 0 ? (
        <EmptyState>{TREND.empty(data.days)}</EmptyState>
      ) : (
        <>
          <div className="text-fg-2 flex flex-col gap-1 text-sm">
            <p>
              {TREND.intro(data.days, data.runIds.length)}
              {data.includeFake ? '' : TREND.fakeLeftOut(data.fakeExcluded)}
            </p>
            <p className="text-xs">{TREND.note}</p>
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            {data.groups.map((g) => (
              <TrendGroupPanel
                key={`${g.model}|${g.effort}`}
                group={g}
                days={data.days}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}

/** Finished runs by config group, each group closed to its outcome line. */
export function CompareScreen({
  data,
  onView,
}: {
  data: CompareResponse
  onView: (view: CompareView) => void
}) {
  const groups = data.comparison.groups
  return (
    <div className="flex flex-col gap-4">
      <ViewSwitch view="config" onView={onView} />
      {groups.length === 0 ? (
        <EmptyState>{COMPARE.empty}</EmptyState>
      ) : (
        <>
          <p className="text-fg-2 text-sm">
            {COMPARE.intro(data.runIds.length)}
          </p>
          <div className="flex flex-col gap-2">
            {groups.map((g) => (
              <GroupPanel
                key={`${g.kind}|${g.configVersion ?? g.label}`}
                group={g}
              />
            ))}
          </div>
        </>
      )}
    </div>
  )
}
