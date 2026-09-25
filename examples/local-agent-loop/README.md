# local-agent-loop — Durably local factory demo

Durably + local SQLite + AI SDK v7 + one logged-in CLI (Codex or Claude Code)
で、実装、固定テスト、独立レビュー、人間承認までをローカルで実行する
サンプルです。新しいワークフローフレームワーク、Docker、GitHub認証、CIは
使いません。

中心となる設計は、工程の境界と会話の境界を分けることです。

- 工程は `code → verify → review → approve → finish/stop` に分け、各判断と
  実行をDurably stepとして保存します。
- `code` は初回実装と修正で共有します。`--context reuse` では同じ
  provider-native sessionを明示的に再開し、`--context fresh` では毎回新しい
  会話を使います。
- `verify` と二つの `review` は、編集可能なworkdirではなく、同じ固定
  Candidateを対象にします。レビュー会話は実装会話と独立した新規sessionです。
- 修正後は新しいCandidateになり、古いテスト結果、レビュー、承認はReducerが
  無効化します。
- 承認waitとsignalは同じCandidate IDを必須とし、最終成果物には承認された
  Candidateを返します。

## 構造

`src/factory/job.ts` は、保存済みstateからPolicy判断を記録し、実関数を持つ
registryを呼び、返ったeventをreduceするだけです。作業場所の用意、固定テスト、
並列レビュー、waitは `src/factory/stages.ts` 内の各Stageが組み立てます。Stage全体を一律に
`step.run()` で包まないため、承認waitはDurablyの正しい境界にあります。

```text
setup
triage (profiles.triage があるときだけ一度。判定を記録するだけ)
decision:N
  └─ stages[decision.stage](...)
       ├─ code: agent call → fixed Candidate
       ├─ verify: fixed acceptance command against Candidate
       ├─ review: correctness + edge-cases (step.all, new sessions)
       ├─ approve: prepareWait → waitFor(Candidate ID)
       └─ finish/stop: approved Candidate or terminal failure
```

ここでCandidateは「実装を終えた時点のコードをコピーした候補版」です。テスト、
レビュー、承認が別々のコードを見ないようにするための識別子であり、信頼できない
コードを隔離するsecurity sandboxではありません。Candidateは次の参照を持ちます。

```ts
type CandidateRef = {
  id: string
  snapshotDir: string
  sourceHash: string
  acceptanceHash: string
}
```

受け入れテストは開始時に別ディレクトリへ固定します。検証コマンドはサンプル側に
固定した `node --test` であり、agentが編集した `package.json` のtest scriptは
合否判定に使いません。Candidateは作成後に同じ場所へ上書きせず、検証・レビューの
前後、承認再開後、終了直前にraw bytesのhashを確認します。これは工程間の
取り違えや意図しない変更を検出するための仕組みで、敵対的なコードからfilesystemを
守るものではありません。レビューpromptには固定した
baselineの変更一覧と元の `src/calc.js` を渡すため、Candidateだけを読む独立session
でも「変更が最小か」「`mul()` を触っていないか」を比較できます。
固定テストは通常の子processで実行します。子processは独自のprocess groupを持ち、
timeoutやcancelではgroupごと終了するので、CLIが起動した孫processが残りません。
hard killはnode自身の `--test-timeout` より少し後ろに置きます。同時に撃つと
SIGKILLが勝ち、「どのテストが止まったか」を含まない結果が修正promptへ渡るため
です。

## セットアップ

```bash
pnpm install
pnpm --filter example-local-agent-loop typecheck
pnpm --filter example-local-agent-loop test:unit
```

使うproviderだけをインストールし、ログインしておきます。

```bash
codex --version
codex login

# または
claude --version
claude auth login
```

Codexは `ai-sdk-provider-codex-cli@2.3.0`（同梱の `@openai/codex` 0.156.1）のapp-server modeを使い、最初の
呼び出しでpersistent threadを作り、修正時は保存した `threadId` を明示します。
Claudeは `ai-sdk-provider-claude-code@4.3.1` が返す `sessionId` を保存し、修正時は
明示的な `resume` を使います。「cwdで最新の会話を選ぶ」動作は使いません。

## 実行

Terminal 1:

```bash
pnpm --filter example-local-agent-loop demo worker
```

workerはstate rootごとに1つだけ動きます。workerは起動時に
`~/.local/state/local-agent-loop/worker.lock` をOSのファイルロック（SQLiteの排他
トランザクション）で握り、同じstate rootで2つ目を起動すると、動いているworkerの
pidと起動元のcheckoutを表示して終了コード1で拒否します。

```text
another worker already runs on ~/.local/state/local-agent-loop: pid 41234, started 2026-09-25T01:02:03.000Z from /Users/me/src/durably/examples/local-agent-loop. Stop it first (kill 41234); two workers would pick up each other's runs.
```

- ロックはプロセスと一緒に消えます。Ctrl-C、SIGTERM、初期化の失敗では自分で
  解放し、`kill -9` やクラッシュではOSが解放します。pidを書いた
  `worker.json` が残っていても、次のworkerはロックを取り直して上書きするので、
  古い情報だけで起動を拒むことはありません。
- 別のstate root（`HOME` が違う環境）のworker同士は互いを拒みません。
- timeoutは `trigger` の時点でrun inputに固定されるので、workerの環境変数で
  既存runの値が変わることはありません（「trigger時点で固定されるもの」）。

Terminal 2:

```bash
pnpm --filter example-local-agent-loop demo trigger \
  --provider codex --context reuse --max-iterations 2

pnpm --filter example-local-agent-loop demo status --run <runId>
pnpm --filter example-local-agent-loop demo waits --run <runId>
pnpm --filter example-local-agent-loop demo approve --run <runId> --wait <waitId>
pnpm --filter example-local-agent-loop demo report --run <runId> --format md
```

Claudeでは `--provider claude` に替えるだけです。承認CLIはwait metadataから
Candidate IDを読み、signal payloadにも同じIDを入れます。拒否は `approve` の
代わりに `reject` を使います。

### 止まったrunと次の手順を見る

`--run` を付けない `status` は、手を打つ必要があるrunを一覧します。対象は
pending、leased、waiting、failed、cancelled、および検証失敗かレビュー上限で
終わったcompleted runです。各runに理由と次に打つコマンドを表示します。何も
なければ「No runs need attention」と表示します。

```bash
pnpm --filter example-local-agent-loop demo status
```

```text
01M375ZAYC...  waiting  (created 2026-09-23T13:06:11.530Z)
  reason:  waiting for human approval of candidate candidate-1-9958e915bf52
  next:    pnpm --filter example-local-agent-loop demo report --run 01M375ZAYC...  # read the reviews first
           pnpm --filter example-local-agent-loop demo approve --run 01M375ZAYC... --wait 01M375ZC2C...
           pnpm --filter example-local-agent-loop demo reject --run 01M375ZAYC... --wait 01M375ZC2C...
```

- 表示するコマンドは、リポジトリ内のどこからでもそのまま貼り付けて実行できます。
  補足は `  # ...` のシェルコメントとして後ろに付けます。
- 承認waitで止まっているrunだけに、そのrun IDとwait IDを入れた `approve` と
  `reject` を表示します。承認・拒否を記録済みでまだworkerが拾っていないrunには、
  判断が記録済みであることと、workerの起動を表示します。
- leasedは、lease期限内なら実行中、期限切れならworkerが止まったものとして
  区別します。期限切れは失敗ではないので、workerを起動すればcheckpointから
  再開します。ただし完了checkpointのないagent呼び出しが残っていれば、再開した
  runはその呼び出しで止まり、人の確認を待ちます。
- 止まったrunには、理由、再試行の可否（`retry`）、人が確認すべき内容
  （`check`）を表示します。`retry: yes` は「新しいrunを始めても、結果の
  分からないagent呼び出しを重ねて送らない」という意味で、同じ入力で成功する
  保証ではありません。
- 開始checkpointだけが残ったagent呼び出しは `uncertain-invocation` として
  `retry: NO` になり、送り直すコマンドは出しません。providerの履歴と作業場所、
  表示されたcheckpointを人が確かめてください。このrunにはworktreeの削除
  コマンドも出しません。分類できない失敗も `retry: NO` です。
- `--publish` 付きでcancelされたrunは `cancelled-publish` として `retry: NO`
  になります。pushやpull requestの作成が記録前に済んでいる可能性があるので、
  remoteのbranchとpull requestを先に確かめてください。
- `retry: yes` のrunには `demo retrigger --run <id>` を表示します。止まったrunに
  保存された入力（task、設定、profile）のまま新しいrunを1回だけ始めます。同じコマンドを
  もう一度打っても、最初に始めたrunを返すだけです。`retry: NO` の
  runや、まだ止まっていないrunには実行を拒みます。素の `demo trigger` は同梱の
  題材で動くので、次の手順には出しません。
- 終わったrepo runのworktreeが残っていれば、
  `git -C '<repo>' worktree remove '<workdir>'` を表示します。setupが記録した
  パスが存在するときだけ出し、強制削除やbranch削除は含みません。変更が残る
  worktreeではgitが削除を拒みます。実行するかどうかは利用者が決めます。

同じ理由と次の手順は、`status --run <runId>` の `diagnosis` と、reportの
`failure`（JSON）および「Stop reason」節（Markdown）にも出ます。

### ブラウザで見る（web UI）

worker を動かしたまま、別のターミナルで読み取り専用の web UI を起動できます。

```bash
pnpm --filter example-local-agent-loop demo ui             # http://127.0.0.1:4380/
pnpm --filter example-local-agent-loop demo ui --port 4500
```

- 表示された URL をブラウザで開きます。待ち受けは `127.0.0.1` だけで、外部には
  公開しません。`--port` は 1〜65535 の整数だけを受け付けます。
- 事前のビルドは要りません。Vite が画面を要求時に変換して配信します。
  `pnpm --filter example-local-agent-loop build:ui` は静的アセットがビルドできるかの
  確認用です。
- UI は固定 state root の DB を読み取り専用で開くだけで、書き込みません。DB が
  まだなければ空の画面を出し、DB を作りません。worker か `trigger` が DB を作ると、
  次の更新から表示されます。
- 画面は 3 秒ごとに読み直します。前の読み込みが終わるまで次は始めません。
  読み込みに失敗したときは直前の表示を残し、上部に「更新失敗」と表示します。
- approve、reject、retrigger などの操作はできません。表示するのはコマンドまでで、
  「承認コマンドをコピー」などのボタンでコピーして CLI で実行します。補足が要る
  コマンドには、ボタンの下にそのコマンドで何が起きるかを日本語で添えます。コマンドそのものは「コマンド全文」を
  開くと見られます。表示もコピーも、CLI が付ける英語の `# ...` の補足は含みません。

run は保存済みの入力から付けた名前で並びます。issue から作った run は
`#番号 タイトル`、`--task` / `--task-file` の run はタスクの最初の行（80 文字まで）、
同梱題材は「同梱題材: calc の add を直す」です。run ID は末尾 6 文字だけを添え、
完全な ID は run 詳細とコピーしたコマンドにあります。作成時刻は「3分前」のような
相対表記で、正確な時刻はマウスを重ねると出ます。

**実行一覧**は3つの欄に分かれます。

- **人の手が要る実行**：承認待ち（approve / reject を決める）、停止（検証失敗、
  レビュー上限、未確定の外部呼び出しなど）、承認以外の入力待ち。停止した run は
  「終わった実行」にも並びます。
- **動いている実行**：実行中（期限内の lease）、担当が途切れた（lease が切れて worker が止まった。
  worker を起動すれば再開）、順番待ち（未処理）、判断済み・再開待ち。
  正常に実行中の run は「人の手が要る実行」の欄には出ません。
- **終わった実行**：新しい順に、タスク、結果、所要時間、費用、見立て（記録した triage 判定）、開始。

状態名は必ず文字で出し、色は「人待ち（琥珀）」「失敗（赤）」「実行中（青）」だけに
付けます。状態の区分と次のコマンドは `demo status` と同じ関数（`src/engine/status.ts`）から
作るので、同じ時点の `demo status --run <id>` と一致します。説明文は区分と停止の種類から
画面用の日本語で出し、CLI の英語の reason は表示しません。未確定の外部呼び出しで
止まった run には、再実行を促すコマンドを出しません。工程の並びでは、通った工程に ✓ を
付けます。

実行中の run の「全体 … 経過」は run の開始（lease 取得、まだなら作成）から、
「この工程 … 経過」はいまの工程の attempt の開始から、画面を読んだ時点までの暫定値です。
report の確定値（所要時間、工程ごとの時間）とは別に扱い、確定値には混ぜません。

**実行の詳細**は `demo report --run <id> --format json` と同じ値を表示します。工程ごとの
時間（横棒）、工程別・役割別の token と費用、レビューの全回の判定とメモ、候補（candidate）
と候補ごとの変更ファイル数・追加行数・削除行数、納品物（delivery）、入力ファイルの
SHA-256 です。工程の時系列で行を選ぶと、実装の行には封印した候補の規模を、レビューの
行にはその回の判定とメモを、検証の行には終了コードと検証ログのパスを出します。
検証失敗で止まった run では、停止理由の欄にも同じログのパスと終了コードを出します。
パスは「〜のパスをコピー」ボタンでコピーできます。ログの中身は画面に出さないので、
コピーしたパスをエディタや `less` で開いてください。承認待ちの run では、レビューの判定とメモは
承認 wait の metadata から、candidate は保存済みの candidate step から読みます
（report の `reviews` と `candidate` にも同じ値が入ります）。

**集計**は終了した run だけを `demo compare` と同じ処理にかけ、config version ごとに
結果別の件数、所要時間・作業時間・費用などの中央値、最小、最大、件数、不明の数、
見立て（triage 判定）別の結果を表示します。

表示値の読み方：

- 費用は記録した token 数を API 料金で換算した参考値です。サブスクリプションの
  請求額ではありません。
- 使用量や価格が分からないものは「不明」と表示し、0 とは表示しません。一部の
  呼び出しだけ分かっている値と、一部の attempt だけ計測できた工程時間には「一部」を
  付けます。
- 集計の統計は不明な値を除いて計算し、除いた数を「不明」の列に出します。

### デモデータ

実際の利用に近い run を並べて web UI を見たいときは `demo seed` を使います。
実 LLM は呼ばず、すべて fake provider で動きます。

```bash
pnpm --filter example-local-agent-loop demo seed
pnpm --filter example-local-agent-loop demo seed --home ~/tmp/factory-demo --latency 3000-15000
```

- 使い捨ての HOME を OS の一時ディレクトリに作り、その場所を表示します。
  `--home` には空のディレクトリか、まだ無いパスを渡します。普段の
  `~/.local/state/local-agent-loop/` には触れません。
- その HOME に小さな JS プロジェクトの git リポジトリと `factory.json` を作り、
  日本語のタスクで repo 対象の run を 13 本起動します。固定テストは本物の
  `node --test` です。
- `factory.json` の各役割には実際に使いそうな model を書いています。実装と
  correctness レビューは `gpt-6-sol`、edge-cases レビューは `claude-opus-5-5`、
  triage は `gpt-6-luna` です。provider は fake なので、これらは requested model
  として記録され、token 数と費用はその model の価格で計算します。run は fake と
  表示され、実 LLM 検証には数えません。
- 結論は一通りそろいます。修正 1 回で承認、初回で承認、レビュー上限、検証失敗、
  未確定の呼び出し、承認待ち 2 本、却下、triage の routine と probe です。
- `--latency` は 1 回の呼び出しにかかる時間の範囲で、既定は `20000-90000` ミリ秒
  です。seed はこの run を同時に進め、承認と却下を `demo approve` / `demo reject`
  と同じ処理で送り、落ち着くまで待ちます。
- 最後の 2 本は、1 回の呼び出しに 10〜20 分かかる設定でバックグラウンドの
  worker に渡します。seed が終わった時点で 1 本は実行中、もう 1 本は worker 待ち
  です。worker の pid とログの場所を表示します。
- 作成時刻は実際に seed を動かした時刻です。Durably が時刻を記録し、seed は DB を
  書き換えないので、数日分の履歴には見えません。

最後に、画面を開くコマンドと、worker を止めたあとで続きを動かすコマンドを
表示します。

```bash
HOME=<表示された場所> pnpm --filter example-local-agent-loop demo ui
HOME=<表示された場所> pnpm --filter example-local-agent-loop demo worker
```

## 実リポジトリに対して動かす

同梱の題材ではなく、実際のリポジトリの作業を渡す場合です。リポジトリごとに変わらない
設定は、対象リポジトリ直下の `factory.json` で管理します。

```json
{
  "check": ["pnpm", "validate"],
  "setup": ["pnpm", "install", "--frozen-lockfile"],
  "base": "main",
  "baselineCheck": true,
  "checkTimeoutMs": 900000,
  "agentTimeoutMs": 1800000,
  "profiles": {
    "code": { "provider": "codex", "model": "gpt-5.6-sol", "effort": "medium" },
    "review": {
      "correctness": { "provider": "codex", "model": "gpt-5.6-terra" },
      "edge-cases": { "provider": "claude", "model": "claude-sonnet-5" }
    }
  }
}
```

これがあれば、作業内容を書いたファイルを渡すだけで起動できます。

```bash
pnpm --filter example-local-agent-loop demo trigger \
  --repo ~/progs/myapp --task-file ~/work/task.md \
  [--spec-file ~/work/spec.md] [--dispositions-file ~/work/dispositions.md]
```

- `--repo` のリポジトリから `git worktree` を切り、その中だけで作業します。
  あなたが開いているcheckoutは一切動きません。
- 作業内容は `--task-file`、`--task "..."`、`--issue 234` のどれか一つで渡します。
  `--issue` は `gh issue view` で本文を取ります。
- `--spec-file` は実装とレビュー二つの全員に、`--dispositions-file`（過去の
  レビュー指摘をどう扱ったか）はレビューだけに渡ります。どれも中身を解釈しない
  UTF-8テキストで、1ファイル256 KiBまでです。promptでは「信頼しないデータ」として区切った区画に入り、
  factoryの指示や出力形式とは混ざりません。
- `check` は**エージェントが走り出す前に固定される採点コマンド**です。argvとして
  そのまま実行するのでshellではありません。configにもフラグにも無ければ起動しません。
  何を直せば通るのかが決まっていない依頼は、そもそもファクトリーに向きません。
- `setup` は新しいworktreeに依存をインストールするためのものです。省略すると
  installなしで `check` が走ります。`base` の既定は `HEAD` です。
- `--check`、`--setup`、`--base` を付けるとconfigの値より優先します。別の場所の
  configは `--config <path>` で選べます。相対パスはCLIプロセスのcwdから解決します。
  `pnpm --filter` はpackageのディレクトリでCLIを動かすので、パスは絶対パスで
  渡してください。
- `profiles` は `code`（実装と修正）、`review.correctness`、`review.edge-cases` の
  三役割を別々に指定できます。configが省いた役割と、役割の中で省いた項目だけを
  `--provider`、`--model`、`--effort` とpresetで補います。ただし `--provider` と
  違うproviderを指定した役割は `--model` と `--effort` を引き継がず、そのproviderの
  既定presetを使います。明示した役割の値が他の役割やフラグで上書きされることは
  ありません。fakeと実providerを役割ごとに混ぜる
  ことはできません。
- timeoutの既定値はターゲットで変わります。実リポジトリはagent呼び出し30分、
  検査15分。同梱題材はそれぞれ5分と2分です。`factory.json` の
  `agentTimeoutMs` と `checkTimeoutMs`（ミリ秒）が最優先で、無ければ `trigger`
  を実行したプロセスの `AGENT_TIMEOUT_MS` と `TEST_TIMEOUT_MS`、それも無ければ
  既定値を使います。どれも正の安全な整数に限り、`0`、負数、小数、`NaN`、
  `Infinity`、`Number.MAX_SAFE_INTEGER` 超は `trigger` の時点で拒否します。
  解決した値はrun inputに保存し、workerの環境変数は読みません（この変更より前に
  保存されたrunだけは、従来どおりworkerの環境変数を読みます）。
- 反復ごとにcommitして封印します。検証・レビュー・成果物は同じcommitを見ます。
- 既定の成果物は `~/.local/state/local-agent-loop/runs/<runId>/delivery/<candidate>.patch`
  です。issueなしのrunのbranchは `factory/<runId>` で、承認されたcommitはこの
  branchに残ります。`status` とreportがbranch名とcommit SHAを表示します。承認されず
  成果物が無いrun（却下、検証失敗、レビュー上限）でも、最後に封印したcandidateの
  branchとcommitを `candidate` として表示します。
  `--publish` を付けるとbranchをpushしてDraft PRを作ります。

`--publish` を付けない限り、外向きの操作は起きません。まずpatchで確かめてから
PRに進むのが安全です。

人間の承認待ちは、実リポジトリでは既定で入りません。Draft PR自体が人間の
レビュー対象で、マージするのも人間だからです。`--approve manual` で
同梱題材と同じ承認waitを挟めます。

### baseの採点を先に確かめる（baselineCheck）

`factory.json` に `"baselineCheck": true` を書くと、setupが終わった直後、
エージェントを呼ぶ前に、base commitのworktreeで固定した `check` を一度だけ
実行します。既定は `false` で、そのときは実行しません。repo targetだけの設定です。

- baseで `check` が失敗したら `baseline-check-failed` で止まります。エージェント
  呼び出し（triageとpreflightを含む）は0回です。`retry: yes` で、次の手順は
  「採点コマンドか環境（setup、依存、base）を直す」です。
- 終了コードと、stdout・stderrの全文ログのpath（`runs/<id>/baseline-logs/<attempt>/`）
  を `status`、reportのJSON（`baseline`、`failure.details`）とMarkdown
  （「Baseline check」節）、web UIの停止理由に出します。timeoutで打ち切られた
  ときは終了コードを不明（`unknown`）とし、打ち切りまでの時間を出します。
- 検証と同じcheckpointで記録します。完了した結果はworker再開時に読み戻して
  再実行せず、途中で止まった採点はやり直します。中断した試行の部分ログは
  合否の根拠にしません。
- 採点がworktreeのtracked fileを書き換えた場合は、最初のcandidateに混ざるので
  runを止めます。

### 設定の事前確認（preflight）

baselineの後、triageを含む最初のエージェント呼び出しの前に、全役割
（code、二つのreview、設定したtriage）のprovider、model、effortを確かめます。
同じ組み合わせは一度だけ確かめ、使う役割すべてに結果を対応付けます。

- Codexは無料の `model/list`（固定したCodex CLIのapp server）で、そのloginで
  使えるmodelと、そのmodelが受け付けるeffortを確かめます。一覧に無い、または
  effortが無ければ、promptを送らずに止めます。一覧が読めないときだけ最小の
  呼び出しにします。
- Claude Codeにはpromptを送らずに確かめる手段が無いので、組み合わせごとに
  最小の呼び出し（「OK」とだけ返させる読み取り専用の呼び出し）を1回します。
- 最小の呼び出しは通常の呼び出しと同じcheckpointと計測を通り、使用量と推定費用は
  stage・roleとも `preflight` として別に集計します（code/reviewには混ぜません）。
  providerが明示的に拒否した場合（未知のmodel、使えないmodel、login切れ、
  Codex CLIが起動しないなど）は完了として記録し、`preflight-failed`（`retry: yes`）
  で止まります。送ったかどうか分からない呼び出しは送り直さず、
  `uncertain-invocation`（`retry: NO`）になります。
- 使えない組み合わせがあると、実装の呼び出し前に `preflight-failed` で止まり、
  役割、設定、確認方法、原因をエラーに出します。reportの `preflight`（JSON）と
  「Preflight」節には、役割ごとの結果、確認方法、CLIのpathと版、最小の呼び出しの
  使用量と費用（分からなければ `unknown`）が残ります。

### Codex CLIを固定する（codexPath）

`factory.json` の `"codexPath"` で起動するCodex CLIを指定できます。相対パスは
`factory.json` のあるディレクトリから解決し、実行可能な通常ファイルでなければ
`trigger` が失敗します。解決した絶対パスをrun inputに固定し、preflight、本番の
呼び出し、版の取得はすべてそのファイルを使います。`.js` などのscriptは `node`
で起動します。省略時は従来どおり、同梱の `@openai/codex` を優先し、無ければ
PATHの `codex` を使います。CLIのpathと版はreportの「Versions」と「Preflight」に
出て、`configVersion` にも入るので、違うCLIで動いたrunは別の設定として比較されます。

### trigger時点で固定されるもの

`factory.json`、task、spec、dispositionsは `trigger` の時点で一度だけ読みます。
フラグを適用した後の各役割のrequested設定と、入力ファイルのpathと本文をrun inputに
保存します。実際に使うmodelとeffortは、workerがそのrequested設定からproviderの
presetで解決します。workerは元のファイルを読み直さないので、trigger後にファイルを
書き換えても、そのrunの設定とpromptは変わりません。timeout、`codexPath`、
`baselineCheck` も同じく解決済みの値をrun inputに保存します。reportには各入力ファイルの
pathと、保存した本文から計算したSHA-256が出ます。

### タスクの事前判定（shadow mode）

`factory.json` の `profiles.triage` を書くと、setupの後、実装の前に一度だけ
LLMにタスクを判定させます。書かなければ判定の呼び出しは起きず、従来と同じ
流れで動きます。

```json
{
  "profiles": {
    "triage": { "provider": "codex", "model": "gpt-5.6-sol", "effort": "low" }
  }
}
```

- 項目の補い方は他の役割と同じです。`"triage": {}` でも有効になり、
  `--provider`、`--model`、`--effort` とpresetの値を使います。fakeと実providerを
  混ぜられない規則も同じです。
- 判定は `routine`（そのまま実装とレビューで終わりそう）か `probe`（試しに実装
  してみるべき）のどちらかと、1〜2文の理由です。新しいsessionで、読み取り専用
  権限で動きます。渡すのは保存済みのtaskとspecだけで、「信頼しないデータ」の
  区画に入れます。dispositionsは渡しません。
- 今は **shadow mode** です。判定は記録するだけで、工程やprofileの選択には
  一切使いません。`routine` と `probe` のrunは同じ工程を同じprofileで進みます。
  経路の切り替えは [ADR-0018](../../docs/adr/0018-local-agent-loop-adaptive-routing.md)
  の後続の段階で、判定の精度を測ってから入れます。
- 形式に合わない応答（空、JUDGMENTが無い、二つある、`routine`/`probe` 以外、
  REASONが無いか500文字を超える）と、provider errorやtimeoutは `unknown` として
  理由と一緒に記録し、runは実装へ進みます。判定の失敗でrunが止まることはありません。
  timeoutは最長5分です。triage呼び出しの使用量が分からない場合、そのrunの合計
  token・costも不明として扱います（0とは数えません）。
  ただし、再開時に開始だけのcheckpointが見つかった場合は、他の呼び出しと同じく
  未確定として止まります。
- 判定と理由は `report --format json` の `triage`、Markdownの「Triage」節、
  `status --run` の `triage` に出ます。承認待ちの途中でも読めます。判定の
  無いrunは `null`（Markdownでは `none`）で、`unknown` とは区別します。
- `profiles.triage` の有無と中身は `configVersion` に入ります。triageの無いrunの
  `configVersion` は以前と変わりません。

### durably checkoutを固定して呼ぶ

コードを対象リポジトリへコピーせず、durablyのcheckoutを特定のcommitに固定して
そのまま呼ぶこともできます。

```bash
git -C ~/src/durably fetch
git -C ~/src/durably checkout <commit>
pnpm -C ~/src/durably install --frozen-lockfile
pnpm -C ~/src/durably --filter example-local-agent-loop demo worker     # Terminal 1
pnpm -C ~/src/durably --filter example-local-agent-loop demo trigger \
  --repo "$PWD" --task-file "$PWD/task.md"                                # Terminal 2
```

対象リポジトリに置くのは `factory.json` と作業内容のファイルだけです。固定する
commitは利用側で記録し、上げるときは意図してcheckoutし直します。コピーする方式との
比較は [docs/porting.md](docs/porting.md) にあります。

### DBと作業物の置き場所

DBと全runのデータは `~/.local/state/local-agent-loop/` に置きます。

```text
~/.local/state/local-agent-loop/
  local-agent-loop.db              run、step、attempt、wait
  runs/<runId>/
    work/                          worktree（同梱題材ではコピー）
    operation-checkpoints/         LLM呼び出しと検証のcheckpoint
    verification-scratch/          検証用の一時領域
    verification-logs/<candidate>/<attempt>/
      stdout.log                   検証コマンドの標準出力（全文）
      stderr.log                   検証コマンドの標準エラー（全文）
    candidates/<candidate>/        repo runの候補ごと
      changes.diff                 base commitから候補commitまでの全差分
      changed-files.txt            変更ファイルの一覧（1行1ファイル）
    delivery/<candidate>.patch     成果物
```

- **検証ログ**: 採点コマンドの出力は、検証の物理的な試行（step attempt）ごとに
  `verification-logs/` へ切り詰めずに保存します。reportの抜粋や修正promptに渡す
  出力は従来どおり末尾だけですが、ログファイルには途中の失敗箇所も残ります。
  タイムアウトで打ち切った試行は終了コードを `null` とし、打ち切りまでの出力を
  残します。完了checkpointから復旧した試行は採点をやり直さず、元の試行のログと
  終了コードを指します。開始checkpointだけが残った試行は採点し直し、新しい試行の
  ログを別のディレクトリに書きます。止まった試行のログも消しません。
  キャンセルやリースの喪失で中断した試行も、終了コードを `null` として途中までの
  ログを記録し、`interrupted: true` を付けます。この試行は判定を出していないので、
  検証の結果には数えません。子プロセスを起動する前に中断した試行はログを記録しません。
  ログファイルへの書き込みに失敗しても検証の結果は変えず、エラーを
  `writeError` に残します。そのログファイルは中身が欠けているかもしれません。
- **候補の差分**: repo runでは候補を封印するたびに、記録済みのbase commitと候補
  commitの差分を `candidates/<candidate>/` に書き出します。worktreeの外なので、
  agentが書き換えることはできません。検証で止まってレビューに進まなかった候補にも
  書きます。両方のレビュアーのpromptにはこの二つのファイルの絶対パスが入り、
  全文を読むよう指示します。Claudeのレビュアーは、作業場所の外ではこの二つの
  ファイルだけを読め、書き込みはできません。

worker、trigger、status、waits、approve、report、compareはすべて引数なしで同じDBを
見ます。ディレクトリが無ければDBを開く前に作ります。durablyのcheckoutの中にも、対象
リポジトリの中にも、DBや `runs/` は作りません。checkoutをどのcommitに切り替えても、
過去のrunはそのまま読めます。置き場所を変える引数や環境変数はありません。二つの
プロセスが別のDBを見ると、runが黙って見えなくなるからです。

### 以前の版からの移行 (Upgrading)

以前の版はDBを `examples/local-agent-loop/local-agent-loop.db`（または `DURABLY_DB`
の指す場所）に、作業物を `examples/local-agent-loop/runs/` に置いていました。
この版はそれらを読まず、移行もしません。checkoutに古いDBが残っていると、
workerとCLIは起動時にその場所と新しい場所をstderrに一度警告します。承認待ちや
実行中のrunが残っているなら、上げる前に以前の版で終わらせるか破棄してください。
その後、古いDBと `runs/` は消して構いません。worktreeを消したときは、対象
リポジトリで `git worktree prune` を実行します。

### 使用量の責任範囲

factoryが責任を持つのは、factoryのDBと `report --format json` までです。利用側で
使用量の台帳をつけている場合は、run終了後に利用側がreportを読んで取り込みます。
factoryから台帳へ書き込むことはしません。

```bash
pnpm --filter example-local-agent-loop demo report --run <runId> --format json \
  | jq '{runId, configVersion, inputs, delivery, roleUsage, summary}'
```

`roleUsage` は `code`、`correctness`、`edge-cases` の三行で、それぞれrequested
provider/model/effort、invocation数、token内訳、合計token、cost、`complete`、
`costComplete` を持ちます。fake providerのようにusageを返さない呼び出しは0にせず、
tokenとcostを `null`、`complete` を `false` にします。tokenがそろっていても価格表に
無いmodelならcostは `null`、`costComplete` は `false` です。

## reuse / fresh 比較

同じ題材、provider、model、effort、最大反復数で二つのrunを作ります。

```bash
pnpm --filter example-local-agent-loop demo trigger \
  --provider codex --context reuse --model gpt-5.6-sol --effort medium

pnpm --filter example-local-agent-loop demo trigger \
  --provider codex --context fresh --model gpt-5.6-sol --effort medium
```

両方を承認まで進め、`compare` で修正回数、cache read/write、実作業時間、
並列review区間、人間待ち、run全体時間の中央値を比較します。session継続はcache hitを
保証しません。効果はproviderが報告したcache usageで判断します。

modelとeffortはコマンドラインとpreset表だけで決まります。環境変数は一切参加
しません。runの構成が、それを起動したコマンドを読めば分かる状態を保つためです。
とくに `CLAUDE_EFFORT` はClaude Codeがシェルへexportするので、これを尊重すると
「どのagent sessionから叩いたか」でeffortが変わり、同じつもりのrunが別の
configVersionに分かれてしまいます。

## 呼び出し識別と復旧

次のIDを混同しません。

```text
sessionId      provider-native conversation/thread
operationKey   一つの論理的な仕事
invocationId   実際に送った一回の依頼
attempt.id     Durably step callbackの実行試行
```

LLM呼び出しと固定テストは、実行前に `operationKey` と `invocationId` のstart
checkpointを保存し、結果を受け取ったらcomplete checkpointをatomicに保存してから
stepを完了します。復旧時にcomplete checkpointがあれば同じ結果を読み、依頼や
テストは再送しません。

startだけが残った場合の扱いは、その仕事を送り直して良いかで分かれます。

- **LLM呼び出し**: 自動再送せず `uncertain external invocation` で停止します。
  CLIがすでに仕事を終えて課金された可能性を、こちらからは判定できないためです。
- **固定テスト**: 古いstart recordを消して採点し直します。固定した
  Candidateを読み、scratchディレクトリへ書くだけなので、再実行は無料で同じ
  判定になります。workerを `kill -9` する再開デモを恒久的に詰まらせません。

作業物とcheckpointは `~/.local/state/local-agent-loop/runs/<runId>/` に
残ります。独自daemonや送信管理DBはありません。

この契約は「結果受信後、Durably checkpoint前」の重複を防ぎます。一方、CLIが
作業を終えた直後かつcomplete checkpoint前にプロセスを強制終了した場合は未確定
として止まります。初版ではprovider-native履歴を推測して自動採用しません。

## 計測

LLM呼び出しはすべて `src/engine/runner.ts` を通り、attempt metadataへ以下を保存します。

- requested、effective、provider-reported model/effort（未指定・未報告値は `null`）
- `sessionId`、`operationKey`、`invocationId`、回収結果かどうか
- 通常input、cache read、cache write、output、total token
- usageの単位（このサンプルは一provider invocation）と取得元
- elapsed、result、error、interruption reason、API換算参考価格とmeter別内訳
- `configVersion`（三役割それぞれのprovider、model、effort、context、指示版、
  反復上限、対象、timeoutのhash。triage profileがあればそれも含む）

providerが返すusageは、一回の呼び出しの**全モデル応答の合計**でなければいけません。
エージェントCLIは一回の呼び出しの中で何十回もモデルを呼ぶので、最後の応答だけでは
桁が変わります。

- **Claude**: Agent SDKの `result` メッセージの累計をそのまま使います。Claude Codeの
  transcriptに記録された各応答の合計と一致することを確認済みです。
- **Codex**: `ai-sdk-provider-codex-cli@2.3.0` は応答ごとの `thread/tokenUsage/updated`
  を turn 内で合計します（2.2.1 は上書きしていたため最後の応答分しか返さず、
  [ben-vargas/ai-sdk-provider-codex-cli#49](https://github.com/ben-vargas/ai-sdk-provider-codex-cli/issues/49)
  で報告して `patches/` のパッチで直していました。2.3.0 で上流に入ったのでパッチは
  外しています）。増分は turn 開始前の thread 累計からの差分で求めるので、
  `--context reuse` でも前回の呼び出し分は含みません。cache write も上流で
  `0` 固定をやめ、
  app-serverが返す値を読むようにしています。ただしChatGPTログイン（サブスク）では、
  サーバーが実際の書き込みに関係なく常に0を返します
  （[openai/codex#32479](https://github.com/openai/codex/issues/32479)）。この環境の
  33万応答のうち、確実に書き込みが起きた2,334件もすべて0でした。そのため
  ChatGPTログインの0は不明として扱い、正の値だけを採用します。APIキーでは値が
  実数なので0もそのまま使います。ログイン方式は `codex login status` で判定します。
  cache writeが不明な呼び出しがあると、レポートは「書き込み割増を含まない下限」
  と注記します。
  修正前は、実際には25回応答していた実装工程が1回分として記録され、
  run全体のコストが約16分の1に見えていました。

集計は `invocationId` で一度だけ数えます。同じcomplete checkpointを別attemptが
読み直してもtokenを二重計上しません。ローカルテストやPolicyはusage対象外です。
LLMを呼んだのにusageが無い場合は欠測として件数を残し、完全な合計にはしません。
レポートはSQLiteのrun、attempt、waitから再生成する純粋な処理です。

```bash
pnpm --filter example-local-agent-loop demo report --run <runId> --format json
pnpm --filter example-local-agent-loop demo report --run <runId> --format md \
  --out reports/<runId>.md
```

レポートは次の三層で出します。

- **Summary**: run 1本を1行に畳んだ値。success、lead time（trigger→終了）、
  work（工程実作業の合計）、human wait とその lead time 比、LLM呼び出し数、
  total tokens、cost、cost per success（成功したrunだけ）、repairs、review rounds
- **Inputs / Candidate / Delivery**: task、spec、dispositionsの各ファイルの
  SHA-256、最後に封印したcandidateのbranchとcommit、成果物の場所、branch名、commit SHA
- **Candidates**: 封印したすべての候補（JSONの `candidates`）。候補ごとに
  何回目の実装か、branch、commit、変更ファイル数、追加行数、削除行数、差分ファイルと
  変更一覧のパス（`changes`）を持ちます。改名は1ファイル、バイナリファイルは
  変更ファイル数にだけ数え、行数にはgitが報告するテキスト行だけを足します。
  変更のない候補はすべて0です。同梱題材の候補は規模を記録しないので `changes` は
  `null` です。`candidate` は従来どおり最後の候補です
- **Review rounds**: レビューの全回（JSONの `reviewRounds`）。回ごとにレビューした
  候補と、両レビュアーの判定とメモを回順に持ちます。保存済みのレビューstepの出力から
  組み立てるので、実行中、承認待ち、修正後に止まったrunでも終わった回が出ます。
  途中で止まった回には、終わったレビュアーの分だけが入ります。`reviews` は従来どおり
  最後の回です
- **Verification logs**: 検証の試行ごとの終了コードと、`stdout.log` / `stderr.log` の
  パス。JSONでは `attempts[].measurement.verificationLog` で、`exitCode`、
  `stdoutPath`、`stderrPath` に加え、中断した試行には `interrupted: true`、
  書き込みに失敗したログには `writeError` が入ります。Markdownでは中断した試行の
  行に `interrupted, not part of the verdict` を付け、書き込みエラーを
  `log write error:` の行に出します。検証失敗で止まったrunでは、最後の検証の
  全試行の終了コードとログのパスを `failure.details` にも載せます
  （`check attempt: `、`check exit code: `、`check stdout log: `、
  `check stderr log: `、`check log write error: `）
- **Triage**: 事前判定（`routine` / `probe` / `unknown`）とその理由。判定の無い
  runは `none`
- **Stage usage**: 工程ごとの visits / reworked（同じ工程への再突入＝手戻り）、
  invocation数、in / cache-read / cache-write / out / total、cost。
  いずれかの呼び出しが未計上なら PARTIAL、価格不明なら unknown
- **Role usage**: `code`、`correctness`、`edge-cases`（triage profileがあれば
  `triage` も）ごとのrequested
  provider/model/effort、invocation数、token、cost、usageとcostそれぞれの完全性。二つのレビューを
  別の行に分けるので、役割ごとに違うmodelを使ったrunでも内訳が混ざりません
- **Timing / Attempts / Waits**: 従来どおりの工程別 work / wall 時間、
  呼び出しごとの生データ、承認待ちの inputWait / executionSlotWait
- **Versions**: `ai` と provider パッケージの版に加え、providerが実際に起動した
  CLIの版とパス。Codexは `codexCli` / `codexCliPath`、Claudeは `claudeCli` /
  `claudeCliPath` です。Codex providerは自分で解決できる `@openai/codex` を
  `node <パッケージ>/bin/codex.js` として起動し、無いときだけPATH上の `codex` を
  使います。Claude Agent SDKは同梱のネイティブバイナリを起動し、PATH上の `claude`
  は使いません。factoryは同じ解決を行い、その実行ファイルをproviderに明示して
  渡すので、記録した版と起動したCLIは同じファイルです。見つからない値は `null`
  にし、別のインストールから推測しません

価格はsubscription請求額ではなく、各呼び出し時に保存した
`api-equivalent-estimate` の参考値です。AI SDK v7 の usage 契約に合わせ、
`inputTokens` 全体のうち cache read / cache write を各 meter の単価で、
残りを input 単価で計算します。cache write はどちらも input の1.25倍です。
cache read はモデルごとに違い、多くは0.1倍、Claude Opus 5.5 は0.05倍、
Claude Fable 5.1 は0.025倍です。価格表は `src/engine/pricing.ts` にあり、
確認日と出典を `PRICE_BASIS` に記録しています。cache legs が報告されなかった呼び出しは input 全体を定価で扱い、
`costCacheAware: false` として区別します。レポートは保存済みの値を合計し、
現在の価格表で再計算したとは表示しません。未知のmodelや欠けたusageを
0円として扱いません。

### モデルの選び方とサブスクでの制約

ログイン済みCLI（サブスク）で使う前提なので、価格表に載っていても呼べない
モデルがあります。2026-09-23 に実際に呼んで確かめた結果です。

| モデル                                                        | サブスクで使えるか                                                 |
| ------------------------------------------------------------- | ------------------------------------------------------------------ |
| `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` | 使える                                                             |
| `gpt-6-sol`, `gpt-6-luna`                                     | 使えない。ChatGPTアカウントのCodexでは400が返る。APIキーでは使える |
| `claude-opus-5-5`, `claude-sonnet-5`                          | 使える                                                             |

`claude-opus-5-5` は Claude Code 2.1.280 以上が必要です。
`ai-sdk-provider-claude-code` は Agent SDK を固定版で同梱しており、最新の4.3.2でも
2.1.278 までしか入らないので、ルートの `pnpm-workspace.yaml` の override で
`@anthropic-ai/claude-agent-sdk` を 0.3.280 に上げています。

`codex debug models` の一覧には、サブスクで呼べないモデルも出ます。一覧ではなく
実際に呼べるかで判断してください。

### 複数 run の比較

1本の run はキャッシュ命中や修正回数でぶれるので、同条件を複数回まわして
`compare` で見ます。`configVersion` が同じ run を1グループにまとめ、
中央値 / 最小 / 最大と欠測数を出します。

```bash
pnpm --filter example-local-agent-loop demo compare \
  --runs <runA>,<runB>,<runC>,<runD> --format md
```

グループごとに success 率、結論別の run 数（`conclusions`。結論を記録する前に
失敗・取り消しで終わった run は `failed` / `cancelled` として数える）、lead time、work、human wait、total tokens、cost、
cost per success、repairs、工程別の work / tokens / cache-read / cost / reworked
を並べます。triage 判定のあるrunを含むグループには、判定（`routine`、`probe`、
`unknown`）ごとの表が付きます。列は run 数、approved、verification-failed、
review-cap-reached、repairs と cost の統計、そして `routine` と判定されたのに
修正が要った、または上限（review cap か、検証失敗で終わった反復上限）に達した
run の数です。最後の列が判定の見逃しで、shadow mode で測りたい値です。cost
不明の run は統計から外して unknown 件数に数えます。triage 呼び出しのtokenと
costは `triage` 工程と `triage` 役割に1回ずつ計上します。

reuse と fresh を比べるときは、`code` 工程の cache-read 比と
repairs の中央値を見ます。unknown は統計から外して件数だけ残し、0 として
平均に混ぜません。

## 権限と制約

- Codex implement/repairはworkspace-write、reviewはread-only sandboxです。
- triageはCodexではread-only sandbox、ClaudeではReadのみで動きます。
- Claude reviewはReadのみです。implement/repairは `canUseTool` と `PreToolUse`
  hookの双方でworkdir外パスを拒否します。これは入力検査であり、OS sandboxでは
  ありません。
- 同じsessionへ並列送信しません。並列なのは新規sessionを使う二つのreviewだけ
  です。
- model、effort、指示版、tool、cwdを途中で替えるhandoffは未実装です。
  trigger時に解決した三役割のprofileをrun中固定します。
- 実装と修正のsession継続は、`code` 役割のprovider、profile ID、cwd、指示版が
  一致するときだけです。レビューのprofileは関係しません。
- fake providerは決定的なローカル練習用で、実LLM検証として数えません。

## fake mode

```bash
pnpm --filter example-local-agent-loop demo worker &
pnpm --filter example-local-agent-loop demo trigger \
  --provider fake --context reuse --max-iterations 3
```

`FAKE_FAIL_FIRST=0` で初回実装を成功させられます。
`FAKE_REVIEW_SEQUENCE="needsChanges,pass"` でreview修正ループを再現できます。
`FAKE_TRIAGE` はtriageの応答を呼び出しごとに順に選びます（`routine`、`probe`、
`empty`、`invalid`、`contradictory`、`unsupported`、`error`。既定は `routine`）。
fakeのtriageは同梱題材ではtriggerのフラグから指定できないので、job inputの
`profiles.triage` で渡します。

fakeのpreflightはrequested modelの名前で決まります。`unlisted-*` は無料の確認で
拒否、`probe-*` は無料の確認では決まらず最小の呼び出しが通り、`refused-*` は最小の
呼び出しが明示的に拒否されます。それ以外は無料の確認で通ります。

`FAKE_LATENCY_MS=20000-90000` を付けると、各呼び出しがその範囲のランダムな時間
待ちます。cancel と timeout では待ちを打ち切ります。`FAKE_USAGE=realistic` を
付けると、役割に応じたそれらしい token 数を返し、requested model の価格で費用を
計算します。付けなければ、これまでどおり token と費用は不明です。

job input の `fakeScenario` は run ごとに fake の振る舞いを変える、デモとテスト
専用の欄です。上の環境変数と同じ項目を run ごとに上書きします。`reviewSequence` と
`reviewNotes` はレビューの回ごとに correctness、edge-cases の順で2つずつ並べ、回と
観点で引くので、呼び出しの順番や再起動後のやり直しで判定が入れ替わりません。すべての
役割が fake の run でしか受け付けず、trigger の時点で断ります。`configVersion` にも
入りません。`demo seed` がこれを使います。

## Layout

コードは三層です。`engine/` はどのリポジトリでも同じもの、`factory/` は工程の
つなぎ方、`targets/` は「何に対して働くか」です。別のリポジトリへ移すときは
`engine/` と `factory/` をそのまま持っていき、`targets/` を書きます。

```text
src/
  engine/           リポジトリに依存しない機構
    runner.ts       LLM呼び出し1回の冪等化と計測
    verification.ts checkpoint付き検証step（採点内容は呼び出し側が渡す）
    candidate.ts    ディレクトリコピーによるCandidate封印
    git.ts          worktree、commit封印、差分、patch、push
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
  ui/               読み取り専用のweb UI（server.tsとReactの画面）
  cli.ts            コマンドの入口
  trigger-input.ts  factory.jsonと入力ファイルの読み込み、trigger時の固定
  approval.ts       candidateに結びつけた承認と却下のsignal
  demo-seed.ts      demo seedが作るデモ用のリポジトリとrun
  durably.ts        固定state directoryのDB（web UI用の読み取り専用接続を含む）
subject/            変更しないバグ入り題材
```

境界の形は `engine/verification.ts` と `factory/target.ts` によく出ています。
前者は start/complete checkpoint、計測、signalの転送までを持ち、「何をもって
検証とするか」は `grade` コールバックとして受け取ります。後者は、作業場所、
封印の仕方、採点、レビューに渡す文脈、成果物の渡し方という、ターゲットごとに
必ず違う5つだけを切り出しています。

移植の手順は [docs/porting.md](docs/porting.md) にあります。
