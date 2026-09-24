/**
 * Japanese names for the stored stage, role, lens and triage identifiers,
 * shared by the server's screen-reader sentences and the page. Unknown
 * identifiers pass through unchanged.
 */
import { DETAIL_PREFIX } from '../engine/failure-details.js'
import type { FailureKind } from '../engine/failure-reasons.js'
import type { Diagnosis, DiagnosisKind } from '../engine/status.js'

const STAGE_NAME: Record<string, string> = {
  setup: '準備',
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
  'verification-failed': {
    reason:
      '最後の修正のあとも、固定したチェックが通りませんでした。修正の回数を使い切っています。',
    check:
      'レポートでチェックの出力を読み、タスク、チェック、--max-iterations のどれを変えるか決める。',
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
 * explains each command in Japanese on its button and in the reason text.
 */
export function commandText(line: string): string {
  const at = line.indexOf('  # ')
  return at < 0 ? line : line.slice(0, at)
}

export function humanCheckText(kind: FailureKind): string {
  return FAILURE_TEXT[kind].check
}

const DETAIL_LABEL: Record<keyof typeof DETAIL_PREFIX, string> = {
  checkpoint: '完了の記録がないチェックポイント',
  error: 'エラー',
}

/** A failure detail line as a label and its value, to show as data. */
export function detailField(line: string): { label: string; value: string } {
  for (const [key, prefix] of Object.entries(DETAIL_PREFIX))
    if (line.startsWith(prefix))
      return {
        label: DETAIL_LABEL[key as keyof typeof DETAIL_PREFIX],
        value: line.slice(prefix.length),
      }
  return { label: '記録', value: line }
}
