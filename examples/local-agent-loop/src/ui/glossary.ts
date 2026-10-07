/**
 * Every word the web UI shows, in one place: names for stored identifiers,
 * state names, headings, table columns, empty, loading and error text, and
 * the labels and notes of actions and copy buttons. The server's sentences
 * for screen readers and its trace labels come from here too.
 *
 * What is data stays out: task names, IDs, commands, file paths, model
 * names and log text are shown as stored, never translated.
 */
import type { DETAIL_PREFIX } from '../engine/failure-details.js'
import type { FailureKind } from '../engine/failure-reasons.js'
import { UNKNOWN } from '../engine/format.js'
import type { AgentTimeout } from '../engine/providers/types.js'
import type { CALIBRATION_KEYS as ENGINE_CALIBRATION_KEYS } from '../engine/report.js'
import type { DiagnosisKind } from '../engine/status.js'
import type { PipelineState, TraceCheckpoint, TraceState } from './server.js'

// ---------------------------------------------------------------- common

export const COMMON = {
  unknown: UNKNOWN,
  none: 'なし',
  defaultSetting: '既定',
  partial: '一部',
  partialUsage: '使用量が分かった呼び出しだけの合計',
  partialTiming: '一部の区間だけを計測した値',
  separator: ' · ',
  started: '開始',
  count: (n: number | string) => `${n}件`,
  /** A cell whose value does not apply to its row, such as a count only one kind has. */
  notApplicable: '–',
  nth: (n: number | string) => `${n}回目`,
  costNote:
    '費用は記録したトークン数を API 料金で換算した参考値で、実際の請求額ではありません',
} as const

// ---------------------------------------------------------------- names

export const STAGE_NAME: Record<string, string> = {
  setup: '準備',
  baseline: 'ベースの検証',
  preflight: '事前確認',
  spec: '仕様',
  'spec-review': '仕様レビュー',
  'spec-wait': '仕様の判断',
  'spec-check': '採点コマンドの決定',
  triage: '見立て',
  policy: '判断',
  code: '実装',
  verify: '検証',
  review: 'レビュー',
  approve: '承認',
  finish: '完了',
  stop: '停止',
}

export const LENS_NAME: Record<string, string> = {
  correctness: '正しさのレビュー',
  'edge-cases': '境界条件のレビュー',
}

/** Usage roles that are not a stage or a lens. */
export const ROLE_NAME: Record<string, string> = {
  repair: '修正',
  'spec-author': '仕様の作成',
  'spec-fix': '仕様の修正',
}

export const SPEC_REVIEWER = (name: string) => `仕様レビュー ${name}`

/** How a comparison group's runs started. */
export const RUN_KIND_NAME: Record<string, string> = {
  normal: '通常の実行',
  repair: '外部の指摘からの修正',
}

export const TRIAGE_NAME: Record<string, string> = {
  routine: '定型',
  probe: '試行が必要',
  unknown: UNKNOWN,
}

/** The last part of a step name inside a stage, such as `agent`. */
export const STEP_PART_NAME: Record<string, string> = {
  agent: 'エージェント',
  candidate: '候補の記録',
  call: '最小の呼び出し',
}

/** A stop reason in a few words, for a count such as a comparison's. */
export const STOP_NAME: Record<FailureKind, string> = {
  'baseline-check-failed': 'ベースの検証失敗',
  'spec-check-failed': '採点コマンドの決定に失敗',
  'preflight-failed': '事前確認で停止',
  'candidate-moved': '修正元の候補の変更',
  'rejected-invocation': '呼び出しの拒否',
  'agent-timeout': '呼び出しの時間切れ',
  'verification-failed': '検証失敗',
  'review-cap-reached': 'レビュー上限',
  'uncertain-invocation': '結果が不明な呼び出し',
  cancelled: '取り消し',
  'cancelled-publish': '公開中の取り消し',
  unclassified: '分類できない停止',
}

export const REVIEW_DECISION: Record<string, { label: string; title: string }> =
  {
    pass: { label: '通過', title: 'レビューは修正なしで通しました' },
    needsChanges: { label: '要修正', title: 'レビューは修正を求めました' },
  }

/**
 * How a review that ran beside verification ended when the candidate failed
 * the check, or that waits on a check with no result yet (ADR-0029): its
 * short label, and the reason in one sentence.
 */
export const REVIEW_STATUS: Record<string, { label: string; reason: string }> =
  {
    cancelled: {
      label: '中止',
      reason:
        '検証が先に失敗したので、このレビューは途中で止めました。判定は出ていません。',
    },
    discarded: {
      label: '不採用',
      reason:
        '検証に落ちた候補へのレビューなので、承認にもレビュー回数にも使っていません。新しいrunでは、次の修正があれば参考として渡します。',
    },
    pending: {
      label: '検証待ち',
      reason:
        '候補の検証の結果がまだ出ていないので、このレビューの判定はまだ使っていません。',
    },
  }

// ---------------------------------------------------------------- states

/** A diagnosis kind as a state name. */
export const KIND_NAME: Record<DiagnosisKind, string> = {
  approval: '承認待ち',
  'spec-approval': '仕様の判断待ち',
  'other-wait': '入力待ち',
  stopped: '停止',
  running: '実行中',
  pending: '順番待ち',
  'lease-expired': '担当が途切れた',
  decided: '判断済み・再開待ち',
  finished: '終了',
}

/** A finished run's conclusion as a state name. */
export const CONCLUSION_NAME: Record<string, string> = {
  approved: '承認済み',
  rejected: '却下',
  'verification-failed': '検証失敗',
  'review-cap-reached': 'レビュー上限',
  failed: '失敗',
  cancelled: '取り消し',
}

/** Words beside a stage in the stage track, so no state rests on color. */
export const PIPELINE_SUFFIX: Partial<Record<PipelineState, string>> = {
  auto: '自動',
  running: '実行中',
  waiting: '人待ち',
  stopped: '停止',
}

export const TRACE_STATE_NAME: Record<TraceState, string> = {
  done: '完了',
  running: '実行中',
  waiting: '人待ち',
  failed: '失敗',
  interrupted: '中断',
  lost: '担当が途切れた',
  idle: '工程の合間',
}

export const INTERRUPTION_NAME: Record<string, string> = {
  'lease-lost': 'ワーカーの担当期限が切れた',
  cancelled: '取り消された',
  unknown: UNKNOWN,
}

/** Which of the factory's limits stopped an agent call. */
export const TIMEOUT_KIND_NAME: Record<AgentTimeout['kind'], string> = {
  total: '全体の時間の上限',
  idle: '無通信の時間の上限',
}

export const CHECKPOINT_NAME: Record<TraceCheckpoint, string> = {
  completed: '完了を記録',
  recovered: '記録した結果を再利用',
  uncertain: '開始だけ記録。結果は不確か',
  running: '実行中',
}

// ---------------------------------------------------------------- server

/** The server's one-sentence pipeline summary, for screen readers. */
export const PIPELINE_WORDS = {
  visits: (stage: string, n: string) => `${stage} ${n}回`,
  skipped: (stages: string[]) => `${stages.join('と')}は通らず`,
  autoApproved: '承認は設定による自動',
  finished: '完了まで終わった',
  stoppedAt: (stage: string) => `${stage}で停止`,
  runningAt: (stage: string) => `いまは${stage}を実行中`,
  waitingAt: (stage: string) => `いまは${stage}で人待ち`,
  at: (stage: string) => `いまは${stage}`,
  sentence: (parts: string[]) => `工程: ${parts.join('、')}`,
} as const

/** Row labels of the trace the server derives. */
export const TRACE_WORDS = {
  run: '実行全体',
  specFinal: '仕様の確定',
  numbered: (name: string, n: number | string) => `${name} ${n}回目`,
  attempt: (n: number, part?: string) =>
    part ? `${part} 試行 ${n}` : `試行 ${n}`,
} as const

/** Names for runs that have no name of their own. */
export const RUN_NAME = {
  subject: '同梱題材: calc の add を直す',
  unnamed: '名前のないタスク',
  previous: '前の実行',
} as const

// ---------------------------------------------------------------- diagnosis

/**
 * The page's own words for why a run is where it is, chosen from the
 * diagnosis kind and the failure kind only. The CLI's reason text carries
 * IDs and timestamps; the page shows those as data, never in a sentence.
 */
export const DIAGNOSIS_TEXT: Record<
  Exclude<DiagnosisKind, 'stopped'>,
  string
> = {
  pending: 'まだどのワーカーも取り出していません。',
  running: 'ワーカーが実行しています。',
  'lease-expired':
    '担当のワーカーが止まったか、連絡が途切れました。ワーカーを動かすと、記録から続きを再開します。',
  approval: 'レビューが終わり、候補の承認を待っています。',
  'spec-approval':
    '仕様レビューの指摘が上限の回数のあとも残り、仕様をどうするか人の判断を待っています。',
  decided: '承認か却下の判断は記録済みです。ワーカーが実行を再開します。',
  'other-wait': '候補の承認ではない入力を待っています。',
  finished: '終わりました。',
}

/** A lease-expired run that left an agent call without a completion. */
export const LEASE_EXPIRED_UNCERTAIN_TEXT =
  '担当のワーカーが止まったか、連絡が途切れました。完了の記録がないエージェント呼び出しが残っているので、ワーカーを動かすとそこで止まり、人の確認を待ちます。'

export const DECIDED_TEXT: Record<string, string> = {
  approved: '承認を記録済みです。ワーカーが実行を再開します。',
  rejected: '却下を記録済みです。ワーカーが実行を再開します。',
  revise:
    '仕様を直すメモを記録済みです。ワーカーが仕様を直してもう一度レビューします。',
}

/** Why a stopped run stopped, and what a person checks first. */
export const FAILURE_TEXT: Record<
  FailureKind,
  { reason: string; check: string }
> = {
  'baseline-check-failed': {
    reason:
      'エージェントを呼ぶ前に、ベースのコミットで固定したチェックがすでに失敗しました。このままでは候補を採点できません。',
    check:
      '下に示したログファイルでチェックの出力を全文読み、採点コマンドか環境を直す。factory.json を直したときは設定を読み直す再実行を、環境だけを直したときは通常の再実行を使う。',
  },
  'spec-check-failed': {
    reason:
      '確定した仕様から採点コマンドを決めるスクリプトが失敗したか、時間切れになったか、決まった形で出力しませんでした。ベースの検証と実装を始める前に止めました。',
    check:
      '下のエラーを読み、スクリプトか factory.json の設定を直して、設定を読み直す再実行を使う。同じ実行の中でスクリプトの結果を読み替えることはしない。',
  },
  'preflight-failed': {
    reason:
      'ある役割のプロバイダー、モデル、推論の強さの組み合わせが使えません。実装を呼ぶ前に止めました。',
    check:
      'エラーに示した役割の設定か、使う実行ファイルの指定を factory.json で直し、設定を読み直す再実行を使う。ログインの問題なら、ログインし直してから通常の再実行を使う。',
  },
  'candidate-moved': {
    reason:
      '修正元の実行が承認した候補のコミットがないか、そのブランチがもう候補を指していません。作業ツリー、ブランチ、実行ディレクトリを残さず、エージェントを呼ぶ前に止めました。',
    check:
      '承認のあとに誰かが作業を変えています。ブランチを候補のコミットに戻して通常の再実行を使うか、変えた作業を承認した実行から修正をやり直す。',
  },
  'rejected-invocation': {
    reason:
      '事前確認のあと、プロバイダーがエージェントの呼び出しをはっきり断りました。断られたことを呼び出しの答えとして記録したので、結果の分からない呼び出しは残っていません。',
    check:
      '下の拒否の理由を読み、その役割の設定か使う実行ファイルの指定を factory.json で直して、設定を読み直す再実行を使う。ログインや利用上限の問題なら、プロバイダー側で直してから通常の再実行を使う。',
  },
  'agent-timeout': {
    reason:
      'factory がエージェントの呼び出しを全体か無通信の時間の上限で止め、run を先へ進められませんでした。実装や修正なら候補にできる変更が残らず、ほかの役割なら途中の結果を使えません。止めたことを呼び出しの結果として記録したので、結果の分からない呼び出しは残っていません。',
    check:
      'レポートで止めた上限とエージェントの出力を読む。時間が足りなかったなら factory.json の agentTimeoutMs か agentIdleTimeoutMs を延ばして設定を読み直す再実行を、そうでなければ通常の再実行を使う。',
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

/** What a person checks first, where the run's own settings change it. */
export const CHECK_TEXT = {
  /** Preflight, for a run with no factory.json to fix. */
  preflightWithoutConfig:
    'エラーに示した役割のプロバイダー、モデル、推論の強さを直し、trigger からやり直す。ログインの問題なら、ログインし直してから通常の再実行を使う。',
  /** A refused call, for a run with no factory.json to fix. */
  rejectedWithoutConfig:
    '下の拒否の理由を読み、その役割のプロバイダー、モデル、推論の強さを直して trigger からやり直す。ログインや利用上限の問題なら、プロバイダー側で直してから通常の再実行を使う。',
  /** The baseline, for a repair run, which keeps its parent's settings. */
  baselineWithoutConfig:
    '下に示したログファイルでチェックの出力を全文読む。環境だけを直したときは通常の再実行を使う。修正の実行は修正元の採点コマンド、準備、ベースを引き継ぐので、それらを変えるときはリポジトリか factory.json を直し、trigger から通常の実行を始めるか、直したあとに承認された実行から修正をやり直す。',
  /** The same when setup left files .gitignore does not cover. */
  setupUntrackedWithoutConfig:
    '準備のコマンドが .gitignore にないファイルを作っています。修正の実行は修正元の準備とベースと baselineCheck を引き継ぐので、リポジトリの .gitignore か factory.json を直し、trigger から通常の実行を始めるか、直したあとに承認された実行から修正をやり直す。',
  /** The baseline, when setup left files .gitignore does not cover. */
  setupUntracked:
    '準備のコマンドが .gitignore にないファイルを作っているので、下に示したファイルを .gitignore に入れるか、factory.json の baselineCheck を外して設定を読み直す再実行を使う。',
} as const

export const RETRY_TEXT = {
  retryable: 'できる。結果の分からない呼び出しは重ねて送らない',
  notRetryable: 'しない。先に人が確認する',
} as const

// ---------------------------------------------------------------- details

export const DETAIL_LABEL: Record<keyof typeof DETAIL_PREFIX, string> = {
  checkpoint: '完了の記録がないチェックポイント',
  error: 'エラー',
  refusal: '拒否の理由',
  checkAttempt: '検証の試行',
  checkExitCode: '検証の終了コード',
  checkStdout: '検証の標準出力',
  checkStderr: '検証の標準エラー',
  checkTimeout: '時間切れまでの時間',
  checkLogWriteError: 'ログの書き込みエラー',
  setupUntracked: '準備が残したファイル',
}

export const DETAIL_TEXT = {
  /** A detail line of a kind the page does not know. */
  record: '記録',
  /** Shown for an exit code the check never returned. */
  noExitCode: '終了コードを得る前に打ち切られました',
  /** Shown for a cancelled or lease-lost grading attempt. */
  interruptedCheck: '中断されたため、判定には含まれません',
  /** Shown beside a log write error, which is kept as data. */
  logWriteErrorNote:
    'ログファイルへの書き込みに失敗したため、ファイルの中身が欠けているかもしれません。',
} as const

// ---------------------------------------------------------------- commands

/**
 * The CLI's English note on a next command, in Japanese. The page shows it
 * as the button's tooltip, so guidance such as "read the reviews first" is
 * not lost when the note is stripped from the command. Unknown notes are
 * dropped.
 */
export const COMMAND_NOTES: [string, string][] = [
  [
    'read the reviews first',
    '承認か却下の前に、レビューの判定とメモを読みます。',
  ],
  [
    'once, with the same stored input; to change the task or --max-iterations, trigger anew',
    '保存済みの入力のまま、1回だけ実行し直します。タスクや --max-iterations を変えたいときは、trigger からやり直します。',
  ],
  [
    'after fixing factory.json; the stored task with the settings read again, once per version of the file',
    'factory.json を直してから実行します。保存済みのタスクのまま設定を読み直し、ファイルの版ごとに1回だけ実行します。',
  ],
  [
    'after fixing factory.json; the --check, --setup or --base given at trigger still wins over it, so to change those, trigger anew',
    'factory.json を直してから実行します。trigger で指定した --check、--setup、--base は factory.json より優先されるので、それらを変えたいときは trigger からやり直します。',
  ],
  [
    'the check output is in the verification attempt',
    '検証コマンドの出力は、検証の試行に入っています。',
  ],
  [
    'go on from the last candidate with a new repair budget; the findings are built from the check failure unless --findings-file is given',
    '最後の候補から、修正の回数を新しくして続けます。--findings-file を渡さなければ、失敗したチェックの出力を指摘として渡します。',
  ],
  [
    'go on from the last candidate with a new repair budget; the findings are built from the last reviews unless --findings-file is given',
    '最後の候補から、修正の回数を新しくして続けます。--findings-file を渡さなければ、最後のレビューの指摘を渡します。',
  ],
  [
    "go on from the last candidate, which passed the check, with a new repair budget; the findings are built from that candidate's finished reviews that asked for changes unless --findings-file is given",
    'チェックを通った最後の候補から、修正の回数を新しくして続けます。--findings-file を渡さなければ、その候補のレビューのうち、終わって修正を求めたものの指摘を渡します。',
  ],
  ['the reviewer notes', 'レビューのメモを読めます。'],
  [
    'read the spec reviews first',
    '判断の前に、仕様レビューの指摘と仕様を読みます。',
  ],
  ['go on with the spec as it is', 'いまの仕様のまま実装に進みます。'],
  [
    'fix it once more with your notes',
    'メモのファイルを渡して、仕様をもう一度直してレビューし直します。',
  ],
  ['stop before any implementation', '実装を始めずに実行を止めます。'],
  [
    'the spec the script read',
    '採点コマンドを決めるときに読んだ仕様を確かめられます。',
  ],
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
    'the refused call and its reason',
    '断られた呼び出しと、その理由を読めます。',
  ],
  [
    'the stopped call, its limit and its agent log',
    '止めた呼び出しと、その上限、エージェントの出力を読めます。',
  ],
  [
    'the preflight result for each role',
    '役割ごとの事前確認の結果と確認の方法を読めます。',
  ],
  [
    'the parent run and the candidate commit',
    '修正元の実行と、候補のコミットを読めます。',
  ],
]

/** What a copy button says, by the command's subcommand. */
export const COMMAND_COPY = {
  worktreeRemove: '作業ツリーの片付けコマンドをコピー',
  approve: '承認コマンドをコピー',
  reject: '却下コマンドをコピー',
  reportJson: 'JSON のレポートをコピー',
  report: 'レポートをコピー',
  status: '状態確認コマンドをコピー',
  worker: 'ワーカー起動コマンドをコピー',
  retriggerReload: '設定を読み直す再実行コマンドをコピー',
  retrigger: '再実行コマンドをコピー',
  repair: '最後の候補から修正するコマンドをコピー',
  waits: '待ち一覧コマンドをコピー',
  specRevise: '仕様の修正コマンドをコピー',
  archive: 'アーカイブのコマンドをコピー',
  unarchive: 'アーカイブを戻すコマンドをコピー',
  other: 'コマンドをコピー',
} as const

export const COPY = {
  copied: 'コピーしました',
  announce: (label: string) => `${label}しました`,
  commandText: 'コマンド全文',
  path: (label: string) => `${label}のパスをコピー`,
  runId: '実行 ID をコピー',
  stdoutPath: '標準出力のパスをコピー',
  stderrPath: '標準エラーのパスをコピー',
  agentLogPath: '出力のパスをコピー',
  squashedBranch: 'まとめたブランチ名をコピー',
  branch: 'ブランチ名をコピー',
  cleanupNote:
    '作業ツリーを片付けるコマンドです。ブランチは残ります。変更が残っている作業ツリーは git が削除を拒否します。',
  cleanupPruneNote:
    '片付け済みのはずの作業ツリーを片付けるコマンドです。変更が残っていても削除し、git の登録も消します。ブランチは残ります。',
} as const

/** A confirmed action: the question, its two answers, and the CLI line. */
export const ACTION = {
  confirm: (action: string) => `${action}しますか`,
  proceed: '実行する',
  cancel: 'やめる',
  busy: '実行しています…',
  sameCommand: '同じ操作のコマンド',
  approve: '承認',
  reject: '却下',
  specApprove: 'いまの仕様で承認',
  specRevise: '仕様を直す',
  retrigger: '再実行',
  archive: 'アーカイブ',
  unarchive: 'アーカイブから戻す',
  rejectNote: '候補は納品せず、この実行を終えます。',
  specApproveNote: '直すべき指摘が残ったまま、いまの仕様で実装に進みます。',
  specRejectNote: '実装を始めずに、この実行を終えます。',
  retriggerNote:
    '保存済みの入力で新しい実行を始めます。エージェントを最初から呼び直すので、費用がかかります。',
  archiveNote:
    '実行の記録はそのまま残ります。終わったタスクに移し、そこからいつでも戻せます。',
  notesLabel: '仕様に直してほしいこと',
  notesHint: 'CLI では、同じメモを書いたファイルを --notes-file に渡します。',
  notesSubmit: 'このメモで直す',
  failed: (action: string) => `${action}できませんでした`,
  dismiss: '閉じる',
  openRun: '新しい実行を開く',
} as const

/** What a finished action says, by the action. */
export const ACTION_DONE = {
  approve: '承認しました',
  reject: '却下しました',
  'spec-revise': '仕様の修正を頼みました',
  retrigger: '新しい実行を登録しました',
  retriggerAgain: 'すでに再実行しています',
  archive: 'アーカイブしました',
  archiveAgain: 'すでにアーカイブしています',
  unarchive: 'アーカイブから戻しました',
  unarchiveAgain: 'アーカイブしていません',
  decided: 'ワーカーが実行を再開すると、一覧に反映されます。',
  queued: 'ワーカーが順に取りかかります。',
  archived: '終わったタスクに移しました。そこから戻せます。',
  worktreeLeft:
    '作業ツリーは片付けられず、残っています。git が返した理由は次のとおりです。',
  unarchived: '状態に合った場所に戻ります。',
} as const

// ---------------------------------------------------------------- shell

export const SHELL = {
  product: 'local-agent-loop',
  skipToContent: '本文へ移動',
  nav: '画面',
  runs: 'タスク一覧',
  compare: '集計',
  back: '← タスク一覧',
  runFallback: '実行の詳細',
} as const

export const REFRESH = {
  loading: '読み込み中…',
  failedAlert: '更新に失敗しました。直近の表示のままです。',
  failed: '更新に失敗しました。',
  staleAt: (at: string) => `${at} 時点の表示のままです。`,
  freshAt: (at: string) => `${at} 時点 · 3 秒ごとに更新`,
  recovered: '更新が再開しました',
  loadFailed: (error: string) => `読み込めませんでした: ${error}`,
} as const

// ---------------------------------------------------------------- run list

export const LIST = {
  attention: '人の手が要るもの',
  attentionEmpty: '人の手が要るものはありません',
  active: '動いているもの',
  activeEmpty: '動いている実行も、順番を待つ実行もありません。',
  done: '終わったタスク',
  doneEmpty: '終わったタスクはまだありません。',
  noDbBefore:
    'データベースがまだありません。ワーカーを起動するか実行を登録すると',
  noDbAfter: 'に作られ、次の更新で表示されます。',
  retry: '再実行: ',
  currentStage: (stage: string) => `いまの工程: ${stage}`,
  betweenStages: 'いまの工程: 工程の合間',
  stageElapsed: (d: string) => `この工程 ${d} 経過`,
  runElapsed: (d: string) => `全体 ${d} 経過`,
  runs: (n: string) => `実行 ${n} 件`,
  firstRun: '最初の実行',
  repairRun: (n: number) => `指摘からの修正 ${n}`,
  superseded: '後の修正で解決',
  archived: 'アーカイブ済み',
  fake: '模擬',
  fakeTitle:
    '最初の実行が模擬のプロバイダーで動いたタスクです。実際のモデルは呼んでいないので、週ごとの推移には数えません。',
  archivedTitle:
    '止まった実行を人がアーカイブしたので、人の手が要るものには出しません。止まった理由はそのまま残っています。',
  supersededTitle:
    '同じ修正元から後に始めた修正が承認されたので、この実行は判断が要りません',
  showRuns: (name: string) => `${name}の実行を表示`,
  total: '合計',
  totalTitle:
    'タスクのすべての実行の所要時間と費用を足した値です。どれかの実行の値が分からないときは不明です。',
  lineage: '同じタスクの実行',
  current: '表示中',
} as const

export const COLUMN = {
  task: 'タスク',
  result: '結果',
  cost: '費用',
  stage: '工程',
  role: '役割',
  roleProfile: 'プロバイダー / 指定モデル / 指定推論量',
  invocations: '呼び出し',
  input: '入力',
  cacheRead: 'キャッシュ読み',
  cacheWrite: 'キャッシュ書き',
  output: '出力',
  totalTokens: '合計トークン',
  metric: '指標',
  median: '中央値',
  min: '最小',
  max: '最大',
  runs: '件数',
  unknown: UNKNOWN,
  judgment: '判定',
} as const

// ---------------------------------------------------------------- run detail

export const DETAIL = {
  conclusion: '結論と次の手',
  noNext: '人がすることはありません。',
  stopRecord: '停止の記録を見る',
  deliveredTo: '納品したブランチ',
  worktreeRemoved: '作業ツリーは片付け済み',
  worktreeKept:
    'ログ、差分、仕様、チェックポイント、納品の記録は残っています。直すときは記録したコミットから新しい実行を始めます。',
  worktreeWarning: '納品のあと、作業ツリーを片付けられませんでした',
  worktreeWarningNote:
    '実行は承認と納品を終えています。demo prune --apply で片付けをやり直せます。',
  worktreeLeft: 'アーカイブした実行の作業ツリーが残っています',
  worktreeLeftNote:
    'アーカイブのときに片付けられませんでした。原因を取り除いてから demo prune --apply で片付けます。',
  retry: '再実行',
  humanCheck: '人が確認すること',
  leadTime: '所要時間',
  workTime: '工程の作業時間',
  humanWait: '人の待ち時間',
  totalTokens: '合計トークン',
  cost: '費用',
  repairsReviews: '修正 / レビュー回数',
  triage: '見立て',
  triageShadow: '見立ては記録するだけで、進め方は変えません。',
  trace: '工程の時系列',
  stageTimesEmpty: 'まだ完了した工程がありません。',
  stageTotal: '全体',
  stageUsage: '工程ごとのトークンと費用',
  stageUsageEmpty: 'まだモデルの呼び出しがありません。',
  roleUsage: '役割ごとのトークンと費用',
  usageNote:
    '。「不明」は使用量か価格が分からない呼び出しを含むことを、「一部」の印は分かった分だけの値であることを示します。',
  fake: '模擬の実行で、実際のモデルでは検証していません',
  timeAndCost: '工程ごとの時間と費用',
  work: '作業時間',
  wall: '所要時間',
  noCost: '–',
  noCostNote: '費用の「–」は、モデルを呼ばなかった工程です。',
  workOverLead:
    '作業時間が所要時間より長いのは、並んで動いた工程を重ねて数えるためです。',
  checkLogs: 'チェックのログファイル',
  logMissing: 'ファイルがありません',
  noLogRecorded:
    'この実行の記録には、ログファイルの場所が残っていません。チェックの出力はレポートの検証の試行で読みます。',
  specTogether: '仕様の工程まとめ',
  specTogetherTitle:
    '仕様の作成、仕様レビュー、採点コマンドの決定を合わせた経過時間です。並んだレビューは一度だけ数え、人の判断を待った時間は含みません。',
  timeNote:
    '作業時間は工程ごとの呼び出しの時間の合計です。レビューのように並んで動いた工程は重ねて数えるので、合計が所要時間を超えることがあります。所要時間は登録から終わるまでの時計の時間です。',
  evidence: '根拠',
  evidenceNote: '記録の詳細です。開くと表示します。',
} as const

export const CALIBRATION_NAME = {
  taskChars: 'タスクの文字数',
  specChars: '仕様の文字数',
  acceptanceCriteria: '仕様の受け入れ基準の数',
  plannedFiles: '仕様が挙げる変更予定ファイルの数',
} as const satisfies Record<(typeof ENGINE_CALIBRATION_KEYS)[number], string>

/**
 * What the triage record measured, in the order report and compare list it.
 * The engine's list is the one definition: this copy must equal it, key for
 * key, or the page does not compile. The engine module itself reads files,
 * so the page cannot import it.
 */
export const CALIBRATION_KEYS = [
  'taskChars',
  'specChars',
  'acceptanceCriteria',
  'plannedFiles',
] as const satisfies typeof ENGINE_CALIBRATION_KEYS

export const BASELINE = {
  measured: 'この実行でチェックを実行しました',
  reused: 'チェックは実行せず、前の実行の結果を再利用しました',
  source: '再利用元',
  checkedAt: '検証日時',
  logMissing: '再利用元のログは残っていません',
} as const

export const REVIEW = {
  heading: 'レビュー',
  empty: 'まだ終わったレビューがありません。',
  round: (n: number) => `${n}回目のレビュー`,
  candidate: '候補',
  candidateOf: (n: number) => `${n}回目の候補`,
  blockers: '直すべき指摘',
  advice: '助言',
  blockerPrefix: '直すべき指摘 ',
  omitted: (n: string) => `ほか${n}件はレポートに残していません。`,
  verdict: '判定',
  highlights: 'レビューの要点',
  fixed: '直した指摘',
  /** The earlier rounds' blockers while the last round has not passed. */
  earlier: 'これまでの指摘',
  left: '残した指摘',
  open: '残っている直すべき指摘',
  none: 'なし',
  rounds: (n: string) => `レビュー ${n} 回`,
  passedLast: '最後のレビューは通過',
  failedLast: '最後のレビューで直すべき指摘が残った',
  incompleteLast: '最後のレビューは、全員の判定がそろっていない',
  more: (n: string) => `ほか ${n} 件`,
  notes: 'メモを読む',
  roundOf: (n: number) => `${n}回目`,
  /** A verdict review that asked for changes a later round no longer asked for. */
  askedFor: (review: string) => `${review}が求めた修正`,
  notesInEvidence: 'メモの本文は、下の根拠の「レビュー」で読めます。',
  noVerdict: '判定なし',
  /** The review calls spent on candidates that failed verification. */
  discardedCost: '検証に落ちた候補へのレビュー',
  discardedCalls: (n: string) => `${n} 回の呼び出し`,
  discardedCostNote: 'この費用は実行全体の費用に含まれています。',
} as const

export const SPEC = {
  heading: '仕様',
  confirmed: '確定',
  fromInput: '実行時にファイルで渡された仕様',
  confirmedAt: (round: number) => `${round}回目の仕様レビューで確定`,
  human: '人の判断',
  humanApproved: '指摘が残った仕様を人が判断して進めました',
  notConfirmed: '仕様はまだ確定していません。',
  check: '仕様から決めた採点コマンド',
  checkNotes: '採点コマンドの注記',
  advice: '実装に渡した助言',
  open: '確定した仕様を開く',
  openDraft: '最後に書かれた仕様を開く',
  round: (n: number) => `${n}回目の仕様レビュー`,
} as const

export const RECORD = {
  candidate: '候補',
  candidateEmpty: 'まだ候補がありません。',
  id: 'ID',
  branch: 'ブランチ',
  commit: 'コミット',
  changes: '変更の規模',
  changesText: (files: string, additions: string, deletions: string) =>
    `${files} ファイル、+${additions} 行、−${deletions} 行`,
  changesMissing: '規模の記録なし',
  delivery: '納品物',
  deliveryEmpty: '納品物はありません。',
  kind: '種類',
  location: '場所',
  summary: '概要',
  squashedBranch: '1コミットにまとめたブランチ',
  inputs: '入力ファイル',
  inputsNote:
    '値は保存した内容の SHA-256 と、読んだファイルの場所か作った元の実行です。',
  /**
   * Findings built from the parent's stored record, not a file: its failed
   * check or its last reviews.
   */
  findingsFromParent: '修正元の実行の記録から作成',
  notGiven: '指定なし',
  notes: '注記',
} as const

export const INPUT_NAME = {
  task: 'タスク',
  spec: '仕様',
  dispositions: '指摘の扱い',
  findings: '外部の指摘',
} as const

// ---------------------------------------------------------------- trace

export const TRACE = {
  label: '工程の時系列',
  stage: '工程',
  duration: '時間',
  fromStart: (d: string) => `、開始から ${d}`,
  noEnd: '終了時刻は記録されていない',
  inspector: '選んだ行の詳細',
  chosen: '選んだ行',
  following: '実行中の行',
  pick: '行を選ぶと詳細を表示',
  clockBefore: '時刻は',
  clockOrigin: '実行の開始',
  clockAfter: 'からの経過です。正確な時刻はホバーで出ます。',
  invocations: 'モデル呼び出し',
  totalTokens: '合計トークン',
  inputOutput: '入力 / 出力',
  cost: '費用',
  leaseGeneration: '担当の世代',
  attempts: '試行',
  iteration: '回',
  start: '開始',
  end: '終了',
  notEnded: '終わっていない',
  elapsed: '経過',
  time: '時間',
  interruption: '中断の理由',
  provider: 'プロバイダー',
  model: 'モデル',
  effort: '推論量',
  reportedModel: '報告されたモデル',
  checkpoint: 'チェックポイント',
  candidate: '候補',
  candidateOrigin: '候補の元',
  timedOutWork: '時間の上限で止めた呼び出しの途中の作業',
  timedOut: '止めた上限',
  timeoutLimit: '上限の長さ',
  branch: 'ブランチ',
  commit: 'コミット',
  files: '変更ファイル数',
  additions: '追加行数',
  deletions: '削除行数',
  approval: '承認',
  waitOpen: '人の判断を待っている',
  waitTimeout: '期限切れ',
  waitSignal: '判断を受け取った',
  humanWait: '人の待ち時間',
  slotWait: '再開までの待ち',
  log: 'ログ',
  exitCode: '終了コード',
  stdout: '標準出力',
  stderr: '標準エラー',
  writeError: '書き込みエラー',
  agentLog: 'エージェントの出力',
  logFile: 'ファイル',
  logShown: '表示するログ',
  logBody: 'ログの本文',
  logLive: '書き込み中',
  logDone: '書き終わり',
  logEmpty: 'まだ出力がありません。',
  logNone: '出力はありませんでした。',
  logMissing:
    '記録されたファイルが見つかりません。消されたか、移された可能性があります。',
  logFailed: 'ログを読めませんでした。次の更新でもう一度読みます。',
  logTrimmed: '長いため末尾だけを表示しています。全文はファイルで読めます。',
} as const

// ---------------------------------------------------------------- compare

export const COMPARE = {
  view: '集計の見方',
  trendTab: '週ごとの推移',
  configTab: '設定ごとの比較',
  empty: '終わった実行がまだないので、集計するものがありません。',
  intro: (runs: string) =>
    `終わった実行 ${runs} 件を、設定のまとまりごとに集計しています。`,
  rules: '集計の決まり',
  rulesTitle:
    '外部の指摘からの修正は通常の実行と分け、修正元の時間や費用は含めません。不明な値は 0 として扱わず、統計から除いて「不明」の列に数えます。費用は API 換算の参考値です。',
  config: (version: string | null) => `設定 ${version ?? '版なし'}`,
  runs: (n: string) => `${n} 件`,
  successes: (n: string) => `成功 ${n}`,
  successRate: (percent: string) => `成功率 ${percent}`,
  unknownCount: (n: string) => `不明 ${n} 件`,
  leadTime: '所要時間',
  workTime: '工程の作業時間',
  humanWait: '人の待ち時間',
  totalTokens: '合計トークン',
  cost: '費用',
  costPerSuccess: '成功 1 件の費用',
  discardedReviewCost: '検証に落ちた候補へのレビュー費用',
  repairs: '修正回数',
  stageWork: '作業時間 中央値 [最小–最大]',
  stageCost: '費用 中央値 [最小–最大]',
  stageWorkUnknown: '時間の不明',
  stageCostUnknown: '費用の不明',
  triageNote:
    '見立ての判定別。見立ては記録するだけなので、判定で進め方は変わっていません。',
  approved: '承認',
  verificationFailed: '検証失敗',
  reviewCapReached: 'レビュー上限',
  repairsMedian: '修正回数 中央値',
  costMedian: '費用 中央値',
  routineNeedingMore: '定型なのに修正か上限',
  stops: '停止の理由',
  calibrationNote:
    '見立ての判定別に、保存したタスクと仕様から測った値の中央値です。仕様がない実行や古い記録の値は不明に数えます。',
} as const

export const TREND = {
  intro: (days: string, tasks: string) =>
    `直近 ${days} 日に終わったタスク ${tasks} 件を、最初の実行のモデルと推論量ごとに、最後の実行が終わった週で並べています。`,
  fakeLeftOut: (n: string) => `模擬のタスク ${n} 件は除いています。`,
  note: '週は月曜から始まります。タスクの所要時間と費用は、修正の実行も含めたすべての実行の合計の中央値です。分からない値を含むタスクは 0 とせず、その中央値から除きます。',
  single: '1 件のみ',
  singleTitle: 'この週のタスクは 1 件だけなので、中央値はその 1 件の値です。',
  empty: (days: string) => `直近 ${days} 日に終わったタスクはありません。`,
  /** Every finished task of the window was a fake-provider task, left out. */
  onlyFake: (days: string, n: string) =>
    `直近 ${days} 日に終わったタスクは模擬のタスク ${n} 件だけで、集計からは除いています。`,
  week: '週',
  tasks: 'タスク',
  firstPass: '初回承認',
  firstPassRate: '初回承認率',
  firstPassTitle: '修正の実行なしに、最初の実行で承認されたタスクの割合です。',
  approved: '最終承認',
  approvalRate: '最終承認率',
  approvedTitle:
    '最後の実行が承認されて届けられたタスクの割合です。修正の実行で承認されたタスクも数えます。',
  leadTime: '所要時間',
  leadTimePerTask: 'タスクあたりの所要時間',
  cost: '費用',
  costPerTask: 'タスクあたりの費用',
  medianTitle: 'タスクごとに、すべての実行を合計した値の中央値です。',
  repairRuns: '修正の実行',
  repairRunsTitle: '最初の実行の後に始めた修正の実行の本数の中央値です。',
  discardedReviewCost: '落ちた候補のレビュー',
  discardedReviewCostTitle:
    '費用のうち、検証に落ちた候補のレビューに使った分の中央値です。',
  noTasks: '–',
  /** How many tasks of the row a rate counts. */
  count: (n: string) => `${n} 件`,
  share: (n: string, tasks: string) => `${tasks} 件中 ${n} 件`,
  median: '中央値',
  groupTasks: (tasks: string, repairs: string) =>
    `タスク ${tasks} 件 · 修正の実行は中央値 ${repairs} 本`,
} as const

// ---------------------------------------------------------------- design

/** The design page: every component in every state, light and dark. */
export const DESIGN = {
  title: '部品の見本',
  intro:
    '見本のデータだけで描いています。API は呼ばず、操作ボタンは確認の表示まで試せます。',
  contents: '部品',
  light: 'ライト',
  dark: 'ダーク',
  part: {
    badge: {
      name: '状態バッジ',
      about: '色が付くのは人待ち、失敗、実行中の三つだけです。',
    },
    taskRow: {
      name: 'タスクの行',
      about: '名前が主役で、ID は末尾だけを添えます。開くと詳細が出ます。',
    },
    stageTrack: {
      name: '工程の並び',
      about: '通った工程に印を付け、いまの工程だけを強めます。',
    },
    metric: {
      name: '数値カード',
      about: '分からない値は 0 にせず、不明と書きます。',
    },
    keyValue: {
      name: 'キーと値の一覧',
      about: '値はデータとして等幅で出します。',
    },
    table: { name: 'データ表', about: '数値の列は右に揃えます。' },
    collapsible: {
      name: '開閉できる節',
      about: '閉じているときは見出しだけを出します。',
    },
    action: {
      name: '操作ボタン',
      about:
        '確認ありの操作は、押すと質問と同じ操作のコマンドを出し、もう一度押すまで実行しません。',
    },
    copy: {
      name: 'コピーボタン',
      about: '何をコピーするかをボタンの名前で言います。',
    },
    empty: {
      name: '空の状態',
      about: 'まだない、読み込み中、読み込めないの三つです。',
    },
    notice: {
      name: '通知',
      about: '左の線が状態の色を持ちます。操作の結果は閉じられます。',
    },
    runActions: {
      name: '実行への操作',
      about:
        '主な操作は1つだけ強く出し、却下とアーカイブは控えめにして確認を挟みます。確認のあいだはほかの操作を隠します。コマンドは閉じた「同じ操作のコマンド」にまとめます。タスクの実行の中では、アーカイブから戻す操作を控えめに添えます。',
    },
    trace: {
      name: '時系列',
      about:
        '行を選ぶと右に詳細とログが出ます。矢印キーで行を移れます。ログは書き込み中、書き終わり、ファイルがない場合の見え方です。',
    },
    links: {
      name: '実行へのリンクと時刻',
      about:
        '実行は名前で示し、ID は末尾だけ添えます。時刻は相対表記で、正確な時刻はホバーで出ます。',
    },
    live: {
      name: 'いまの工程',
      about: '実行中の工程と経過時間を1行目に、残りを2行目に出します。',
    },
    highlights: {
      name: 'レビューの要点',
      about:
        '前の回の指摘を「直した指摘」と呼ぶのは、最後の回が全員の判定で通過したときだけです。',
    },
    findings: {
      name: '指摘の題名',
      about:
        '種類ごとの件数と、レポートが残した題名だけを出します。本文はレポートで読みます。',
    },
    path: {
      name: 'ファイルの場所',
      about: 'パスはデータとして等幅で出し、コピーボタンを添えます。',
    },
    worktree: {
      name: '作業ツリーの片付け',
      about:
        '片付けた作業ツリーのパスは出しません。残っている記録と、片付けに失敗したときの理由を出します。',
    },
  },
  state: {
    closed: '閉じた状態',
    open: '開いた状態',
    known: '分かっている値',
    partial: '一部だけの値',
    unknown: '不明な値',
    stacked: '縦に並べる',
    inline: '横に並べる',
    framed: '枠あり',
    bare: '枠なし',
    plain: '確認なし',
    confirm: '確認あり',
    confirming: '確認の表示',
    busy: '実行中',
    disabled: '押せない',
    idle: '押す前',
    copied: 'コピーの直後',
    commands: '次の手順のコマンド',
    empty: 'まだない',
    loading: '読み込み中',
    error: '読み込めない',
    link: '実行へのリンク',
    relations: '同じタスクの実行',
    autoApproved: '設定による自動の承認',
    logMissing: 'ファイルがないログ',
    logLive: '書き込み中のログ',
    logDone: '書き終わったログ',
    noLog: '場所の記録がないログ',
    total: '複数の実行の合計',
    ago: '相対時刻',
    between: '工程の合間',
    path: 'コピーできるパス',
    worktreeRemoved: '片付け済み',
    worktreeWarning: '片付けに失敗',
    worktreeLeft: 'アーカイブ後も残った',
    archiveWarning: 'アーカイブしたが作業ツリーが残った',
    writeError: '書き込めなかったログ',
    reviewPassed: '最後の回が通過',
    reviewOpen: '最後の回で指摘が残った',
    reviewIncomplete: '最後の回の判定がそろっていない',
    reviewDiscarded: '検証に落ちた候補へのレビュー',
    reviewPending: '検証の結果を待つレビュー',
    approval: '承認待ち',
    specApproval: '仕様の判断待ち',
    specRevise: '仕様のメモを書く',
    stopped: '止まった実行',
    stoppedNoRetry: '再実行できない停止',
    approveAsking: '承認の確認',
    archiveAsking: 'アーカイブの確認',
    retriggerAsking: '再実行の確認',
    archived: 'アーカイブ済み',
    archivedRun: 'タスクの実行の中のアーカイブ済み',
    result: '操作の結果',
    failed: '操作が断られた',
  },
  sample: {
    approve: '承認',
    retrigger: '再実行',
    reject: '却下',
    refresh: '表示を更新',
    done: '見本なので、何も実行していません。',
    waitingTitle: '承認を待っている実行があります',
    waitingBody: '人の手が要る実行の一覧から判断できます。',
    runningTitle: '実行を始めました',
    doneTitle: '更新が再開しました',
    empty: '終わった実行はまだありません。',
    metricNote: '直近 10 件の中央値',
    section: 'レビュー',
  },
} as const
