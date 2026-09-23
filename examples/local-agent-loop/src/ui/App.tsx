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
  })
  useEffect(
    () =>
      pollJson<T>(
        url,
        REFRESH_MS,
        (data) => setState({ data, error: null, fetchedAt: new Date() }),
        (error) => setState((s) => ({ ...s, error })),
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

const dateFmt = new Intl.DateTimeFormat('ja-JP', {
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
})
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
      className={`inline-flex shrink-0 items-center gap-1.5 rounded-sm px-2 py-0.5 text-xs font-medium ${TONE_CLASS[tone]}`}
    >
      {tone === 'running' ? (
        <span
          aria-hidden
          className="dot-live size-1.5 rounded-full bg-current"
        />
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
  const [copied, setCopied] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = useCallback(async (text: string) => {
    setCopied((await writeClipboard(text)) ? text : null)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(null), 1600)
  }, [])
  return { copied, copy }
}

/** One next command: shown in full, copied without its note. */
function CommandLine({
  line,
  copied,
  onCopy,
}: {
  line: string
  copied: string | null
  onCopy: (command: string) => void
}) {
  const { command, note } = splitCommand(line)
  return (
    <li className="flex items-start gap-2">
      <div className="min-w-0 flex-1">
        <code className="bg-sunken font-code text-fg block overflow-x-auto rounded-sm px-2 py-1 text-sm whitespace-pre">
          {command}
        </code>
        {note ? <p className="text-fg-3 mt-0.5 text-xs"># {note}</p> : null}
      </div>
      <span className="relative">
        <button
          type="button"
          onClick={() => onCopy(command)}
          aria-label={`コピー: ${command}`}
          className="border-line-strong bg-raised text-fg-2 hover:text-fg rounded-md border px-2 py-1 text-xs transition-colors duration-150"
        >
          コピー
        </button>
        {copied === command ? (
          <span className="bg-raised text-fg absolute top-full right-0 z-50 mt-1 rounded-sm px-2 py-1 text-xs whitespace-nowrap shadow-[var(--shadow-pop)]">
            コピーしました
          </span>
        ) : null}
      </span>
    </li>
  )
}

function Commands({ lines }: { lines: string[] }) {
  const { copied, copy } = useCopy()
  if (lines.length === 0) return null
  return (
    <>
      <ul className="flex flex-col gap-1.5">
        {lines.map((line) => (
          <CommandLine
            key={line}
            line={line}
            copied={copied}
            onCopy={(c) => void copy(c)}
          />
        ))}
      </ul>
      <p className="sr-only" aria-live="polite">
        {copied ? 'コピーしました' : ''}
      </p>
    </>
  )
}

// ---------------------------------------------------------------- shell

function RefreshStatus({ polled }: { polled: PollState<unknown> }) {
  const at = polled.fetchedAt ? timeFmt.format(polled.fetchedAt) : null
  if (polled.error)
    return (
      <p role="status" className="text-failed text-xs">
        更新失敗（{polled.error}）。{at ? `${at} 時点の表示のままです` : ''}
      </p>
    )
  return (
    <p role="status" className="text-fg-3 text-xs">
      {at ? `${at} 時点 · 3 秒ごとに更新` : '読み込み中…'}
    </p>
  )
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
      className={`rounded-md px-2 py-1 text-sm ${current ? 'bg-sunken text-fg font-medium' : 'text-fg-2 hover:text-fg'}`}
    >
      {label}
    </a>
  )
  return (
    <div className="min-h-screen">
      <header className="border-line bg-canvas sticky top-0 z-20 border-b">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-1 px-4 py-3 sm:px-6">
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
          <span className="text-fg-3 text-sm font-normal tabular-nums">
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

function RunLink({ id }: { id: string }) {
  return (
    <a
      href={`#/runs/${encodeURIComponent(id)}`}
      className="font-code text-fg decoration-line-strong text-sm underline underline-offset-2 hover:decoration-current"
    >
      {id}
    </a>
  )
}

// ---------------------------------------------------------------- run list

function liveText(live: LiveElapsed | null): string | null {
  if (!live) return null
  const stage = live.stage
    ? `${live.stage} ${fmtMs(live.stageMs)}`
    : '工程の合間'
  return `経過（実行中）: 全体 ${fmtMs(live.runMs)} · いまの工程 ${stage}`
}

/** An open or stopped run, with its reason and next commands. */
function OpenRun({ run }: { run: RunRow }) {
  const kind = KIND_LABEL[run.diagnosis.kind]
  const progress = [
    run.iterations > 0 ? `実装 ${run.iterations} 回目` : null,
    run.reviewRounds > 0 ? `レビュー ${run.reviewRounds} 回` : null,
  ]
    .filter(Boolean)
    .join(' · ')
  const live = run.diagnosis.kind === 'running' ? liveText(run.live) : null
  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <StateBadge label={kind.label} tone={kind.tone} />
        <RunLink id={run.id} />
        <span className="text-fg-2 min-w-0 truncate text-sm">{run.title}</span>
        <span className="text-fg-3 ml-auto text-xs tabular-nums">
          作成 {dateFmt.format(new Date(run.createdAt))}
        </span>
      </div>
      <p className="text-fg-2 text-sm">{run.diagnosis.reason}</p>
      {live || progress ? (
        <p className="text-fg-3 text-xs tabular-nums">
          {[live, progress].filter(Boolean).join(' · ')}
        </p>
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

function OpenList({ runs }: { runs: RunRow[] }) {
  return (
    <ul className="divide-line border-line bg-raised divide-y rounded-lg border">
      {runs.map((run) => (
        <OpenRun key={run.id} run={run} />
      ))}
    </ul>
  )
}

function Th({ children, num }: { children: ReactNode; num?: boolean }) {
  return (
    <th
      scope="col"
      className={`text-fg-3 px-3 py-2 text-xs font-medium ${num ? 'text-right' : 'text-left'}`}
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

function FinishedTable({ runs }: { runs: RunRow[] }) {
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
                  <RunLink id={run.id} />
                  <div className="text-fg-3 max-w-xs truncate text-xs">
                    {run.title}
                  </div>
                </Td>
                <Td>
                  <StateBadge label={c.label} tone={c.tone} />
                </Td>
                <Td num>{fmtMs(run.leadTimeMs)}</Td>
                <Td num>{fmtUsd(run.costUsd)}</Td>
                <Td>{run.triage ?? <span className="text-fg-3">なし</span>}</Td>
                <Td>
                  <span className="text-fg-3 text-xs tabular-nums">
                    {dateFmt.format(new Date(run.createdAt))}
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
          <OpenList runs={human} />
        ) : (
          <Empty>承認待ちや停止した run はありません。</Empty>
        )}
      </Section>
      <Section title="進行中" count={open.length}>
        {open.length > 0 ? (
          <OpenList runs={open} />
        ) : (
          <Empty>動いている run も、worker を待つ run もありません。</Empty>
        )}
      </Section>
      <Section title="終了した run" count={finished.length}>
        {finished.length > 0 ? (
          <FinishedTable runs={finished} />
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
    <div className="flex flex-col gap-0.5">
      <dt className="text-fg-3 text-xs">{label}</dt>
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
        <p className="text-fg-2 mb-3 text-sm tabular-nums">
          {liveText(data.live)}
        </p>
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
          <p className="text-fg-3 mb-1 text-xs">
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
        <p className="text-fg-3 mt-3 text-xs">
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
          <ul className="text-fg-2 flex list-disc flex-col gap-1 pl-5 text-sm">
            {r.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </>
  )
}

function RunPage({ data }: { data: RunDetailResponse }) {
  const r = data.report
  const kind = KIND_LABEL[data.diagnosis.kind]
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <a href="#/" className="text-fg-2 hover:text-fg text-sm">
          ← run 一覧
        </a>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-code text-xl font-semibold">{r.runId}</h1>
          <StateBadge label={kind.label} tone={kind.tone} />
          {r.fake ? (
            <span className="text-fg-3 text-xs">
              fake mode（実 LLM の検証ではない）
            </span>
          ) : null}
        </div>
        <p className="text-fg-2 text-sm">
          {data.title} · 作成 {dateFmt.format(new Date(data.createdAt))}
        </p>
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
              <p className="text-fg-3 mb-2 text-xs">
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

function PolledPage<T>({
  route,
  url,
  render,
}: {
  route: Route
  url: string
  render: (data: T) => ReactNode
}) {
  const polled = usePolled<T>(url)
  return (
    <Shell route={route} status={<RefreshStatus polled={polled} />}>
      {polled.data ? (
        render(polled.data)
      ) : polled.error ? (
        <Empty>読み込めませんでした: {polled.error}</Empty>
      ) : (
        <p className="text-fg-3 text-sm">読み込み中…</p>
      )}
    </Shell>
  )
}

export function App() {
  const route = useRoute()
  // Keyed by URL, so moving to another page stops the old page's polling
  // and never shows one run's data under another's address.
  if (route.page === 'run') {
    const url = `/api/runs/${encodeURIComponent(route.id)}`
    return (
      <PolledPage<RunDetailResponse>
        key={url}
        route={route}
        url={url}
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
        render={(data) => <ComparePage data={data} />}
      />
    )
  return (
    <PolledPage<RunsResponse>
      key="runs"
      route={route}
      url="/api/runs"
      render={(data) => <RunsPage data={data} />}
    />
  )
}
