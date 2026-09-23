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
  type LiveElapsed,
  type LoopReport,
  type ReportTriage,
} from '../engine/report.js'
import { diagnose, needsHuman, type Diagnosis } from '../engine/status.js'
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
  return {
    name: runName(run.input),
    createdAt: run.createdAt,
    diagnosis,
    needsHuman: needsHuman(diagnosis.kind),
    live: liveElapsed(run, report.attempts, now),
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
    return {
      now: new Date(now).toISOString(),
      ...(await inspect(db, found, now)),
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
