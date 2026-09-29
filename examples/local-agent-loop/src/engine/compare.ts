/**
 * Cross-run comparison: group reports by config version and reduce each
 * group's per-run summaries and per-stage numbers to median / min / max.
 *
 * A single run is a noisy sample — cache hits, provider latency, and
 * repair counts vary between otherwise identical runs — so comparisons
 * between context modes or model placements should be read from group
 * statistics, never from one report. Unknown values are dropped from the
 * statistic and counted in `unknown`, never treated as zero.
 */
import { formatters } from './format.js'
import {
  CALIBRATION_KEYS,
  SPEC_STAGES,
  TRIAGE_JUDGMENTS,
  UNKNOWN_CALIBRATION,
  type LoopReport,
  type ReportTriage,
  type TriageCalibration,
} from './report.js'
import { TERMINAL_STATUSES } from './terminal.js'

/** The Markdown is English; the web UI reads the same values in Japanese. */
const {
  formatCost,
  formatCount,
  formatDuration,
  formatPercent,
  formatTokens,
  formatWeek,
  unknown: UNKNOWN,
} = formatters('en')

export interface Stat {
  n: number
  unknown: number
  median: number | null
  min: number | null
  max: number | null
}

export interface StageStats {
  stage: string
  workMs: Stat
  totalTokens: Stat
  cacheReadTokens: Stat
  costUsd: Stat
  reworked: Stat
}

/** Outcomes of the runs in one config group that triage judged the same way. */
export interface TriageStats {
  judgment: ReportTriage['judgment']
  runs: number
  approved: number
  verificationFailed: number
  reviewCapReached: number
  repairs: Stat
  costUsd: Stat
  /**
   * The calibration recorded with each judgment, one statistic per value.
   * A run whose value is unknown (no spec, an older record) counts under
   * `unknown`, never as zero.
   */
  calibration: Record<keyof TriageCalibration, Stat>
  /**
   * Runs per stop reason (`failure.kind`), such as `rejected-invocation` or
   * `uncertain-invocation`. Runs that did not stop are not counted.
   */
  stops: Record<string, number>
  /**
   * Runs judged `routine` that still needed a repair or stopped at a cap
   * (review cap, or the iteration cap as verification-failed). Always 0 on
   * the other rows.
   */
  routineNeedingMore: number
}

/**
 * `repair` runs start from an approved candidate and outside findings;
 * `normal` runs start from the task. The two never share a group.
 */
export type RunKind = 'normal' | 'repair'

export interface ConfigGroup {
  kind: RunKind
  configVersion: string | null
  runIds: string[]
  /** Label reconstructed from the first run's input for readability. */
  label: string
  runs: number
  successes: number
  successRate: number
  /**
   * Runs per conclusion. A run that ended without one (failed or cancelled
   * before its outcome was recorded) counts under its status instead.
   */
  conclusions: Record<string, number>
  leadTimeMs: Stat
  workMs: Stat
  humanWaitMs: Stat
  totalTokens: Stat
  costUsd: Stat
  /** Cost over successful runs only. */
  costPerSuccessUsd: Stat
  repairs: Stat
  stages: StageStats[]
  /** One row per triage judgment present; empty when no run had triage. */
  triage: TriageStats[]
}

export interface Comparison {
  groups: ConfigGroup[]
}

export function stat(values: (number | null | undefined)[]): Stat {
  const known = values
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
    .sort((a, b) => a - b)
  const unknown = values.length - known.length
  if (known.length === 0)
    return { n: 0, unknown, median: null, min: null, max: null }
  const mid = Math.floor(known.length / 2)
  const at = (i: number): number => known[i] ?? Number.NaN
  const median = known.length % 2 === 1 ? at(mid) : (at(mid - 1) + at(mid)) / 2
  return {
    n: known.length,
    unknown,
    median,
    min: at(0),
    max: at(known.length - 1),
  }
}

type ReportInput = {
  provider?: string
  model?: string
  effort?: string
  context?: string
  repairOf?: {
    profiles?: {
      code?: {
        effectiveModel?: string | null
        effectiveEffort?: string | null
      }
    }
  }
} | null

/**
 * The model and effort the run's code profile ran on; null where neither the
 * calls nor the input name one. A repair run's first code call is a repair,
 * possibly on its own profile, so it takes the code profile it inherited, as
 * a normal run's does.
 */
export function codeProfileOf(report: Pick<LoopReport, 'input' | 'attempts'>): {
  model: string | null
  effort: string | null
} {
  const input = report.input as ReportInput
  const code = input?.repairOf
    ? input.repairOf.profiles?.code
    : report.attempts.find(
        (a) => a.stepName.includes(':code:') && a.measurement,
      )?.measurement
  return {
    model: code?.effectiveModel ?? input?.model ?? null,
    effort: code?.effectiveEffort ?? input?.effort ?? null,
  }
}

function labelOf(report: LoopReport): string {
  const input = report.input as ReportInput
  const code = codeProfileOf(report)
  return [
    input?.provider ?? 'unknown',
    code.model ?? 'default-model',
    code.effort ?? 'default-effort',
    input?.context ?? 'unknown-context',
  ].join('/')
}

function calibrationStats(
  runs: LoopReport[],
): Record<keyof TriageCalibration, Stat> {
  const of = (r: LoopReport) => r.triage?.calibration ?? UNKNOWN_CALIBRATION
  return Object.fromEntries(
    CALIBRATION_KEYS.map((key) => [key, stat(runs.map((r) => of(r)[key]))]),
  ) as Record<keyof TriageCalibration, Stat>
}

function stopCounts(runs: LoopReport[]): Record<string, number> {
  const stops: Record<string, number> = {}
  for (const r of runs)
    if (r.failure) stops[r.failure.kind] = (stops[r.failure.kind] ?? 0) + 1
  return stops
}

function triageStats(list: LoopReport[]): TriageStats[] {
  return TRIAGE_JUDGMENTS.flatMap((judgment) => {
    const runs = list.filter((r) => r.triage?.judgment === judgment)
    if (runs.length === 0) return []
    const concluded = (c: string) =>
      runs.filter((r) => r.summary.conclusion === c).length
    return [
      {
        judgment,
        runs: runs.length,
        approved: runs.filter((r) => r.summary.success).length,
        verificationFailed: concluded('verification-failed'),
        reviewCapReached: concluded('review-cap-reached'),
        repairs: stat(runs.map((r) => r.summary.repairs)),
        costUsd: stat(runs.map((r) => r.summary.costUsd)),
        calibration: calibrationStats(runs),
        stops: stopCounts(runs),
        routineNeedingMore:
          judgment === 'routine'
            ? runs.filter(
                (r) =>
                  r.summary.repairs > 0 ||
                  r.summary.conclusion === 'review-cap-reached' ||
                  r.summary.conclusion === 'verification-failed',
              ).length
            : 0,
      },
    ]
  })
}

/** Whether a report is of a repair run; its own numbers only, never its parent's. */
export function runKindOf(report: Pick<LoopReport, 'lineage'>): RunKind {
  return report.lineage?.parent ? 'repair' : 'normal'
}

export function compareReports(reports: LoopReport[]): Comparison {
  const groups = new Map<string, LoopReport[]>()
  for (const r of reports) {
    const key = `${runKindOf(r)}|${r.configVersion ?? `unversioned:${labelOf(r)}`}`
    groups.set(key, [...(groups.get(key) ?? []), r])
  }
  const out: ConfigGroup[] = []
  for (const list of groups.values()) {
    const first = list[0]
    if (!first) continue
    const successes = list.filter((r) => r.summary.success).length
    // Stages with LLM usage, and the spec stages by their time alone: the
    // check chosen from the spec calls no LLM but is part of the work.
    const stageNames = [
      ...new Set(
        list.flatMap((r) => [
          ...r.stageUsage.map((u) => u.stage),
          ...r.stageTimings
            .map((t) => t.stage)
            .filter((stage) => SPEC_STAGES.includes(stage)),
        ]),
      ),
    ]
    const stages: StageStats[] = stageNames.map((stage) => {
      const usage = list.map((r) => r.stageUsage.find((u) => u.stage === stage))
      const timing = list.map((r) =>
        r.stageTimings.find((t) => t.stage === stage),
      )
      const visits = list.map((r) =>
        r.stageVisits.find((v) => v.stage === stage),
      )
      return {
        stage,
        workMs: stat(timing.map((t) => (t?.complete ? t.elapsedMs : null))),
        totalTokens: stat(usage.map((u) => u?.totalTokens)),
        cacheReadTokens: stat(usage.map((u) => u?.cacheReadTokens)),
        costUsd: stat(usage.map((u) => u?.costUsd)),
        reworked: stat(visits.map((v) => v?.reworked ?? 0)),
      }
    })
    const conclusions: Record<string, number> = {}
    for (const r of list) {
      const key = r.summary.conclusion ?? r.status
      conclusions[key] = (conclusions[key] ?? 0) + 1
    }
    out.push({
      kind: runKindOf(first),
      configVersion: first.configVersion,
      runIds: list.map((r) => r.runId),
      label: labelOf(first),
      runs: list.length,
      successes,
      successRate: successes / list.length,
      conclusions,
      leadTimeMs: stat(list.map((r) => r.summary.leadTimeMs)),
      workMs: stat(list.map((r) => r.summary.workMs)),
      humanWaitMs: stat(list.map((r) => r.summary.humanWaitMs)),
      totalTokens: stat(list.map((r) => r.summary.totalTokens)),
      costUsd: stat(list.map((r) => r.summary.costUsd)),
      costPerSuccessUsd: stat(
        list
          .filter((r) => r.summary.success)
          .map((r) => r.summary.costPerSuccessUsd),
      ),
      repairs: stat(list.map((r) => r.summary.repairs)),
      stages,
      triage: triageStats(list),
    })
  }
  return { groups: out }
}

/**
 * `median [min..max] (n=…)`, each value in the format a person reads that
 * quantity in; an unknown median is `unknown`.
 */
function fmtStat(
  s: Stat,
  f: (v: number | null) => string = formatCount,
): string {
  if (s.median === null) return `${UNKNOWN} (${s.unknown} unknown)`
  const tail = s.unknown > 0 ? `, ${s.unknown} unknown` : ''
  return `${f(s.median)} [${f(s.min)}..${f(s.max)}] (n=${s.n}${tail})`
}

function fmtStops(stops: Record<string, number>): string {
  const entries = Object.entries(stops)
  return entries.length === 0
    ? 'none'
    : entries.map(([kind, n]) => `${kind} ${n}`).join(', ')
}

export function comparisonToMarkdown(c: Comparison): string {
  const lines: string[] = []
  lines.push('# Run comparison')
  lines.push('')
  lines.push(
    'median [min..max] (n=known runs); unknown values are excluded, never zero-filled.',
  )
  lines.push(
    'Repair runs from outside findings are grouped apart from normal runs; each counts only its own time, cost and stages, never its parent run.',
  )
  for (const g of c.groups) {
    lines.push('')
    const kind = g.kind === 'repair' ? 'repair from findings: ' : ''
    lines.push(
      `## ${kind}${g.label} — config ${g.configVersion ?? 'unversioned'}`,
    )
    lines.push('')
    lines.push(`- runs: ${g.runIds.join(', ')}`)
    lines.push(
      `- success: ${g.successes}/${g.runs} (${(g.successRate * 100).toFixed(0)}%)`,
    )
    lines.push(
      `- conclusions: ${Object.entries(g.conclusions)
        .map(([c, n]) => `${c} ${n}`)
        .join(', ')}`,
    )
    lines.push(`- lead time: ${fmtStat(g.leadTimeMs, formatDuration)}`)
    lines.push(`- work: ${fmtStat(g.workMs, formatDuration)}`)
    lines.push(`- human wait: ${fmtStat(g.humanWaitMs, formatDuration)}`)
    lines.push(`- total tokens: ${fmtStat(g.totalTokens, formatTokens)}`)
    lines.push(`- cost: ${fmtStat(g.costUsd, formatCost)}`)
    lines.push(
      `- cost per success: ${fmtStat(g.costPerSuccessUsd, formatCost)}`,
    )
    lines.push(`- repairs: ${fmtStat(g.repairs)}`)
    lines.push('')
    lines.push('| stage | work | total tokens | cache-read | cost | reworked |')
    lines.push('|---|---|---|---|---|---|')
    for (const s of g.stages) {
      lines.push(
        `| ${s.stage} | ${fmtStat(s.workMs, formatDuration)} | ${fmtStat(s.totalTokens, formatTokens)} | ${fmtStat(s.cacheReadTokens, formatTokens)} | ${fmtStat(s.costUsd, formatCost)} | ${fmtStat(s.reworked)} |`,
      )
    }
    if (g.triage.length > 0) {
      lines.push('')
      lines.push(
        'By triage judgment (shadow mode; the judgment chose nothing):',
      )
      lines.push('')
      lines.push(
        '| judgment | runs | approved | verification-failed | review-cap-reached | repairs | cost | routine needing repair or cap | stops |',
      )
      lines.push('|---|---|---|---|---|---|---|---|---|')
      for (const t of g.triage) {
        lines.push(
          `| ${t.judgment} | ${t.runs} | ${t.approved} | ${t.verificationFailed} | ${t.reviewCapReached} | ${fmtStat(t.repairs)} | ${fmtStat(t.costUsd, formatCost)} | ${t.judgment === 'routine' ? t.routineNeedingMore : '-'} | ${fmtStops(t.stops)} |`,
        )
      }
      lines.push('')
      lines.push(
        'Calibration by triage judgment (from the stored task and spec):',
      )
      lines.push('')
      lines.push(
        '| judgment | task chars | spec chars | acceptance criteria | planned files |',
      )
      lines.push('|---|---|---|---|---|')
      for (const t of g.triage) {
        lines.push(
          `| ${t.judgment} | ${CALIBRATION_KEYS.map((k) => fmtStat(t.calibration[k])).join(' | ')} |`,
        )
      }
    }
  }
  lines.push('')
  return lines.join('\n')
}

// ---------------------------------------------------------------- trend

/** The trend's window, in days back from now, unless asked otherwise. */
export const TREND_DAYS = 30

const DAY_MS = 86_400_000

/**
 * `--days` as a whole number of days from 1 up to `Number.MAX_SAFE_INTEGER`;
 * the default when absent. Anything else is refused, never rounded.
 */
export function parseTrendDays(raw: string | undefined): number {
  if (raw === undefined) return TREND_DAYS
  const days = Number(raw)
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(days) || days < 1)
    throw new Error(
      `--days must be a whole number of days from 1 to ${Number.MAX_SAFE_INTEGER}, not ${raw}`,
    )
  return days
}

/** A finished run's report and when it finished, as the trend reads it. */
export interface TrendRun {
  report: LoopReport
  completedAt: string | null
}

/** One group's runs over one week, or over the whole window. */
export interface TrendCell {
  runs: number
  approved: number
  /** `approved / runs`; null without runs. */
  approvalRate: number | null
  leadTimeMs: Stat
  costUsd: Stat
  repairs: Stat
}

export interface TrendWeek extends TrendCell {
  /** The week's Monday, local time, as `YYYY-MM-DD`. */
  week: string
}

/** The runs whose code profile ran on one model and effort. */
export interface TrendGroup {
  /** Null when neither the calls nor the input named one. */
  model: string | null
  effort: string | null
  /** Newest completion first. */
  runIds: string[]
  total: TrendCell
  /** One per week of the trend, oldest first, weeks without runs included. */
  weeks: TrendWeek[]
}

/**
 * Finished runs by week and by the code profile's model and effort, for
 * reading whether the factory gets better. The CLI version is not part of the
 * group: a new release of the same model is the same line.
 */
export interface Trend {
  days: number
  includeFake: boolean
  /** Mondays from the first run's week to the current week, oldest first. */
  weeks: string[]
  /** The runs counted, newest completion first. */
  runIds: string[]
  /** Fake-provider runs in the window that were left out. */
  fakeExcluded: number
  /** Most runs first. */
  groups: TrendGroup[]
}

function pad(n: number): string {
  return String(n).padStart(2, '0')
}

function localDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** The Monday that starts the week of `ms`, local time, at midnight. */
function mondayOf(ms: number): Date {
  const d = new Date(ms)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return d
}

function cellOf(list: TrendRun[]): TrendCell {
  const approved = list.filter((r) => r.report.summary.success).length
  return {
    runs: list.length,
    approved,
    approvalRate: list.length > 0 ? approved / list.length : null,
    leadTimeMs: stat(list.map((r) => r.report.summary.leadTimeMs)),
    costUsd: stat(list.map((r) => r.report.summary.costUsd)),
    repairs: stat(list.map((r) => r.report.summary.repairs)),
  }
}

/**
 * The trend over the finished runs that completed in the `days` before
 * `now`, fake-provider runs left out unless `includeFake`. An unknown time
 * or cost is left out of its median and counted in `unknown`, never as 0.
 */
export function trendOf(
  entries: TrendRun[],
  options: { now: number; days?: number; includeFake?: boolean },
): Trend {
  const days = options.days ?? TREND_DAYS
  const includeFake = options.includeFake ?? false
  const since = options.now - days * DAY_MS
  const done = entries
    .map((e) => ({ ...e, at: Date.parse(e.completedAt ?? '') }))
    .filter(
      (e) =>
        TERMINAL_STATUSES.includes(e.report.status) &&
        Number.isFinite(e.at) &&
        e.at > since &&
        e.at <= options.now,
    )
    .sort((x, y) => y.at - x.at)
  const counted = done.filter((e) => includeFake || !e.report.fake)
  const weeks: string[] = []
  const first = counted.at(-1)
  if (first) {
    for (
      const d = mondayOf(first.at);
      d.getTime() <= options.now;
      d.setDate(d.getDate() + 7)
    )
      weeks.push(localDate(d))
  }
  const byGroup = new Map<string, (typeof counted)[number][]>()
  for (const e of counted) {
    const code = codeProfileOf(e.report)
    const key = JSON.stringify([code.model, code.effort])
    byGroup.set(key, [...(byGroup.get(key) ?? []), e])
  }
  const groups = [...byGroup.values()].map((list): TrendGroup => {
    const code = codeProfileOf((list[0] as TrendRun).report)
    return {
      model: code.model,
      effort: code.effort,
      runIds: list.map((e) => e.report.runId),
      total: cellOf(list),
      weeks: weeks.map((week) => ({
        week,
        ...cellOf(list.filter((e) => localDate(mondayOf(e.at)) === week)),
      })),
    }
  })
  groups.sort(
    (x, y) =>
      y.total.runs - x.total.runs ||
      `${x.model}/${x.effort}`.localeCompare(`${y.model}/${y.effort}`),
  )
  return {
    days,
    includeFake,
    weeks,
    runIds: counted.map((e) => e.report.runId),
    fakeExcluded: done.length - counted.length,
    groups,
  }
}

function trendRow(label: string, c: TrendCell): string {
  if (c.runs === 0) return `| ${label} | 0 | 0 | - | - | - | - |`
  return `| ${label} | ${c.runs} | ${c.approved} | ${formatPercent(c.approvalRate)} | ${fmtStat(c.leadTimeMs, formatDuration)} | ${fmtStat(c.costUsd, formatCost)} | ${fmtStat(c.repairs)} |`
}

export function trendToMarkdown(t: Trend): string {
  const lines: string[] = []
  lines.push('# Run trend')
  lines.push('')
  lines.push(
    `Finished runs of the last ${t.days} days, by week (Monday, local time) and by the code profile's model and effort. ${t.includeFake ? 'Fake-provider runs included.' : `Fake-provider runs left out: ${t.fakeExcluded}.`}`,
  )
  lines.push(
    'median [min..max] (n=known runs); unknown values are excluded, never zero-filled.',
  )
  if (t.groups.length === 0) {
    lines.push('', 'No finished run in the window.', '')
    return lines.join('\n')
  }
  for (const g of t.groups) {
    lines.push('')
    lines.push(
      `## ${g.model ?? 'default-model'} / ${g.effort ?? 'default-effort'}`,
    )
    lines.push('')
    lines.push(
      '| week | runs | approved | approval rate | lead time | cost | repairs |',
    )
    lines.push('|---|---|---|---|---|---|---|')
    for (const w of g.weeks) lines.push(trendRow(formatWeek(w.week), w))
    lines.push(trendRow(`last ${t.days} days`, g.total))
  }
  lines.push('')
  return lines.join('\n')
}
