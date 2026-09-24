/**
 * The factory's read-only web UI: runs that need a person first, then open
 * runs, then finished ones; one run's report; and the comparison of finished
 * runs by config version. Every value is shown as the API returns it from
 * `diagnose`, `buildReport` and `compareReports`; nothing is recomputed here.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from 'react'

import type { Stat } from '../engine/compare'
import type {
  LiveElapsed,
  LoopReport,
  ReportCandidate,
  UsageTotals,
} from '../engine/report'
import type { DiagnosisKind } from '../engine/status'
import { TERMINAL_STATUSES } from '../engine/terminal'
import {
  commandNote,
  commandText,
  detailField,
  diagnosisText,
  humanCheckText,
  lensName,
  reviewDecision,
  roleName,
  stageName,
  triageName,
} from './labels'
import { pollJson } from './poll'
import type {
  CompareResponse,
  Pipeline,
  PipelineState,
  RunDetailResponse,
  RunRow,
  RunsResponse,
  Trace,
  TraceCheckpoint,
  TraceNode,
  TraceProfile,
  TraceState,
} from './server'

const REFRESH_MS = 3000

// ---------------------------------------------------------------- data

interface PollState<T> {
  data: T | null
  /** Set while the latest refresh failed; the last data stays on screen. */
  error: string | null
  fetchedAt: Date | null
  /** Set once a refresh works again after failing, until the next failure. */
  recovered: boolean
}

/**
 * Fetch `url` now and every 3 seconds, one request at a time. Leaving the
 * page aborts the request in flight and stops the timer.
 */
function usePolled<T>(url: string): PollState<T> {
  const [state, setState] = useState<PollState<T>>({
    data: null,
    error: null,
    fetchedAt: null,
    recovered: false,
  })
  useEffect(
    () =>
      pollJson<T>(
        url,
        REFRESH_MS,
        (data) =>
          setState((s) => ({
            data,
            error: null,
            fetchedAt: new Date(),
            recovered: s.recovered || s.error !== null,
          })),
        (error) => setState((s) => ({ ...s, error, recovered: false })),
      ),
    [url],
  )
  return state
}

// ---------------------------------------------------------------- routing

type Route =
  | { page: 'runs' }
  | { page: 'run'; id: string }
  | { page: 'compare' }

function subscribeHash(onChange: () => void) {
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}

function useRoute(): Route {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash)
  const run = /^#\/runs\/(.+)$/.exec(hash)
  if (run?.[1]) return { page: 'run', id: decodeURIComponent(run[1]) }
  if (hash === '#/compare') return { page: 'compare' }
  return { page: 'runs' }
}

// ---------------------------------------------------------------- format

const UNKNOWN = '不明'

function fmtMs(ms: number | null | undefined): string {
  if (ms == null) return UNKNOWN
  if (ms < 1000) return `${ms} ms`
  const s = ms / 1000
  if (s < 60) return `${s.toFixed(1)} 秒`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m} 分 ${Math.round(s % 60)} 秒`
  return `${Math.floor(m / 60)} 時間 ${m % 60} 分`
}

/** Same six decimals as the CLI report. */
function fmtUsd(v: number | null | undefined): string {
  return v == null ? UNKNOWN : `$${v.toFixed(6)}`
}

function fmtInt(v: number | null | undefined): string {
  return v == null ? UNKNOWN : v.toLocaleString('en-US')
}

/** "3分前" relative to the response's `now`; the exact time on hover. */
function relative(iso: string, now: string): string {
  const s = Math.max(0, Math.floor((Date.parse(now) - Date.parse(iso)) / 1000))
  if (!Number.isFinite(s)) return UNKNOWN
  if (s < 60) return `${s}秒前`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}分前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}時間前`
  return `${Math.floor(h / 24)}日前`
}

function Ago({
  iso,
  now,
  prefix,
}: {
  iso: string
  now: string
  prefix?: string
}) {
  return (
    <time dateTime={iso} title={iso} className="tabular-nums">
      {prefix}
      {relative(iso, now)}
    </time>
  )
}

const timeFmt = new Intl.DateTimeFormat('ja-JP', {
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

const COST_NOTE =
  '費用は記録したトークン数を API 料金で換算した参考値で、実際の請求額ではありません'

function retryLabel(retryable: boolean): string {
  return retryable
    ? 'できる。結果の分からない呼び出しは重ねて送らない'
    : 'しない。先に人が確認する'
}

// ---------------------------------------------------------------- state labels

type Tone = 'waiting' | 'failed' | 'running' | 'none'

const KIND_LABEL: Record<DiagnosisKind, { label: string; tone: Tone }> = {
  approval: { label: '承認待ち', tone: 'waiting' },
  'other-wait': { label: '入力待ち', tone: 'waiting' },
  stopped: { label: '停止', tone: 'failed' },
  running: { label: '実行中', tone: 'running' },
  pending: { label: '順番待ち', tone: 'none' },
  'lease-expired': { label: '担当が途切れた', tone: 'none' },
  decided: { label: '判断済み・再開待ち', tone: 'none' },
  finished: { label: '終了', tone: 'none' },
}

const CONCLUSION_LABEL: Record<string, { label: string; tone: Tone }> = {
  approved: { label: '承認', tone: 'none' },
  rejected: { label: '却下', tone: 'none' },
  'verification-failed': { label: '検証失敗', tone: 'failed' },
  'review-cap-reached': { label: 'レビュー上限', tone: 'failed' },
  failed: { label: '失敗', tone: 'failed' },
  cancelled: { label: '取り消し', tone: 'none' },
}

function conclusionOf(key: string): { label: string; tone: Tone } {
  return CONCLUSION_LABEL[key] ?? { label: key, tone: 'none' }
}

const TONE_CLASS: Record<Tone, string> = {
  waiting: 'bg-waiting-bg text-waiting',
  failed: 'bg-failed-bg text-failed',
  running: 'bg-running-bg text-running',
  none: 'bg-sunken text-fg-2',
}

/** A state name, always in words; color only for the three states. */
function StateBadge({ label, tone }: { label: string; tone: Tone }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-2 rounded-sm px-2 py-1 text-xs leading-4 font-medium ${TONE_CLASS[tone]}`}
    >
      {tone === 'running' ? (
        <span aria-hidden className="dot-live size-2 rounded-full bg-current" />
      ) : null}
      {label}
    </span>
  )
}

// ---------------------------------------------------------------- copy

/** Copy through the Clipboard API, or a hidden selection where it is refused. */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.append(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  }
}

function useCopy() {
  const [copied, setCopied] = useState<{ text: string; label: string } | null>(
    null,
  )
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = useCallback(async (text: string, label: string) => {
    setCopied((await writeClipboard(text)) ? { text, label } : null)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(null), 1600)
  }, [])
  return { copied, copy }
}

/** What a copy button says, from the command it copies. */
function commandLabel(command: string): string {
  if (/^git .* worktree remove /.test(command))
    return '作業ツリーの片付けコマンドをコピー'
  const sub = /\bdemo (\S+)/.exec(command)?.[1]
  switch (sub) {
    case 'approve':
      return '承認コマンドをコピー'
    case 'reject':
      return '却下コマンドをコピー'
    case 'report':
      return command.includes('--format json')
        ? 'JSON のレポートをコピー'
        : 'レポートをコピー'
    case 'status':
      return '状態確認コマンドをコピー'
    case 'worker':
      return 'ワーカー起動コマンドをコピー'
    case 'retrigger':
      return '再実行コマンドをコピー'
    case 'waits':
      return '待ち一覧コマンドをコピー'
    default:
      return 'コマンドをコピー'
  }
}

const BUTTON =
  'border-line-strong bg-raised text-fg-2 hover:text-fg inline-flex min-h-8 items-center rounded-md border px-3 text-xs transition-colors duration-[var(--duration-fast)] ease-[var(--ease-out)]'

/** A labelled copy button with a short confirmation beside it. */
function CopyButton({
  text,
  label,
  copied,
  onCopy,
}: {
  text: string
  label: string
  copied: { text: string } | null
  onCopy: (text: string, label: string) => void
}) {
  return (
    <span className="relative">
      <button
        type="button"
        onClick={() => onCopy(text, label)}
        className={BUTTON}
      >
        {label}
      </button>
      {copied?.text === text ? (
        <span
          aria-hidden
          className="bg-raised text-fg absolute top-full left-0 z-50 mt-1 rounded-sm px-2 py-1 text-xs whitespace-nowrap shadow-[var(--shadow-pop)]"
        >
          コピーしました
        </span>
      ) : null}
    </span>
  )
}

/** Names what was copied, for screen readers. */
function CopyAnnouncer({ copied }: { copied: { label: string } | null }) {
  return (
    <p className="sr-only" aria-live="polite">
      {copied ? `${copied.label}しました` : ''}
    </p>
  )
}

/**
 * Next commands as copy buttons named for what they do. The command text,
 * which carries IDs such as the wait ID, stays behind a disclosure.
 */
function Commands({ lines }: { lines: string[] }) {
  const { copied, copy } = useCopy()
  if (lines.length === 0) return null
  const commands = lines.map(commandText)
  const notes = lines.flatMap((line, i) => {
    const note = commandNote(line)
    const command = commands[i] as string
    return note ? [{ command, label: commandLabel(command), note }] : []
  })
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {commands.map((command) => (
          <CopyButton
            key={command}
            text={command}
            label={commandLabel(command)}
            copied={copied}
            onCopy={(t, l) => void copy(t, l)}
          />
        ))}
      </div>
      {notes.length > 0 && (
        <ul className="text-fg-2 flex flex-col gap-1 text-xs">
          {notes.map((n) => (
            <li key={n.command}>
              {n.label}：{n.note}
            </li>
          ))}
        </ul>
      )}
      <details className="text-xs">
        <summary className="text-fg-2 hover:text-fg inline-flex min-h-8 cursor-pointer items-center">
          コマンド全文
        </summary>
        <ul className="mt-1 flex flex-col gap-2">
          {commands.map((command) => (
            <li key={command}>
              <code className="bg-sunken font-code text-fg block overflow-x-auto rounded-sm px-2 py-1 text-sm whitespace-pre">
                {command}
              </code>
            </li>
          ))}
        </ul>
      </details>
      <CopyAnnouncer copied={copied} />
    </div>
  )
}

// ---------------------------------------------------------------- shell

/**
 * The refresh time is shown but never announced. Screen readers hear only a
 * change of state: an alert when refreshing starts failing, and a status
 * line once it works again.
 */
function RefreshStatus({ polled }: { polled: PollState<unknown> }) {
  const at = polled.fetchedAt ? timeFmt.format(polled.fetchedAt) : null
  const failing = polled.error !== null
  return (
    <div className="text-fg-2 text-xs">
      {failing ? (
        <>
          <p role="alert" className="sr-only">
            更新に失敗しました。直近の表示のままです。
          </p>
          <p>更新に失敗しました。{at ? `${at} 時点の表示のままです。` : ''}</p>
          <p className="font-code">{polled.error}</p>
        </>
      ) : (
        <p className="tabular-nums">
          {at ? `${at} 時点 · 3 秒ごとに更新` : '読み込み中…'}
        </p>
      )}
      <p role="status" className="sr-only">
        {polled.recovered ? '更新が再開しました' : ''}
      </p>
    </div>
  )
}

const PAGE_TITLE_ID = 'page-title'

function focusPageTitle() {
  document.getElementById(PAGE_TITLE_ID)?.focus()
}

function Shell({
  route,
  status,
  children,
}: {
  route: Route
  status: ReactNode
  children: ReactNode
}) {
  const nav = (href: string, label: string, current: boolean) => (
    <a
      href={href}
      aria-current={current ? 'page' : undefined}
      className={`inline-flex min-h-8 items-center rounded-md px-2 text-sm ${current ? 'bg-sunken text-fg font-medium' : 'text-fg-2 hover:text-fg'}`}
    >
      {label}
    </a>
  )
  return (
    <div className="min-h-screen">
      {/* The hash is the router, so the skip link moves focus itself. */}
      <button
        type="button"
        onClick={focusPageTitle}
        className="bg-raised text-fg sr-only z-50 rounded-md px-3 py-2 text-sm shadow-[var(--shadow-pop)] focus:not-sr-only focus:fixed focus:top-2 focus:left-2"
      >
        本文へ移動
      </button>
      <header className="border-line bg-canvas sticky top-0 z-20 border-b">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-1 px-4 py-2 sm:px-6">
          <span className="text-sm font-semibold">local-agent-loop</span>
          <nav aria-label="画面" className="flex gap-1">
            {nav('#/', '実行一覧', route.page !== 'compare')}
            {nav('#/compare', '集計', route.page === 'compare')}
          </nav>
          <div className="ml-auto">{status}</div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6">{children}</main>
    </div>
  )
}

/** The page's one h1; focus lands here when the route changes. */
function PageTitle({ children }: { children: ReactNode }) {
  return (
    <h1
      id={PAGE_TITLE_ID}
      tabIndex={-1}
      className="text-xl font-semibold text-balance focus-visible:outline-none"
    >
      {children}
    </h1>
  )
}

function Section({
  title,
  count,
  children,
}: {
  title: string
  count?: number
  children: ReactNode
}) {
  return (
    <section className="mb-8">
      <h2 className="mb-3 flex items-baseline gap-2 text-lg font-semibold">
        {title}
        {count !== undefined ? (
          <span className="text-fg-2 text-sm font-normal tabular-nums">
            {count}
          </span>
        ) : null}
      </h2>
      {children}
    </section>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="border-line-strong text-fg-2 rounded-lg border border-dashed px-4 py-3 text-sm">
      {children}
    </p>
  )
}

/** The last characters of a run ID: enough to tell runs apart at a glance. */
function IdSuffix({ id }: { id: string }) {
  return <span className="font-code text-fg-2 text-xs">…{id.slice(-6)}</span>
}

/** A run by its name, with the ID suffix as a quiet aside. */
function RunLink({ id, name }: { id: string; name: string }) {
  return (
    <span className="inline-flex min-w-0 items-baseline gap-2">
      <a
        href={`#/runs/${encodeURIComponent(id)}`}
        className="text-fg decoration-line-strong min-w-0 truncate font-medium underline underline-offset-2 hover:decoration-current"
      >
        {name}
      </a>
      <IdSuffix id={id} />
    </span>
  )
}

// ---------------------------------------------------------------- pipeline

const STAGE_CLASS: Record<PipelineState, string> = {
  done: 'text-fg',
  running: 'bg-running-bg text-running rounded-sm px-1 font-medium',
  waiting: 'bg-waiting-bg text-waiting rounded-sm px-1 font-medium',
  current: 'bg-sunken text-fg rounded-sm px-1 font-medium',
  stopped: 'bg-failed-bg text-failed rounded-sm px-1 font-medium',
  'not-reached': 'text-fg-3',
}

/**
 * Words beside the stage name, so a state never rests on color alone. A
 * done stage carries a check mark; a stage without one was not reached.
 */
const STAGE_SUFFIX: Partial<Record<PipelineState, string>> = {
  running: '実行中',
  waiting: '人待ち',
  stopped: '停止',
}

/**
 * The run's stages in their fixed order, on one line where it fits. Screen
 * readers hear the server's one-sentence summary instead of the chips.
 */
function Stepper({ pipeline }: { pipeline: Pipeline }) {
  return (
    <div className="text-xs leading-5">
      <p className="sr-only">{pipeline.label}</p>
      <ol aria-hidden className="flex flex-wrap items-center gap-x-1 gap-y-1">
        {pipeline.stages.map((s, i) => (
          <li key={s.stage} className="inline-flex items-center gap-1">
            {i > 0 ? <span className="text-fg-3">›</span> : null}
            <span
              className={`inline-flex items-center gap-1 whitespace-nowrap ${STAGE_CLASS[s.state]}`}
            >
              {s.state === 'running' ? (
                <span className="dot-live size-1.5 rounded-full bg-current" />
              ) : null}
              {s.state === 'done' ? <span>✓</span> : null}
              {stageName(s.stage)}
              {s.count > 1 ? (
                <span className="tabular-nums">×{s.count}</span>
              ) : null}
              {STAGE_SUFFIX[s.state] ? (
                <span className="font-normal">{STAGE_SUFFIX[s.state]}</span>
              ) : null}
            </span>
          </li>
        ))}
      </ol>
    </div>
  )
}

/** "0", "30秒", "1分30秒": short enough for an axis tick. */
function fmtTick(ms: number): string {
  if (ms === 0) return '0'
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}秒`
  const m = Math.floor(s / 60)
  if (m < 60) return s % 60 ? `${m}分${s % 60}秒` : `${m}分`
  return m % 60 ? `${Math.floor(m / 60)}時間${m % 60}分` : `${m / 60}時間`
}

const TICK_STEPS = [10, 20, 50, 100, 200, 500]
  .concat(
    [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600].map(
      (s) => s * 1000,
    ),
  )
  .concat([2, 3, 6, 12, 24].map((h) => h * 3_600_000))

/** At most five round ticks from 0 across the span. */
function ticks(spanMs: number): number[] {
  const step =
    TICK_STEPS.find((t) => spanMs / t <= 5) ?? TICK_STEPS.at(-1) ?? spanMs
  const out: number[] = []
  for (let t = 0; t < spanMs; t += step) out.push(t)
  return out
}

// ---------------------------------------------------------------- trace

const TRACE_STATE: Record<TraceState, { label: string; tone: Tone }> = {
  done: { label: '完了', tone: 'none' },
  running: { label: '実行中', tone: 'running' },
  waiting: { label: '人待ち', tone: 'waiting' },
  failed: { label: '失敗', tone: 'failed' },
  interrupted: { label: '中断', tone: 'none' },
  lost: { label: '担当が途切れた', tone: 'none' },
  idle: { label: '工程の合間', tone: 'none' },
}

const TONE_TEXT: Record<Tone, string> = {
  waiting: 'text-waiting',
  failed: 'text-failed',
  running: 'text-running',
  none: 'text-fg-3',
}

const INTERRUPTION_LABEL: Record<string, string> = {
  'lease-lost': 'ワーカーの担当期限が切れた',
  cancelled: '取り消された',
  unknown: UNKNOWN,
}

const CHECKPOINT_LABEL: Record<TraceCheckpoint, string> = {
  completed: '完了を記録',
  recovered: '記録した結果を再利用',
  uncertain: '開始だけ記録。結果は不確か',
  running: '実行中',
}

/** A 12px glyph per state; the state's word always sits beside it. */
function StateGlyph({ state }: { state: TraceState }) {
  const box = 'size-3 shrink-0'
  switch (state) {
    case 'running':
      return (
        <span
          aria-hidden
          className={`${box} text-running grid place-items-center`}
        >
          <span className="dot-live size-2 rounded-full bg-current" />
        </span>
      )
    case 'waiting':
      return (
        <svg aria-hidden viewBox="0 0 12 12" className={`${box} text-waiting`}>
          <rect
            x="3"
            y="2.5"
            width="2"
            height="7"
            rx="0.5"
            fill="currentColor"
          />
          <rect
            x="7"
            y="2.5"
            width="2"
            height="7"
            rx="0.5"
            fill="currentColor"
          />
        </svg>
      )
    case 'failed':
      return (
        <svg aria-hidden viewBox="0 0 12 12" className={`${box} text-failed`}>
          <path
            d="M3 3l6 6M9 3l-6 6"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
          />
        </svg>
      )
    case 'done':
      return (
        <svg aria-hidden viewBox="0 0 12 12" className={`${box} text-fg-3`}>
          <path
            d="M2.5 6.25l2.25 2.25L9.5 3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )
    case 'interrupted':
    case 'lost':
      return (
        <svg aria-hidden viewBox="0 0 12 12" className={`${box} text-fg-3`}>
          <path
            d="M3 6h6"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
          />
        </svg>
      )
    case 'idle':
      return (
        <svg aria-hidden viewBox="0 0 12 12" className={`${box} text-fg-3`}>
          <circle
            cx="6"
            cy="6"
            r="3.25"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.25"
          />
        </svg>
      )
  }
}

/**
 * The response's `now`, advanced by the time since it arrived, every second
 * while the run is open. It never reads the browser's wall clock, so a skewed
 * laptop clock cannot move the bars.
 */
function useLiveNow(serverNow: string, open: boolean): number {
  const base = useMemo(
    () => ({ server: Date.parse(serverNow), client: performance.now() }),
    [serverNow],
  )
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!open) return
    const timer = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [open])
  return open
    ? base.server + Math.max(0, performance.now() - base.client)
    : base.server
}

interface VisibleRow {
  node: TraceNode
  level: number
  parentId: string | null
  posinset: number
  setsize: number
}

/** Iterations and the run start expanded; retried attempts start folded. */
function expandedByDefault(node: TraceNode): boolean {
  return node.kind !== 'entry'
}

function flatten(
  node: TraceNode,
  isExpanded: (n: TraceNode) => boolean,
): VisibleRow[] {
  const out: VisibleRow[] = []
  const walk = (
    n: TraceNode,
    level: number,
    parentId: string | null,
    posinset: number,
    setsize: number,
  ) => {
    out.push({ node: n, level, parentId, posinset, setsize })
    if (n.children.length > 0 && isExpanded(n))
      n.children.forEach((c, i) =>
        walk(c, level + 1, n.id, i + 1, n.children.length),
      )
  }
  walk(node, 1, null, 1, 1)
  return out
}

/** The deepest row still running or waiting, through expanded rows only. */
function followTarget(
  root: TraceNode,
  isExpanded: (n: TraceNode) => boolean,
): TraceNode | null {
  let at: TraceNode | null = null
  let n: TraceNode | undefined = root
  while (n?.open) {
    at = n
    if (!isExpanded(n)) break
    n = [...n.children].reverse().find((c) => c.open)
  }
  return at === root ? null : at
}

function findNode(root: TraceNode, id: string): TraceNode | null {
  if (root.id === id) return root
  for (const c of root.children) {
    const hit = findNode(c, id)
    if (hit) return hit
  }
  return null
}

/** A row's times with any open end moved to the live clock. */
function liveTimes(node: TraceNode, elapsed: number) {
  const end = node.open ? Math.max(node.endMs ?? elapsed, elapsed) : node.endMs
  const duration =
    node.open && node.startMs !== null
      ? Math.max(node.durationMs ?? 0, elapsed - node.startMs)
      : node.durationMs
  return { start: node.startMs, end, duration }
}

function barClass(node: TraceNode): string {
  // The run and its iterations are plain spans of what they contain.
  if (node.kind === 'run' || node.kind === 'iteration')
    return node.state === 'failed' ? 'bg-failed/50' : 'bg-fg-3/35'
  if (node.wait)
    return node.open
      ? 'bar-hatch border border-dashed border-waiting'
      : 'bar-hatch-done border border-dashed border-fg-3'
  if (node.state === 'failed') return 'bg-failed'
  if (node.open) return 'bg-running bar-live'
  return 'bg-fg-3/60'
}

const BAR_HEIGHT: Record<TraceNode['kind'], string> = {
  run: 'h-1.5',
  iteration: 'h-1.5',
  entry: 'h-3',
  attempt: 'h-2',
}

/** "+15.0 秒": time from the run's start, tabular for the column. */
function fmtOffset(ms: number | null): string {
  return ms === null ? UNKNOWN : `+${fmtMs(ms)}`
}

function exact(iso: string | null): string | undefined {
  return iso ? `${new Date(iso).toLocaleString('ja-JP')}  ${iso}` : undefined
}

const TRACE_COLS =
  'grid grid-cols-[minmax(8rem,15rem)_5.5rem_minmax(4rem,1fr)] sm:grid-cols-[minmax(12rem,17rem)_7rem_minmax(8rem,1fr)]'

/**
 * The run as a span tree beside a waterfall on one time axis from the run's
 * creation, with the selected row's stored details alongside. The tree is a
 * keyboard treegrid that carries every value in text; the waterfall is a
 * drawing of the same values and is hidden from screen readers.
 */
function TraceView({
  trace,
  report,
  serverNow,
}: {
  trace: Trace
  report: LoopReport
  serverNow: string
}) {
  const liveNow = useLiveNow(serverNow, trace.open)
  const origin = Date.parse(trace.startedAt)
  const elapsed = trace.open ? Math.max(0, liveNow - origin) : trace.spanMs
  // An open run keeps a little room right of `now`, so the line is visible.
  const axisMs = Math.max(1, trace.open ? elapsed * 1.06 : trace.spanMs)

  const [overrides, setOverrides] = useState<Record<string, boolean>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [focusedId, setFocusedId] = useState<string>(trace.root.id)
  const [userScrolled, setUserScrolled] = useState(false)
  const scroller = useRef<HTMLDivElement | null>(null)
  const rowRefs = useRef(new Map<string, HTMLDivElement>())
  const programmatic = useRef(false)

  const isExpanded = useCallback(
    (n: TraceNode) => overrides[n.id] ?? expandedByDefault(n),
    [overrides],
  )
  const rows = useMemo(
    () => flatten(trace.root, isExpanded),
    [trace.root, isExpanded],
  )
  const follow = useMemo(
    () => followTarget(trace.root, isExpanded),
    [trace.root, isExpanded],
  )
  const selected =
    (selectedId ? findNode(trace.root, selectedId) : null) ??
    follow ??
    trace.root
  const focusIndex = Math.max(
    0,
    rows.findIndex((r) => r.node.id === focusedId),
  )
  const rovingId = rows[focusIndex]?.node.id ?? trace.root.id

  // Follow the running row until the person scrolls or picks a row.
  const followId = follow?.id ?? null
  useEffect(() => {
    const box = scroller.current
    const row = followId ? rowRefs.current.get(followId) : null
    if (!box || !row || userScrolled || selectedId !== null) return
    const top = row.offsetTop - box.clientHeight / 2
    if (Math.abs(box.scrollTop - top) < 4) return
    programmatic.current = true
    box.scrollTop = Math.max(0, top)
  }, [followId, serverNow, userScrolled, selectedId])

  const focusRow = (id: string) => {
    setFocusedId(id)
    rowRefs.current.get(id)?.focus()
  }
  const setExpanded = (id: string, value: boolean) =>
    setOverrides((o) => ({ ...o, [id]: value }))

  const onKeyDown = (e: KeyboardEvent, row: VisibleRow, i: number) => {
    const n = row.node
    const hasChildren = n.children.length > 0
    const open = hasChildren && isExpanded(n)
    const go = (index: number) => {
      const target = rows[Math.min(rows.length - 1, Math.max(0, index))]
      if (target) focusRow(target.node.id)
    }
    switch (e.key) {
      case 'ArrowDown':
        go(i + 1)
        break
      case 'ArrowUp':
        go(i - 1)
        break
      case 'Home':
        go(0)
        break
      case 'End':
        go(rows.length - 1)
        break
      case 'ArrowRight':
        if (hasChildren && !open) setExpanded(n.id, true)
        else if (open) go(i + 1)
        break
      case 'ArrowLeft':
        if (open) setExpanded(n.id, false)
        else if (row.parentId) focusRow(row.parentId)
        break
      case 'Enter':
      case ' ':
        setSelectedId(n.id)
        break
      default:
        return
    }
    e.preventDefault()
  }

  const marks = ticks(axisMs)
  const pctOf = (ms: number) => `${(ms / axisMs) * 100}%`

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="border-line min-w-0 overflow-hidden rounded-md border">
        <div
          ref={scroller}
          onScroll={() => {
            if (programmatic.current) programmatic.current = false
            else setUserScrolled(true)
          }}
          className="relative max-h-[32rem] overflow-auto"
        >
          <div
            aria-hidden
            className={`${TRACE_COLS} bg-raised border-line text-fg-2 sticky top-0 z-10 h-7 items-center border-b text-xs`}
          >
            <span className="px-2">工程</span>
            <span className="px-2 text-right">時間</span>
            <span className="relative h-full tabular-nums">
              {marks.map((m) => (
                <span
                  key={m}
                  className="absolute top-1/2 -translate-y-1/2 whitespace-nowrap"
                  style={{
                    left: pctOf(m),
                    // The first label starts at 0; one near the edge ends there.
                    transform:
                      m === 0
                        ? 'translateY(-50%)'
                        : m / axisMs > 0.92
                          ? 'translate(-100%, -50%)'
                          : 'translate(-50%, -50%)',
                  }}
                >
                  {fmtTick(m)}
                </span>
              ))}
            </span>
          </div>
          <div className="relative">
            {/* Tick lines and the `now` line, over the waterfall column only. */}
            <div
              aria-hidden
              className={`${TRACE_COLS} pointer-events-none absolute inset-0`}
            >
              <span />
              <span />
              <span className="relative">
                {marks.slice(1).map((m) => (
                  <span
                    key={m}
                    className="bg-line absolute inset-y-0 w-px"
                    style={{ left: pctOf(m) }}
                  />
                ))}
                {trace.open ? (
                  <span
                    className="bg-fg-2 absolute inset-y-0 w-px"
                    style={{ left: pctOf(elapsed) }}
                  />
                ) : null}
              </span>
            </div>
            <div
              role="treegrid"
              aria-label="工程の時系列"
              aria-readonly
              className="relative"
            >
              {rows.map((row, i) => {
                const n = row.node
                const t = liveTimes(n, elapsed)
                const state = TRACE_STATE[n.state]
                const hasChildren = n.children.length > 0
                const isOpen = hasChildren && isExpanded(n)
                const isSelected = selected.id === n.id
                return (
                  <div
                    key={n.id}
                    ref={(el) => {
                      if (el) rowRefs.current.set(n.id, el)
                      else rowRefs.current.delete(n.id)
                    }}
                    role="row"
                    aria-level={row.level}
                    aria-posinset={row.posinset}
                    aria-setsize={row.setsize}
                    aria-expanded={hasChildren ? isOpen : undefined}
                    aria-selected={isSelected}
                    tabIndex={n.id === rovingId ? 0 : -1}
                    onKeyDown={(e) => onKeyDown(e, row, i)}
                    onFocus={() => setFocusedId(n.id)}
                    onClick={() => {
                      setSelectedId(n.id)
                      setFocusedId(n.id)
                    }}
                    className={`${TRACE_COLS} h-7 cursor-default items-center text-sm focus-visible:rounded-none focus-visible:outline-offset-[-2px] ${isSelected ? 'bg-sunken' : 'hover:bg-sunken/60'}`}
                  >
                    <span
                      role="gridcell"
                      className="flex min-w-0 items-center gap-1.5 pr-2"
                      style={{ paddingLeft: `${(row.level - 1) * 12 + 4}px` }}
                    >
                      {hasChildren ? (
                        <span
                          aria-hidden
                          onClick={(e) => {
                            e.stopPropagation()
                            setExpanded(n.id, !isOpen)
                            setFocusedId(n.id)
                          }}
                          className="text-fg-3 hover:text-fg grid size-4 shrink-0 cursor-pointer place-items-center"
                        >
                          <svg
                            viewBox="0 0 12 12"
                            className={`size-3 transition-transform duration-[var(--duration-fast)] ${isOpen ? 'rotate-90' : ''}`}
                          >
                            <path
                              d="M4.5 3l3 3-3 3"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          </svg>
                        </span>
                      ) : (
                        <span aria-hidden className="size-4 shrink-0" />
                      )}
                      <StateGlyph state={n.state} />
                      <span
                        className={`truncate ${n.kind === 'iteration' || n.kind === 'run' ? 'font-medium' : ''} ${n.kind === 'attempt' ? 'text-fg-2' : ''}`}
                      >
                        {n.label}
                      </span>
                      {n.state !== 'done' ? (
                        <span
                          className={`shrink-0 text-xs ${TONE_TEXT[state.tone]}`}
                        >
                          {state.label}
                        </span>
                      ) : (
                        <span className="sr-only">{state.label}</span>
                      )}
                    </span>
                    <span
                      role="gridcell"
                      className="font-code text-fg-2 px-2 text-right text-xs whitespace-nowrap tabular-nums"
                    >
                      {fmtMs(t.duration)}
                      <span className="sr-only">
                        、開始から {fmtMs(t.start)}
                      </span>
                    </span>
                    <span aria-hidden className="relative h-full">
                      {t.start === null ? null : t.end === null ? (
                        <span
                          title="終了時刻は記録されていない"
                          className="border-fg-3 absolute inset-y-1.5 border-l-2 border-dotted"
                          style={{ left: pctOf(t.start) }}
                        />
                      ) : (
                        <span
                          className={`absolute top-1/2 min-w-0.5 -translate-y-1/2 rounded-sm ${BAR_HEIGHT[n.kind]} ${barClass(n)}`}
                          style={{
                            left: pctOf(t.start),
                            width: pctOf(Math.max(0, t.end - t.start)),
                          }}
                        />
                      )}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>
      <TraceInspector
        node={selected}
        chosen={selectedId !== null}
        report={report}
        elapsed={elapsed}
        origin={trace.startedAt}
      />
    </div>
  )
}

function InspectorField({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <div className="grid grid-cols-[6.5rem_1fr] gap-2 py-1">
      <dt className="text-fg-2 text-xs leading-5">{label}</dt>
      <dd className="min-w-0 text-sm break-words tabular-nums">{children}</dd>
    </div>
  )
}

function Num({ children }: { children: ReactNode }) {
  return <span className="font-code">{children}</span>
}

function UsageFields({
  u,
}: {
  u: Pick<UsageTotals, 'totalTokens' | 'costUsd' | 'complete'> & {
    invocations: number
    inputTokens?: number | null
    outputTokens?: number | null
  }
}) {
  const tag = (v: number | null | undefined) =>
    v == null || u.complete ? null : (
      <PartialTag title="使用量が分かった呼び出しだけの合計" />
    )
  return (
    <>
      <InspectorField label="モデル呼び出し">
        <Num>{u.invocations}</Num>
      </InspectorField>
      <InspectorField label="合計トークン">
        <Num>{fmtInt(u.totalTokens)}</Num>
        {tag(u.totalTokens)}
      </InspectorField>
      {u.inputTokens !== undefined ? (
        <InspectorField label="入力 / 出力">
          <Num>
            {fmtInt(u.inputTokens)} / {fmtInt(u.outputTokens)}
          </Num>
          {tag(u.inputTokens ?? u.outputTokens)}
        </InspectorField>
      ) : null}
      <InspectorField label="費用">
        <span title={COST_NOTE}>
          <Num>{fmtUsd(u.costUsd)}</Num>
        </span>
      </InspectorField>
    </>
  )
}

/** A time from the run's start; the exact time on hover. */
function Offset({ ms, iso }: { ms: number | null; iso: string | null }) {
  return (
    <span title={exact(iso)} className="font-code">
      {fmtOffset(ms)}
    </span>
  )
}

/** Stage, pass, attempts, and the row's times. */
function TimingFields({
  node: n,
  elapsed,
  leadTimeMs,
}: {
  node: TraceNode
  elapsed: number
  leadTimeMs: number | null
}) {
  const t = liveTimes(n, elapsed)
  const attempts =
    n.kind === 'attempt' ? (
      <InspectorField label="担当の世代">
        <Num>{n.leaseGeneration ?? UNKNOWN}</Num>
      </InspectorField>
    ) : n.kind === 'run' || n.wait ? null : (
      <InspectorField label="試行">
        <Num>{n.attempts}</Num>
      </InspectorField>
    )
  // A finished run's time is the report's lead time, to the millisecond.
  const duration = n.kind === 'run' && !n.open ? leadTimeMs : t.duration
  return (
    <>
      {n.stage ? (
        <InspectorField label="工程">{stageName(n.stage)}</InspectorField>
      ) : null}
      {n.iteration !== null && n.kind !== 'iteration' ? (
        <InspectorField label="回">{n.iteration}回目</InspectorField>
      ) : null}
      {attempts}
      <InspectorField label="開始">
        <Offset ms={t.start} iso={n.startedAt} />
      </InspectorField>
      <InspectorField label="終了">
        {n.open ? '終わっていない' : <Offset ms={t.end} iso={n.endedAt} />}
      </InspectorField>
      <InspectorField label={n.open ? '経過' : '時間'}>
        <Num>{fmtMs(duration)}</Num>
      </InspectorField>
      {n.interruptionReason ? (
        <InspectorField label="中断の理由">
          {INTERRUPTION_LABEL[n.interruptionReason] ?? n.interruptionReason}
        </InspectorField>
      ) : null}
    </>
  )
}

function ProfileFields({ profile: p }: { profile: TraceProfile }) {
  return (
    <>
      <InspectorField label="プロバイダー">
        {p.provider ?? UNKNOWN}
      </InspectorField>
      <InspectorField label="モデル">
        <Num>{p.model ?? '既定'}</Num>
      </InspectorField>
      <InspectorField label="推論量">
        <Num>{p.effort ?? '既定'}</Num>
      </InspectorField>
      {p.reportedModel && p.reportedModel !== p.model ? (
        <InspectorField label="報告されたモデル">
          <Num>{p.reportedModel}</Num>
        </InspectorField>
      ) : null}
    </>
  )
}

function CandidateFields({ candidate: c }: { candidate: ReportCandidate }) {
  return (
    <>
      <InspectorField label="候補">
        <Num>{c.id}</Num>
      </InspectorField>
      <InspectorField label="ブランチ">
        <Num>{c.branch ?? 'なし'}</Num>
      </InspectorField>
      <InspectorField label="コミット">
        <Num>{c.commit?.slice(0, 12) ?? 'なし'}</Num>
      </InspectorField>
    </>
  )
}

function WaitFields({
  node: n,
  wait: w,
  elapsed,
}: {
  node: TraceNode
  wait: NonNullable<TraceNode['wait']>
  elapsed: number
}) {
  const state = n.open
    ? '人の判断を待っている'
    : w.outcome === 'timeout'
      ? '期限切れ'
      : w.outcome === 'signal'
        ? '判断を受け取った'
        : UNKNOWN
  return (
    <>
      <InspectorField label="承認">{state}</InspectorField>
      <InspectorField label="人の待ち時間">
        <Num>
          {fmtMs(n.open ? liveTimes(n, elapsed).duration : w.inputWaitMs)}
        </Num>
      </InspectorField>
      {n.open ? null : (
        <InspectorField label="再開までの待ち">
          <Num>{fmtMs(w.executionSlotWaitMs)}</Num>
        </InspectorField>
      )}
    </>
  )
}

function ReviewBlock({ node: n }: { node: TraceNode }) {
  if (n.review)
    return (
      <div className="flex flex-col gap-1">
        <p className="text-sm">
          判定{' '}
          <span
            className="font-medium"
            title={reviewDecision(n.review.decision).title}
          >
            {reviewDecision(n.review.decision).label}
          </span>
        </p>
        <p className="bg-sunken max-h-48 overflow-auto rounded-md px-3 py-2 text-sm whitespace-pre-wrap">
          {n.review.notes}
        </p>
      </div>
    )
  return null
}

/** Reserved for the row's agent log; nothing is read into it yet. */
function LogSlot() {
  return (
    <section aria-labelledby="trace-log-slot" className="flex flex-col gap-1">
      <h4 id="trace-log-slot" className="text-fg-2 text-xs font-medium">
        ログ
      </h4>
      <p className="border-line-strong text-fg-3 rounded-md border border-dashed px-3 py-2 text-xs">
        この行のログは、まだここに表示しません。
      </p>
    </section>
  )
}

/** The selected row's stored details, and the slot where logs will go. */
function TraceInspector({
  node: n,
  chosen,
  report,
  elapsed,
  origin,
}: {
  node: TraceNode
  chosen: boolean
  report: LoopReport
  elapsed: number
  origin: string
}) {
  const state = TRACE_STATE[n.state]
  const s = report.summary
  const heading = chosen
    ? '選んだ行'
    : n.open
      ? '実行中の行'
      : '行を選ぶと詳細を表示'
  return (
    <aside
      aria-label="選んだ行の詳細"
      className="border-line flex min-w-0 flex-col gap-3 rounded-md border p-3"
    >
      <div className="flex flex-col gap-1">
        <p className="text-fg-3 text-xs">{heading}</p>
        <h3 className="flex flex-wrap items-center gap-2 text-base font-semibold">
          <span className="break-all">{n.label}</span>
          <StateBadge label={state.label} tone={state.tone} />
        </h3>
      </div>
      <dl className="divide-line flex flex-col divide-y">
        <TimingFields node={n} elapsed={elapsed} leadTimeMs={s.leadTimeMs} />
        {n.profile ? <ProfileFields profile={n.profile} /> : null}
        {n.kind === 'run' ? (
          // The whole run shows the report's own totals.
          <UsageFields
            u={{
              invocations: s.llmInvocations,
              totalTokens: s.totalTokens,
              costUsd: s.costUsd,
              complete: tokensComplete(report),
            }}
          />
        ) : n.usage ? (
          <UsageFields u={n.usage} />
        ) : null}
        {n.checkpoint ? (
          <InspectorField label="チェックポイント">
            {CHECKPOINT_LABEL[n.checkpoint]}
          </InspectorField>
        ) : null}
        {n.candidate ? <CandidateFields candidate={n.candidate} /> : null}
        {n.wait ? (
          <WaitFields node={n} wait={n.wait} elapsed={elapsed} />
        ) : null}
      </dl>
      {n.stage === 'review' && n.kind === 'entry' ? (
        <ReviewBlock node={n} />
      ) : null}
      <LogSlot />
      <p className="text-fg-3 text-xs">
        時刻は
        <time dateTime={origin} title={exact(origin)}>
          実行の開始
        </time>
        からの経過です。正確な時刻はホバーで出ます。
      </p>
    </aside>
  )
}

// ---------------------------------------------------------------- run list

/** The running stage, on a line of its own; the rest as secondary text. */
function LiveProgress({
  live,
  extra,
}: {
  live: LiveElapsed | null
  extra?: string
}) {
  const rest = [
    live?.stage ? `この工程 ${fmtMs(live.stageMs)} 経過` : null,
    live ? `全体 ${fmtMs(live.runMs)} 経過` : null,
    extra || null,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div className="flex flex-col gap-1">
      <p className="text-fg text-sm font-medium tabular-nums">
        {live?.stage
          ? `いまの工程: ${stageName(live.stage)}`
          : 'いまの工程: 工程の合間'}
      </p>
      {rest ? <p className="text-fg-2 text-xs tabular-nums">{rest}</p> : null}
    </div>
  )
}

/** An open or stopped run, with its reason and next commands. */
function OpenRun({ run, now }: { run: RunRow; now: string }) {
  const kind = KIND_LABEL[run.diagnosis.kind]
  const progress = [
    run.iterations > 0 ? `実装 ${run.iterations} 回目` : null,
    run.reviewRounds > 0 ? `レビュー ${run.reviewRounds} 回` : null,
  ]
    .filter(Boolean)
    .join(' · ')
  const running = run.diagnosis.kind === 'running'
  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <StateBadge label={kind.label} tone={kind.tone} />
        <h3 className="min-w-0 text-sm">
          <RunLink id={run.id} name={run.name} />
        </h3>
        <span className="text-fg-2 ml-auto text-xs">
          <Ago iso={run.createdAt} now={now} prefix="開始 " />
        </span>
      </div>
      <Stepper pipeline={run.pipeline} />
      {running ? <LiveProgress live={run.live} extra={progress} /> : null}
      <p className="text-fg-2 text-sm">
        {diagnosisText(run.diagnosis, run.uncertainCall)}
      </p>
      {!running && progress ? (
        <p className="text-fg-2 text-xs tabular-nums">{progress}</p>
      ) : null}
      {run.diagnosis.failure ? (
        <p className="text-fg-2 text-xs">
          再実行: {retryLabel(run.diagnosis.failure.retryable)}
        </p>
      ) : null}
      <Commands lines={run.diagnosis.next} />
    </li>
  )
}

function OpenList({ runs, now }: { runs: RunRow[]; now: string }) {
  return (
    <ul className="divide-line border-line bg-raised divide-y rounded-lg border">
      {runs.map((run) => (
        <OpenRun key={run.id} run={run} now={now} />
      ))}
    </ul>
  )
}

function Th({
  children,
  num,
  title,
}: {
  children: ReactNode
  num?: boolean
  title?: string
}) {
  return (
    <th
      scope="col"
      title={title}
      className={`text-fg-2 px-3 py-2 text-xs font-medium ${num ? 'text-right' : 'text-left'}`}
    >
      {children}
    </th>
  )
}

function Td({ children, num }: { children: ReactNode; num?: boolean }) {
  return (
    <td
      className={`px-3 py-2 align-top ${num ? 'font-code text-right tabular-nums' : ''}`}
    >
      {children}
    </td>
  )
}

function FinishedTable({ runs, now }: { runs: RunRow[]; now: string }) {
  return (
    <div className="border-line bg-raised overflow-x-auto rounded-lg border">
      <table className="w-full text-sm">
        <thead className="border-line border-b">
          <tr>
            <Th>タスク</Th>
            <Th>結果</Th>
            <Th num>所要時間</Th>
            <Th num title={COST_NOTE}>
              費用
            </Th>
            <Th>見立て</Th>
            <Th>開始</Th>
          </tr>
        </thead>
        <tbody className="divide-line divide-y">
          {runs.map((run) => {
            const c = conclusionOf(run.conclusion ?? run.status)
            return (
              <tr key={run.id}>
                <Td>
                  <span className="flex max-w-md flex-col gap-1">
                    <RunLink id={run.id} name={run.name} />
                    <Stepper pipeline={run.pipeline} />
                  </span>
                </Td>
                <Td>
                  <StateBadge label={c.label} tone={c.tone} />
                </Td>
                <Td num>{fmtMs(run.leadTimeMs)}</Td>
                <Td num>{fmtUsd(run.costUsd)}</Td>
                <Td>
                  {run.triage ? (
                    triageName(run.triage)
                  ) : (
                    <span className="text-fg-2">なし</span>
                  )}
                </Td>
                <Td>
                  <span className="text-fg-2 text-xs whitespace-nowrap">
                    <Ago iso={run.createdAt} now={now} />
                  </span>
                </Td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

function RunsPage({ data }: { data: RunsResponse }) {
  if (!data.exists)
    return (
      <Empty>
        データベースがまだありません。ワーカーを起動するか実行を登録すると{' '}
        <span className="font-code">{data.db}</span>{' '}
        に作られ、次の更新で表示されます。
      </Empty>
    )
  const human = data.runs.filter((r) => r.needsHuman)
  const open = data.runs.filter(
    (r) => !r.needsHuman && !TERMINAL_STATUSES.includes(r.status),
  )
  const finished = data.runs.filter((r) => TERMINAL_STATUSES.includes(r.status))
  return (
    <>
      <Section title="人の手が要る実行" count={human.length}>
        {human.length > 0 ? (
          <OpenList runs={human} now={data.now} />
        ) : (
          <Empty>承認待ちや停止した実行はありません。</Empty>
        )}
      </Section>
      <Section title="動いている実行" count={open.length}>
        {open.length > 0 ? (
          <OpenList runs={open} now={data.now} />
        ) : (
          <Empty>動いている実行も、順番を待つ実行もありません。</Empty>
        )}
      </Section>
      <Section title="終わった実行" count={finished.length}>
        {finished.length > 0 ? (
          <FinishedTable runs={finished} now={data.now} />
        ) : (
          <Empty>終わった実行はまだありません。</Empty>
        )}
      </Section>
    </>
  )
}

// ---------------------------------------------------------------- run detail

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-fg-2 text-xs">{label}</dt>
      <dd className="font-code text-sm break-all tabular-nums">{children}</dd>
    </div>
  )
}

function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-line bg-raised rounded-lg border p-4">
      <h2 className="mb-3 text-base font-semibold">{title}</h2>
      {children}
    </section>
  )
}

/**
 * Whether the run's token total covers every call: it is the sum of the
 * stage totals, so it is partial when any stage's is.
 */
function tokensComplete(report: LoopReport): boolean {
  return report.stageUsage.every((u) => u.complete)
}

/** Marks a value that covers only part of what it counts. */
function PartialTag({ title }: { title: string }) {
  return (
    <span title={title} className="text-fg-3 font-ui ml-1 text-xs">
      一部
    </span>
  )
}

const TOKEN_KEYS = [
  'inputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'outputTokens',
  'totalTokens',
] as const

/** Token counts, marked when only some calls reported usage. */
function UsageCells({ u }: { u: UsageTotals }) {
  return (
    <>
      <Td num>{u.invocations}</Td>
      {TOKEN_KEYS.map((key) => (
        <Td key={key} num>
          {fmtInt(u[key])}
          {u[key] == null || u.complete ? null : (
            <PartialTag title="使用量が分かった呼び出しだけの合計" />
          )}
        </Td>
      ))}
      <Td num>{fmtUsd(u.costUsd)}</Td>
    </>
  )
}

const USAGE_HEAD = (
  <>
    <Th num>呼び出し</Th>
    <Th num>入力</Th>
    <Th num>キャッシュ読み</Th>
    <Th num>キャッシュ書き</Th>
    <Th num>出力</Th>
    <Th num>合計トークン</Th>
    <Th num>費用</Th>
  </>
)

function StageTimings({ report }: { report: LoopReport }) {
  const max = Math.max(1, ...report.stageTimings.map((t) => t.elapsedMs ?? 0))
  if (report.stageTimings.length === 0)
    return <Empty>まだ完了した工程がありません。</Empty>
  return (
    <ul className="flex flex-col gap-2">
      {report.stageTimings.map((t) => (
        <li
          key={t.stage}
          className="grid grid-cols-[6rem_1fr_9rem] items-center gap-3"
        >
          <span className="text-sm">{stageName(t.stage)}</span>
          <span className="bg-sunken h-2 rounded-sm" aria-hidden>
            <span
              className="bg-fg-3/60 block h-full rounded-sm"
              style={{ width: `${((t.elapsedMs ?? 0) / max) * 100}%` }}
            />
          </span>
          <span className="font-code text-right text-sm tabular-nums">
            {t.elapsedMs == null ? (
              UNKNOWN
            ) : (
              <>
                {fmtMs(t.elapsedMs)}
                {t.complete ? null : (
                  <PartialTag title="一部の区間だけを計測した値" />
                )}
              </>
            )}
          </span>
        </li>
      ))}
      <li className="border-line grid grid-cols-[6rem_1fr_9rem] gap-3 border-t pt-2 text-sm">
        <span>工程合計</span>
        <span />
        <span className="font-code text-right tabular-nums">
          {fmtMs(report.stageTotalMs)}
        </span>
      </li>
    </ul>
  )
}

function StatusPanel({ data }: { data: RunDetailResponse }) {
  return (
    <Panel title="いまの状態と次の手順">
      <p className="mb-3 text-sm">
        {diagnosisText(data.diagnosis, data.uncertainCall)}
      </p>
      {data.diagnosis.kind === 'running' ? (
        <div className="mb-3">
          <LiveProgress live={data.live} />
        </div>
      ) : null}
      {data.diagnosis.failure ? (
        <dl className="mb-3 flex flex-col gap-2">
          <Field label="再実行">
            {retryLabel(data.diagnosis.failure.retryable)}
          </Field>
          <Field label="人が確認すること">
            <span className="font-ui">
              {humanCheckText(data.diagnosis.failure.kind)}
            </span>
          </Field>
          {data.diagnosis.failure.details.map(detailField).map((d) => (
            <Field key={d.value} label={d.label}>
              {d.value}
            </Field>
          ))}
        </dl>
      ) : null}
      <Commands lines={data.diagnosis.next} />
      {data.diagnosis.cleanup ? (
        <div className="mt-3">
          <p className="text-fg-2 mb-2 text-xs">
            作業ツリーを片付けるコマンドです。ブランチは残ります。変更が残っている作業ツリーは
            git が削除を拒否します。
          </p>
          <Commands lines={[data.diagnosis.cleanup]} />
        </div>
      ) : null}
    </Panel>
  )
}

function SummaryPanel({ report: r }: { report: LoopReport }) {
  const s = r.summary
  return (
    <Panel title="まとめ">
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Field label="結果">
          {s.conclusion ? conclusionOf(s.conclusion).label : 'まだない'}
        </Field>
        <Field label="所要時間">{fmtMs(s.leadTimeMs)}</Field>
        <Field label="工程の作業時間">{fmtMs(s.workMs)}</Field>
        <Field label="人の待ち時間">{fmtMs(s.humanWaitMs)}</Field>
        <Field label="合計トークン">
          {fmtInt(s.totalTokens)}
          {s.totalTokens == null || tokensComplete(r) ? null : (
            <PartialTag title="使用量が分かった呼び出しだけの合計" />
          )}
        </Field>
        <Field label="費用">{fmtUsd(s.costUsd)}</Field>
        <Field label="修正 / レビュー回数">
          {s.repairs} / {s.reviewRounds}
        </Field>
        <Field label="見立て">
          <span className="font-ui">
            {r.triage ? triageName(r.triage.judgment) : 'なし'}
          </span>
        </Field>
      </dl>
      {r.triage ? (
        <div className="text-fg-2 mt-3 flex flex-col gap-1">
          <p className="text-sm">{r.triage.reason}</p>
          <p className="text-xs">
            見立ては記録するだけで、進め方は変えません。
          </p>
        </div>
      ) : null}
    </Panel>
  )
}

function UsagePanels({ report: r }: { report: LoopReport }) {
  return (
    <>
      <Panel title="工程ごとのトークンと費用">
        {r.stageUsage.length === 0 ? (
          <Empty>まだモデルの呼び出しがありません。</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-line border-b">
                <tr>
                  <Th>工程</Th>
                  {USAGE_HEAD}
                </tr>
              </thead>
              <tbody className="divide-line divide-y">
                {r.stageUsage.map((u) => (
                  <tr key={u.stage}>
                    <Td>{stageName(u.stage)}</Td>
                    <UsageCells u={u} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="役割ごとのトークンと費用">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-line border-b">
              <tr>
                <Th>役割</Th>
                <Th>プロバイダー / 指定モデル / 指定推論量</Th>
                {USAGE_HEAD}
              </tr>
            </thead>
            <tbody className="divide-line divide-y">
              {r.roleUsage.map((u) => (
                <tr key={u.role}>
                  <Td>{roleName(u.role)}</Td>
                  <Td>
                    <span className="font-code text-xs">
                      {u.provider ?? UNKNOWN} / {u.requestedModel ?? '既定'} /{' '}
                      {u.requestedEffort ?? '既定'}
                    </span>
                  </Td>
                  <UsageCells u={u} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-fg-2 mt-3 text-xs">
          {COST_NOTE}
          。「不明」は使用量か価格が分からない呼び出しを含むことを、「一部」の印は分かった分だけの値であることを示します。
        </p>
      </Panel>
    </>
  )
}

function ReviewsPanel({ report: r }: { report: LoopReport }) {
  return (
    <Panel title="レビュー">
      {r.reviews.length === 0 ? (
        <Empty>まだ終わったレビューがありません。</Empty>
      ) : (
        <ul className="flex flex-col gap-3">
          {r.reviews.map((review) => (
            <li key={review.lens} className="flex flex-col gap-1">
              <p className="text-sm">
                <span className="font-medium">{lensName(review.lens)}</span>
                <span
                  className="text-fg-2"
                  title={reviewDecision(review.decision).title}
                >
                  {' · '}
                  {reviewDecision(review.decision).label}
                </span>
              </p>
              <p className="bg-sunken rounded-md px-3 py-2 text-sm whitespace-pre-wrap">
                {review.notes}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

const INPUT_NAME = {
  task: 'タスク',
  spec: '仕様',
  dispositions: '指摘の扱い',
} as const

function RecordPanels({ report: r }: { report: LoopReport }) {
  return (
    <>
      <div className="grid gap-6 md:grid-cols-2">
        <Panel title="候補">
          {r.candidate ? (
            <dl className="flex flex-col gap-2">
              <Field label="ID">{r.candidate.id}</Field>
              <Field label="ブランチ">{r.candidate.branch ?? 'なし'}</Field>
              <Field label="コミット">{r.candidate.commit ?? 'なし'}</Field>
            </dl>
          ) : (
            <Empty>まだ候補がありません。</Empty>
          )}
        </Panel>
        <Panel title="納品物">
          {r.delivery ? (
            <dl className="flex flex-col gap-2">
              <Field label="種類">{r.delivery.kind}</Field>
              <Field label="場所">{r.delivery.location}</Field>
              <Field label="ブランチ">{r.delivery.branch ?? 'なし'}</Field>
              <Field label="コミット">{r.delivery.commit ?? 'なし'}</Field>
              <Field label="概要">
                <span className="font-ui">{r.delivery.summary}</span>
              </Field>
            </dl>
          ) : (
            <Empty>納品物はありません。</Empty>
          )}
        </Panel>
      </div>

      <Panel title="入力ファイル">
        <p className="text-fg-2 mb-3 text-xs">
          値は保存した内容の SHA-256 とファイルの場所です。
        </p>
        <dl className="flex flex-col gap-2">
          {(['task', 'spec', 'dispositions'] as const).map((name) => {
            const file = r.inputs[name]
            return (
              <Field key={name} label={INPUT_NAME[name]}>
                {file ? `${file.sha256}  ${file.path}` : '指定なし'}
              </Field>
            )
          })}
        </dl>
      </Panel>

      {r.notes.length > 0 ? (
        <Panel title="注記">
          <ul className="text-fg-2 flex list-disc flex-col gap-1 pl-4 text-sm">
            {r.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </>
  )
}

/** Everything under the run's name, which `PolledPage` renders as the h1. */
function RunPage({ data }: { data: RunDetailResponse }) {
  const r = data.report
  const kind = KIND_LABEL[data.diagnosis.kind]
  const { copied, copy } = useCopy()
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <StateBadge label={kind.label} tone={kind.tone} />
          <span className="text-fg-2 text-sm">
            <Ago iso={data.createdAt} now={data.now} prefix="開始 " />
          </span>
          {r.fake ? (
            <span className="text-fg-2 text-xs">
              模擬の実行で、実際のモデルでは検証していません
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-fg-2 text-xs">実行 ID</span>
          <code className="font-code text-fg-2 text-xs break-all">
            {r.runId}
          </code>
          <CopyButton
            text={r.runId}
            label="実行 ID をコピー"
            copied={copied}
            onCopy={(t, l) => void copy(t, l)}
          />
          <CopyAnnouncer copied={copied} />
        </div>
        <Stepper pipeline={data.pipeline} />
      </div>

      <StatusPanel data={data} />

      <SummaryPanel report={r} />

      <Panel title="工程の時系列">
        <TraceView trace={data.trace} report={r} serverNow={data.now} />
      </Panel>

      <Panel title="工程ごとの時間">
        <StageTimings report={r} />
      </Panel>

      <UsagePanels report={r} />

      <ReviewsPanel report={r} />

      <RecordPanels report={r} />
    </div>
  )
}

// ---------------------------------------------------------------- compare

function StatRow({
  label,
  stat,
  f,
}: {
  label: string
  stat: Stat
  f: (v: number | null) => string
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

const STAT_HEAD = (
  <>
    <Th num>中央値</Th>
    <Th num>最小</Th>
    <Th num>最大</Th>
    <Th num>件数</Th>
    <Th num>不明</Th>
  </>
)

function ComparePage({ data }: { data: CompareResponse }) {
  const groups = data.comparison.groups
  if (groups.length === 0)
    return <Empty>終わった実行がまだないので、集計するものがありません。</Empty>
  return (
    <div className="flex flex-col gap-6">
      <p className="text-fg-2 text-sm">
        終わった実行 {data.runIds.length}{' '}
        件を設定のまとまりごとに集計しています。不明な値は 0
        として扱わず、統計から除いて「不明」の列に数えます。費用は API
        換算の参考値です。
      </p>
      {groups.map((g) => (
        <Panel
          key={g.configVersion ?? g.label}
          title={`${g.label} · 設定 ${g.configVersion ?? '版なし'}`}
        >
          <p className="mb-3 text-sm">
            {g.runs} 件 · 成功 {g.successes} · 成功率{' '}
            {(g.successRate * 100).toFixed(0)}% ·{' '}
            {Object.entries(g.conclusions)
              .map(([c, n]) => `${conclusionOf(c).label} ${n}`)
              .join(' · ')}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-line border-b">
                <tr>
                  <Th>指標</Th>
                  {STAT_HEAD}
                </tr>
              </thead>
              <tbody className="divide-line divide-y">
                <StatRow label="所要時間" stat={g.leadTimeMs} f={fmtMs} />
                <StatRow label="工程の作業時間" stat={g.workMs} f={fmtMs} />
                <StatRow label="人の待ち時間" stat={g.humanWaitMs} f={fmtMs} />
                <StatRow label="合計トークン" stat={g.totalTokens} f={fmtInt} />
                <StatRow label="費用" stat={g.costUsd} f={fmtUsd} />
                <StatRow
                  label="成功 1 件の費用"
                  stat={g.costPerSuccessUsd}
                  f={fmtUsd}
                />
                <StatRow label="修正回数" stat={g.repairs} f={fmtInt} />
              </tbody>
            </table>
          </div>
          {g.stages.length > 0 ? (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-line border-b">
                  <tr>
                    <Th>工程</Th>
                    <Th num>作業時間 中央値 [最小–最大]</Th>
                    <Th num>費用 中央値 [最小–最大]</Th>
                    <Th num>時間の不明</Th>
                    <Th num>費用の不明</Th>
                  </tr>
                </thead>
                <tbody className="divide-line divide-y">
                  {g.stages.map((st) => (
                    <tr key={st.stage}>
                      <Td>{stageName(st.stage)}</Td>
                      <Td num>
                        {st.workMs.median === null
                          ? UNKNOWN
                          : `${fmtMs(st.workMs.median)} [${fmtMs(st.workMs.min)}–${fmtMs(st.workMs.max)}]`}
                      </Td>
                      <Td num>
                        {st.costUsd.median === null
                          ? UNKNOWN
                          : `${fmtUsd(st.costUsd.median)} [${fmtUsd(st.costUsd.min)}–${fmtUsd(st.costUsd.max)}]`}
                      </Td>
                      <Td num>{st.workMs.unknown}</Td>
                      <Td num>{st.costUsd.unknown}</Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {g.triage.length > 0 ? (
            <div className="mt-4 overflow-x-auto">
              <p className="text-fg-2 mb-2 text-xs">
                見立ての判定別。見立ては記録するだけなので、判定で進め方は変わっていません。
              </p>
              <table className="w-full text-sm">
                <thead className="border-line border-b">
                  <tr>
                    <Th>判定</Th>
                    <Th num>件数</Th>
                    <Th num>承認</Th>
                    <Th num>検証失敗</Th>
                    <Th num>レビュー上限</Th>
                    <Th num>修正回数 中央値</Th>
                    <Th num>費用 中央値</Th>
                    <Th num>定型なのに修正か上限</Th>
                  </tr>
                </thead>
                <tbody className="divide-line divide-y">
                  {g.triage.map((t) => (
                    <tr key={t.judgment}>
                      <Td>{triageName(t.judgment)}</Td>
                      <Td num>{t.runs}</Td>
                      <Td num>{t.approved}</Td>
                      <Td num>{t.verificationFailed}</Td>
                      <Td num>{t.reviewCapReached}</Td>
                      <Td num>{fmtInt(t.repairs.median)}</Td>
                      <Td num>{fmtUsd(t.costUsd.median)}</Td>
                      <Td num>
                        {t.judgment === 'routine' ? t.routineNeedingMore : '–'}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </Panel>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- pages

/**
 * One polled page under its h1. The h1 stays the same element from loading
 * to loaded, so focus moved to it on a route change is not lost.
 */
function PolledPage<T>({
  route,
  url,
  heading,
  back,
  render,
}: {
  route: Route
  url: string
  heading: (data: T | null) => ReactNode
  back?: boolean
  render: (data: T) => ReactNode
}) {
  const polled = usePolled<T>(url)
  return (
    <Shell route={route} status={<RefreshStatus polled={polled} />}>
      <div className="mb-6 flex flex-col gap-2">
        {back ? (
          <a
            href="#/"
            className="text-fg-2 hover:text-fg inline-flex min-h-8 items-center self-start text-sm"
          >
            ← 実行一覧
          </a>
        ) : null}
        <PageTitle>{heading(polled.data)}</PageTitle>
      </div>
      {polled.data ? (
        render(polled.data)
      ) : polled.error ? (
        <Empty>読み込めませんでした: {polled.error}</Empty>
      ) : (
        <p className="text-fg-2 text-sm">読み込み中…</p>
      )}
    </Shell>
  )
}

function routeKey(route: Route): string {
  return route.page === 'run' ? `run:${route.id}` : route.page
}

/** After a route change (not the first load), focus the new page's h1. */
function useFocusOnRouteChange(route: Route) {
  const key = routeKey(route)
  const previous = useRef<string | null>(null)
  useEffect(() => {
    if (previous.current !== null && previous.current !== key) focusPageTitle()
    previous.current = key
  }, [key])
}

export function App() {
  const route = useRoute()
  useFocusOnRouteChange(route)
  // Keyed by URL, so moving to another page stops the old page's polling
  // and never shows one run's data under another's address.
  if (route.page === 'run') {
    const url = `/api/runs/${encodeURIComponent(route.id)}`
    return (
      <PolledPage<RunDetailResponse>
        key={url}
        route={route}
        url={url}
        back
        heading={(data) => data?.name ?? '実行の詳細'}
        render={(data) => <RunPage data={data} />}
      />
    )
  }
  if (route.page === 'compare')
    return (
      <PolledPage<CompareResponse>
        key="compare"
        route={route}
        url="/api/compare"
        heading={() => '集計'}
        render={(data) => <ComparePage data={data} />}
      />
    )
  return (
    <PolledPage<RunsResponse>
      key="runs"
      route={route}
      url="/api/runs"
      heading={() => '実行一覧'}
      render={(data) => <RunsPage data={data} />}
    />
  )
}
