/**
 * The factory's read-only web UI: runs that need a person first, then open
 * runs, then finished ones; one run's report; and the comparison of finished
 * runs by config version. Every value is shown as the API returns it from
 * `diagnose`, `buildReport` and `compareReports`; nothing is recomputed here.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'

import type { Stat } from '../engine/compare'
import type { LiveElapsed, LoopReport, UsageTotals } from '../engine/report'
import type { DiagnosisKind } from '../engine/status'
import { TERMINAL_STATUSES } from '../engine/terminal'
import { pollJson } from './poll'
import type {
  CompareResponse,
  RunDetailResponse,
  RunRow,
  RunsResponse,
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

function retryLabel(retryable: boolean): string {
  return retryable
    ? 'できる（結果の分からない呼び出しを重ねない）'
    : 'しない — 先に人が確認する'
}

/** The command itself, without the CLI's trailing `  # note`. */
function splitCommand(line: string): { command: string; note: string | null } {
  const at = line.indexOf('  # ')
  return at < 0
    ? { command: line, note: null }
    : { command: line.slice(0, at), note: line.slice(at + 4) }
}

// ---------------------------------------------------------------- state labels

type Tone = 'waiting' | 'failed' | 'running' | 'none'

const KIND_LABEL: Record<DiagnosisKind, { label: string; tone: Tone }> = {
  approval: { label: '承認待ち', tone: 'waiting' },
  'other-wait': { label: '入力待ち', tone: 'waiting' },
  stopped: { label: '停止', tone: 'failed' },
  running: { label: '実行中', tone: 'running' },
  pending: { label: '未処理（worker 待ち）', tone: 'none' },
  'lease-expired': { label: 'lease 期限切れ', tone: 'none' },
  decided: { label: '判断記録済み・再開待ち', tone: 'none' },
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
    return 'worktree 片付けコマンドをコピー'
  const sub = /\bdemo (\S+)/.exec(command)?.[1]
  switch (sub) {
    case 'approve':
      return '承認コマンドをコピー'
    case 'reject':
      return '却下コマンドをコピー'
    case 'report':
      return command.includes('--format json')
        ? 'report（JSON）をコピー'
        : 'report をコピー'
    case 'status':
      return 'status をコピー'
    case 'worker':
      return 'worker 起動コマンドをコピー'
    case 'retrigger':
      return 'retrigger コマンドをコピー'
    case 'waits':
      return 'waits をコピー'
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
  const parsed = lines.map(splitCommand)
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {parsed.map(({ command }) => (
          <CopyButton
            key={command}
            text={command}
            label={commandLabel(command)}
            copied={copied}
            onCopy={(t, l) => void copy(t, l)}
          />
        ))}
      </div>
      <details className="text-xs">
        <summary className="text-fg-2 hover:text-fg inline-flex min-h-8 cursor-pointer items-center">
          コマンド全文
        </summary>
        <ul className="mt-1 flex flex-col gap-2">
          {parsed.map(({ command, note }) => (
            <li key={command}>
              <code className="bg-sunken font-code text-fg block overflow-x-auto rounded-sm px-2 py-1 text-sm whitespace-pre">
                {command}
              </code>
              {note ? <p className="text-fg-2 mt-1"># {note}</p> : null}
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
          <p>
            更新失敗（{polled.error}）。{at ? `${at} 時点の表示のままです` : ''}
          </p>
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
            {nav('#/', 'run 一覧', route.page !== 'compare')}
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
  return (
    <span className="font-code text-fg-2 text-xs" title={id}>
      …{id.slice(-6)}
    </span>
  )
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
    live ? `全体 ${fmtMs(live.runMs)} 経過（実行中）` : null,
    extra || null,
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <div className="flex flex-col gap-1">
      <p className="text-fg text-sm font-medium tabular-nums">
        {live?.stage
          ? `いまの工程: ${live.stage}（${fmtMs(live.stageMs)} 経過・実行中）`
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
          <Ago iso={run.createdAt} now={now} prefix="作成 " />
        </span>
      </div>
      {running ? <LiveProgress live={run.live} extra={progress} /> : null}
      <p className="text-fg-2 text-sm">{run.diagnosis.reason}</p>
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

function Th({ children, num }: { children: ReactNode; num?: boolean }) {
  return (
    <th
      scope="col"
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
            <Th>run</Th>
            <Th>結論</Th>
            <Th num>所要時間</Th>
            <Th num>費用（API 換算）</Th>
            <Th>triage</Th>
            <Th>作成</Th>
          </tr>
        </thead>
        <tbody className="divide-line divide-y">
          {runs.map((run) => {
            const c = conclusionOf(run.conclusion ?? run.status)
            return (
              <tr key={run.id}>
                <Td>
                  <span className="block max-w-md">
                    <RunLink id={run.id} name={run.name} />
                  </span>
                </Td>
                <Td>
                  <StateBadge label={c.label} tone={c.tone} />
                </Td>
                <Td num>{fmtMs(run.leadTimeMs)}</Td>
                <Td num>{fmtUsd(run.costUsd)}</Td>
                <Td>{run.triage ?? <span className="text-fg-2">なし</span>}</Td>
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
        データベースがまだありません（
        <span className="font-code">{data.db}</span>）。worker か trigger
        を実行すると作られ、次の更新で表示されます。
      </Empty>
    )
  const human = data.runs.filter((r) => r.needsHuman)
  const open = data.runs.filter(
    (r) => !r.needsHuman && !TERMINAL_STATUSES.includes(r.status),
  )
  const finished = data.runs.filter((r) => TERMINAL_STATUSES.includes(r.status))
  return (
    <>
      <Section title="人の判断が必要" count={human.length}>
        {human.length > 0 ? (
          <OpenList runs={human} now={data.now} />
        ) : (
          <Empty>承認待ちや停止した run はありません。</Empty>
        )}
      </Section>
      <Section title="進行中" count={open.length}>
        {open.length > 0 ? (
          <OpenList runs={open} now={data.now} />
        ) : (
          <Empty>動いている run も、worker を待つ run もありません。</Empty>
        )}
      </Section>
      <Section title="終了した run" count={finished.length}>
        {finished.length > 0 ? (
          <FinishedTable runs={finished} now={data.now} />
        ) : (
          <Empty>終了した run はまだありません。</Empty>
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
          {u[key] == null || u.complete
            ? fmtInt(u[key])
            : `${fmtInt(u[key])}（一部）`}
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
    <Th num>cache 読み</Th>
    <Th num>cache 書き</Th>
    <Th num>出力</Th>
    <Th num>合計 token</Th>
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
          <span className="text-sm">{t.stage}</span>
          <span className="bg-sunken h-2 rounded-sm" aria-hidden>
            <span
              className="bg-fg-3/60 block h-full rounded-sm"
              style={{ width: `${((t.elapsedMs ?? 0) / max) * 100}%` }}
            />
          </span>
          <span className="font-code text-right text-sm tabular-nums">
            {t.elapsedMs == null
              ? UNKNOWN
              : t.complete
                ? fmtMs(t.elapsedMs)
                : `${fmtMs(t.elapsedMs)}（一部のみ計測）`}
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
      <p className="mb-3 text-sm">{data.diagnosis.reason}</p>
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
            <span className="font-ui">{data.diagnosis.failure.humanCheck}</span>
          </Field>
          {data.diagnosis.failure.details.map((d) => (
            <Field key={d} label="詳細">
              {d}
            </Field>
          ))}
        </dl>
      ) : null}
      <Commands lines={data.diagnosis.next} />
      {data.diagnosis.cleanup ? (
        <div className="mt-3">
          <p className="text-fg-2 mb-2 text-xs">
            worktree の片付け（branch は残る。変更のある worktree は git
            が拒否する）
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
        <Field label="結論">
          {s.conclusion ? conclusionOf(s.conclusion).label : 'まだない'}
        </Field>
        <Field label="所要時間（確定値）">{fmtMs(s.leadTimeMs)}</Field>
        <Field label="工程の作業時間">{fmtMs(s.workMs)}</Field>
        <Field label="人の待ち時間">{fmtMs(s.humanWaitMs)}</Field>
        <Field label="合計 token">{fmtInt(s.totalTokens)}</Field>
        <Field label="費用（API 換算）">{fmtUsd(s.costUsd)}</Field>
        <Field label="修正 / レビュー回数">
          {s.repairs} / {s.reviewRounds}
        </Field>
        <Field label="triage（記録のみ）">
          {r.triage ? r.triage.judgment : 'なし'}
        </Field>
      </dl>
      {r.triage ? (
        <p className="text-fg-2 mt-3 text-sm">{r.triage.reason}</p>
      ) : null}
    </Panel>
  )
}

function UsagePanels({ report: r }: { report: LoopReport }) {
  return (
    <>
      <Panel title="工程ごとの token と費用">
        {r.stageUsage.length === 0 ? (
          <Empty>まだ LLM 呼び出しがありません。</Empty>
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
                    <Td>{u.stage}</Td>
                    <UsageCells u={u} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="役割ごとの token と費用">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-line border-b">
              <tr>
                <Th>役割</Th>
                <Th>provider / model / effort（指定）</Th>
                {USAGE_HEAD}
              </tr>
            </thead>
            <tbody className="divide-line divide-y">
              {r.roleUsage.map((u) => (
                <tr key={u.role}>
                  <Td>{u.role}</Td>
                  <Td>
                    <span className="font-code text-xs">
                      {u.provider ?? UNKNOWN} / {u.requestedModel ?? '（既定）'}{' '}
                      / {u.requestedEffort ?? '（既定）'}
                    </span>
                  </Td>
                  <UsageCells u={u} />
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-fg-2 mt-3 text-xs">
          費用は記録した token 数を API
          料金で換算した参考値で、実際の請求額ではありません。「不明」は使用量か価格が分からない呼び出しを含むことを、「（一部）」は分かった分だけの値であることを示します。
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
                <span className="font-medium">{review.lens}</span>{' '}
                <span className="text-fg-2">
                  {review.decision === 'pass'
                    ? '— 通過（pass）'
                    : review.decision === 'needsChanges'
                      ? '— 要修正（needsChanges）'
                      : `— ${review.decision}`}
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

function RecordPanels({ report: r }: { report: LoopReport }) {
  return (
    <>
      <div className="grid gap-6 md:grid-cols-2">
        <Panel title="candidate">
          {r.candidate ? (
            <dl className="flex flex-col gap-2">
              <Field label="id">{r.candidate.id}</Field>
              <Field label="branch">{r.candidate.branch ?? 'なし'}</Field>
              <Field label="commit">{r.candidate.commit ?? 'なし'}</Field>
            </dl>
          ) : (
            <Empty>まだ candidate がありません。</Empty>
          )}
        </Panel>
        <Panel title="delivery">
          {r.delivery ? (
            <dl className="flex flex-col gap-2">
              <Field label="種類">{r.delivery.kind}</Field>
              <Field label="場所">{r.delivery.location}</Field>
              <Field label="branch">{r.delivery.branch ?? 'なし'}</Field>
              <Field label="commit">{r.delivery.commit ?? 'なし'}</Field>
              <Field label="概要">
                <span className="font-ui">{r.delivery.summary}</span>
              </Field>
            </dl>
          ) : (
            <Empty>delivery はありません。</Empty>
          )}
        </Panel>
      </div>

      <Panel title="入力ファイル（保存した内容の SHA-256）">
        <dl className="flex flex-col gap-2">
          {(['task', 'spec', 'dispositions'] as const).map((name) => {
            const file = r.inputs[name]
            return (
              <Field key={name} label={name}>
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
            <Ago iso={data.createdAt} now={data.now} prefix="作成 " />
          </span>
          {r.fake ? (
            <span className="text-fg-2 text-xs">
              fake mode（実 LLM の検証ではない）
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-fg-2 text-xs">run ID</span>
          <code className="font-code text-fg-2 text-xs break-all">
            {r.runId}
          </code>
          <CopyButton
            text={r.runId}
            label="run ID をコピー"
            copied={copied}
            onCopy={(t, l) => void copy(t, l)}
          />
          <CopyAnnouncer copied={copied} />
        </div>
      </div>

      <StatusPanel data={data} />

      <SummaryPanel report={r} />

      <Panel title="工程ごとの時間">
        <StageTimings report={r} />
      </Panel>

      <UsagePanels report={r} />

      <ReviewsPanel report={r} />

      {/* A log panel for the agent output belongs here, once logs exist. */}

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
    return (
      <Empty>終了した run がまだないので、集計するものがありません。</Empty>
    )
  return (
    <div className="flex flex-col gap-6">
      <p className="text-fg-2 text-sm">
        終了した run {data.runIds.length} 件を config version
        ごとにまとめています。不明な値は統計から除き、「不明」の列に数えます（0
        として扱いません）。費用は API 換算の参考値です。
      </p>
      {groups.map((g) => (
        <Panel
          key={g.configVersion ?? g.label}
          title={`${g.label} · config ${g.configVersion ?? 'unversioned'}`}
        >
          <p className="mb-3 text-sm">
            {g.runs} run · 成功 {g.successes}（
            {(g.successRate * 100).toFixed(0)}%） ·{' '}
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
                <StatRow label="合計 token" stat={g.totalTokens} f={fmtInt} />
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
                    <Th num>不明（時間 / 費用）</Th>
                  </tr>
                </thead>
                <tbody className="divide-line divide-y">
                  {g.stages.map((st) => (
                    <tr key={st.stage}>
                      <Td>{st.stage}</Td>
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
                      <Td num>
                        {st.workMs.unknown} / {st.costUsd.unknown}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {g.triage.length > 0 ? (
            <div className="mt-4 overflow-x-auto">
              <p className="text-fg-2 mb-2 text-xs">
                triage の判定別（shadow mode: 判定は経路を変えていない）
              </p>
              <table className="w-full text-sm">
                <thead className="border-line border-b">
                  <tr>
                    <Th>判定</Th>
                    <Th num>run</Th>
                    <Th num>承認</Th>
                    <Th num>検証失敗</Th>
                    <Th num>レビュー上限</Th>
                    <Th num>修正回数 中央値</Th>
                    <Th num>費用 中央値</Th>
                    <Th num>routine なのに修正か上限</Th>
                  </tr>
                </thead>
                <tbody className="divide-line divide-y">
                  {g.triage.map((t) => (
                    <tr key={t.judgment}>
                      <Td>{t.judgment}</Td>
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
            ← run 一覧
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
        heading={(data) => data?.name ?? 'run の詳細'}
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
      heading={() => 'run 一覧'}
      render={(data) => <RunsPage data={data} />}
    />
  )
}
