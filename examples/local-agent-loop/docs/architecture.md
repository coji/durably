# 仕組みと制約

[README](../README.md) に戻る。

## 候補と固定したテスト

ここでいう候補（Candidate）は、「実装を終えた時点のコードをコピーした候補の版」
です。テスト、レビュー、承認がそれぞれ別のコードを見ないようにするための
識別子で、信頼できないコードを隔離するセキュリティのサンドボックスではありません。
候補は次の参照を持ちます。

```ts
type CandidateRef = {
  id: string
  snapshotDir: string
  sourceHash: string
  acceptanceHash: string
}
```

受け入れテストは、開始のときに別のディレクトリへ固定します。検証のコマンドは
サンプル側で固定した `node --test` で、エージェントが編集した `package.json` の
`test` スクリプトは合否の判定に使いません。候補は作ったあとに同じ場所へ上書きせず、
検証とレビューの前後、承認から再開したあと、終わる直前に、ファイルのバイト列
そのもののハッシュを確かめます。これは、工程のあいだの取り違えや意図しない変更を
見つけるための仕組みで、悪意のあるコードからファイルシステムを守るものでは
ありません。レビューのプロンプトには、固定したベースからの変更の一覧と元の
`src/calc.js` を渡します。そのため、候補だけを読む独立したセッションでも、
「変更が最小か」「`mul()` を触っていないか」を比べられます。
固定したテストは、通常の子プロセスで実行します。子プロセスは自分のプロセス
グループを持ち、時間の上限や取り消しではグループごと終わるので、CLI が起動した
孫プロセスが残りません。強制終了は、node 自身の `--test-timeout` より少し後に
置きます。同時に送ると SIGKILL で先に終わり、「どのテストが止まったか」を含まない
結果が修正のプロンプトへ渡るためです。

## 呼び出しの識別と復旧

次の ID を混同しません。

```text
sessionId      provider-native conversation/thread
operationKey   一つの論理的な仕事
invocationId   実際に送った一回の依頼
attempt.id     Durably step callbackの実行試行
```

LLM の呼び出しと固定テストは、実行する前に、`operationKey` と `invocationId` の
開始のチェックポイントを保存します。結果を受け取ったら、完了のチェックポイントを
途中で切れない形で（atomic に）保存してから、Durably の `step` を完了します。
復旧するときに完了のチェックポイントがあれば、同じ結果を読み、依頼もテストも
送り直しません。

開始の記録だけが残ったときの扱いは、その仕事を送り直してよいかどうかで分かれます。

- **LLM の呼び出し**: 自動では送り直さず、`uncertain external invocation` で
  止まります。CLI がすでに仕事を終えて課金されたかもしれず、それをこちらからは
  判定できないためです。
- **固定テスト**: 古い開始の記録を消して、採点し直します。固定した候補を読み、
  使い捨ての作業ディレクトリ（scratch）へ書くだけなので、もう一度動かしても
  費用はかからず、同じ判定になります。そのため、ワーカーを `kill -9` する再開の
  デモが、ずっと詰まったままになることはありません。

作業物とチェックポイントは `~/.local/state/local-agent-loop/runs/<runId>/` に
残ります。独自の常駐プロセス（daemon）や、送信を管理する DB はありません。

この取り決めは、「結果を受け取ったあと、Durably のチェックポイントの前」に起きる
重複を防ぎます。一方、CLI が作業を終えた直後で、完了のチェックポイントの前に
プロセスを強制終了した場合は、未確定として止まります。初版では、プロバイダー側の
会話の履歴を推測して、自動で採用することはしません。

## 権限と制約

- Codex の実装と修正は workspace-write、レビューは read-only のサンドボックスで
  動きます。
- 見立ては、Codex では read-only のサンドボックス、Claude では Read だけで
  動きます。
- Claude のレビューは Read だけです。実装と修正では、`canUseTool` と
  `PreToolUse` フックの両方で、作業ディレクトリの外のパスを拒否します。これは
  入力の検査で、OS のサンドボックスではありません。`command` か
  `local-instructions` を使う Claude のレビューは `Read`、`Grep`、`Glob`、
  `Agent` だけで、読める場所は、自分の作業ディレクトリ、作業ツリー、レビュー資料の
  ディレクトリです（[「レビュー役の呼び出しと出力」](review-and-repair.md)を参照）。このレビューが
  読み込む設定は、ベースのコミットの `CLAUDE.md` と `.claude/` だけで、候補の
  ものは読みません。フック、コマンドの中のシェル、MCP サーバーは動かしません。
- 仕様の作成と修正では、リポジトリを読み、実行が持つ仕様ファイル
  （`runs/<runId>/spec/spec.md`）だけを書けます。仕様のレビューは読むだけです
  （[「仕様を先に作ってレビューする」](review-and-repair.md)の節）。
- 同じセッションへは、並べて送りません。並べて送るのは、新しいセッションを使う
  レビューと、仕様のレビューだけです。
- モデル、推論量、指示の版、ツール、cwd を途中で替える引き継ぎ（handoff）は、
  まだありません。`trigger` のときに解決した 3 つの役割のプロファイルを、実行の
  あいだ固定します。
- 実装と修正でセッションを続けるのは、`code` の役割のプロバイダー、プロファイル
  ID、cwd、指示の版が一致するときだけです。レビューのプロファイルは関係しません。
  `code` と違う `repair` のプロファイルでの修正は、実装のセッションを続けません。
  例外は Claude で推論量だけが違う場合で、プロファイル ID の代わりに、事前確認で
  Claude Code が報告したモデルが一致することを確かめて続けます（「推論量だけが違う
  修正では、実装のセッションを続ける」の節）。
- fake プロバイダーは、決まった筋書きどおりに答えるローカルの練習用（deterministic）
  で、実際の LLM での検証には数えません。

## fake モードの詳細

fake の事前確認（preflight）は、要求したモデルの名前で決まります。`unlisted-*` は
無料の確認で拒否され、`probe-*` は無料の確認では決まらずに最小の呼び出しが通り、
`refused-*` は最小の呼び出しがはっきり拒否されます。`rejects-*` は無料の確認で
通り、その後の実装、修正、レビュー、見立ての呼び出しが、すべてはっきり拒否
されます。それ以外は、無料の確認で通ります。

`FAKE_LATENCY_MS=20000-90000` を付けると、各呼び出しが、その範囲のランダムな
時間だけ待ちます。取り消しと時間の上限では、待ちを打ち切ります。
`FAKE_USAGE=realistic` を付けると、役割に応じたそれらしいトークンの数を返し、
要求したモデルの価格で費用を計算します。付けなければ、これまでどおり、トークンと
費用は不明です。

ジョブの入力の `fakeScenario` は、実行ごとに fake の振る舞いを変える、デモと
テスト専用の欄です。上の環境変数と同じ項目を、実行ごとに上書きします。
`reviewSequence` と `reviewNotes` は、レビューの回ごとに correctness、edge-cases
の順で 2 つずつ並べます。回と観点で引くので、呼び出しの順番や、再起動のあとの
やり直しで、判定が入れ替わりません。`reviewOutputs` は、同じ並びで、レビューの
返答そのものを指定します（`findings-json` の壊れた返答や、途中で切れた返答も
書けます）。`reviewDenials` は、同じ並びで、その呼び出しが道具の使用を拒否された
ことにします（空文字列なら拒否なし）。テストが記録を始めているあいだ
（`recordFakeReviewCalls`）だけ、`command`、`context`、`output` を設定した
レビューの呼び出しについて、受け取った入力、作業ディレクトリとその中のファイル、
読めるディレクトリのファイルと中身、呼び出しを始めたときと返答したときの作業
ディレクトリの `CLAUDE.local.md` の有無と中身を記録します。記録していない
ワーカーは、何もためません。`output` は `{ chunks, intervalMs }` で、各呼び出しが、
返答の前に `intervalMs` ごとに `chunks` を 1 つずつ、エージェントの出力として
書きます。指定がなくても、fake の呼び出しは返答の本文を出力の最後に書きます。
`FAKE_REVIEW_SLOW_MS` は、これらの呼び出しでも edge-cases のレビューを遅らせます。
すべての役割が fake の実行でしか受け付けず、そうでなければ `trigger` のときに
断ります。`configVersion` にも入りません。`demo seed` がこれを使います。

テスト専用の `claudeEffortResume: true` を付けると、fake は「推論量を変えて
セッションを再開しても、キャッシュが残る Claude Code」の代わりをします。呼び出し
ごとに、渡された推論量をそのまま使います（`low` に固定しません）。Claude の
プロバイダーと同じく、実際に使うモデルは指定どおり（指定がなければ `fake-model`）
で、別名の解決は「CLI」の側が行います。各呼び出しは、実際に動いたモデルを報告し、
`fake` は `fake-model` として報告され、`unobserved-*` は何も報告しません。
Claude Code と同じく無料の確認がないので、事前確認では最小の呼び出しを行って、
そのモデルを読みます。実装と修正の呼び出しでは、セッションを再開したときには
キャッシュの読み込みの多い使用量を、新しいセッションのときにはキャッシュの
読み込みが 0 の使用量を返します。準備の工程もこの欄を読み、推論量だけ違う修正は、
事前確認でモデルを確かめたうえでセッションを続けます。準備の工程での判定は
`configVersion` に入ります。実際のプロバイダーには影響しません。

## ファイルの構成

コードは三層です。`engine/` はどのリポジトリでも同じもの、`factory/` は工程の
つなぎ方、`targets/` は「何を相手に働くか」です。別のリポジトリへ移すときは、
`engine/` と `factory/` をそのまま持っていき、`targets/` を書きます。

```text
src/
  engine/           リポジトリに依存しない機構
    runner.ts       LLM呼び出し1回の冪等化と計測
    verification.ts checkpoint付き検証step（採点内容は呼び出し側が渡す）
    candidate.ts    ディレクトリコピーによるCandidate封印
    git.ts          worktree、commit封印、差分、patch、push、worktreeとbranchの削除
    tree.ts         ディレクトリのhashと差分
    child.ts        process group単位で終了する子process
    providers/      AI SDK v7のCodex / Claude / fake adapter
    models.ts       modelごとのpresetとprovider既定
    usage.ts        token集計（欠測はnullのまま）
    pricing.ts      meter別のAPI換算参考価格
    report.ts       工程別集計とmarkdown/json
    build-report.ts 永続記録からのレポート組み立て
    compare.ts      config version別の複数run比較
    status.ts       runの状態区分、理由、次のコマンド（statusとweb UIで共有）
    types.ts        CandidateRef / SessionRef / ResolvedProfile
  factory/          工程のつなぎ方（何を作るかは知らない）
    target.ts       Targetインターフェース：targetsとの境界
    job.ts          役割別profileの固定、decision保存とStage dispatch
    stages.ts       code / verify / review / approve / finish / stop
    policy.ts       次に実行する工程の決定
    prompts.ts      promptの骨格（TASKとRULESはtargetが埋める）
    types.ts, events.ts, reducer.ts   状態機械
  targets/          何に対して働くか
    subject.ts      同梱の題材。固定テストで採点、成果物はディレクトリ
    repo.ts         実リポジトリ。worktreeで作業、commitで封印、patch/PRを出す
    index.ts        setup時のprepareと、replay時のcreateTarget
  ui/               web UI（server.tsとReactの画面）。操作はactions.tsを呼ぶ
  cli.ts            コマンドの入口
  trigger-input.ts  factory.jsonと入力ファイルの読み込み、trigger時の固定
  actions.ts        承認、却下、仕様の修正、再実行、アーカイブ（CLIとweb UIで共有）、pruneの対象選び
  approval.ts       candidateに結びつけた承認と却下のsignal
  demo-seed.ts      demo seedが作るデモ用のリポジトリとrun
  durably.ts        固定state directoryのDB
subject/            変更しないバグ入り題材
```

境界の形は、`engine/verification.ts` と `factory/target.ts` によく出ています。
前者は、開始と完了のチェックポイント、計測、`signal` の転送までを持ち、「何を
もって検証とするか」は `grade` コールバックとして受け取ります。後者は、作業場所、
封印の仕方、採点、レビューに渡す文脈、成果物の渡し方という、対象ごとに必ず違う
5 つだけを切り出しています。

移植の手順は [docs/porting.md](porting.md) にあります。
