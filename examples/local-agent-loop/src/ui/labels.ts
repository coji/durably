/**
 * Japanese names for the stored stage, role, lens and triage identifiers,
 * shared by the server's screen-reader sentences and the page. Unknown
 * identifiers pass through unchanged.
 */
import {
  DETAIL_PREFIX,
  INTERRUPTED_CHECK,
  PATH_DETAILS,
} from '../engine/failure-details.js'
import type { FailureKind } from '../engine/failure-reasons.js'
import type { Diagnosis, DiagnosisKind } from '../engine/status.js'

const STAGE_NAME: Record<string, string> = {
  setup: '準備',
  baseline: 'ベースの検証',
  preflight: '事前確認',
  triage: '見立て',
  policy: '判断',
  code: '実装',
  verify: '検証',
  review: 'レビュー',
  approve: '承認',
  finish: '完了',
  stop: '停止',
}

export function stageName(stage: string): string {
  return STAGE_NAME[stage] ?? stage
}

const LENS_NAME: Record<string, string> = {
  correctness: '正しさのレビュー',
  'edge-cases': '境界条件のレビュー',
}

/** A review lens, such as `correctness`, as a review's name. */
export function lensName(lens: string): string {
  return LENS_NAME[lens] ?? lens
}

/** A usage role: `code`, `triage`, or a review lens. */
export function roleName(role: string): string {
  return LENS_NAME[role] ?? STAGE_NAME[role] ?? role
}

const TRIAGE_NAME: Record<string, string> = {
  routine: '定型',
  probe: '試行が必要',
  unknown: '不明',
}

export function triageName(judgment: string): string {
  return TRIAGE_NAME[judgment] ?? judgment
}

const STEP_PART_NAME: Record<string, string> = {
  agent: 'エージェント',
  candidate: '候補の記録',
  call: '最小の呼び出し',
}

/** The last part of a step name inside a stage, such as `agent`. */
export function stepPartName(part: string): string {
  return STEP_PART_NAME[part] ?? part
}

/**
 * The page's own words for why a run is where it is, chosen from the
 * diagnosis kind and the failure kind only. The CLI's reason text carries
 * IDs and timestamps; the page shows those as data, never in a sentence.
 */
const DIAGNOSIS_TEXT: Record<Exclude<DiagnosisKind, 'stopped'>, string> = {
  pending: 'まだどのワーカーも取り出していません。',
  running: 'ワーカーが実行しています。',
  'lease-expired':
    '担当のワーカーが止まったか、連絡が途切れました。ワーカーを動かすと、記録から続きを再開します。',
  approval: 'レビューが終わり、候補の承認を待っています。',
  decided: '承認か却下の判断は記録済みです。ワーカーが実行を再開します。',
  'other-wait': '候補の承認ではない入力を待っています。',
  finished: '終わりました。',
}

/** Why a stopped run stopped, and what a person checks first. */
const FAILURE_TEXT: Record<FailureKind, { reason: string; check: string }> = {
  'baseline-check-failed': {
    reason:
      'エージェントを呼ぶ前に、ベースのコミットで固定したチェックがすでに失敗しました。このままでは候補を採点できません。',
    check:
      '下に示したログファイルでチェックの出力を全文読み、採点コマンドか環境を直す。',
  },
  'preflight-failed': {
    reason:
      'ある役割のプロバイダー、モデル、推論の強さの組み合わせが使えません。実装を呼ぶ前に止めました。',
    check:
      'エラーに示した役割の設定か、使う実行ファイルの指定を直す。ログインの問題なら、ログインし直してから始め直す。',
  },
  'verification-failed': {
    reason:
      '最後の修正のあとも、固定したチェックが通りませんでした。修正の回数を使い切っています。',
    check:
      '下に示したログファイルでチェックの出力を全文読み、タスク、チェック、--max-iterations のどれを変えるか決める。',
  },
  'review-cap-reached': {
    reason:
      'チェックは通りましたが、最後の修正のあともレビューが修正を求めました。',
    check:
      'レポートでレビューの指摘を読み、候補を手で仕上げるか、タスクを書き直す。',
  },
  'uncertain-invocation': {
    reason:
      'エージェントの呼び出しを始めましたが、完了の記録がありません。プロバイダーが受け取って動いたかは分かりません。',
    check:
      'もう一度送る前に、プロバイダー側のセッション履歴と使用量、作業ツリー、開始だけ記録されたチェックポイントを確かめる。',
  },
  cancelled: {
    reason:
      '実行は取り消されました。完了の記録がない呼び出しは残っていません。',
    check: '取り消しが意図したものか確かめる。',
  },
  'cancelled-publish': {
    reason:
      '公開する設定の実行が取り消されました。リモートへのブランチの送信やプルリクエストの作成が、もう済んでいるかもしれません。',
    check:
      'もう一度始める前に、リモートに実行のブランチと下書きのプルリクエストがないか確かめる。',
  },
  unclassified: {
    reason: '記録からは分からない理由で止まりました。',
    check: 'もう一度始める前に、実行のエラーと試行を読む。',
  },
}

const DECIDED_TEXT: Record<string, string> = {
  approved: '承認を記録済みです。ワーカーが実行を再開します。',
  rejected: '却下を記録済みです。ワーカーが実行を再開します。',
}

export function diagnosisText(
  d: Pick<Diagnosis, 'kind' | 'failure' | 'decision'>,
  /** A lease-expired run left an agent call without a completion. */
  uncertainCall = false,
): string {
  if (d.kind === 'stopped')
    return d.failure
      ? FAILURE_TEXT[d.failure.kind].reason
      : FAILURE_TEXT.unclassified.reason
  if (d.kind === 'lease-expired' && uncertainCall)
    return '担当のワーカーが止まったか、連絡が途切れました。完了の記録がないエージェント呼び出しが残っているので、ワーカーを動かすとそこで止まり、人の確認を待ちます。'
  if (d.kind === 'decided' && d.decision && DECIDED_TEXT[d.decision])
    return DECIDED_TEXT[d.decision]
  return DIAGNOSIS_TEXT[d.kind]
}

const REVIEW_DECISION: Record<string, { label: string; title: string }> = {
  pass: { label: '通過', title: 'レビューは修正なしで通しました' },
  needsChanges: { label: '要修正', title: 'レビューは修正を求めました' },
}

/**
 * A review verdict's word and hover text. An unknown verdict is data, shown
 * as stored.
 */
export function reviewDecision(decision: string): {
  label: string
  title: string
} {
  return REVIEW_DECISION[decision] ?? { label: decision, title: decision }
}

/**
 * The command itself, without the CLI's English `  # …` comment. The page
 * explains each command in Japanese on its button, in the note under the
 * buttons, and in the reason text.
 */
export function commandText(line: string): string {
  return splitCommand(line).command
}

/** A CLI next-command line split into the command and its English note. */
function splitCommand(line: string): { command: string; note: string | null } {
  const at = line.indexOf('  # ')
  return at < 0
    ? { command: line, note: null }
    : { command: line.slice(0, at), note: line.slice(at + 4) }
}

/**
 * The CLI's English note on a next command, in Japanese. The page shows it
 * under the buttons, so guidance such as "read the reviews first" is not
 * lost when the note is stripped from the command. Unknown notes are dropped.
 */
const COMMAND_NOTES: [string, string][] = [
  [
    'read the reviews first',
    '承認か却下の前に、レビューの判定とメモを読みます。',
  ],
  [
    'once, with the same stored input; to change the task or --max-iterations, trigger anew',
    '保存済みの入力のまま、1回だけ実行し直します。タスクや --max-iterations を変えたいときは、trigger からやり直します。',
  ],
  [
    'the check output is in the verification attempt',
    '検証コマンドの出力は、検証の試行に入っています。',
  ],
  ['the reviewer notes', 'レビューのメモを読めます。'],
  [
    'delivery shows what was recorded',
    '納品物に記録された内容を確かめられます。',
  ],
  ['if none is running', 'ワーカーが動いていなければ起動します。'],
  [
    'the baseline check output',
    'ベースのコミットでのチェックの結果とログの場所を読めます。',
  ],
  [
    'the preflight result for each role',
    '役割ごとの事前確認の結果と確認の方法を読めます。',
  ],
]

/**
 * Notes the page does not repeat under the buttons, because the reason text
 * above them already says the same thing: the lease-expired run's notes.
 */
const SAID_BY_REASON = [
  'the reclaimed run stops at that call',
  'a worker reclaims the run',
]

export function commandNote(line: string): string | null {
  const { note } = splitCommand(line)
  if (note === null || SAID_BY_REASON.some((en) => note.startsWith(en)))
    return null
  // Whole-note match: a note that gains a clause must get its own translation.
  return COMMAND_NOTES.find(([en]) => note === en)?.[1] ?? null
}

/** Is this CLI note one the page deliberately leaves to the reason text? */
export function noteSaidByReason(note: string): boolean {
  return SAID_BY_REASON.some((en) => note.startsWith(en))
}

export function humanCheckText(kind: FailureKind): string {
  return FAILURE_TEXT[kind].check
}

const DETAIL_LABEL: Record<keyof typeof DETAIL_PREFIX, string> = {
  checkpoint: '完了の記録がないチェックポイント',
  error: 'エラー',
  checkAttempt: '検証の試行',
  checkExitCode: '検証の終了コード',
  checkStdout: '検証の標準出力',
  checkStderr: '検証の標準エラー',
  checkTimeout: '時間切れまでの時間',
  checkLogWriteError: 'ログの書き込みエラー',
}

/** Shown for an exit code the check never returned. */
export const NO_EXIT_CODE = '終了コードを得る前に打ち切られました'

/** Shown for a cancelled or lease-lost grading attempt. */
export const INTERRUPTED_CHECK_TEXT = '中断されたため、判定には含まれません'

/** Shown beside a log write error, which is kept as data. */
export const LOG_WRITE_ERROR_NOTE =
  'ログファイルへの書き込みに失敗したため、ファイルの中身が欠けているかもしれません。'

/**
 * A failure detail line as a label and its value, to show as data. `title`
 * explains a value that needs it on hover; `note` is a sentence to show
 * above the value.
 */
export function detailField(line: string): {
  label: string
  value: string
  title?: string
  note?: string
} {
  for (const [key, prefix] of Object.entries(DETAIL_PREFIX)) {
    if (!line.startsWith(prefix)) continue
    const label = DETAIL_LABEL[key as keyof typeof DETAIL_PREFIX]
    const value = line.slice(prefix.length)
    if (key === 'checkAttempt' && value === INTERRUPTED_CHECK)
      return { label, value: INTERRUPTED_CHECK_TEXT }
    if (key === 'checkExitCode' && value === 'null')
      return { label, value, title: NO_EXIT_CODE }
    if (key === 'checkLogWriteError')
      return { label, value, note: LOG_WRITE_ERROR_NOTE }
    return { label, value }
  }
  return { label: '記録', value: line }
}

/** A detail line whose value is a file path to copy, such as a check log. */
export function isPathDetail(line: string): boolean {
  return PATH_DETAILS.some((key) => line.startsWith(DETAIL_PREFIX[key]))
}
