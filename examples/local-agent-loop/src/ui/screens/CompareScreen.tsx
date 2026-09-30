import type { Stat, TrendGroup, TrendWeek } from '../../engine/compare'
import {
  formatCost,
  formatCount,
  formatDuration,
  formatPercent,
  formatWeek,
} from '../../engine/format'
import { DataTable, Td, Th } from '../components/DataTable'
import { EmptyState } from '../components/EmptyState'
import { COMMON, COMPARE, TREND } from '../glossary'
import type { CompareResponse, TrendResponse } from '../server'
import { GroupPanel } from './compare/GroupPanel'
import { Figure, MedianCell, type Formatter } from './compare/StatTable'

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

/** What the view counts in one sentence; how it counts, on hover. */
function Intro({ text, rules }: { text: string; rules: string }) {
  return (
    <p className="text-fg-2 text-sm">
      {text}{' '}
      <span
        title={rules}
        className="decoration-line-strong cursor-help text-xs underline decoration-dotted underline-offset-2"
      >
        {COMPARE.rules}
      </span>
    </p>
  )
}

/** A rate with how many tasks it counts under it. */
function RateCell({ n, rate }: { n: number; rate: number | null }) {
  return (
    <span className="flex flex-col items-end">
      {formatPercent(rate)}
      <span className="text-fg-2 text-xs">{TREND.count(formatCount(n))}</span>
    </span>
  )
}

/**
 * One week's tasks; a week without tasks says so once, and a week of a
 * single task is marked, since its medians are that task's values.
 */
function TrendRow({ w, max }: { w: TrendWeek; max: number }) {
  const empty = w.tasks === 0
  const dash = <span className="text-fg-3">{TREND.noTasks}</span>
  const median = (stat: Stat, f: Formatter) =>
    empty ? dash : <MedianCell stat={stat} f={f} />
  const lead = w.leadTimeMs.median
  return (
    <tr>
      <Td>
        {formatWeek(w.week)}
        {w.tasks === 1 ? (
          <span
            title={TREND.singleTitle}
            className="text-fg-2 bg-sunken ml-2 rounded-sm px-1 text-xs whitespace-nowrap"
          >
            {TREND.single}
          </span>
        ) : null}
      </Td>
      <Td num>{formatCount(w.tasks)}</Td>
      <Td num>
        {empty ? (
          dash
        ) : (
          <RateCell n={w.firstPassApproved} rate={w.firstPassRate} />
        )}
      </Td>
      <Td num>
        {empty ? dash : <RateCell n={w.approved} rate={w.approvalRate} />}
      </Td>
      <Td num>
        {median(w.leadTimeMs, formatDuration)}
        {!empty && lead !== null ? (
          <span aria-hidden className="bg-sunken mt-1 block h-1 rounded-sm">
            <span
              className="bg-fg-3/60 ml-auto block h-full rounded-sm"
              style={{ width: `${(lead / max) * 100}%` }}
            />
          </span>
        ) : null}
      </Td>
      <Td num>{median(w.costUsd, formatCost)}</Td>
      <Td num>{median(w.repairRuns, formatCount)}</Td>
    </tr>
  )
}

/** Under a median card: how many tasks it could not count, if any. */
function unknownNote(stat: Stat) {
  return stat.unknown > 0
    ? COMPARE.unknownCount(formatCount(stat.unknown))
    : TREND.median
}

/**
 * One model and effort: the window's two approval rates and a task's time
 * and cost first, then the same numbers week by week.
 */
function TrendGroupView({ group: g }: { group: TrendGroup }) {
  const t = g.total
  const max = Math.max(1, ...g.weeks.map((w) => w.leadTimeMs.median ?? 0))
  const tasks = formatCount(t.tasks)
  return (
    <section className="flex flex-col gap-2">
      <h2 className="flex flex-wrap items-baseline gap-x-3 text-base font-semibold">
        {`${g.model ?? COMMON.defaultSetting}${COMMON.separator}${g.effort ?? COMMON.defaultSetting}`}
        <span className="text-fg-2 text-xs font-normal">
          {TREND.groupTasks(tasks, formatCount(t.repairRuns.median))}
        </span>
      </h2>
      <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <dl className="border-line bg-raised grid grid-cols-2 rounded-lg border py-1">
          <Figure
            label={TREND.firstPassRate}
            value={formatPercent(t.firstPassRate)}
            note={TREND.share(formatCount(t.firstPassApproved), tasks)}
          />
          <Figure
            label={TREND.approvalRate}
            value={formatPercent(t.approvalRate)}
            note={TREND.share(formatCount(t.approved), tasks)}
          />
          <Figure
            label={TREND.leadTimePerTask}
            value={formatDuration(t.leadTimeMs.median)}
            note={unknownNote(t.leadTimeMs)}
          />
          <Figure
            label={TREND.costPerTask}
            value={formatCost(t.costUsd.median)}
            note={unknownNote(t.costUsd)}
          />
        </dl>
        <DataTable
          framed
          head={
            <>
              <Th>{TREND.week}</Th>
              <Th num>{TREND.tasks}</Th>
              <Th num title={TREND.firstPassTitle}>
                {TREND.firstPass}
              </Th>
              <Th num title={TREND.approvedTitle}>
                {TREND.approved}
              </Th>
              <Th num title={TREND.medianTitle}>
                {TREND.leadTime}
              </Th>
              <Th num title={`${TREND.medianTitle}${COMMON.costNote}`}>
                {TREND.cost}
              </Th>
              <Th num title={TREND.repairRunsTitle}>
                {TREND.repairRuns}
              </Th>
            </>
          }
        >
          {g.weeks.map((w) => (
            <TrendRow key={w.week} w={w} max={max} />
          ))}
        </DataTable>
      </div>
    </section>
  )
}

/**
 * Whether the factory gets better: the tasks finished in the last 30 days,
 * week by week, one block per model and effort the first run's code stage
 * ran on.
 */
export function TrendScreen({
  data,
  onView,
}: {
  data: TrendResponse
  onView: (view: CompareView) => void
}) {
  const days = formatCount(data.days)
  return (
    <div className="flex flex-col gap-4">
      <ViewSwitch view="trend" onView={onView} />
      {data.groups.length === 0 ? (
        <EmptyState>
          {data.fakeExcluded > 0
            ? TREND.onlyFake(days, formatCount(data.fakeExcluded))
            : TREND.empty(days)}
        </EmptyState>
      ) : (
        <>
          <Intro
            text={TREND.intro(days, formatCount(data.taskIds.length))}
            rules={`${data.includeFake ? '' : TREND.fakeLeftOut(formatCount(data.fakeExcluded))}${TREND.note}`}
          />
          <div className="flex flex-col gap-6">
            {data.groups.map((g) => (
              <TrendGroupView key={`${g.model}|${g.effort}`} group={g} />
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
          <Intro
            text={COMPARE.intro(formatCount(data.runIds.length))}
            rules={COMPARE.rulesTitle}
          />
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
