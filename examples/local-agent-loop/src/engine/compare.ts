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
import {
  TRIAGE_JUDGMENTS,
  UNKNOWN_CALIBRATION,
  type LoopReport,
  type ReportTriage,
  type TriageCalibration,
} from './report.js'

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

export interface ConfigGroup {
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

function labelOf(report: LoopReport): string {
  const input = report.input as {
    provider?: string
    model?: string
    effort?: string
    context?: string
  } | null
  const code = report.attempts.find(
    (a) => a.stepName.includes(':code:') && a.measurement,
  )?.measurement
  return [
    input?.provider ?? 'unknown',
    code?.effectiveModel ?? input?.model ?? 'default-model',
    code?.effectiveEffort ?? input?.effort ?? 'default-effort',
    input?.context ?? 'unknown-context',
  ].join('/')
}

/** The calibration values, in the order every table shows them. */
export const CALIBRATION_KEYS = [
  'taskChars',
  'specChars',
  'acceptanceCriteria',
  'plannedFiles',
] as const satisfies readonly (keyof TriageCalibration)[]

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

export function compareReports(reports: LoopReport[]): Comparison {
  const groups = new Map<string, LoopReport[]>()
  for (const r of reports) {
    const key = r.configVersion ?? `unversioned:${labelOf(r)}`
    groups.set(key, [...(groups.get(key) ?? []), r])
  }
  const out: ConfigGroup[] = []
  for (const list of groups.values()) {
    const first = list[0]
    if (!first) continue
    const successes = list.filter((r) => r.summary.success).length
    const stageNames = [
      ...new Set(list.flatMap((r) => r.stageUsage.map((u) => u.stage))),
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

function fmtStat(s: Stat, digits = 0): string {
  if (s.median === null) return `unknown (${s.unknown} unknown)`
  const f = (v: number | null) => (v === null ? '?' : v.toFixed(digits))
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
  for (const g of c.groups) {
    lines.push('')
    lines.push(`## ${g.label} — config ${g.configVersion ?? 'unversioned'}`)
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
    lines.push(`- lead time ms: ${fmtStat(g.leadTimeMs)}`)
    lines.push(`- work ms: ${fmtStat(g.workMs)}`)
    lines.push(`- human wait ms: ${fmtStat(g.humanWaitMs)}`)
    lines.push(`- total tokens: ${fmtStat(g.totalTokens)}`)
    lines.push(`- cost USD: ${fmtStat(g.costUsd, 6)}`)
    lines.push(`- cost per success USD: ${fmtStat(g.costPerSuccessUsd, 6)}`)
    lines.push(`- repairs: ${fmtStat(g.repairs)}`)
    lines.push('')
    lines.push(
      '| stage | work ms | total tokens | cache-read | cost USD | reworked |',
    )
    lines.push('|---|---|---|---|---|---|')
    for (const s of g.stages) {
      lines.push(
        `| ${s.stage} | ${fmtStat(s.workMs)} | ${fmtStat(s.totalTokens)} | ${fmtStat(s.cacheReadTokens)} | ${fmtStat(s.costUsd, 6)} | ${fmtStat(s.reworked)} |`,
      )
    }
    if (g.triage.length > 0) {
      lines.push('')
      lines.push(
        'By triage judgment (shadow mode; the judgment chose nothing):',
      )
      lines.push('')
      lines.push(
        '| judgment | runs | approved | verification-failed | review-cap-reached | repairs | cost USD | routine needing repair or cap | stops |',
      )
      lines.push('|---|---|---|---|---|---|---|---|---|')
      for (const t of g.triage) {
        lines.push(
          `| ${t.judgment} | ${t.runs} | ${t.approved} | ${t.verificationFailed} | ${t.reviewCapReached} | ${fmtStat(t.repairs)} | ${fmtStat(t.costUsd, 6)} | ${t.judgment === 'routine' ? t.routineNeedingMore : '-'} | ${fmtStops(t.stops)} |`,
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
