/**
 * `demo seed`: fill a throwaway HOME with runs that look like real use, for
 * looking at the web UI. Demo only: every run is on the fake provider, with a
 * per-run fake scenario, and every run is marked fake as usual.
 *
 * The runs get real timestamps. Durably stamps creation and lease times
 * itself, and the seed does not rewrite the database, so the history spans
 * the minutes the seed took, not days.
 */
import { spawn } from 'node:child_process'
import { openSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { signalApproval, type ApprovalDecision } from './approval.js'
import {
  createAgentDurably,
  defaultStateRoot,
  type AgentLoopDurably,
} from './durably.js'
import { runChild } from './engine/child.js'
import { DEMO } from './engine/failure-reasons.js'
import { parseLatency, type FakeScenario } from './engine/providers/fake.js'
import { checkpointPaths } from './engine/runner.js'
import { shellQuote } from './engine/status.js'
import { TERMINAL_STATUSES } from './engine/terminal.js'
import { buildTriggerInput, startableRepair } from './trigger-input.js'

/** A small project with a real `node --test` check that fails on the base. */
const PROJECT: Record<string, string> = {
  'package.json': `${JSON.stringify(
    {
      name: 'shop-app',
      private: true,
      type: 'module',
      scripts: { test: 'node --test test/**/*.test.js' },
    },
    null,
    2,
  )}\n`,
  'README.md':
    '# shop-app\n\n小さな EC サイトのバックエンドです。`npm test` で全テストを実行します。\n',
  'src/calc.js': `export function add(a, b) {
  return Math.trunc(a) + Math.trunc(b)
}

export function mul(a, b) {
  return a * b
}
`,
  'src/format.js': `export function formatYen(amount) {
  return \`¥\${amount}\`
}
`,
  'test/calc.test.js': `import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { add, mul } from '../src/calc.js'

describe('calc', () => {
  it('adds decimals without truncation', () => {
    assert.equal(add(0.1, 0.2), 0.30000000000000004)
  })
  it('multiplies', () => {
    assert.equal(mul(3, 4), 12)
  })
})
`,
  'factory.json': `${JSON.stringify(
    {
      check: ['node', '--test', 'test/**/*.test.js'],
      base: 'main',
      profiles: {
        code: { provider: 'fake', model: 'gpt-6-sol', effort: 'medium' },
        review: {
          correctness: {
            provider: 'fake',
            model: 'gpt-6-sol',
            effort: 'medium',
          },
          'edge-cases': {
            provider: 'fake',
            model: 'claude-opus-5-5',
            effort: 'high',
          },
        },
        triage: { provider: 'fake', model: 'gpt-6-luna', effort: 'low' },
      },
    },
    null,
    2,
  )}\n`,
}

type Ending =
  /** Settles on its own: completed or failed. */
  | 'settle'
  /** Parks on the approval wait, then gets this decision. */
  | ApprovalDecision
  /** Parks on the approval wait and stays there. */
  | 'wait'
  /** A start-only checkpoint makes the first code call uncertain. */
  | 'uncertain'
  /** Keeps running after the seed returns, on a background worker. */
  | 'running'

interface DemoTask {
  slug: string
  title: string
  body: string
  ending: Ending
  scenario: FakeScenario
}

const PASS_NOTES = [
  '変更は依頼の範囲に収まっており、既存のテストも通ります。',
  '境界値と空入力を確認しました。問題は見つかりません。',
]

const TASKS: DemoTask[] = [
  {
    slug: 'login-error-message',
    title: 'ログイン画面のエラーメッセージを具体的にする',
    body: 'パスワード違いとアカウント未登録を区別して表示する。どちらの場合も入力欄の値は消さない。',
    ending: 'settle',
    scenario: {
      failIterations: 1,
      triage: ['routine'],
      triageReason: '文言と分岐の追加だけで、既存テストで確認できる。',
      summary:
        'ログインエラーを原因ごとのメッセージに分け、入力値を保持するようにした。',
      changes: {
        'src/login-messages.js': `export const LOGIN_ERRORS = {
  wrongPassword: 'パスワードが違います。',
  unknownAccount: 'このメールアドレスのアカウントは見つかりません。',
}
`,
      },
      reviewNotes: PASS_NOTES,
    },
  },
  {
    slug: 'csv-export-date',
    title: 'CSV エクスポートで日付がずれる不具合を直す',
    body: '注文 CSV の日付が UTC で出力され、日本時間の深夜の注文が前日になる。店舗のタイムゾーンで出力する。',
    ending: 'settle',
    scenario: {
      failIterations: 0,
      reviewSequence: ['needsChanges', 'pass', 'pass', 'pass'],
      reviewNotes: [
        '月末をまたぐ注文で日付が 1 日ずれるケースが残っています。テストで再現できます。',
        '出力形式は既存の CSV と一致しています。',
        ...PASS_NOTES,
      ],
      triage: ['probe'],
      triageReason:
        'タイムゾーンの扱いは境界が多く、試しに実装して確かめたい。',
      summary: '日付の出力を店舗のタイムゾーンに揃えた。',
      changes: {
        'src/csv-date.js': `export function formatOrderDate(date, timeZone = 'Asia/Tokyo') {
  return new Intl.DateTimeFormat('sv-SE', { timeZone }).format(date)
}
`,
      },
    },
  },
  {
    slug: 'timezone-setting',
    title: '設定画面にタイムゾーンの選択を足す',
    body: '店舗設定にタイムゾーンの選択肢を足す。既定は Asia/Tokyo。保存した値は CSV エクスポートでも使う。',
    ending: 'wait',
    scenario: {
      failIterations: 0,
      triage: ['probe'],
      triageReason: '設定の保存先と既存画面の両方に手が入る。',
      summary: '店舗設定にタイムゾーンを追加し、既定値を Asia/Tokyo にした。',
      changes: {
        'src/settings.js': `export const DEFAULT_SETTINGS = { timeZone: 'Asia/Tokyo' }
`,
      },
      reviewNotes: PASS_NOTES,
    },
  },
  {
    slug: 'webhook-idempotent',
    title: '決済 webhook のリトライを冪等にする',
    body: '決済サービスが同じ webhook を再送したとき、注文が二重に確定しないようにする。イベント ID で重複を判定する。',
    ending: 'settle',
    scenario: {
      failIterations: 0,
      reviewSequence: ['needsChanges', 'pass', 'needsChanges', 'pass'],
      reviewNotes: [
        '重複判定がメモリ上の Set なので、プロセスを再起動すると二重確定します。',
        '正常系は問題ありません。',
        '同時に 2 件届いたときの競合が残っています。一意制約で防ぐ必要があります。',
        'ログの出力は十分です。',
      ],
      triage: ['probe'],
      triageReason: '決済まわりで、同時実行の扱いを確かめる必要がある。',
      summary: 'イベント ID で処理済みかを判定するようにした。',
      changes: {
        'src/webhook.js': `const seen = new Set()

export function handlePaymentEvent(event) {
  if (seen.has(event.id)) return 'duplicate'
  seen.add(event.id)
  return 'processed'
}
`,
      },
    },
  },
  {
    slug: 'search-paging',
    title: '検索結果のページングを 50 件ずつにする',
    body: '検索結果の 1 ページあたりの件数を 20 件から 50 件に変える。',
    ending: 'settle',
    scenario: {
      failIterations: 0,
      triage: ['routine'],
      triageReason: '定数を 1 つ変えるだけで、影響範囲が狭い。',
      summary: '1 ページあたりの件数を 50 件にした。',
      changes: { 'src/search.js': 'export const PAGE_SIZE = 50\n' },
      reviewNotes: PASS_NOTES,
    },
  },
  {
    slug: 'password-reset-expiry',
    title: 'パスワード再設定メールの有効期限を 24 時間にする',
    body: '再設定リンクの有効期限を 1 時間から 24 時間に延ばす。期限切れの画面の文言も合わせる。',
    ending: 'approved',
    scenario: {
      failIterations: 0,
      triage: ['routine'],
      triageReason: '期限の定数と文言だけの変更。',
      summary: '再設定リンクの有効期限を 24 時間にし、文言を合わせた。',
      changes: {
        'src/password-reset.js':
          'export const RESET_LINK_TTL_MS = 24 * 60 * 60 * 1000\n',
      },
      reviewNotes: PASS_NOTES,
    },
  },
  {
    slug: 'unread-count',
    title: '通知一覧の未読件数がずれる不具合を直す',
    body: '通知を既読にしても、ヘッダーの未読件数が再読み込みまで減らない。',
    ending: 'settle',
    scenario: {
      failIterations: 1,
      triage: ['routine'],
      triageReason: '件数の再計算を 1 か所に足せば済みそう。',
      summary: '既読にしたときに未読件数を再計算するようにした。',
      changes: {
        'src/notifications.js': `export function unreadCount(items) {
  return items.filter((item) => !item.read).length
}
`,
      },
      reviewNotes: PASS_NOTES,
    },
  },
  {
    slug: 'invoice-separator',
    title: '請求書 PDF の金額に桁区切りを入れる',
    body: '請求書 PDF の金額を ¥1,234,567 の形式で表示する。',
    ending: 'settle',
    scenario: {
      failIterations: 2,
      triage: ['routine'],
      triageReason: '表示形式の変更だけに見える。',
      summary: '金額の表示に桁区切りを入れた。',
    },
  },
  {
    slug: 'admin-user-search',
    title: '管理画面のユーザー検索を部分一致にする',
    body: 'ユーザー検索を前方一致から部分一致に変える。メールアドレスのドメインでも検索できるようにする。',
    ending: 'uncertain',
    scenario: {
      failIterations: 0,
      triage: ['routine'],
      triageReason: '検索条件を 1 か所変えるだけ。',
    },
  },
  {
    slug: 'sort-newest',
    title: '商品一覧の並び替えに「新着順」を足す',
    body: '商品一覧の並び替えに新着順を追加する。同じ登録日時の商品は商品 ID の降順で並べる。',
    ending: 'wait',
    scenario: {
      failIterations: 1,
      triage: ['routine'],
      triageReason: '並び替えの選択肢を 1 つ足すだけ。',
      summary: '並び替えに新着順を追加し、同時刻は商品 ID の降順にした。',
      changes: {
        'src/sort.js': `export function byNewest(a, b) {
  return b.createdAt - a.createdAt || b.id - a.id
}
`,
      },
      reviewNotes: PASS_NOTES,
    },
  },
  {
    slug: 'upload-limit',
    title: 'アップロード画像のサイズ上限を 10MB にする',
    body: '商品画像のアップロード上限を 5MB から 10MB に上げる。上限を超えたときのメッセージも直す。',
    ending: 'rejected',
    scenario: {
      failIterations: 0,
      triage: ['probe'],
      triageReason: 'ストレージの容量と CDN の設定に影響するかもしれない。',
      summary: 'アップロード上限を 10MB に変更した。',
      changes: {
        'src/upload.js': 'export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024\n',
      },
      reviewNotes: PASS_NOTES,
    },
  },
  {
    slug: 'order-history-latency',
    title: '注文履歴の API レスポンスを 200ms 以内にする',
    body: '注文履歴 API が注文 1 件ごとに商品を取りに行っている。まとめて取得して 200ms 以内に返す。',
    ending: 'running',
    scenario: {
      failIterations: 0,
      triage: ['probe'],
      triageReason: 'クエリの組み立てを変えるので、性能を測りながら進めたい。',
      summary: '商品の取得をまとめて 1 回にした。',
      reviewNotes: PASS_NOTES,
    },
  },
  {
    slug: 'terms-checkbox',
    title: '会員登録フォームに利用規約の同意チェックを足す',
    body: '会員登録フォームに利用規約への同意チェックを足す。チェックしないと登録できないようにする。',
    ending: 'running',
    scenario: {
      failIterations: 0,
      triage: ['routine'],
      triageReason: 'フォームの項目と検証を 1 つずつ足すだけ。',
      summary: '利用規約の同意チェックを追加した。',
      reviewNotes: PASS_NOTES,
    },
  },
]

/**
 * A repair run from outside findings on one approved run, so the web UI
 * shows a parent and its child.
 */
const REPAIR = {
  parentSlug: 'login-error-message',
  title: 'ログイン画面のエラーメッセージを具体的にする',
  findings:
    '# UI の確認で見つかったこと\n\n- アカウント未登録のメッセージに、登録画面への導線がない。\n',
  scenario: {
    failIterations: 0,
    summary: '未登録のメッセージに登録画面への案内を足した。',
    changes: {
      'src/login-messages.js': `export const LOGIN_ERRORS = {
  wrongPassword: 'パスワードが違います。',
  unknownAccount:
    'このメールアドレスのアカウントは見つかりません。新規登録はこちらから行えます。',
}
`,
    },
    reviewNotes: PASS_NOTES,
  } satisfies FakeScenario,
}

/** Start the seed's repair run from its approved parent. */
async function triggerRepair(
  durably: AgentLoopDurably,
  repo: string,
  parentId: string,
  latencyMs: { min: number; max: number },
) {
  const path = join(
    repo,
    '..',
    '..',
    'tasks',
    `${REPAIR.parentSlug}-findings.md`,
  )
  const { input, idempotencyKey } = await startableRepair(
    durably,
    parentId,
    {
      findings: { content: REPAIR.findings, ref: { path } },
      dispositions: null,
    },
    { usage: 'realistic', latencyMs, ...REPAIR.scenario },
  )
  await writeFile(path, REPAIR.findings)
  return durably.jobs.agentLoop.trigger(input, { idempotencyKey })
}

export interface SeedOptions {
  home: string
  /** Wait per fake call for runs that settle during the seed. */
  latencyMs: { min: number; max: number }
  /** Wait per fake call for the runs left running. */
  longLatencyMs: { min: number; max: number }
  /** Start a background worker for the runs left running. */
  backgroundWorker: boolean
  log?: (line: string) => void
}

export interface SeedResult {
  home: string
  runs: { title: string; ending: Ending; runId: string }[]
  workerPid: number | null
  workerLog: string | null
}

async function git(cwd: string, args: string[]): Promise<void> {
  const res = await runChild('git', args, { cwd, timeoutMs: 60000 })
  if (res.code !== 0) throw new Error(`git ${args.join(' ')}: ${res.stderr}`)
}

async function createProject(home: string): Promise<string> {
  const repo = join(home, 'work', 'shop-app')
  for (const [path, content] of Object.entries(PROJECT)) {
    await mkdir(dirname(join(repo, path)), { recursive: true })
    await writeFile(join(repo, path), content)
  }
  await git(repo, ['init', '--initial-branch=main'])
  await git(repo, ['config', 'user.email', 'demo@localhost'])
  await git(repo, ['config', 'user.name', 'demo'])
  await git(repo, ['config', 'commit.gpgsign', 'false'])
  await git(repo, ['add', '-A'])
  await git(repo, ['commit', '-m', 'shop-app の初期状態'])
  return repo
}

async function waitUntil(
  cond: () => Promise<boolean>,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const started = Date.now()
  for (;;) {
    if (await cond()) return
    if (Date.now() - started > timeoutMs)
      throw new Error(`demo seed timed out waiting for ${label}`)
    // sleep-ok(poll): one tick of a loop that re-checks run state until its deadline
    await new Promise((r) => setTimeout(r, 500))
  }
}

/** True once the run has stopped moving without a person or more time. */
async function parked(durably: AgentLoopDurably, runId: string) {
  const run = await durably.getRun(runId)
  if (!run) return false
  if (TERMINAL_STATUSES.includes(run.status)) return true
  if (run.status !== 'waiting') return false
  const wait = (await durably.getWaits(runId)).find(
    (w) => w.id === run.waitingOnWaitId,
  )
  return wait?.status === 'pending'
}

async function trigger(
  durably: AgentLoopDurably,
  repo: string,
  task: DemoTask,
  latencyMs: { min: number; max: number },
) {
  const taskFile = join(repo, '..', '..', 'tasks', `${task.slug}.md`)
  await mkdir(dirname(taskFile), { recursive: true })
  await writeFile(taskFile, `# ${task.title}\n\n${task.body}\n`)
  const manual = task.ending === 'wait' || task.ending === 'approved'
  const input = await buildTriggerInput({
    repo,
    'task-file': taskFile,
    ...(manual || task.ending === 'rejected' ? { approve: 'manual' } : {}),
  })
  return durably.jobs.agentLoop.trigger({
    ...input,
    fakeScenario: { usage: 'realistic', latencyMs, ...task.scenario },
  })
}

export async function seed(options: SeedOptions): Promise<SeedResult> {
  const log = options.log ?? (() => {})
  // Everything reads HOME: the state root, and git's global config, which
  // must not bring the owner's signing or hooks into the throwaway repo.
  process.env.HOME = options.home
  const stateRoot = defaultStateRoot()
  const repo = await createProject(options.home)
  log(`demo project: ${repo}`)

  const now = TASKS.filter((t) => t.ending !== 'running')
  const later = TASKS.filter((t) => t.ending === 'running')
  const durably = createAgentDurably({
    stateRoot,
    maxConcurrentRuns: now.length,
  })
  await durably.migrate()
  const runs: SeedResult['runs'] = []
  try {
    for (const task of now) {
      const run = await trigger(durably, repo, task, options.latencyMs)
      runs.push({ title: task.title, ending: task.ending, runId: run.id })
      if (task.ending === 'uncertain') {
        // As if a worker died right after sending the first implementation
        // prompt: the start checkpoint exists and its completion does not.
        const dir = join(stateRoot, 'runs', run.id, 'operation-checkpoints')
        await mkdir(dir, { recursive: true })
        const operationKey = `${run.id}/stage:0:code/agent`
        await writeFile(
          checkpointPaths(dir, operationKey).started,
          `${JSON.stringify({
            operationKey,
            invocationId: `lost-${run.id}`,
            status: 'started',
            invocationStartedAt: new Date().toISOString(),
          })}\n`,
        )
      }
      log(`triggered ${run.id}  ${task.title}`)
    }
    await durably.init()
    const budget = 30 * 60 * 1000
    for (const r of runs)
      await waitUntil(() => parked(durably, r.runId), budget, r.title)
    for (const r of runs) {
      if (r.ending !== 'approved' && r.ending !== 'rejected') continue
      const run = await durably.getRun(r.runId)
      if (!run?.waitingOnWaitId)
        throw new Error(`${r.title}: expected an approval wait`)
      await signalApproval(durably, r.runId, run.waitingOnWaitId, r.ending)
      log(`${r.ending} ${r.runId}  ${r.title}`)
    }
    for (const r of runs) {
      if (r.ending !== 'approved' && r.ending !== 'rejected') continue
      await waitUntil(
        async () =>
          TERMINAL_STATUSES.includes(
            (await durably.getRun(r.runId))?.status ?? '',
          ),
        budget,
        r.title,
      )
    }
    // One approved run gets outside findings, and a repair run from them.
    const parent = runs.find((r) => r.title === REPAIR.title)
    if (parent) {
      const run = await triggerRepair(
        durably,
        repo,
        parent.runId,
        options.latencyMs,
      )
      runs.push({ title: REPAIR.title, ending: 'settle', runId: run.id })
      log(`triggered ${run.id}  ${REPAIR.title} の指摘からの修正`)
      await waitUntil(() => parked(durably, run.id), budget, REPAIR.title)
    }
    await durably.stop()
    for (const task of later) {
      const run = await trigger(durably, repo, task, options.longLatencyMs)
      runs.push({ title: task.title, ending: task.ending, runId: run.id })
      log(`triggered ${run.id}  ${task.title}`)
    }
  } finally {
    await durably.stop()
    await durably.db.destroy()
  }

  let workerPid: number | null = null
  let workerLog: string | null = null
  if (options.backgroundWorker && later.length > 0) {
    workerLog = join(options.home, 'worker.log')
    const out = openSync(workerLog, 'a')
    const cli = join(dirname(fileURLToPath(import.meta.url)), 'cli.ts')
    const child = spawn(
      process.execPath,
      [...process.execArgv, cli, 'worker'],
      {
        cwd: dirname(dirname(cli)),
        env: { ...process.env, HOME: options.home },
        detached: true,
        stdio: ['ignore', out, out],
      },
    )
    child.unref()
    workerPid = child.pid ?? null
    const first = runs.find((r) => r.ending === 'running')?.runId ?? ''
    const reader = createAgentDurably({ stateRoot })
    try {
      await waitUntil(
        async () => (await reader.getRun(first))?.status === 'leased',
        60000,
        'the background worker to pick up a run',
      )
    } finally {
      await reader.db.destroy()
    }
  }
  return { home: options.home, runs, workerPid, workerLog }
}

/** `demo seed [--home <dir>] [--latency <min>-<max>]` */
export async function seedCommand(a: Record<string, string>): Promise<void> {
  let home: string
  if (a['home']) {
    home = resolve(a['home'])
    await mkdir(home, { recursive: true })
    if ((await readdir(home)).length > 0)
      throw new Error(
        `--home ${home} is not empty; give an empty or new directory`,
      )
  } else {
    home = await mkdtemp(join(tmpdir(), 'local-agent-loop-demo-'))
  }
  const latencyMs = parseLatency(a['latency'] ?? '20000-90000')
  if (!latencyMs) throw new Error('--latency must be <min>-<max>')
  const result = await seed({
    home,
    latencyMs,
    longLatencyMs: { min: 600_000, max: 1_200_000 },
    backgroundWorker: true,
    log: (line) => console.log(line),
  })
  const env = `HOME=${shellQuote(home)}`
  console.log('')
  console.log(`デモデータを作りました: ${home}`)
  console.log('')
  console.log('画面を開く:')
  console.log(`  ${env} ${DEMO} ui`)
  if (result.workerPid !== null) {
    console.log('')
    console.log(
      '実行中の run はバックグラウンドの worker が進めています。1 回の呼び出しに 10〜20 分かかります。',
    )
    console.log(`  worker の pid: ${result.workerPid}`)
    console.log(`  worker のログ: ${result.workerLog ?? ''}`)
    console.log(`  止めるとき: kill -9 ${result.workerPid}`)
    console.log(
      '  worker は実行中の run が終わるまで kill では止まりません。呼び出しの途中で止めた run は、再開すると未確定の呼び出しとして止まります。',
    )
  }
  console.log('')
  console.log('worker を止めたあとで残りの run を続ける:')
  console.log(`  ${env} ${DEMO} worker`)
}
