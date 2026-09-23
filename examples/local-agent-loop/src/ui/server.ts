/**
 * `demo ui`: a read-only web UI over the factory's database.
 *
 * - Listens on 127.0.0.1 only. The API answers only to a loopback Host
 *   header, so a page on another origin cannot read runs through DNS
 *   rebinding.
 * - Opens the fixed state root's existing database read-only, lazily: until a
 *   worker or `trigger` creates it, every view is empty and nothing is
 *   created. `migrate()` and `init()` are never called.
 * - Every number comes from `buildReport` / `compareReports` and every reason
 *   and command from `diagnose`, the same code the CLI prints from. The API
 *   has no endpoint that runs a command or changes a run.
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http'
import type { AddressInfo } from 'node:net'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { Run } from '@coji/durably'

import {
  dbPath,
  defaultStateRoot,
  openReadOnlyAgentDurably,
  type AgentLoopDurably,
} from '../durably.js'
import { buildReport } from '../engine/build-report.js'
import { compareReports, type Comparison } from '../engine/compare.js'
import {
  liveElapsed,
  stageOf,
  type AttemptRow,
  type LiveElapsed,
  type LoopReport,
  type ReportTriage,
  type WaitRow,
} from '../engine/report.js'
import {
  diagnose,
  needsHuman,
  type Diagnosis,
  type DiagnosisKind,
} from '../engine/status.js'
import { TERMINAL_STATUSES } from '../engine/terminal.js'

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** One row of the run list. */
export interface RunRow {
  id: string
  status: string
  createdAt: string
  /** From the stored input; see `runName`. */
  name: string
  diagnosis: Diagnosis
  /** Approval, a stop, or an unknown wait: a person decides next. */
  needsHuman: boolean
  /** Provisional, as of the response's `now`; null for a finished run. */
  live: LiveElapsed | null
  /** Times the code stage was entered (first implementation + repairs). */
  iterations: number
  reviewRounds: number
  conclusion: string | null
  /** The report's settled lead time; null while the run is open. */
  leadTimeMs: number | null
  costUsd: number | null
  triage: ReportTriage['judgment'] | null
  pipeline: Pipeline
}

export interface RunsResponse {
  db: string
  /** False until a worker or `trigger` creates the database. */
  exists: boolean
  now: string
  /** Newest first. */
  runs: RunRow[]
}

export interface RunDetailResponse {
  now: string
  /** From the stored input; see `runName`. */
  name: string
  createdAt: string
  diagnosis: Diagnosis
  needsHuman: boolean
  live: LiveElapsed | null
  pipeline: Pipeline
  /** Null before any stage has started. */
  timeline: Timeline | null
  /** Exactly what `report --run <id> --format json` prints. */
  report: LoopReport
}

export interface CompareResponse {
  /** Finished runs, newest first, in the order given to `compareReports`. */
  runIds: string[]
  comparison: Comparison
}

/** The heading for the bundled sample, whose task never varies. */
export const SUBJECT_RUN_NAME = '同梱題材: calc の add を直す'

const NAME_MAX = 80

/**
 * A person-readable name for a run, from its stored input only: the issue
 * number and title when the run came from an issue, else the task's first
 * non-empty line (a leading Markdown heading mark dropped), else the bundled
 * sample's fixed name. Truncated to 80 characters.
 */
export function runName(input: unknown): string {
  const target = (
    input as {
      target?: {
        kind?: string
        task?: string
        issue?: { number?: number; title?: string } | null
      }
    } | null
  )?.target
  if (target?.kind !== 'repo') return SUBJECT_RUN_NAME
  const issue = target.issue
  const line =
    issue?.number != null
      ? `#${issue.number} ${issue.title?.trim() ?? ''}`.trim()
      : ((target.task ?? '')
          .split('\n')
          .map((l) => l.trim().replace(/^#+\s*/, ''))
          .find((l) => l.length > 0) ?? '')
  if (line.length === 0) return 'タスク（名前なし）'
  return line.length > NAME_MAX ? `${line.slice(0, NAME_MAX - 1)}…` : line
}

// ---------------------------------------------------------------- pipeline

/**
 * Where a stage stands in a run: `running` / `waiting` / `current` is the
 * stage the run is at now (a worker on it, a person to decide, or neither);
 * `stopped` is where a run that did not finish ended.
 */
export type PipelineState =
  | 'done'
  | 'running'
  | 'waiting'
  | 'current'
  | 'stopped'
  | 'not-reached'

export interface PipelineStage {
  stage: string
  state: PipelineState
  /** Times the stage was entered; above 1 for a repair loop. */
  count: number
}

export interface Pipeline {
  stages: PipelineStage[]
  /** The whole stepper in one sentence, for screen readers. */
  label: string
}

const PIPELINE_ORDER = [
  'setup',
  'triage',
  'code',
  'verify',
  'review',
  'approve',
  'finish',
]

export interface PipelineInput {
  status: string
  diagnosisKind: DiagnosisKind
  live: Pick<LiveElapsed, 'stage'> | null
  report: Pick<LoopReport, 'attempts' | 'waits' | 'stageVisits' | 'roleUsage'>
}

/** Stored step or wait name to the stage it belongs to, dated by its start. */
function pipelineEvents(
  attempts: Pick<AttemptRow, 'stepName' | 'startedAt'>[],
  waits: Pick<WaitRow, 'name' | 'createdAt'>[],
): { stage: string; at: number }[] {
  return [
    ...attempts.map((a) => ({
      stage: stageOf(a.stepName),
      at: Date.parse(a.startedAt),
    })),
    ...waits.map((w) => ({
      stage: stageOf(w.name),
      at: Date.parse(w.createdAt),
    })),
  ].filter((e) => PIPELINE_ORDER.includes(e.stage))
}

/**
 * The fixed stage order with each stage's visit count and state, from the
 * report's stored attempts, waits and visit counts. Triage appears only
 * when the run has a triage step or profile. A stop is shown on the stage
 * the run stopped after, not as a stage of its own.
 */
export function derivePipeline(input: PipelineInput): Pipeline {
  const { report } = input
  const approvals = report.waits.filter((w) => stageOf(w.name) === 'approve')
  const counts = new Map<string, number>()
  for (const v of report.stageVisits) counts.set(v.stage, v.visits)
  // Approval is a wait, not a step, so it has no attempts to count.
  counts.set('approve', new Set(approvals.map((w) => w.name)).size)
  for (const once of ['setup', 'triage'])
    counts.set(once, report.attempts.some((a) => a.stepName === once) ? 1 : 0)
  const hasTriage =
    (counts.get('triage') ?? 0) > 0 ||
    report.roleUsage.some((r) => r.role === 'triage')
  const order = PIPELINE_ORDER.filter((s) => s !== 'triage' || hasTriage)

  const events = pipelineEvents(report.attempts, approvals).sort(
    (x, y) => x.at - y.at,
  )
  const last = events.at(-1)?.stage ?? null
  const terminal = TERMINAL_STATUSES.includes(input.status)
  let at: string | null
  let atState: PipelineState
  if (terminal) {
    const finished =
      input.status === 'completed' && (counts.get('finish') ?? 0) > 0
    at = finished ? null : (last ?? 'setup')
    atState = 'stopped'
  } else {
    const live = input.live?.stage
    at = live && order.includes(live) ? live : (last ?? 'setup')
    atState =
      input.diagnosisKind === 'running'
        ? 'running'
        : needsHuman(input.diagnosisKind)
          ? 'waiting'
          : 'current'
  }
  const stages = order.map((stage) => {
    const count = counts.get(stage) ?? 0
    const state: PipelineState =
      stage === at ? atState : count > 0 ? 'done' : 'not-reached'
    return { stage, state, count }
  })

  const parts = stages
    .filter((s) => s.count > 1)
    .map((s) => `${s.stage} ${s.count}回`)
  if (at === null) parts.push('finish まで完了')
  else if (atState === 'stopped') parts.push(`${at} で停止`)
  else if (atState === 'running') parts.push(`いまは ${at} を実行中`)
  else if (atState === 'waiting') parts.push(`いまは ${at} で人待ち`)
  else parts.push(`いまは ${at}`)
  return { stages, label: `工程: ${parts.join('、')}` }
}

// ---------------------------------------------------------------- timeline

export interface TimelineBar {
  /** `code`, `verify`, `review:correctness`, `approve`, … */
  lane: string
  /** `wait` is the human approval wait; `work` is a stage's step attempts. */
  kind: 'work' | 'wait'
  /** Milliseconds from the timeline's start. */
  startMs: number
  /** Null when the end was never recorded (an interrupted attempt). */
  endMs: number | null
  /** Still running or waiting: the bar ends at `now`. */
  open: boolean
  failed: boolean
  startedAt: string
  /** Wall time of the bar; provisional while open, null when unknown. */
  durationMs: number | null
}

export interface Timeline {
  startedAt: string
  /** From `startedAt` to the last known end, or to `now` for an open run. */
  spanMs: number
  /** Lanes that have bars, in stage order. */
  lanes: string[]
  bars: TimelineBar[]
}

const TIMELINE_LANES = [
  'triage',
  'code',
  'verify',
  'review:correctness',
  'review:edge-cases',
  'approve',
]

/** The lane a step runs in, and the stage entry it belongs to. */
function laneOf(stepName: string): { lane: string; entry: string } | null {
  if (stepName === 'triage') return { lane: 'triage', entry: 'once' }
  const [kind, sequence, stage, sub] = stepName.split(':')
  if (kind !== 'stage' || !sequence) return null
  if (stage === 'code' || stage === 'verify')
    return { lane: stage, entry: sequence }
  if (stage === 'review' && (sub === 'correctness' || sub === 'edge-cases'))
    return { lane: `review:${sub}`, entry: sequence }
  return null
}

export interface TimelineInput {
  run: {
    status: string
    createdAt: string
    startedAt: string | null
    leaseGeneration: number
  }
  attempts: Pick<
    AttemptRow,
    'stepName' | 'startedAt' | 'completedAt' | 'status' | 'leaseGeneration'
  >[]
  waits: Pick<WaitRow, 'name' | 'createdAt' | 'resolvedAt'>[]
  now: number
}

/**
 * One bar per stage entry per lease generation: a stage entered twice (a
 * repair) is two bars in its lane, and a worker that lost its lease leaves
 * a bar of its own. Reviews run in parallel, so their lanes overlap. Only
 * the current lease generation of an open run can still be running; any
 * other missing end stays unknown rather than being drawn to `now`.
 */
export function deriveTimeline(input: TimelineInput): Timeline | null {
  const { run, now } = input
  const terminal = TERMINAL_STATUSES.includes(run.status)
  type Raw = Omit<TimelineBar, 'startMs' | 'endMs' | 'durationMs'> & {
    start: number
    end: number | null
  }
  const groups = new Map<string, Raw>()
  for (const a of input.attempts) {
    const where = laneOf(a.stepName)
    const start = Date.parse(a.startedAt)
    if (!where || !Number.isFinite(start)) continue
    const end = a.completedAt ? Date.parse(a.completedAt) : NaN
    const open =
      !terminal &&
      a.completedAt === null &&
      a.status === 'started' &&
      a.leaseGeneration === run.leaseGeneration
    const key = `${where.lane}#${where.entry}#${a.leaseGeneration}`
    const bar = groups.get(key)
    const next: Raw = {
      lane: where.lane,
      kind: 'work',
      start,
      end: Number.isFinite(end) ? end : null,
      open,
      failed: a.status === 'failed',
      startedAt: a.startedAt,
    }
    if (!bar) {
      groups.set(key, next)
      continue
    }
    if (start < bar.start) {
      bar.start = start
      bar.startedAt = a.startedAt
    }
    // One attempt with no recorded end leaves the whole bar's end unknown.
    bar.end =
      bar.end === null || next.end === null ? null : Math.max(bar.end, next.end)
    bar.open ||= open
    bar.failed ||= next.failed
  }
  const raws = [...groups.values()]
  for (const w of input.waits) {
    const start = Date.parse(w.createdAt)
    if (stageOf(w.name) !== 'approve' || !Number.isFinite(start)) continue
    const end = w.resolvedAt ? Date.parse(w.resolvedAt) : NaN
    raws.push({
      lane: 'approve',
      kind: 'wait',
      start,
      end: Number.isFinite(end) ? end : null,
      open: !terminal && w.resolvedAt === null,
      failed: false,
      startedAt: w.createdAt,
    })
  }
  if (raws.length === 0) return null

  const runStart = Date.parse(run.startedAt ?? run.createdAt)
  const origin = Math.min(
    ...raws.map((r) => r.start),
    ...(Number.isFinite(runStart) ? [runStart] : []),
  )
  const endOf = (r: Raw) => (r.open ? Math.max(now, r.start) : r.end)
  const ends = raws.map(endOf).filter((e): e is number => e !== null)
  const last = Math.max(
    origin,
    ...raws.map((r) => r.start),
    ...ends,
    ...(terminal ? [] : [now]),
  )
  const bars = raws
    .map((r): TimelineBar => {
      const end = endOf(r)
      return {
        lane: r.lane,
        kind: r.kind,
        startMs: r.start - origin,
        endMs: end === null ? null : end - origin,
        open: r.open,
        failed: r.failed,
        startedAt: r.startedAt,
        durationMs: end === null ? null : Math.max(0, end - r.start),
      }
    })
    .sort(
      (x, y) =>
        TIMELINE_LANES.indexOf(x.lane) - TIMELINE_LANES.indexOf(y.lane) ||
        x.startMs - y.startMs,
    )
  return {
    startedAt: new Date(origin).toISOString(),
    spanMs: Math.max(1, last - origin),
    lanes: TIMELINE_LANES.filter((l) => bars.some((b) => b.lane === l)),
    bars,
  }
}

/** A database that exists but has no tables yet reads as `empty`. */
function orEmpty<T>(read: Promise<T>, empty: T): Promise<T> {
  return read.catch((error: unknown) => {
    if (/no such table/.test((error as Error)?.message ?? '')) return empty
    throw error
  })
}

async function allRuns(durably: AgentLoopDurably): Promise<Run[]> {
  const runs = await durably.getRuns({ jobName: durably.jobs.agentLoop.name })
  return runs.sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt))
}

/** What both the list row and the detail page read for one run. */
async function inspect(durably: AgentLoopDurably, run: Run, now: number) {
  const [diagnosis, report] = await Promise.all([
    diagnose(durably, run, now),
    buildReport(durably, run.id),
  ])
  const live = liveElapsed(run, report.attempts, now)
  return {
    name: runName(run.input),
    createdAt: run.createdAt,
    diagnosis,
    needsHuman: needsHuman(diagnosis.kind),
    live,
    pipeline: derivePipeline({
      status: run.status,
      diagnosisKind: diagnosis.kind,
      live,
      report,
    }),
    report,
  }
}

async function runRow(
  durably: AgentLoopDurably,
  run: Run,
  now: number,
): Promise<RunRow> {
  const { report, ...seen } = await inspect(durably, run, now)
  return {
    id: run.id,
    status: run.status,
    ...seen,
    iterations: report.stageVisits.find((v) => v.stage === 'code')?.visits ?? 0,
    reviewRounds: report.summary.reviewRounds,
    conclusion: report.summary.conclusion,
    leadTimeMs: report.summary.leadTimeMs,
    costUsd: report.summary.costUsd,
    triage: report.triage?.judgment ?? null,
  }
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** The read API, without a listening socket. */
function createUiApi() {
  const stateRoot = defaultStateRoot()
  let durably: AgentLoopDurably | null = null
  // Opened on first use after the file appears, then kept.
  const source = () => (durably ??= openReadOnlyAgentDurably({ stateRoot }))

  async function runs(): Promise<RunsResponse> {
    const now = Date.now()
    const base = {
      db: dbPath(stateRoot),
      now: new Date(now).toISOString(),
    }
    const db = source()
    if (!db) return { ...base, exists: false, runs: [] }
    const all = await orEmpty(allRuns(db), [])
    const rows = await Promise.all(all.map((run) => runRow(db, run, now)))
    return { ...base, exists: true, runs: rows }
  }

  async function run(id: string): Promise<RunDetailResponse> {
    const now = Date.now()
    const db = source()
    const found = db ? await orEmpty(db.getRun(id), null) : null
    if (!db || !found) throw new HttpError(404, `no run ${id}`)
    const seen = await inspect(db, found, now)
    return {
      now: new Date(now).toISOString(),
      ...seen,
      timeline: deriveTimeline({
        run: found,
        attempts: seen.report.attempts,
        waits: seen.report.waits,
        now,
      }),
    }
  }

  async function compare(): Promise<CompareResponse> {
    const db = source()
    if (!db) return { runIds: [], comparison: { groups: [] } }
    const finished = (await orEmpty(allRuns(db), [])).filter((r) =>
      TERMINAL_STATUSES.includes(r.status),
    )
    const reports = await Promise.all(
      finished.map((r) => buildReport(db, r.id)),
    )
    return {
      runIds: finished.map((r) => r.id),
      comparison: compareReports(reports),
    }
  }

  async function handle(pathname: string): Promise<unknown> {
    if (pathname === '/api/runs') return runs()
    if (pathname === '/api/compare') return compare()
    const match = /^\/api\/runs\/([^/]+)$/.exec(pathname)
    if (match?.[1]) return run(decodeURIComponent(match[1]))
    throw new HttpError(404, `no such endpoint: ${pathname}`)
  }

  return {
    handle,
    async close() {
      await durably?.db.destroy()
    },
  }
}

export interface UiServerOptions {
  port: number
}

export interface UiServer {
  url: string
  close(): Promise<void>
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

/** Start the loopback server; resolves once it is listening. */
export async function startUiServer(
  options: UiServerOptions,
): Promise<UiServer> {
  const host = '127.0.0.1'
  const api = createUiApi()
  let port = options.port
  const onRequest = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${host}`)
    if (!url.pathname.startsWith('/api/')) return vite.middlewares(req, res)
    const hostHeader = req.headers.host ?? ''
    if (hostHeader !== `${host}:${port}` && hostHeader !== `localhost:${port}`)
      return sendJson(res, 403, { error: 'loopback host only' })
    if (req.method !== 'GET' && req.method !== 'HEAD')
      return sendJson(res, 405, { error: 'read-only API' })
    try {
      sendJson(res, 200, await api.handle(url.pathname))
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500
      sendJson(res, status, { error: (error as Error).message })
    }
  }
  const server = createServer((req, res) => void onRequest(req, res))
  // Vite's live-reload socket shares this server, so it stays on loopback.
  const vite = await (
    await import('vite')
  ).createServer({
    configFile: join(packageRoot, 'vite.config.ts'),
    appType: 'spa',
    logLevel: 'warn',
    server: { middlewareMode: true, hmr: { server } },
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(options.port, host, () => {
        server.off('error', reject)
        resolve()
      })
    })
  } catch (error) {
    await vite.close()
    throw error
  }
  port = (server.address() as AddressInfo).port
  return {
    url: `http://${host}:${port}/`,
    async close() {
      const closed = new Promise<void>((resolve) =>
        server.close(() => resolve()),
      )
      server.closeAllConnections()
      await closed
      await vite.close()
      await api.close()
    },
  }
}
