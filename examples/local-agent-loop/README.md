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

Codexは `ai-sdk-provider-codex-cli@2.3.0` のapp-server modeを使い、最初の
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
- `demo trigger`、`demo status`、`demo wait` は同じロックファイルをのぞいて
  workerの有無を確かめます（`wait` は1秒ごと。読み取りの瞬間だけ共有ロックを
  握ります）。workerの起動はこの瞬間との衝突を最大2秒までリトライして乗り越える
  ので、`wait`を見ながらworkerを起動しても失敗しません。1つ目のworkerが排他ロック
  を握り続けている間は、2つ目のworkerはこのリトライを超えても変わらず拒否されます。
- ロックファイルが読めない（壊れている、権限がないなど）ときは、workerの有無を
  「不明」（`running: null`、`worker: unknown`）と表示します。`wait` は不明を
  「workerがいない」とは数えないので、それだけで終了コード6にはなりません。
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

`--max-iterations` は1つのrunで実装と修正を合わせて何回までするかで、1から5まで
指定できます。省略すると2です。

Claudeでは `--provider claude` に替えるだけです。承認CLIはwait metadataから
Candidate IDを読み、signal payloadにも同じIDを入れます。拒否は `approve` の
代わりに `reject` を使います。

### 止まったrunと次の手順を見る

`--run` を付けない `status` は、手を打つ必要がある task を一覧します。task は
最初の run と、そこから `demo repair` で始めた修正 run（修正の修正も含む）を
まとめた単位です。task ごとに、状態を代表する run の理由と次に打つコマンドを
表示し、その下に task の名前と、ほかの run を `also:` として並べます。

- 先に「人の判断待ち」（承認待ち、仕様の判断待ち、承認以外の入力待ち）と
  「未解決の停止」の task、次に pending、leased、判断済みで再開待ちの task を
  出します。それぞれ新しい順です。
- 修正 run が止まっても、同じ修正元から後に始めた修正 run が承認されていれば、
  その停止は解決済みとして扱い、一覧の上部には出しません（`also:` に
  `replaced by a later approved repair` と付けます）。
- 代表の run は、判断待ちや停止があればその run、動いている run があればその run、
  どれもなければ置き換えられていない最新の run です。
- `demo archive` でアーカイブした止まった run は、終わった run として数えます
  （下の「止まったrunをアーカイブする」）。同じ task のほかの run が人の手を
  待っていれば、その task は上部に残ります。アーカイブした run は最後に
  `stopped run(s) archived:` として、戻すコマンドとともに並べます。
- 止まったままアーカイブしていない run がある task には `stops:` の行で、その件数と
  `demo archive --series <最初の run の ID>` を出します。後の修正 run が承認されて
  置き換えた停止も数え、アーカイブした停止は数えません。この行はテキスト表示だけで、
  `--format json` と web UI には出しません。
- 何もなければ「No runs need attention」と表示します。
- run が複数ある task には `total:` の行で、全 run の所要時間と費用の合計を
  出します。どれかの run の値が分からなければ unknown です。
- `--format json` は、同じ task の並び（`tasks`、合計は各 task の `total`）、
  worker の状態、DB の場所を JSON で出します。web UI の一覧（`/api/runs` の
  `tasks`）と同じ値です。

```bash
pnpm --filter example-local-agent-loop demo status
pnpm --filter example-local-agent-loop demo status --format json
```

```text
01M375ZAYC...  waiting  (created 2026-09-23T13:06:11.530Z)
  reason:  waiting for human approval of candidate candidate-1-9958e915bf52
  next:    pnpm --filter example-local-agent-loop demo report --run 01M375ZAYC...  # read the reviews first
           pnpm --filter example-local-agent-loop demo approve --run 01M375ZAYC... --wait 01M375ZC2C...
           pnpm --filter example-local-agent-loop demo reject --run 01M375ZAYC... --wait 01M375ZC2C...
  task:    #261 Round the report's cost to cents  (first run 01M375ZAYC..., 1 run(s))
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
- preflightを通った後で、providerが実装、修正、レビュー、triageの呼び出しを
  明示的に拒否した場合（login切れ、利用上限、使えなくなったmodelなど）は
  `rejected-invocation` として `retry: yes` で止まります。拒否は呼び出しの
  完了checkpointとして記録するので、再開しても送り直さず、同じ拒否理由を
  表示します（`refusal: ...`）。拒否と判定するのはproviderが明示した場合だけで、
  timeout、cancel、接続断、判定できないerrorは拒否として扱いません。
  preflight以外では、その呼び出しでagentが動いた後（文章、推論、tool呼び出し、
  usageの報告のどれかが届いた後）のerrorも、すでに何かを実行した可能性があるので
  拒否とせず `uncertain-invocation` として止めます。startだけの
  checkpointが残っていれば、拒否より先に `uncertain-invocation` として扱います。
- factoryが自分の時間の上限でagent呼び出しを止めた場合は、結果の分からない
  呼び出しにしません。止めた理由が分かっているので、上限の種類（全体か無通信か）と
  長さを完了checkpointとして記録し、再開しても送り直しません。実装と修正の
  呼び出しが作業ツリーに変更を残していれば、それを通常どおり候補として封印して
  検証へ進みます（下の「実リポジトリに対して動かす」を参照）。変更が無い場合と、
  仕様の作成・修正・レビュー、レビュー、preflightの呼び出しを止めた場合は
  `agent-timeout` として `retry: yes` で止まります。triageは従来どおり
  `unknown` を記録してrunを続けます。workerの停止やleaseの喪失で呼び出しが
  終わった場合は、従来どおり `uncertain-invocation` です。
- `--publish` 付きでcancelされたrunは `cancelled-publish` として `retry: NO`
  になります。pushやpull requestの作成が記録前に済んでいる可能性があるので、
  remoteのbranchとpull requestを先に確かめてください。
- `retry: yes` のrunには `demo retrigger --run <id>` を表示します。止まったrunに
  保存された入力（task、設定、profile）のまま新しいrunを1回だけ始めます。同じコマンドを
  もう一度打っても、最初に始めたrunを返すだけです。`retry: NO` の
  runや、まだ止まっていないrunには実行を拒みます。素の `demo trigger` は同梱の
  題材で動くので、次の手順には出しません。
- `baseline-check-failed`、`preflight-failed`、`rejected-invocation`、`agent-timeout` には、
  `demo retrigger --run <id> --reload-config` も表示します。`factory.json` を直してから打つコマンドです。
  保存したtask、spec、dispositions、issue、対象リポジトリはそのままで、
  `factory.json` だけを読み直します。読み直すのはtrigger時に `--config` で
  渡したファイルで、渡していなければリポジトリ直下の `factory.json` です。
  直下の `factory.json` を消した場合は、設定なしのtriggerと同じに扱います。
  `--config` で渡したファイル（パスが直下の `factory.json` でも）が無くなって
  いれば、設定なしとはみなさずエラーにします。
  profile、`check`、`selfCheck`、`setup`、`base`、`codexPath`、timeout、`baselineCheck`、
  `baselineReuse` は `trigger` と同じ規則で解決・検証し、trigger時の `--check`、`--setup`、`--base`
  は引き続き設定より優先します。そのrunでは、次の手順の注記にもそう表示します。
  これらを変えるときは `trigger` からやり直します。同梱の題材のrunと
  外部の指摘からの修正run（`demo repair`）は `factory.json` を読まないので、
  `--reload-config` は表示しません。修正runの人の確認欄も、設定を変えるときは
  通常の `trigger` から始めるか、直したあとに承認されたrunから修正をやり直すよう
  案内します。
  timeoutを設定に書いていなければ、`retrigger` を打ったプロセスの環境変数、
  それも無ければ既定値を使います。ファイルの中身が同じ間は、何度打っても最初に
  始めたrunを返します。書き換えれば、その版で1回だけ新しいrunを始めます。
  環境だけを直した場合（依存のインストール、providerへのログインなど）は、
  `--reload-config` なしの `retrigger` を使います。
- 終わったrepo runのworktreeが残っていれば、
  `git -C '<repo>' worktree remove '<workdir>'` を表示します。setupが記録した
  パスが存在するときだけ出し、強制削除やbranch削除は含みません。変更が残る
  worktreeではgitが削除を拒みます。実行するかどうかは利用者が決めます。
  承認・納品済みのrunとアーカイブ済みのrunは、本来片付いているはずなので、
  代わりに `demo prune --apply` を表示します。こちらは強制削除とGitの登録の
  pruneまで行い、branchは残します。
  まとめて片付けるときは `demo prune` を使います（下の「終わったrunの作業ツリーを
  片付ける」）。
- worktreeを片付けたrunには `worktree: removed` と表示します。承認・納品の後に
  片付けられなかったrunには、gitの出したエラーを `warning:` として表示します。

同じ理由と次の手順は、`status --run <runId>` の `diagnosis` と、reportの
`failure`（JSON）および「Stop reason」節（Markdown）にも出ます。

### workerの稼働状態

`trigger` のJSON、`status --run` のJSON、`status` の一覧は、workerが動いているかを
表示します。workerがいなければpendingのrunは進まないので、`trigger` と `status`
はworkerの起動コマンドを案内します。

```json
"worker": {
  "running": false,
  "pid": null,
  "startedAt": null,
  "start": "pnpm --filter example-local-agent-loop demo worker"
}
```

- 稼働しているかは、workerのロック（`worker.lock`）が握られているかで判断します。
  `kill -9` で止まったworkerの `worker.json` は残りますが、ロックは残らないので、
  稼働中とは表示しません。pidと起動時刻は、ロックが握られているときだけ
  `worker.json` から読んで表示します。
- workerが動いていれば、pendingのrunや判断済みのwaitにworkerの起動を案内しません。
- `status --run` の `lastLeaseRenewedAt` は、workerがそのrunのleaseを最後に更新した
  時刻です。専用のheartbeatは記録していないので、有効なleaseの期限からlease期間
  （10秒）を引いて求めます。leaseを持たないpending、waiting、終わったrunと、
  leaseが期限切れのrunでは `null` です。workerはrunを実行している間だけleaseを
  更新するので、workerが動いていても、runを持っていない間は更新がありません。

### runが止まるまで待つ（wait）

`wait` は、runが終わるか、人の判断を待つところで止まるまで待ち、結果を要約して
終了します。runの状態やreportを繰り返し確かめる代わりに使います。

```bash
pnpm --filter example-local-agent-loop demo wait --run <runId> \
  [--timeout <ms>] [--worker-timeout <ms> | --no-worker-timeout] [--format json]
```

- 保存されたrunを1秒ごとに読み直します。別プロセスのworkerのイベントはこの
  プロセスに届かないので、DBだけを見ます。runを進めるのは、別に起動した
  workerです。
- 止まったと判断するのは、run自体の `status` が `completed`、`failed`、
  `cancelled` のときと、`waiting` でrunの `waitingOnWaitId` が指すwaitが未解決の
  ときです。outputやprogressの中にある `status` は見ません。承認・拒否を記録済みで
  workerの再開を待っているrunは、待ち続けます。
- `--timeout` は全体の制限時間です。省略すると制限しません。
- `--worker-timeout` は、workerがいない状態が続いたら打ち切るまでの時間です。
  既定は10秒です。workerが再び見つかれば、数え直します。`--no-worker-timeout`
  を付けると、workerがいないことだけでは打ち切りません。
- どちらのtimeoutも1以上2147483647以下の整数ミリ秒です。範囲外の値や
  小数を渡すと、待ち始める前に終了コード1で終わります。
- runが止まっていれば、timeoutやworker不在よりもその結果を優先します。
- reportは、結果が決まったあとに1回だけ作ります。

要約には、run ID、runの状態、結論（`conclusion`）、止まった理由、次のコマンド、
workerの状態、最後のlease更新時刻、工程ごとの時間を出します。計測できていない
attemptを含む工程の時間は、分かった分だけの合計を出さず、`null`（通常の出力では
`unknown`）にします。`--format json` では同じ項目を1つのJSONオブジェクトで出します。

```text
run:        01M3NS4V2HEWGT14DDC8TPKC0H
status:     completed
conclusion: approved
stopped:    completed: approved and delivered (exit 0)
diagnosis:  finished: approved
worker: running (pid 43292, started 2026-09-29T05:10:46.402Z)
last lease renewal: none recorded
timing:
  setup: work=20 ms, wall=20 ms
  code: work=71 ms, wall=73 ms
  ...
  stage total: 236 ms
  run elapsed: 11764 ms
```

終了コードは次のとおりです。

| 終了コード | 意味                                                                         |
| ---------- | ---------------------------------------------------------------------------- |
| 0          | 承認され、納品まで済んで完了した                                             |
| 1          | コマンドの誤り（引数の不正、存在しないrunなど）                              |
| 2          | 未解決のwaitで止まっている（承認待ちとそれ以外のdurable wait）               |
| 3          | 失敗した、または承認・納品に至らずに完了した（拒否、検証失敗、レビュー上限） |
| 4          | 取り消された                                                                 |
| 5          | `--timeout` に達した                                                         |
| 6          | workerがいない状態が `--worker-timeout` 続いた                               |

### 止まったrunをアーカイブする

止まったまま誰も手を打たない run は、アーカイブすると `status` と web UI の
「人の手が要るもの」から外れます。

```bash
pnpm --filter example-local-agent-loop demo archive --run <runId>
pnpm --filter example-local-agent-loop demo archive --run <runId> --delete-branch
pnpm --filter example-local-agent-loop demo archive --series <runId>
pnpm --filter example-local-agent-loop demo archive --series <runId> --delete-branch
pnpm --filter example-local-agent-loop demo unarchive --run <runId>
```

- アーカイブできるのは止まった run だけです。failed か cancelled で終わった run と、
  承認と納品まで進まずに completed になった run（検証の失敗、レビューの上限）が
  当たります。承認されて納品した run や、人が却下して終わった run は誰の手も
  要らないので、アーカイブを断ります。判断待ちの run は、アーカイブせずに
  approve、reject、spec-revise で判断します。この判定は CLI、`status`、web UI が
  同じ関数（`archivable`）で行います。
- `unarchive` は、アーカイブのファイルがある run ならどれでも戻せます。
- アーカイブは state root の `archived/<runId>` に小さなファイルを置きます。
  run の状態、step、wait は変えないので、止まった理由はそのまま残り、
  `unarchive` でファイルを消すと元の区分に戻ります。
- repo run をアーカイブすると、その run の worktree とレビュー用スナップショットも
  片付けます。git が削除を拒んだときは警告を表示し、アーカイブはそのまま済ませます。
  すでにアーカイブした run にもう一度 `archive` を打つと、残った worktree の
  片付けをやり直します。`unarchive` しても worktree は元に戻りません。
- ブランチは残します。`--delete-branch` を付けたときだけ、その run が記録した
  factory のブランチ（issue 付きの run は `factory/issue-<番号>-<runId>`）と
  `factory/<runId>-squashed` を消します。
- `--series` は、指定した run が属する task（最初の run とその下の修正 run すべて）の
  止まった run をまとめてアーカイブします。task のどの run の ID を渡してもかまいません。
  `status` の `stops:` の行は最初の run の ID でこのコマンドを出します。
- `--series` がアーカイブするのは止まった run だけです。判断待ち、実行中、承認と納品まで
  済んだ run はそのまま残し、エラーにもしません。納品済みの run の ID を渡しても、
  同じ task の止まった run をアーカイブします。
- 納品済みの task でも、止まった run は自動では解決済みになりません。アーカイブは
  「人が確認を終えた」合図で、worktree の片付けもこの合図で行うためです。
- `--series` は、すでにアーカイブした止まった run にも片付けをやり直します。
  `--delete-branch` を付けると、対象の各 run のブランチを `--run` と同じ規則で消します。
  警告は run の ID を先頭に付けて表示します。
- `--series` で一部の run のアーカイブに失敗しても、残りの run は続けてアーカイブします。
  最後に失敗した run を ID 付きで表示し、0 以外で終わります。
- `--run` と `--series` は同時に指定できません。どちらもなければエラーです。
- `status` と web UI は同じファイルを同じ関数（`groupTasks`）で読むので、
  どちらでアーカイブしても両方から外れます。

### 終わったrunの作業ツリーを片付ける

repo run の worktree（`runs/<runId>/work`）は、次のときに片付けます。片付けるのは
worktree とレビュー用スナップショット（`runs/<runId>/review-snapshots`）だけです。

- 承認して納品した run は、納品の記録を step に残した直後に、自分の worktree を
  片付けます。納品後に直すときは、記録した commit とブランチから新しい run を
  作るので（`demo repair`）、元の worktree は要りません。
- 止まった run をアーカイブしたとき（上の「止まったrunをアーカイブする」）。
- `demo prune --apply` を打ったとき。この変更より前に終わった run の worktree を
  まとめて片付けるためのものです。

```bash
pnpm --filter example-local-agent-loop demo prune                      # 対象と容量を表示するだけ
pnpm --filter example-local-agent-loop demo prune --apply              # worktree を片付ける
pnpm --filter example-local-agent-loop demo prune --delete-branches    # 消すブランチも表示する
pnpm --filter example-local-agent-loop demo prune --delete-branches --apply
```

- 削除は `git worktree remove --force` で行い、続けて `git worktree prune` で
  git の登録も消します。git が削除を拒んだときは、ディレクトリを別の方法で
  消さずに残し、警告にします。
- 納品後の片付けに失敗しても、run は承認・納品済みとして終わります。失敗の理由は
  run の出力の `worktreeCleanupWarning` に残り、`status`、report、web UI の
  詳細画面に出ます。`demo prune --apply` でやり直せます。
- `demo prune` の対象は、終わった repo run のうち、承認して納品したものか
  アーカイブしたもので、worktree がまだ残っているものです。保存した run、setup、
  納品の記録、アーカイブのファイルから決め、ディレクトリ名だけからは決めません。
  `--apply` なしでは対象の run ID、worktree ごとの容量、合計を表示するだけで、
  何も消しません。同じコマンドをもう一度打っても、片付けが済んでいれば何もせずに
  成功します。
- pending、leased、waiting の run は、アーカイブのファイルがあっても片付けません。
  アーカイブしていない止まった run、却下した run、納品せずに完了した run も
  対象外です。止まった run の worktree は、人が原因を調べる材料だからです。
- ブランチは通常の片付けでは消しません。`demo prune --delete-branches --apply` は、
  アーカイブした run が記録した factory のブランチと `factory/<runId>-squashed`
  だけを消します。worktree が残っているかどうかは問いません。`--apply` なしでは
  消す予定のブランチを表示します。納品した run のブランチは消しません。納品物で
  あり、`demo repair` の起点だからです。
- 片付けた後も、仕様、検証ログ、エージェントの出力、report、checkpoint、候補の差分、納品の記録
  （patch と `delivery`）はそのまま読めます。report と web UI は、片付けた
  worktree のパスを作業場所として案内せず、「作業ツリーは片付け済み」と表示します。
- run 全体やリモートのブランチ、pull request は消しません。この方針は
  [ADR-0028](../../docs/adr/0028-local-agent-loop-worktree-retention.md) に
  まとめています。

### ブラウザで見る（web UI）

worker を動かしたまま、別のターミナルで web UI を起動できます。一覧と詳細を
見るほか、承認、却下、仕様の判断、再実行、アーカイブを画面から行えます。

```bash
pnpm --filter example-local-agent-loop demo ui             # http://127.0.0.1:4380/
pnpm --filter example-local-agent-loop demo ui --port 4500
```

- 表示された URL をブラウザで開きます。待ち受けは `127.0.0.1` だけで、外部には
  公開しません。`--port` は 1〜65535 の整数だけを受け付けます。
- 事前のビルドは要りません。Vite が画面を要求時に変換して配信します。
  `pnpm --filter example-local-agent-loop build:ui` は静的アセットがビルドできるかの
  確認用です。
- UI は固定 state root の DB を CLI と同じ接続で開きます。DB がまだなければ
  空の画面を出し、DB を作りません。worker か `trigger` が DB を作ると、次の更新
  から表示されます。画面を読むだけでは何も書き込みません。
- UI は worker を起動せず、worker のロックも取りません。承認や再実行のあとで
  run を進めるのは、別に動かしている worker です。
- 画面は 3 秒ごとに読み直します。前の読み込みが終わるまで次は始めません。
  読み込みに失敗したときは直前の表示を残し、上部に「更新失敗」と表示します。
- 画面の操作は、CLI の `approve`、`reject`、`spec-revise`、`retrigger`
  （`--reload-config` なし）、`archive`、`unarchive` と同じ関数（`src/actions.ts`）を
  呼びます。確かめる内容も結果も CLI と同じです。承認と却下は run がいま待っている
  wait にだけ、候補または仕様の版に結びつけて送り、別の run の wait、判断済みの
  wait、種類の違う wait には送りません。再実行は保存済みの入力だけを使い、CLI が
  再実行を拒む停止には画面からも実行しません。`factory.json` の読み直しは CLI だけの
  操作です。
- どの操作にも、同じ操作の CLI コマンドを添えます。操作ボタンの下の閉じた
  「同じ操作のコマンド」を開くと、レポートや状態確認を含む次のコマンドの
  「〜をコピー」ボタンと全文が出ます。却下とアーカイブは控えめなボタンで、押すと
  確認を挟みます。再実行も費用のかかる新しい実行を始めるので、保存済みの入力で
  新しい実行を始めると伝える確認を挟みます。承認も確認を挟み、その確認にレビューの回数、最後の回の結果、
  直した指摘と残した指摘の件数と題名を出します。確認の中にはその操作のコマンドを
  1行とコピーボタンで出し、確認のあいだは同じ行のほかの操作を隠します。仕様の
  修正は、画面に書いたメモをそのまま送ります。CLI では同じメモを書いたファイルを
  `--notes-file` に渡します。
- 操作の結果は画面上部に通知として出し、一覧は次の更新で動きます。断られたときは
  CLI と同じ英語のメッセージを通知に出します。
- 書き込みの API は `POST /api/runs/<id>/<action>` だけです。サーバーは起動の
  たびにランダムなトークンを作ってページに埋め込み、書き込みには
  `x-loop-ui-token` ヘッダーのトークンと、このサーバー自身を指す `Origin`
  ヘッダーを求めます。Host、トークン、Origin のどれかが違えば 403、POST 以外は
  405 で、操作の関数を呼ぶ前に断ります。run ID の書き方が壊れたパスは 400 です。
  トークンはログに出さず、cookie も使いません。ページは CORS を許さないので、
  localhost のほかのポートのページからもトークンは読めません。読み取りの API は GET と HEAD だけです。
- ログの読み取りは `GET /api/runs/<id>/logs/<attemptId>?from=<バイト位置>` です。
  既定はその試行のエージェントの出力で、`&file=stdout` と `&file=stderr` で検証の
  標準出力と標準エラーを読みます。応答は `{ chunk, nextOffset, done }` で、1回に
  読むのは 64 KiB までです。`from` は省略すると 0 で、0 以上の整数だけを受け付け、
  ほかの値は 400 です。UTF-8 の文字の途中で切れた末尾は返さず、次の読み取りに
  回します。`nextOffset` は返したバイト数だけ進みます。`done` は、試行が終わって
  ファイルの最後まで読んだときに `true` になります。試行は run の ID と合わせて DB で
  探し、ファイルの場所は試行が記録したパスだけを使います。リクエストでパスは
  指定できません。知らない試行や、そのログを記録していない試行は 404、記録した
  パスが run のディレクトリの外にあるか、リンクをたどると外に出るときは 403、
  記録したファイルが消えているときは 410 です。ほかの読み取りと同じ Host の制限が
  かかり、トークンは要りません。
- 操作のない行では次のコマンドを「〜をコピー」ボタンで出し、全文は
  「コマンド全文」を開くと見られます。表示もコピーも、
  CLI が付ける英語の `# ...` の補足は含みません。補足はボタンにマウスを重ねると
  日本語で出ます。
- `http://127.0.0.1:4380/#/design` は、画面の部品と状態を固定の見本データで並べた
  ページです。DB も API も使わないので、worker や DB がなくても開けます。

run は保存済みの入力から付けた名前で並びます。issue から作った run は
`#番号 タイトル`、`--task` / `--task-file` の run はタスクの最初の行（80 文字まで）、
同梱題材は「同梱題材: calc の add を直す」です。run ID は末尾 6 文字だけを添え、
完全な ID は run 詳細とコピーしたコマンドにあります。作成時刻は「3分前」のような
相対表記で、正確な時刻はマウスを重ねると出ます。

**タスク一覧**は task ごとに1行で、3つの欄に分かれます。並びと区分は
`demo status` と同じ関数（`groupTasks`）で決めます。

- **人の手が要るもの**：判断待ち（承認、仕様の判断、承認以外の入力）と、未解決の
  停止（検証失敗、レビュー上限、未確定の外部呼び出しなど）の task。行は開いた
  状態で、理由、再実行の可否、その run にできる操作と同じ操作のコマンドを
  出します。コマンドの補足はボタンにマウスを重ねると出ます。承認・納品済みの
  task、後の修正 run の承認で解決した停止、アーカイブした停止は出ません。何も
  なければ「人の手が要るものはありません」と出します。
- **動いているもの**：実行中（期限内の lease）、担当が途切れた（lease が切れて
  worker が止まった。worker を起動すれば再開）、順番待ち、判断済み・再開待ちの task。
- **終わったタスク**：新しい順に、状態、task の名前、run の数、所要時間、費用、
  開始。run が複数ある task の所要時間と費用は全 run の「合計」で、どれかの run の
  値が不明なら不明です（`demo status` の `total` と同じ値）。行の名前は代表の run の
  詳細へのリンクで、左の矢印で開くと工程の並びと、run が複数ある task では
  「最初の実行」「指摘からの修正 1」…のように各 run とその所要時間と費用を
  出します。後の修正で解決した run には「後の修正で解決」と添えます。
  アーカイブした task は「アーカイブ済み」と添え、状態は色を付けずに出します。
  開くと止まった理由と「アーカイブから戻す」が出ます。最初の run が fake provider で
  動いた task も隠さずに並べ、「模擬」と添えます。修正の run が実 provider でも、
  最初の run で決まります（`demo status --format json` の task の `fake`）。

状態は1つの run につき1つだけ出します。動いている run はいまの状態（承認待ち、
実行中など）、終わった run は結果（承認済み、検証失敗など）です。
状態名は必ず文字で出し、色は「人待ち（琥珀）」「失敗（赤）」「実行中（青）」だけに
付けます。状態の区分と次のコマンドは `demo status` と同じ関数（`src/engine/status.ts`）から
作るので、同じ時点の `demo status --run <id>` と一致します。説明文は区分と停止の種類から
画面用の日本語で出し、CLI の英語の reason は表示しません。未確定の外部呼び出しで
止まった run には、再実行を促すコマンドを出しません。provider に呼び出しを
拒否されて止まった run には、拒否の理由を停止理由の欄に出し、設定を読み直す再実行と
通常の再実行のコマンドをコピーできる形で出します。工程の並びでは、通った工程に ✓ を
付けます。承認の wait を作らずに完了まで進んだ run（`--approve auto`）の承認は
「✓ 承認 自動」と出します。

実行中の run の「全体 … 経過」は run の開始（lease 取得、まだなら作成）から、
「この工程 … 経過」はいまの工程の attempt の開始から、画面を読んだ時点までの暫定値です。
report の確定値（所要時間、工程ごとの時間）とは別に扱い、確定値には混ぜません。

**実行の詳細**は `demo report --run <id> --format json` と同じ値を、上から読んで
途中でやめても要点が分かる順に並べます。

名前の下には、同じ task の run を「最初の実行」「指摘からの修正 N」として
状態と開始時刻とともに並べ、表示中の run に「表示中」と添えます。

1. **結論と次の手**：停止や判断待ちの理由、人が確認すること、再実行の可否、
   その run にできる操作と同じ操作のコマンド。主な操作（承認、仕様を直す、
   再実行）だけを強いボタンで出します。人が確認することがログファイルを読むように言う停止では、その
   すぐ下にチェックのログのパスをコピーできる形で出します。ファイルがなければ
   「ファイルがありません」、記録にパスがなければそう書きます。承認・納品済みの
   run は納品したブランチをコピーできる形で出します。
   その下に所要時間、工程の作業時間、人の待ち時間、費用、合計トークン、
   修正とレビューの回数を1行で並べ、作業時間が所要時間より長いときは理由を
   1行添えます。停止の記録（終了コードなど）は「停止の記録を見る」を開くと出ます。
2. **レビューの要点**：report の `reviewHighlights` です。最後より前のレビューで
   出た直すべき指摘を、最後のレビューが通過したときは「直した指摘」、そうでなければ
   「これまでの指摘」として、最後のレビューの助言を「残した指摘」として、件数と題名を
   出します。最後のレビューが通過したと言えるのは、両方のレビュアーの判定がそろい、
   どちらも通過したときだけです。通らなかった run では、そこで出た直すべき指摘を
   「残っている直すべき指摘」として別に出し、判定がそろっていない回はそう書きます。
   指摘を回をまたいで突き合わせることはしません。見出しの件数は report と同じ指摘の
   数です。判定だけを返すレビュー（verdict）は回、観点、判定だけを題名の下に出し
   （直した側では「〜が求めた修正」）、件数には数えません。最後のレビューで通過した
   verdict は何も残していないので、「残した指摘」ではなく、最後のレビューの結果の
   下に出します。メモの本文は根拠の節で読みます。
3. **工程の時系列**と**工程ごとの時間と費用**：工程ごとに作業時間（呼び出しの時間の
   合計）、所要時間（時計の時間）、費用を1行で並べます。費用の「–」はモデルを
   呼ばなかった工程、「不明」は値の分からない呼び出しを含む工程です。終わった run の
   時系列は全行を出し、動いている run だけが枠の中でスクロールします。レビューのように並んで動いた
   工程は作業時間を重ねて数えるので、作業時間の合計は所要時間を超えることが
   あります。spec 工程のある run には「仕様の工程まとめ」として、仕様の作成、
   仕様レビュー、採点コマンドの決定を合わせた経過時間（report の `specWallMs`）を
   出します。並んだレビューは一度だけ数え、人の判断を待った時間は含みません。
4. **根拠**（初期状態は閉じています）：仕様、レビューの全回の判定とメモ（メモは
   開くと出ます）、工程別・役割別の token と費用、見立てと較正材料、候補と候補ごとの
   変更の規模、納品物、入力ファイルの SHA-256、注記。

工程の時系列で行を選ぶと、実装の行には封印した候補の規模を、レビューの行には
その回の判定とメモを、検証の行には終了コードと検証ログのパスを出します。
パスは「〜のパスをコピー」ボタンでコピーできます。

エージェントを呼んだ行を選ぶと、その呼び出しの出力を「エージェントの出力」に
出します。検証の行では、標準出力と標準エラーを切り替えて読めます。出すのは
その行の最後の試行のログで、やり直した工程では試行の行を開くと、その試行の
ログを読めます。

- 書き込み中のログは 3 秒ごとに続きを読み、「書き込み中」の印を付けます。
  前の読み込みが終わるまで次は始めません。試行が終わって最後まで読むと
  「書き終わり」と出し、読み直しを止めます。
- 終わったログも先頭から順に読みます。画面に残すのは末尾の 256 KiB までで、
  それより長いログは末尾だけを出します。全文はファイルのパスをコピーして、
  エディタや `less` で開いてください。
- 本文は文字としてそのまま出し、Markdown や HTML として解釈しません。端末の色などの
  エスケープは取り除きます。
- 本文の末尾を見ているあいだは、追記に合わせて下へ送ります。上へスクロールすると
  その位置で止まります。
- 記録したファイルが消えていれば、その旨を出します。

承認待ちの run では、レビューの判定とメモは承認 wait の metadata から、candidate は
保存済みの candidate step から読みます（report の `reviews` と `candidate` にも
同じ値が入ります）。

**集計**は2つの見方を切り替えます。開いたときは「週ごとの推移」です。ほかの画面へ
移って戻っても、ページを読み直すまでは最後に選んだ見方のままです。

- **週ごとの推移**：`demo compare --trend --format json` と同じ値です。run ではなく
  task を数えます。最後の run が直近 30 日に終わった task を、最初の run の実装に
  使ったモデルと推論量の組ごとにまとめます。まとまりごとに、まず期間全体の初回承認率、
  最終承認率、task あたりの所要時間と費用の中央値を出し、その横に週（月曜始まり、
  この PC の時刻）ごとの task 数、初回承認、最終承認、所要時間、費用、修正の run 数の
  中央値を並べます。task が1件だけの週には「1 件のみ」と添えます。最初の run が
  模擬（fake provider）の task は除き、期間に終わった task が模擬だけのときは、除いた
  件数をそう書きます。CLI の版はまとまりに含めないので、同じモデルの新しい版は同じ表に
  並びます。数え方は CLI の節の `--trend` と同じです。
- **設定ごとの比較**：終了した run を `demo compare --runs` と同じ処理にかけ、
  config version ごとのまとまりを閉じた状態で並べます。見出しに件数と成功率が出て、
  開くと所要時間・作業時間・費用などの中央値、最小、最大、件数、不明の数、工程別の
  値、見立て（triage 判定）別の結果と停止理由の件数、判定別の較正材料の中央値を
  表示します。

表示値の読み方：

- 費用は記録した token 数を API 料金で換算した参考値です。サブスクリプションの
  請求額ではありません。
- 使用量や価格が分からないものは web UI では「不明」、CLI の Markdown（`report`、
  `compare`）では `unknown` と表示し、0 とは表示しません。一部の
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
  日本語のタスクで repo 対象の run を 13 本起動します。承認された 1 本には、外部の
  指摘からの修正 run を 1 本足します。固定テストは本物の `node --test` です。
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
  "agentTimeoutMs": 7200000,
  "agentIdleTimeoutMs": 900000,
  "commit": {
    "authorName": "Factory Bot",
    "authorEmail": "factory-bot@example.com"
  },
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
- `profiles` は `code`（実装と、`repair` が無ければ修正も）、`review.correctness`、
  `review.edge-cases` の三役割を別々に指定できます。修正だけを別の設定にする
  `repair` と、事前判定の `triage` は任意です（下の節を参照）。configが省いた役割と、役割の中で省いた項目だけを
  `--provider`、`--model`、`--effort` とpresetで補います（`repair` で省いた項目は
  `code` から補います）。ただし `--provider` と
  違うproviderを指定した役割は `--model` と `--effort` を引き継がず、そのproviderの
  既定presetを使います。明示した役割の値が他の役割やフラグで上書きされることは
  ありません。fakeと実providerを役割ごとに混ぜる
  ことはできません。
- agent呼び出しには二つの時間の上限があります。`agentTimeoutMs` は呼び出しの
  開始からの全体の上限です。`agentIdleTimeoutMs` は無通信の上限で、agentの活動
  （文章、推論、tool呼び出しとその結果、実行中のtoolの進捗）、出力、usageの報告が
  この時間途絶えたら止めます。どれかが届くたびに数え直すので、動き続けている
  呼び出しは無通信の上限を超えても続き、全体の上限で止まります。providerに渡す
  上限はfactoryの全体の上限より遅くしてあり、止めるのは常にfactoryのtimerです。
- timeoutの既定値はターゲットで変わります。実リポジトリはagent呼び出しが全体2時間、
  無通信15分、検査15分。同梱題材は全体5分、無通信5分、検査2分です。`factory.json` の
  `agentTimeoutMs`、`agentIdleTimeoutMs`、`checkTimeoutMs`（ミリ秒）が最優先で、
  無ければ `trigger` を実行したプロセスの `AGENT_TIMEOUT_MS`、`AGENT_IDLE_TIMEOUT_MS`、
  `TEST_TIMEOUT_MS`、それも無ければ既定値を使います。無通信の既定値は全体の上限を
  超えないように、全体の上限に合わせて短くします。どれも2147483647以下の正の整数に限り、`0`、負数、小数、
  `NaN`、`Infinity`、2147483647超は `trigger` の時点で拒否します。これより大きい
  値はNodeのtimerがあふれて約1ミリ秒で発火し、呼び出しを始めた直後に打ち切るからです。
  無通信の上限が全体の上限より長い組み合わせも、作業ツリーを作る前に `trigger` で拒否します。
  解決した値はrun inputに保存し、workerの環境変数は読みません（この変更より前に
  保存されたrunだけは、従来どおりworkerの環境変数を読みます）。修正のrunは親が
  保存した値を引き継ぎ、`retrigger --reload-config` だけが `factory.json` から読み直します。
  reportは解決した全体と無通信の上限を表示します。
- 実装や修正の呼び出しをfactoryが時間の上限で止めたときは、その呼び出しを始めた
  時点の候補（最初の実装ならbase）から作業ツリーに変更があるかを見ます。変更が
  あれば、終わった呼び出しと同じ手順でcommitして候補にし、通常どおり検証します。
  検証に落ちれば、修正の回数を1つ使って次の修正へ進みます。次の修正には、前の
  呼び出しが時間の上限で止まり、その途中の作業が今の候補だと伝えます。report、
  traceは、その候補が時間切れの呼び出しから作られたことを表示します。変更が
  無ければ候補を作らず `agent-timeout` で止まります。
- 反復ごとにcommitして封印します。検証・レビュー・成果物は同じcommitを見ます。
- 既定の成果物は `~/.local/state/local-agent-loop/runs/<runId>/delivery/<candidate>.patch`
  です。patchはbase commitと最後のcandidateの差分です。issueなしのrunのbranchは
  `factory/<runId>`（issue付きは `factory/issue-<番号>-<runId>`）で、反復ごとの
  commitと承認されたcommitはこのbranchに残ります。`status` とreportがbranch名と
  commit SHAを表示します。承認されず成果物が無いrun（却下、検証失敗、レビュー上限）
  でも、最後に封印したcandidateのbranchとcommitを `candidate` として表示します。
- 承認されて成果物を作るときは、もう一つ `factory/<runId>-squashed` を作ります
  （issue付きのrunも同じ名前です）。記録したbase commitを唯一の親とし、最後の
  candidateと同じtreeを持つcommitが1つだけ乗ったbranchです。candidateがbaseと
  同じtreeでも空のcommitを1つ作るので、baseからのcommit数は常に1です。refだけで
  作るので、元のbranch、worktree、あなたのcheckoutは動きません。成果物を作る
  stepが途中で止まって再実行されたときは、まず `git commit-tree` で期待する
  commitを組み立て、既にあるこのbranchがそのcommitを指しているときだけ使い回します。
  author、message、親、treeのすべてが一致している必要があります。それ以外の
  branchは拒否し、手を付けずに残します。承認されなかったrunには作りません。
  branch名とcommit SHAは `delivery.squashedBranch` と `delivery.squashedCommit`
  に記録し、`status --run` のJSONとreportのJSON・Markdownに出ます。web UIの
  納品物はbranch名だけ表示します。この記録が無い以前のrunでは `null` です。
- `--publish` を付けると反復履歴のあるbranchをpushしてDraft PRを作ります。
  `commit.publishSquashed` が `true` のときだけ、代わりにsquash branchをpushして
  Draft PRのheadにします。どちらの場合も、同じheadで開いているPRが既にあれば
  （PR作成後に記録前で止まったstepの再実行など）新しく作らずにそれを使います。
  `delivery.location` は実際に公開したbranchのPRのURLです。

`--publish` を付けない限り、外向きの操作は起きません。まずpatchで確かめてから
PRに進むのが安全です。

人間の承認待ちは、実リポジトリでは既定で入りません。Draft PR自体が人間の
レビュー対象で、マージするのも人間だからです。`--approve manual` で
同梱題材と同じ承認waitを挟めます。

### commitの作者とメッセージ（commit）

`factory.json` の `commit` で、factoryが作るcommitの作者とメッセージを決められます。
どの項目も省略でき、文字列は空（空白だけも含む）を `trigger` の時点で拒否します。

```json
{
  "commit": {
    "authorName": "Factory Bot",
    "authorEmail": "factory-bot@example.com",
    "messageTemplate": "fix: {task} (factory {runId}, iteration {iteration})",
    "publishSquashed": true
  }
}
```

- `authorName` と `authorEmail` は反復commitとsquash commitの作者とcommitterに
  なります。省略した項目は `durably-factory` と `durably-factory@localhost` です。
- `messageTemplate` の `{iteration}`、`{runId}`、`{task}` を置き換えます。
  `{task}` は保存したtaskの1行目、`{iteration}` は反復commitではその反復の番号、
  squash commitでは最後のcandidateを封印した反復の番号です。省略すると反復commitは
  `factory iteration <番号>`、squash commitは `factory run <runId>` です。
- 変更の無い反復では、従来どおり空の反復commitを作りません。
- `publishSquashed` の既定は `false` です。`--publish` が無ければ、この値に
  かかわらずpushもPR作成もしません。
- 設定は `trigger` の時点で解決してrun inputに保存します。trigger後に
  `factory.json` を書き換えても既存のrunは変わらず、`retrigger --reload-config`
  で作ったrunは書き換えた後の値を使います。
- 作者とメッセージテンプレートは反復commitとしてworktreeの履歴に残り、エージェントが
  読めるので `configVersion` に入ります。どちらも省略したrunの版は従来と同じです。
  `publishSquashed` は `--publish` と同じく公開先を選ぶだけなので入りません。

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
- setupや採点がworktreeのtracked fileを書き換えた場合は、最初のcandidateに
  混ざるので `baseline-check-failed` で止め、エラーにその旨を出します。採点
  コマンドが起動できない場合（コマンドが見つからないなど）も同じ分類で止めます。
- setupは、`.gitignore` の対象外の未追跡ファイルを残してはいけません。空の
  ディレクトリも同じです。採点後の片付けで消えてしまうからです。判定には
  片付けと同じ `git clean -ffdn` の結果を使うので、無視されたファイルだけが
  入ったディレクトリは残してかまいません。
  `baselineCheck` がオンのときは、setupの直後、採点の前に確かめます。残って
  いれば採点もエージェント呼び出しもせずに `baseline-check-failed` で止め、
  最初の数件のpathを `failure.details` に出します。次の手順は「setupが
  `.gitignore` にないファイルを作っているので、そのファイルを `.gitignore` に
  入れるか `baselineCheck` を外す」です。ignore対象のファイル（`node_modules`
  など）は残してかまいません。
- 採点が通ったら `git clean -ffd` で、`.gitignore` の対象外の未追跡ファイルを
  入れ子のgitリポジトリも含めてすべて消します。カバレッジやテスト結果の
  ファイルが最初のcandidateに入らないようにするためです。上の前提があるので、
  消えるのは採点が残したものだけです。途中で止まった採点をworker再開時に
  やり直した場合も、前の試行が残したファイルごと消えます。ignore対象の
  ファイルは残ります。消したあとも対象外の未追跡ファイルが残っていれば、
  `baseline-check-failed` で止めます。

### baseの採点結果を使い回す（baselineReuse）

同じリポジトリの同じbase commitから続けてrunを始めると、runごとに数分かかる
baseの採点を繰り返します。`baselineCheck` と一緒に `baselineReuse` を書くと、
条件が同じで期限内の、ほかのrunの成功した結果を使い、採点を省きます。

```json
{
  "baselineCheck": true,
  "baselineReuse": { "maxAgeMs": 3600000 }
}
```

- `maxAgeMs` はミリ秒の正の整数で、上限は7日分のミリ秒です。索引の記録は
  7日より古くなると消えるため、上限もそれに合わせています。0、負の数、
  小数、7日を超える値は `trigger` が拒否します。省略すると使い回しは
  しません。`baselineCheck` がオフのrunでは読みません。
- 使い回すのは、同じstate DBにある、ほかのrunのbaselineで、そのrun自身が採点して
  成功した結果だけです。失敗した結果、終わっていない結果、別の結果を使い回した
  結果、この機能より前の形式の結果は使いません。
- 次の値がすべて一致する結果だけを使います。リポジトリのルート（シンボリック
  リンクを解決したpath）、base commit、`check` と `setup` のargv、
  `checkTimeoutMs`、Node.jsの版、OSのplatform、architecture、`check` の先頭の
  コマンドが実際に起動するファイル（PATHから探し、シンボリックリンクを解決した
  path。worktreeの中のファイルはworktreeからの相対path）。起動するファイルは
  `spawn` と同じ順で探します。PATHの空の要素はworktreeを指します。PATHが
  未設定のときとWindowsでは分からないものとします。どれかが分からない
  runは、結果を使わず、ほかのrunに使わせる結果も残しません。
- これらの値はsetupで一度だけ求めて記録します。setupとbaselineの間でworkerが
  再起動し、Node.jsやPATHが変わっても、setupで記録した値で照合します。
- 比べるのはこれだけです。依存パッケージの中身、環境変数、`check` が内部で
  呼ぶほかのコマンド、ignore対象のファイル（`node_modules` など）は比べません。
  これらが変わったときは、`baselineReuse` を外すか、期限を短くします。
- 採点して成功したrunは、state rootの `baseline-index/<条件のSHA-256>/<run ID>.json`
  に、run IDと採点の完了時刻を書きます。runごとに自分のファイルだけを書き、
  ほかのrunのファイルは上書きしません。同時に書くrunがあっても、書く操作自体が
  互いの記録を消すことはありません。
- 使い回しを判断するときは、条件のディレクトリを1つ読みます。読めない記録と
  期限切れの記録を除き、残りを新しい順に試します。書かれたrunのbaselineを
  state DBから読み直し、採点して成功した結果であることと条件の一致を確かめ、最初に通ったものを
  使います。どれも通らなければ、通常どおり採点します。読むのはその条件の記録
  だけで、過去のrunを全部は読みません。
- 自分の記録を書いたあと、その条件の記録のうち `checkedAt` が7日より古いものと
  読めないものを消します。それより新しい記録は消さないので、同時に書いたrunの
  記録も残ります。ほかのrunが同時に消していても失敗にしません。`maxAgeMs` の
  上限は7日なので、期限内の記録が整理で消えることはありません。
- 期限は、元のrunで採点が完了した時刻（checkpointの記録）から、このrunが
  使い回しを判断する時刻までで測ります。元のrunが再開後にbaselineを保存して
  いても、再開の時刻からは測りません。時計の変更は扱いません。起きても、
  採点が1回増えるか、このマシンの時計で判断した結果を使うだけです。
- 使い回すときも、setupは毎回実行し、新しいworktreeを作ります。setupの直後の
  未追跡ファイルの確認も省きません。採点を省く前に、worktreeがbase commitに
  あること、tracked fileに変更がないこと、`.gitignore` の対象外の未追跡ファイル
  がないことを確かめ、満たさなければ通常の `baseline-check-failed` で止めます。
- 使い回しの判断はbaselineの結果として記録します。worker再開時は記録を読み戻し、
  候補を探し直しません。このrunで採点を始めたあとに再開した場合は、使い回さずに
  採点をやり直します。
- 使い回した結果には、ログをコピーせず、元のrunのログのpathを記録します。元の
  ログが消えていれば、reportのlogは `null` になり、理由を出します。
  checkpointから読み戻したかどうかの表示は、元のrunの記録に従います。
- reportのJSON（`baseline.reusedFrom` に元の `runId` と採点の完了時刻
  `checkedAt`）とMarkdown（「Baseline check」節の `source`）、web UIの
  「工程ごとの時間」のベースの検証の行に、使い回したかどうかと、使い回した
  ときの元のrunと時刻を出します。
- 運用のための最適化で、エージェントに見せるものも採点の基準も変えないので、
  `configVersion` には入りません。

### 検証とレビューを同時に始める（parallelReview）

既定では、封印した候補を検証し、通ったものだけをレビューします。
`factory.json` に `"parallelReview": true` を書くと、候補を封印した直後に
検証と二つのレビューを同時に始めます。検証がほぼ毎回通るリポジトリでは、
レビューを待つ時間のぶんrunが短くなります。

```json
{
  "parallelReview": true
}
```

- 書かなければオフで、工程の順序、stepの名前、レビューの呼び出し回数と
  費用は今までと同じです。値は `trigger` の時点でrun inputに保存します。
  `retrigger` は保存した値を引き継ぎ、`--reload-config` はファイルを読み直し、
  `demo repair` の修正runは元のrunの値を引き継ぎます。いつレビューするかの
  選択で、レビューの中身は変えないので、`configVersion` には入りません。
- オンのとき、レビュー役が読む候補のコードは、封印したcommitから取り出した
  木（head snapshot）と、候補のdiffと変更ファイル一覧だけです。検証が動いている
  worktreeは、作業ディレクトリにも、promptにも、読める場所にも入れません。
  promptのレビューはhead snapshotの中で動きます。`command` や
  `local-instructions` のレビューは今までどおり自分用のディレクトリで動き、
  base snapshotも読めます。Codex、Claudeのどちらでも同じです。
- 検証とレビューの両方が通った候補だけが、今までどおり承認に進みます。
  レビューが修正を求めたときは、今までどおり修正に回ります。
- 検証がレビューの途中で失敗すると、その回のレビューを止めます。止めた
  呼び出しは、それまでに分かった使用量と、完了のcheckpointを
  `cancelled`（理由 `superseded-by-verify`）として残します。workerが再開しても
  その呼び出しを送り直さず、`uncertain-invocation` にもしません。まだ送って
  いなかったレビューは送らず、呼び出しとしても費用としても数えません
  （計測の記録は `not-sent`）。すべてのレビューが終わってから次の工程に進みます。
- レビューが先に終わってから検証が失敗した回は、判定を記録に残したうえで
  `discarded`（理由 `verify-failed`）として使いません。
- 止めた回と使わなかった回の判定は承認に使わず、`review-cap-reached` までの
  レビュー回数にも数えません。
- 検証が失敗したとき、次の修正にはまず検証の失敗を渡し、先にそれを直すよう
  求めます。その回で最後まで終わったレビューの判定と指摘は、そのあとに
  信頼できない入力として区切って渡します。検証に落ちた候補へのレビューなので、
  修正後には当てはまらない指摘もあると添えます。止めたレビューからは
  何も渡しません。
- レビューの途中でworkerが止まり、開始のcheckpointしかない呼び出しは、
  今までどおり `uncertain-invocation` で止め、送り直しません。
- 検証が失敗する前に、レビューがそれ自体の理由で失敗したとき（返答を読めない、
  providerが拒否した）は、逐次のときと同じくrunを失敗にします。ツール呼び出しを
  拒まれただけなら、返答が読める限りレビューは失敗にしません（後述）。

reportの「Review rounds」では、数えなかった回に `cancelled` か `discarded` と
理由が付きます。検証がまだ終わっていない回と、検証がエラーで終わった回は
`pending`（理由 `verify-pending`）で、これも数えず、レビューの要点にも
使いません。「検証に落ちた候補へのレビュー」の呼び出し数と費用は、
reportの要約、`demo compare` の設定ごとの行、`demo compare --trend` の列に、
総費用とは別に出ます。この費用は総費用に含まれています。使用量や価格が
分からない呼び出しがあれば、0 ではなく不明と出します。止めたレビューは、
止めるまでにproviderが報告した使用量（モデル別）とsession IDを残します
（後述の「止めた呼び出しの使用量」）。この使用量は止めた時点までの下限なので、
それを含む合計は完全な値として出さず、そのrunの総費用も不明と出ます。web UIでは、
レビューの欄と工程の時系列の詳細に「中止」「不採用」「検証待ち」と理由が出て、
工程の時系列では検証とレビューの重なりが実際の時刻どおりに見えます。

### 終える前にエージェントに確かめさせる（selfCheck）

`factory.json` の `"selfCheck"` に短いコマンドを書くと、実装と修正のpromptに
「終える前にworktreeでこれらを実行し、出た問題を直す」という規則が1つ加わります。
未使用のexportのように、手元ですぐ見つかる問題で修正の1回を使わないためです。

```json
{
  "check": ["pnpm", "validate"],
  "selfCheck": [
    ["pnpm", "lint"],
    ["pnpm", "typecheck"]
  ]
}
```

- 1から5個のコマンドを書けます。各コマンドは `check` と同じくargvの配列で、
  空の配列と空の文字列は `trigger` の時点で拒否します。
- promptには各コマンドを1行ずつ、バッククォートで囲んで載せます。あわせて、
  採点コマンドも同じ問題を見つけることと、runの合否を決めるのは採点コマンド
  だけであることを伝えます。
- factoryはこれらのコマンドを実行しません。工程も、やり直しも、反復の数え方も
  増えません。合否は今までどおり `check` だけで決めます。
- 書かなければpromptは今までと同じです。値は `trigger` の時点でrun inputに
  保存します。`retrigger` は保存した値を引き継ぎ、`--reload-config` はファイルを
  読み直し、`demo repair` の修正runは元のrunの値を引き継ぎます。promptが変わる
  ので、書いたときは `configVersion` に入ります。

### 設定の事前確認（preflight）

baselineの後、triageを含む最初のエージェント呼び出しの前に、全役割
（code、二つのreview、設定したtriage）のprovider、model、effortを確かめます。
同じ組み合わせは一度だけ確かめ、使う役割すべてに結果を対応付けます。

- Codexは無料の `model/list`（固定したCodex CLIのapp server）で、そのloginで
  使えるmodelと、そのmodelが受け付けるeffortを確かめます。一覧にあるmodelが
  そのeffortを受け付けなければ、promptを送らずに止めます。app serverが起動
  しない（CLIが見つからない、`app-server` に対応しない古い版、初期化の失敗）
  場合も、promptを送らずに止めます。初期化が時間切れになっただけの場合は起動が
  遅いだけかもしれないので、止めずに最小の呼び出しで確かめます。最小の呼び出しの
  初期化も時間切れになった場合は、送ったかどうか分からない呼び出しとして
  `uncertain-invocation`（`retry: NO`）で止まります。一覧は1ページ目だけを
  読みます。一覧は隠しmodelを含まないので、一覧に無い
  modelは使えないとは決めず、一覧が読めないときと同じく最小の呼び出しで確かめます。
  一覧は同じCLIファイルにつき1回だけ読みます。
- Claude Codeにはpromptを送らずに確かめる手段が無いので、組み合わせごとに
  最小の呼び出し（「OK」とだけ返させる読み取り専用の呼び出し）を1回します。
- 最小の呼び出しは通常の呼び出しと同じcheckpointと計測を通り、使用量と推定費用は
  stage・roleとも `preflight` として別に集計します（code/reviewには混ぜません）。
  providerが明示的に拒否した場合（未知のmodel、使えないmodel、login切れ、
  Codex CLIが起動しないなど）は完了として記録し、`preflight-failed`（`retry: yes`）
  で止まります。Claude Codeのlogin切れやmodelの誤りは、providerが構造化した
  種別を付けずに本文から判定することもあり、その場合も拒否として扱います。送ったかどうか分からない呼び出しは送り直さず、
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
で起動します。省略時はPATHの `codex` を優先し、無ければ同梱の `@openai/codex`
を使います。同梱の版は新しいモデルに追いつかないことがあるためです。CLIのpathと版はreportの「Versions」と「Preflight」に
出て、`configVersion` にも入るので、違うCLIで動いたrunは別の設定として比較されます。

### trigger時点で固定されるもの

`factory.json`、task、spec、dispositionsは `trigger` の時点で一度だけ読みます。
フラグを適用した後の各役割のrequested設定と、入力ファイルのpathと本文をrun inputに
保存します。実際に使うmodelとeffortは、workerがそのrequested設定からproviderの
presetで解決します。workerは元のファイルを読み直さないので、trigger後にファイルを
書き換えても、そのrunの設定とpromptは変わりません。timeout、`codexPath`、
`baselineCheck`、`baselineReuse`、`parallelReview`、`selfCheck`、`commit` も同じく解決済みの値をrun inputに保存します。reportには各入力ファイルの
pathと、保存した本文から計算したSHA-256が出ます。設定を直した後に同じtaskで
やり直すには、`demo retrigger --run <id> --reload-config` を使います（上の
「止まったrunと次の手順を見る」を参照）。

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

- triageの完了記録には、判定と理由と一緒に、保存済みのtaskとspecから測った
  較正材料を残します。taskの文字数、specの文字数、specの受け入れ基準の項目数、
  specが挙げる変更予定ファイルの数の四つです。文字数はUnicodeのcode pointで
  数えます。項目数とファイル数は、次の一つの規則で数えます。
  - `#` 〜 `######` の見出しのうち、題が `Acceptance Criteria`、
    `Completion Criteria`、`受け入れ基準`、`完了条件`、`完了基準` のもの
    （受け入れ基準）と、`Files to Change`、`Files to Modify`、`Changed Files`、
    `変更するファイル`、`変更予定のファイル`、`変更対象のファイル` のもの
    （変更予定ファイル）を対象にします。題は大文字小文字と末尾のコロンを
    区別しません。
  - 節は次の同じか上の階層の見出しまでで、その中の小見出しも含みます。
  - 数えるのは行頭から始まる箇条書き（`-`、`*`、`+`、`1.`、`1)`。
    `[ ]` / `[x]` 付きも可）だけで、字下げした入れ子は上の項目の一部として
    数えません。fenced code blockの中は読みません。
  - 同じ記述は一度だけ数えます。受け入れ基準は空白をまとめて小文字にした
    本文で、変更予定ファイルは項目の最初の `` `code` ``（無ければ最初の語）の
    pathで比べます。
  - specが無いrunでは、spec由来の三つは「不明」（`null`）です。specに該当する
    見出しが無い場合も、その値は「不明」にします。0とは数えません。この値の
    無い古いtriage記録も「不明」として読みます。
    較正材料は、承認待ちの途中のreport（triageの完了step）と、終わった後のreport
    （run output）に同じ値で出ます。
- triageの呼び出しをproviderが明示的に拒否した場合は、`unknown` として
  進まずに `rejected-invocation` で止まります。

### 修正専用のprofile（profiles.repair）

`factory.json` の `profiles.repair` を書くと、修正（検証の失敗やレビューの
指摘を受けた2回目以降の実装）だけを別のprovider、model、effortで動かせます。

```json
{
  "profiles": {
    "code": { "provider": "codex", "model": "gpt-5.6-sol", "effort": "medium" },
    "repair": {
      "provider": "codex",
      "model": "gpt-5.6-terra",
      "effort": "high"
    }
  }
}
```

- 書かなければ、修正は従来どおり `code` の設定で動き、`--context reuse` では
  実装のsessionを継続します。`configVersion` も変わりません。
- 書かなかった項目は、フラグやpresetではなく解決済みの `code` から補います。
  `"repair": { "effort": "high" }` なら、providerとmodelは `code` のまま、effortだけ
  変わります。providerを `code` と違うものにした場合は、`code` のmodelとeffortは
  使わず、そのproviderの既定presetで補います。
- fakeと実providerを混ぜられない規則、preflightの対象になることは
  他の役割と同じです。preflightは同じ設定を一度だけ確かめるので、`code` と同じ
  設定の `repair` は追加の確認をしません。
- `repair` のprovider、model、effortが `code` と同じなら、書かなかった場合と同じ
  です。sessionを継続し、`configVersion` も変わりません。
- 違う場合は、修正のたびに新しいsessionを始めます。promptには保存済みのtask、
  spec、実装の規則と、検証・レビューから得た修正の指示を渡し、前の実装が
  作業場所に残っていることを伝えます。`configVersion` はこの設定を含むので、
  `repair` の無いrunとは別のグループとして比較されます。
- ただしClaudeでeffortだけが違う場合は、実装のsessionを継続します（次の節）。
- `--context fresh` の修正は、`repair` の有無にかかわらず毎回新しいsessionです。
- 修正の呼び出しと使用量は、reportの役割別集計で `code` ではなく `repair` の
  行に入ります。
- 修正の呼び出しをproviderが明示的に拒否すると `rejected-invocation` で止まります。
  `factory.json` の `repair` を直してから `demo retrigger --run <id>
--reload-config` でやり直します。

### effortだけ違う修正は実装のsessionを継続する（Claude）

Claude Codeは、再開したsessionのeffortを変えてもprompt cacheを保ちます
（[公式ドキュメント](https://code.claude.com/docs/en/prompt-caching#changing-effort-level)、
Claude Code 2.1.280での実測でも、新しいsessionのcache readは0、effortを変えて
再開したsessionは同じeffortでの再開と同じ43,628 tokenでした）。そこで次の条件を
すべて満たすときは、`repair` が `code` と違っていても、修正で実装のsessionを
継続します。

- `--context reuse`
- providerが両方ともClaudeで、実効effortだけが違う
- 事前確認（preflight）の最小呼び出しで、Claude Codeが報告したmodelが
  両方で同じ（下の「modelの確かめ方」）
- そのmodelがOpus 5.5（`claude-opus-5-5`）かFable 5.1（`claude-fable-5-1`）
- Claude Code CLIが2.1.260以降（`claudeCli` の版から読みます。読めなければ継続しません）。
  2.1.260は公式ドキュメントが挙げる版で、実測は2.1.280で行いました。
  なお `claude-opus-5-5` そのものを使うには2.1.280以上が必要です（「モデルの選び方とサブスクでの制約」の節）
- `CLAUDE_CODE_USE_BEDROCK`、`CLAUDE_CODE_USE_VERTEX`、
  `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` のどれも設定されていない

```json
{
  "profiles": {
    "code": {
      "provider": "claude",
      "model": "claude-opus-5-5",
      "effort": "medium"
    },
    "repair": { "effort": "high" }
  }
}
```

- modelの確かめ方: `opus` のような別名を実際のmodelに解決するのはClaude Code
  自身で、このサンプルは別名の対応表を持ちません。実効modelは指定どおり
  （`opus` なら `opus`）です。そこで事前確認の最小呼び出しで、Claude Codeが
  `init` メッセージで報告したmodel（`opus` なら2.1.280では `claude-opus-5-5`）を
  読み、`code` と `repair` で比べます。
  - `opus` と `opus`、`opus` と `claude-opus-5-5` は、両方の報告が
    `claude-opus-5-5` なら継続します。
  - 報告が無いmodel（報告を記録する前の事前確認を含む）は、分からないものとして
    新しいsessionにします。
  - `claude-` で始まる完全なmodel IDはClaude Codeがそのまま使います。どちらか
    片方でも対象外の完全なID（`opus` と `claude-sonnet-5` など）なら、また
    完全なIDどうしが違えば、setupの時点で継続しないと決めます。
- 判定は二段です。setupで、modelを除く条件（context、provider、effort、CLIの版、
  環境変数、完全なIDの確認）を一度だけ判定し、runの `setup.repairSession`
  に候補かどうか（`eligible`）と理由を記録します。候補になっても継続はまだ
  確定していません。事前確認のあとで報告されたmodelを確かめて確定し、
  `preflight:repair-session` stepに、setupの判定、確定した判定（`continues` と
  理由）、runの `configVersion` を記録します。どちらも記録済みのstep出力だけから
  決まるので、あとでworkerを別の環境変数で起動し直しても、そのrunの扱いは
  変わりません。
- 確定した判定と理由は、JSON reportの `repairSession` と、Markdown reportの
  `repair session` の行に出ます。修正呼び出しごとの扱いは `repairCalls` の
  `sessionHandling` と `sessionReason` で確かめられます。
- 継続する修正は、記録済みのsession IDを `resume` に、`repair` の実効effortを
  `effort` に渡して呼びます。promptは新しいsessionとしては書かず、前の会話の
  続きとして書きます。修正が返したsession IDを次の修正のために記録します。
- 継続してよいかは、provider、事前確認で確かめたmodel、作業場所、指示版の
  一致で確かめます（effortの一致は求めません）。このため実装と修正のsessionには、
  その呼び出しでClaude Codeが報告したmodelを記録します。事前確認と実装の間に
  Claude Codeが更新されて別名の解決先が変わった場合など、記録したmodelが確定した
  modelと違えば、止まらずに新しいsessionにし、理由を `sessionReason` に残します。
  modelを記録していない古いsession（`null` を含む）も、effortをまたいで継続せず
  新しいsessionにします。
- 事前確認で継続が確定したrunだけ `configVersion` にこの方針が入ります。setupでは
  方針を含まない版を記録し、確定したときだけ事前確認のあとの呼び出しとreportが
  方針を含む版になります。候補になっても確定しなかったrun（たとえば `sonnet`
  どうしで、Claude Codeが `claude-sonnet-5` を報告した場合）を含め、それ以外の
  runの `configVersion` は変わりません。事前確認の最小呼び出しの計測には、
  確定前の版が残ります。
- Codex、providerやmodelが違う修正、`--context fresh`、外部の指摘から始まる子run
  の最初の修正は、これまでどおり新しいsessionです。子runは親のsessionを
  引き継ぎません。
- 環境の判定は環境変数だけを見ます。設定ファイルやgatewayなど、環境変数以外の
  方法でBedrockやVertexを使っている場合は判定できず、継続してしまうことが
  あります。そのときはcacheが効かないだけで、結果は変わりません。reportの
  修正呼び出しごとのcache-read比率で確かめられます。
- 判断の理由は [ADR-0024](../../docs/adr/0024-local-agent-loop-claude-effort-session-reuse.md)
  にあります。

### レビュー役の呼び出しと出力（command、context、output）

`profiles.review.correctness` と `profiles.review.edge-cases` には、provider、model、
effortに加えて、呼び出し方と返答の読み方を役割ごとに書けます。

```json
{
  "profiles": {
    "review": {
      "correctness": {
        "provider": "claude",
        "model": "claude-opus-5-5",
        "effort": "high",
        "command": "/code-review {effort} {base}...{head}",
        "context": "local-instructions",
        "output": "findings-json"
      },
      "edge-cases": { "provider": "codex", "output": "findings-json" }
    }
  }
}
```

- `command` は、factoryのレビューpromptの代わりに送る入力です。使える
  プレースホルダーは `{effort}`（その役割のeffort）、`{base}`（runが固定した
  base commit）、`{head}`（レビューするcandidateのcommit）の三つだけです。
  展開した文字列を一度だけ送り、送り直しません。空白だけの値、ほかの `{…}`、
  閉じていない `{` や対応しない `}`、effortが決まらない役割での `{effort}` は、
  `trigger` の時点で理由を付けて拒否します。factoryは特定のコマンド名を知りません。
- `context` はレビューの文脈（確認事項、trusted context、ハッシュ付きの
  `TASK`／`SPEC`／`DISPOSITIONS`／`FINDINGS`、差分と変更ファイル一覧とスナップ
  ショットの場所、返答の形）をどこに置くかです。`prompt`（既定）は入力に含めます。
  `command` があれば、その後ろに続けます。`local-instructions` は、factoryがその
  呼び出しのために作る作業ディレクトリ（後述）の `CLAUDE.local.md` に置き、入力は
  `command` だけにします（`command` が無ければ「`CLAUDE.local.md` のレビューを
  する」という短い文です）。candidateのworktreeには何も書きません。
  `prompt` でも、`command` があれば（コマンドモード）作業ディレクトリに短い
  `CLAUDE.local.md` を置きます。入力が届くのは親のセッションだけで、作業ディレクトリ
  にはコードが無いからです。このファイルはcandidateのworktree、差分、変更ファイル一覧、
  baseとheadのtreeの場所を示し、サブエージェントも含めて、コードをそこから絶対パスで
  読むよう伝えます。
- `output` は返答の読み方です。`verdict`（既定）は従来の `DECISION`／`NOTES` です。
  `findings-json` は、返答の最後の ` ```json ` ブロックにある配列を読みます。
  各指摘は `{"severity": "blocker" | "non-blocker", "title": "...", "body": "...",
"file": "...", "line": 12}` で、`file` と `line` は省けます。書く場合は
  `file` が空でない文字列、`line` が1以上の整数でなければなりません。ファイル全体への
  指摘は `line` を省きます（`0` は形が違う指摘です）。`null` は「省いた」扱いにはせず
  形が違う指摘として止めます。返答の最終行は改行1つ（`\n` または `\r\n`）を
  除いて `REVIEW_STATUS: COMPLETE` ちょうどでなければならず、末尾の空白や
  タブがあれば完了行として認めません。`blocker` が一件でも
  あれば `needsChanges` で、`blocker` だけを `- [file:line] title — body` の形で
  一行ずつnotesにし、修正に渡します。notesの長さには上限があり、各行は
  1,000文字まで、並べるのは最初の20件まで（最大でおよそ20 × 1,000文字）で、残りは
  件数だけを書きます。`title`、`body`、`file` の改行（LF、CR、垂直タブ、改ページ、
  U+0085、Unicodeの行区切りと段落区切り）は前後の空白ごと空白一つにするので、一件が
  複数行になることはありません。
  空の配列か `non-blocker` だけなら `pass` です。完了行が無い・最終行でない・別の状態、JSONが無い・壊れている、指摘の形が
  違う、途中で切れた、はどれも `review-incomplete`
  で止まり、`pass` にはなりません。同じ呼び出しを自動で送り直すこともしません。
- レビューのツール呼び出しをガードが拒んでも、それだけでは `review-incomplete` に
  しません。ガードが拒むのは、レビュー自身の作業ディレクトリ、候補のworktree、
  差分と変更ファイル一覧のディレクトリ、baseとheadの木の外だけなので、拒まれた
  読み取りで候補の中身が隠れることはないからです。返答が読めれば、その判定を
  そのまま使います。返答が読めなければ、拒まれた呼び出しがあってもなくても
  `review-incomplete` で止まります。`command` のないレビューも、仕様のレビューも
  同じです。
  拒まれた呼び出しは、ツール名とガードが示した理由（`Glob` ならパターンと
  `path` 引数）を、件数と先頭10件、各300文字までで記録します。記録はレビューの
  stepの出力と呼び出しの試行のmeasurementに残し、reportではJSONのレビューの
  `permissionDenials` と、Markdownのレビューの行の下の1行に出します。拒まれた
  呼び出しが無いレビューには出しません。
  指摘の本文にコードフェンスがあっても、JSON配列として読める最初の閉じフェンスまでを
  読むので途中で切れません。
  読めた返答の指摘は、判定とnotesとは別に、レビューstepの出力に構造化して保存し、
  レポートに出します（後述の **Review rounds**）。`blocker` と `non-blocker` は
  それぞれ先頭20件までを元の順序で残すので、`blocker` が多くても `non-blocker` は
  消えません。各指摘の `title` と `file` は200文字、`body` は600文字までに切り、
  省いた項目は付けません。`review-incomplete` で止まった返答の指摘は保存しません。
- `findings-json` はproviderを問わず使えます。`command` と `local-instructions` は
  Claudeとfakeのレビューだけが使えます。Codexのレビューに書くと、`trigger` の
  時点で役割名と項目を示して拒否します。CLIを通さずjobを直接 `trigger` した
  場合も、入力の検査で拒否し、runは作られません。fakeで使えるのはテストのためで、fakeの
  判定は実LLMの判定として数えません。
- 三つとも書かない役割は、従来どおりのpromptとverdictで動きます。どれか一つでも
  書いた役割だけ、三つの確定値が `configVersion` に入ります。どの役割も書かなければ
  `configVersion` は変わりません。`demo repair` の子runは、`--max-iterations` を除いて親の設定をそのまま使います。

`command` か `local-instructions` を使う役割があるrunでは、candidateをレビューする
直前に、次のものを `runs/<runId>/review-snapshots/` に作ります。どれもworktreeの外に
あり、候補の差分、反復のcommit、squash branchには入りません。

- `base/`：base commitのtree。runで一度だけ書き出して使い回します。
- `<candidate>/head/`：candidate commitのtree。
- `<candidate>/<役割>/cwd/`：その役割のレビューの作業ディレクトリ。base commitの
  `CLAUDE.md` と `.claude/`（あれば）と、factoryが書く `CLAUDE.local.md`
  （`local-instructions` ならレビューの指示全体、`prompt` ならcandidateの場所）を
  置きます。リンクは、たどった先がbaseのtreeの中にあるときだけ中身をコピーします。
  treeの外（ホストのファイルやディレクトリ）を指すリンク、どこも指さないリンク、
  コピー中のディレクトリに戻るリンクはコピーしません。役割ごとに別なので、
  二つのレビューが互いの指示を読むことはなく、従来どおり並行して呼びます。

treeは、commitを一時的なindexに読み込んで `git checkout-index` で書き出します。
`git archive` と違い、`.gitattributes` の `export-ignore` や `export-subst` で
中身が変わりません（checkoutのfilterや改行の変換はworktreeと同じく効きます）。
アーカイブファイルは作りません。書き出すgitのプロセスはほかの子プロセスと同じく
登録するので、cancel、leaseの喪失、workerの停止で止まります。やり直したレビューは、
中断した書き出しが残した途中のtree、一時的なindex、そのロックファイルを消してから
足りないtreeを書き出し直し、作業ディレクトリは作り直します。

消すのはworkerです。candidateのtreeと作業ディレクトリは、そのレビューの回が
終われば（失敗や中断でも、記録済みの結果を読むだけのやり直しでも）消します。
もうレビューが来ない工程（承認、完了、停止）の前にはbaseのtreeも消すので、
workerがレビューの記録の直後に落ちても、承認待ちの間に残りません。runが失敗する、
cancelされる、終わる、setupをやり直す、のいずれでも全体を消します。失敗とcancelでは、
jobの中で消し終えてからrunの状態が記録されます。別のプロセスから `demo cancel` した
ときは、workerにはleaseの喪失としか見えず、ほかのworkerがrunを拾い直す場合に備えて
workerは消しません。代わりにcancelした側が消しますが、そのときworkerが書き出していた
treeは残ることがあります。workerは起動時に、終わったrun（完了、失敗、cancel）の
`review-snapshots/` をすべて消すので、そうした残りも次の起動で消えます。このとき
見るのはworker自身のstate rootのrunだけで、データベースを調べるのは
`review-snapshots/` が残っているrunだけです。

`command` か `local-instructions` を使うClaudeのレビューは、次の設定で動きます。
通常のClaudeの呼び出しの設定は変わりません。

- `cwd` は上の作業ディレクトリです。`settingSources` は `project` と `local` なので、
  読み込む設定は、base commitの `CLAUDE.md` と `.claude/`（settings、コマンド、skill、
  agentの定義）と、factoryの `CLAUDE.local.md` だけです。candidateの `CLAUDE.md` や
  `.claude/` は、実装役が書き換えられるので読み込みません。baseはすでにマージされた
  コードなので信頼します。`CLAUDE.md` が `@` で取り込む別のファイルは作業ディレクトリに
  無いので読まれません。Claude Codeはcwdより上のディレクトリの `CLAUDE.md` も読みますが、
  そこにcandidateのファイルはありません。
- candidateはデータとしてだけ読みます。worktree、差分・変更ファイル一覧のある
  ディレクトリ、二つのtreeは `additionalDirectories` にしません。Claude Codeは追加
  ディレクトリの `.claude/` にあるskill、コマンド、agentの定義を読み込むからです。
  これらは、許可した道具と下の検査を通して読みます。
- 使える道具は `Read`、`Grep`、`Glob`、`Agent` だけで、`permissionMode` は `dontAsk`
  です。
- 読み込んだ設定のうちプログラムを動かすものは止めます。`--settings` と同じ層
  （project、localより優先）で `disableAllHooks` と `disableSkillShellExecution` を
  指定し、settingsやpluginのhookとstatus line、コマンドやskillに埋め込んだshell
  （`!` の行）を動かしません。`strictMcpConfig` と空の `mcpServers` で、`.mcp.json`
  やsettingsのMCPサーバーも起動しません。`!` の出力に頼るコマンドは、出力の代わりに
  プレースホルダーを受け取ります。factoryの検査はSDKに渡すcallbackなので、これらの
  影響を受けません。baseのsettingsにある `env` や認証用のhelperは、baseを信頼する
  ので止めていません。
- 読めるのは作業ディレクトリ、worktree、差分・変更ファイル一覧のあるディレクトリ、
  二つのtreeだけです。`canUseTool` と `PreToolUse` hookが、サブエージェントの
  呼び出しも含めて、Bash、書き込み、ほかの場所への読み取りを拒否します。
  パスはシンボリックリンクを解決してから比べるので、candidateやtreeの中から外を
  指すリンクは通りません。`~` で始まるパスも拒否します。`Grep` と `Glob` がディレクトリを
  たどる途中のリンクは、ツールがリンクをたどらないこと（ripgrepの既定）に頼ります。
- `Agent` は、`isolation`（`worktree` や `remote`）を指定した呼び出しを拒否します。
  `mode` が `acceptEdits`、`auto`、`bypassPermissions` の呼び出しも拒否します。
  これは念のための防御で、境界そのものではありません。サブエージェントは親の権限の
  モードを引き継ぐか、agentの定義の `permissionMode` に従い、その定義はbaseの
  `.claude/` からしか読みません。チームのメンバーを起動する道具も無く、サブエージェントの
  呼び出しも上の検査を通ります。
- セッションは保存しません（`persistSession: false`）。レビューは再開せず、呼び出し
  ごとに作業ディレクトリが違うので、保存すると `~/.claude/projects/` に呼び出しの数だけ
  項目が増えるからです。
- 使用量は最終結果の `modelUsage` から、サブエージェントの分も含めて一回分として
  数えます。親の使用量に重ねて足しません。モデルが報告しない項目は不明のままです。
  費用はモデルごとにそのモデルの単価で計算して合計し、単価の分からないモデルが
  一つでもあれば不明にします。親のモデルの単価で代用しません。
- これはこのモードのレビューだけです。ほかのClaudeの呼び出し（既定のレビューを
  含む）の使用量は、従来どおり親のループの値です。

`command` も `local-instructions` も使わず `output: findings-json` だけを書いた
Claudeのレビューは、道具を `Read` だけにして呼びます。ガードが拒む道具は
最初から見せません。

### 仕様を先に作ってレビューする（spec）

`factory.json` に `spec` を書くと、`--spec-file` を渡さなかったrepository runは、
実装の前に仕様を作ってレビューします。`--spec-file` を渡したrunと `spec` の無い
runは、これまでどおりの工程で動き、`configVersion` も変わりません。ただし
`--spec-file` を渡したrunでも `spec.checkFromSpec` があれば、baselineの前に
`spec-check` を走らせ、それが選んだcheckで採点し、`checkFromSpec` を
`configVersion` に含めます（後述の `checkFromSpec` を参照）。

```json
{
  "spec": {
    "template": "docs/spec-template.md",
    "reviewTemplate": "docs/spec-review.md",
    "maxRounds": 3,
    "author": {
      "provider": "claude",
      "model": "claude-opus-5-5",
      "effort": "high"
    },
    "fix": { "effort": "medium" },
    "review": {
      "product": { "provider": "codex", "output": "findings-json" },
      "tech": {
        "provider": "claude",
        "command": "/spec-review {base} {effort}",
        "context": "local-instructions",
        "output": "findings-json"
      }
    },
    "checkFromSpec": ["node", "scripts/check-from-spec.mjs"]
  }
}
```

工程の順番は次のとおりです。

1. 準備（setup）
2. 事前確認（preflight）。実装やレビューの役割に加えて、仕様の作成、修正、
   全レビュー役を確かめます。使えない役割があれば、仕様を書き始める前に止まります。
3. 仕様の作成。`author` がリポジトリを読み、仕様を書きます。
4. 仕様レビュー。`review` に名前を付けて並べたレビュー役が、同じ仕様を並列に
   レビューします。一人ずつ別のstepとして記録するので、再開時には済んだレビューを
   読み戻します。
5. 仕様の修正。blockerがあれば `fix` が仕様を直し、4に戻ります。blockerが
   なくなった時点の仕様を確定します。non-blockerは直す条件にしません。
6. `checkFromSpec` があれば、確定した仕様から採点コマンドを決めます。
7. ベースの検証（`baselineCheck` のとき）、見立て、実装と続きます。

- 仕様ファイルは `runs/<runId>/spec/spec.md` にあり、worktreeの外です。
  `author` と `fix` はリポジトリを読めますが、書けるのはこのファイルだけです。
  Claudeは `Read`、`Grep`、`Glob`、`Edit`、`Write` だけを持ち、`Edit` と `Write` は
  このファイルに限ります。Codexはこのファイルのディレクトリを作業ディレクトリにして
  workspace-writeで動かすので、worktreeには書けません。ただし同じディレクトリに
  ほかのファイルは作れるので、`author` と `fix` の呼び出しが終わるたびに
  （成功しても失敗しても）`spec.md` 以外を消し、成功したときは消したものを
  そのstepの出力（`removed` と `warning`）に残します。この掃除はrunを止めません。
  そのうえで `spec.md` 自体が通常のファイルでなければ（シンボリックリンクなど）、
  それを消してstepを失敗させます。レビュー役は読むだけです。
- `fix` を書かなければ `author` の設定で直します。`fix` で省いた項目は `author` から
  補います。`maxRounds` の既定は3で、正の整数に限ります。0、負数、小数、
  `Number.MAX_SAFE_INTEGER` を超える値は `trigger` で拒否します。
- `template`（仕様の雛形）と `reviewTemplate`（レビューの指示）は、`factory.json`
  のあるディレクトリからの相対パスで、`trigger` の時点で一度だけ読みます。中身は
  run inputに保存し、`configVersion` に含めます。あとでファイルを直しても、
  始まったrunは変わりません。
- レビュー役の `command`、`context`、`output` は、候補のレビュー役と同じ規則で
  読みます（前の節）。違いは、候補がまだ無いので `{head}` を使えないことです。
  使えるのは `{effort}` と `{base}` だけです。仕様ファイルの場所は、
  `local-instructions` なら `CLAUDE.local.md` に、`prompt` なら入力に書きます。
  壊れた `findings-json` は通過にせず、runを止めます。
- 仕様を直す `fix` には、blockerの指摘、前の回で直した指摘、人のメモを
  「信頼しないデータ」の区画で渡します。
- 確定した仕様は、実装とレビューの `SPEC` として渡します。最後の回のnon-blocker
  （人が承認したときは残ったblockerも）は助言 `SPEC_ADVICE` として、実装だけに
  「信頼しないデータ」の区画で渡します。

#### 上限の回まで直らなかったとき

`maxRounds` 回レビューしてもblockerが残ると、`spec-wait:<n>` というdurable waitで
人の判断を待ちます。`status` と `wait` は候補の承認待ちとは別の「仕様の判断待ち」と
して表示し、次のコマンドを示します。

```bash
pnpm --filter example-local-agent-loop demo approve --run <id> --wait <waitId>
pnpm --filter example-local-agent-loop demo spec-revise --run <id> --notes-file notes.md
pnpm --filter example-local-agent-loop demo reject --run <id> --wait <waitId>
```

- `approve` はいまの仕様を確定して実装に進みます。
- `spec-revise` はメモのファイルを読み、その中身をsignalに入れます。仕様の修正と
  レビューを1回ずつ足し、まだblockerが残れば、もう一度判断を待ちます。メモの
  ファイルは入力ファイルと同じく、256 KiBまでのUTF-8で、空は拒否します。
- `reject` は実装を始めずにrunを終えます。結論は `rejected` です。
- signalには、run ID、待っている仕様のSHA-256、判断が入ります。別のrunや別の
  版の仕様に向けた判断は受け付けません。再開したworkerは、記録した判断とメモを
  そのまま使います。

#### 仕様から採点コマンドを決める（checkFromSpec）

`checkFromSpec` はargvです。runが固定した仕様（spec工程で確定した仕様か、
`--spec-file`）の絶対パスを最後の引数に足し、worktreeで、`checkTimeoutMs` 以内に
一度だけ実行します。成功したときの標準出力は次の形のJSONに限ります。

```json
{
  "check": ["pnpm", "vitest", "run", "src/calc.test.ts"],
  "notes": "calcだけで足りる"
}
```

- `check` は空でない文字列の配列で、`factory.json` の `check` と `--check` の
  代わりに、ベースの検証、その識別（baselineReuse）、すべての検証で使います。
  `checkFromSpec` があるとき、`check` は省けます。
- `notes` は任意で、実装と候補のレビューに `CHECK_NOTES` として「信頼しないデータ」
  の区画で渡し、reportに残します。
- 失敗、時間切れ、JSONでない出力、形の違う `check` は `spec-check-failed` で止まり、
  ベースの検証も実装も始めません。スクリプトを直したら、`retrigger --reload-config`
  で新しいrunを始めます。同じrunの再開で、スクリプトの結果を読み替えることはしません。
- `checkFromSpec` があるのに仕様が無い（spec工程も `--spec-file` も無い）runは、
  `trigger` で拒否します。

#### reportとweb UI

- reportの `specRounds[]` は `reviewRounds[]` と同じ形で、回ごとにレビュー役ごとの
  結果を持ちます（`lens` はレビュー役の名前です）。済んだstepから読むので、
  進行中のrunでも出ます。
- `spec` には、確定した仕様、確定した回、残った指摘を人が承認して進めたか
  （`blocked`）、助言、`checkFromSpec` が決めた採点コマンドとnotesが入ります。
  確定する前は、最後に書かれた仕様を `content` と `sha256` に入れ、`round` は
  `null` のままです。仕様の判断を待つ間も、判断する仕様をここで読めます。`--spec-file` の
  runには `spec:final` が無いので、`spec-check` がまだ済んでいなくても
  （失敗していても）runの入力の仕様を `source: "input"` として入れます。
- 使用量は `spec-author`、`spec-fix`、`spec-review:<名前>` の役割で分けて数え、
  工程の時間は `spec`、`spec-review`、`spec-check` として出します。`compare` にも
  同じ工程が並びます。3つを合わせた経過時間は `specWallMs` です。各 attempt の
  区間を重ねて数えるので、並んだ仕様レビューは一度だけ入り、区間の間（仕様の判断を
  人が待った時間など）は入りません。
- web UIは、spec工程があるrunだけ「仕様」「仕様レビュー」を工程に出し、仕様の
  判断待ちを候補の承認待ちとは別の状態で見せます。

### 外部の指摘から修正する（repair）

承認して納品まで終わったrepository runに、あとからUIの確認、正式なレビュー、CIなど
factoryの外で指摘が見つかったときは、`demo repair` でそのrunの候補を直す子runを
起動します。終わったrunを再開するのではなく、候補のcommitを引き継ぐ新しいrunとして
記録するので、修正の時間、費用、回数もfactoryで測れます。

修正の回数を使い切ってもチェックが通らずに止まったrun（`verification-failed`）と、
チェックは通ったのにレビューが修正を求めたまま止まったrun（`review-cap-reached`）、
最後の候補がチェックを通ったあとにレビューが終わらず失敗したrun
（`review-incomplete`）も、同じ `demo repair` で最後の候補から続けられます。`retrigger` と違って実装を
最初からやり直さず、修正の回数を新しくして最後の候補を直します。

```bash
pnpm --filter example-local-agent-loop demo repair --run <親の runId> \
  [--findings-file findings.md] [--dispositions-file dispositions.md] \
  [--max-iterations 4]
```

- 親にできるのは、repository runのうち次の4種類です。
  - `completed` で、結論が `approved`、納品が記録され、最後の候補と納品の
    commitが一致するrun。
  - `completed` で、結論が `verification-failed`、最後の候補のcommitとブランチが
    記録されたrun。納品は要りません。
  - `completed` で、結論が `review-cap-reached`、最後の候補のcommitとブランチが
    記録されたrun。納品は要りません。
  - `failed` で、runのエラーか失敗したレビューのstepのエラーが
    `review-incomplete` で始まり、最後に封をした候補のstepにcommitとブランチが
    あり、その候補のあとの検証のstepが完了して通ったrun。失敗したrunには出力が
    無いので、候補と検証の結果はrunが残したstepから読みます。

  拒否、取り消し、承認待ちのrunと、ほかの理由で失敗したrunは、候補が残っていても
  親にできません。最後の候補に封をしていない、その候補の検証が無いか落ちた、
  という失敗したrunも親にできません。
  子runが同じ条件を満たせば、さらにその子を作れます。

- 起動前に、親の候補commitが対象リポジトリにあり、記録された候補ブランチの先端が
  そのcommitのままであることを確かめます。ブランチが動いていれば何も作りません。
  子runのsetupも、worktreeとブランチを候補commitから作る直前（CLIの確認のあと、
  `setupCommand` の前）に同じ確認をします。途中で止まったsetupをやり直すときは、
  前回のworktreeとブランチを片付けてから確かめます。`demo repair` の確認のあとで
  ブランチが動いた場合や、子runを `demo retrigger` した場合も、ここで
  `candidate-moved`（`retry: yes`）として止まります。worktree、ブランチ、
  run directoryは残さず、agentは呼びません。ブランチを候補commitに戻せば
  `retrigger` で続けられます。
- `demo repair` が受け付けるのは `--run`、`--findings-file`、`--dispositions-file`、
  `--max-iterations` だけです。`--publish`、`--check`、`--config` など、ほかの
  フラグは黙って無視せずエラーにします。
- 子runは、親が保存したtask、spec、issue、profile（triageも含む解決済みの値）、
  check、`selfCheck`、setup、timeout、`codexPath`、commitとpublishの設定、`--max-iterations` を
  引き継ぎます。`--max-iterations`（1から5の整数）を渡したときだけ、子runの修正回数を
  その値にします。値は子runの入力に保存され、`configVersion` にも入ります。親のsetupが記録した値は `null` でもそのまま使い、setupに項目が
  無い古い親だけ保存済みの入力から補います。子の子も同じです。
  いまの `factory.json` と環境変数は読みません。`--reload-config` は受け付けません。
  設定を変えたいときは、通常の `trigger` から始めます。
- 親が `approved` なら指摘ファイルは必須です。親が `verification-failed`、
  `review-cap-reached`、`review-incomplete` なら任意で、渡せばそのファイルを
  使います。渡さなければ、親が保存した記録から指摘を作ります。
  - `verification-failed` の親では、最後の候補で失敗したチェックの出力の末尾
    （stdout と stderr）、終了コード、親が使った採点コマンドです。ログファイルは
    読まず、前の候補の結果で代用もしません。最後の候補の失敗結果が保存されて
    いなければ、指摘ファイルを求めて止まります。親のrunの中で検証に落ちた候補への
    レビューは、子runには渡しません。渡したいときは指摘ファイルに書いて渡します。
  - `review-cap-reached` の親では、runの出力に保存した各レビューの最後の判定のうち
    `needsChanges` のものを、レビューの種類ごとの見出しとメモにまとめます。
    `pass` のレビューのメモは入れません。`findings-json` で答えるレビューのメモは、
    保存済みの直すべき指摘の行です。途中の回の工程やログは読みません。
    `needsChanges` のレビューが無いか、メモが空白だけなら、指摘ファイルを
    求めて止まります。
  - `review-incomplete` の親では、最後の候補の回のレビューのstepのうち、完了して
    `needsChanges` を返したものを、同じくレビューの種類ごとの見出しとメモに
    まとめます。前の候補のレビューと、終わらなかった、取り消した、失敗した
    レビューは入れません。該当するレビューが無いか、メモが空白だけなら、
    指摘ファイルを求めて止まります。
- 処分ファイルは任意で、指定すると親の処分を置き換え、
  省略すると親の処分を引き継ぎます。どちらも `--task-file` と同じ検査（256 KiB
  まで、UTF-8、空白だけは不可）を通し、内容と読み込んだパスを子runに保存します。
  指摘は修正担当と両レビュアーに、task、specと同じ信頼しない入力として渡します。
  記録から作った指摘も同じです。
  処分はこれまでどおり両レビュアーにだけ渡します。親が `approved` なら、
  レビュアーには、承認済みの候補に対する修正だけの差分を見て、指摘に応えているか、
  承認済みの候補を壊していないかを判断するよう伝えます。親が `verification-failed`
  なら、修正担当とレビュアーに、基点の候補はチェックが通らず承認されていないことを
  伝えます。親が `review-cap-reached` なら、チェックは通ったもののレビューの上限の
  あとも指摘が残り、承認されていないことを伝えます。親が `review-incomplete` なら、
  チェックは通ったもののレビューが終わらず、候補全体をまだ誰もレビューしていない
  ことを伝えます。どれも、レビュアーには
  基点と修正を合わせた候補全体をtaskとspecに照らして判断する
  よう伝えます。レビュアーに渡す変更ファイルの一覧は修正の分だけなので、基点の
  変更は、CANDIDATE FILES の節が示す候補の木を読んで確かめるよう伝えます。
  節が木を示していなければ、作業ディレクトリを読みます。
- 子runの基点は親の最後の候補commitです。親の元のbaseや、起動時点の `HEAD` は
  使いません。反復のブランチはissueの有無にかかわらず `factory/<子の runId>`、
  squashedブランチは `factory/<子の runId>-squashed` で、差分、patch、squashed
  commitの親はすべて親の候補commitです。
- 子runでもsetup、preflight、設定していればbaselineCheckを実行します。
  `baselineReuse` も親の設定を引き継ぎます。ただし親が `verification-failed`
  の子runはbaselineCheckを実行しません。基点は親のチェックが失敗した候補なので
  必ず `baseline-check-failed` で止まり、その失敗はすでに指摘として渡しているから
  です。設定は記録して孫runへ引き継ぎ、reportの「Baseline check」節は `none`
  になります。親が `review-cap-reached` か `review-incomplete` の子runは、基点が
  チェックを通った候補なので、baselineCheckを通常どおり実行します。triageと
  初回実装は行わず（triage profileは記録するだけで、呼び出しも事前確認も、CLIの
  確認もしません）、最初のcode工程を `repair` の1回目として新しいsessionで始め
  ます。`profiles.repair` があればそれを使います。そのあとは通常どおり検証、
  両レビュー、承認、納品に進みます。
- 子runの `--max-iterations` は、引き継いだ値でも指定した値でも、子run自身の
  修正回数だけを数え、親が使った回数は差し引きません。最初の修正も修正回数と
  使用量に入ります。
- 同じ親、同じ指摘の内容、同じ処分の内容、同じ修正回数で起動すると、パスが違っても
  同じ子runを返し、runもブランチも増やしません。記録から作った指摘は親の記録だけで
  決まるので、繰り返しても同じ子runです。指摘か処分の内容、または修正回数が変われば
  別の子runです。親と同じ修正回数を指定したときは、省略したときと同じ子runです。
- `--publish` のDraft PRは通常のrunと同じく既定ブランチ向けです。親がまだ
  mergeされていなければ、PRには親の変更も含まれます。
- 子runは起動するどの経路（`demo repair`、`demo retrigger`、`demo seed`）でも
  run label `repairOf=<親の runId>` を付けます。1件の `report`、`status --run`、
  CLIの `compare`、web UIの詳細は、このlabelで子を1回問い合わせます。SQLiteは
  この問い合わせでjobのrunを順に見てlabelを引くので、費用は履歴の長さに比例
  します。web UIの一覧と比較は、読み込んだ全runのlabel（無ければ入力の
  `repairOf`）から親ごとの子を一度にまとめ、runごとには問い合わせません。
- `report` と `status --run` には親のIDと子のID一覧が、reportには指摘ファイルの
  パスと保存内容のSHA-256も出ます。記録から作った指摘は、パスの代わりに作った元の
  親runを示します（JSONでは `parentRun`）。web UIでは一覧と詳細で、親と子をtaskの名前で
  リンクします。`compare` は通常のrunと子runを別のグループに分け、親の時間、費用、
  工程を子の値に足しません。子run同士は `configVersion` ごとにまとめます。
- 判断の理由は [ADR-0022](../../docs/adr/0022-local-agent-loop-external-repair-runs.md)
  と、`verification-failed`、`review-cap-reached`、`review-incomplete` の親を加えた
  [ADR-0030](../../docs/adr/0030-local-agent-loop-verification-failed-repair.md)
  にあります。
- `verification-failed` か `review-cap-reached` で止まったrepository runの次の一手
  には、`retrigger` と並べて `demo repair --run <id>` を出します。
  `review-incomplete` で失敗したrepository runでは、最後の候補が記録されていて
  その検証が通っているときだけ、次の一手に `demo repair --run <id>` を出します。

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
    work/                          worktree（同梱題材ではコピー）。repo runでは
                                   納品後やアーカイブ時に片付ける
    worktree-removed               納品後に片付けを始めた印（再実行の判定用）
    operation-checkpoints/         LLM呼び出しと検証のcheckpoint
    agent-logs/<attempt>.log       エージェントの出力（LLM呼び出しの試行ごと）
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
- **エージェントの出力**: LLMを呼ぶ試行は、送る前に `agent-logs/<attempt>.log` を作り、
  そのパスを試行の `agentLog.path` に記録してから呼び出します。assistant の本文を
  届いた順に、ツールの呼び出しを名前と短い引数（コマンド、検索語、パスを優先）で
  `> exec pnpm test` のように1行ずつ、コマンドの終了コードを `< exec exit 1` の
  ように1行ずつ追記します。prompt、
  思考や推論のブロック、使用量は書きません。完了checkpointから復旧した試行と、
  送る前に取りやめた試行はファイルを作りません。追記に失敗しても呼び出しの結果は
  変えず、エラーを `agentLog.writeError` に残します。作業ツリーの片付けや
  `demo prune` では消しません。保存期限やローテーションはありません。
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
- 修正の呼び出しでは、呼び出す前に決めたsessionの扱い（`sessionHandling`：
  `continued`、`continued-effort-change`、`fresh`）とその理由（`sessionReason`）
- 通常input、cache read、cache write、output、total token
- usageの単位（このサンプルは一provider invocation）と取得元
- elapsed、result、error、interruption reason、API換算参考価格とmeter別内訳
- `configVersion`（三役割それぞれのprovider、model、effort、context、指示版、
  反復上限、対象、timeoutのhash。triage profileと、`code` と違うrepair profileと、
  `selfCheck` のコマンドがあればそれも含む。effortだけ違う修正でsessionを継続すると事前確認で確定した
  runは、その方針も含む。事前確認の最小呼び出しには確定前の版が入る）

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
  SHA-256、最後に封印したcandidateのbranchとcommit、成果物の場所、branch名、commit SHA、
  squash branchの名前とcommit SHA
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
  最後の回です。`findings-json` のレビューは、`reviewRounds[].reviews[]` と
  `reviews[]` の両方に `findings` を持ちます。`findings.blocker` と
  `findings.nonBlocker` は保存した指摘（`severity`、`title`、`body`、あれば `file`
  と `line`）の配列で、それぞれ先頭20件までです。`findings.counts` は省いた分も
  含めたseverityごとの総件数なので、配列の長さではなくこちらを件数として読みます。
  指摘は完了したチェックポイントの返答をレビューstepが読んだときに保存したもので、
  レポートを作るときにreviewerを呼び直したり、チェックポイントを読み直したりしません。
  `verdict` のレビューと、指摘を保存する前のrunのレビューは `findings: null` です。
  runの出力（`output.reviews`）には指摘を入れません。Markdownと画面には、総件数と
  保存した指摘のタイトル、省いた件数だけを出し、本文、ファイル、行番号は出しません。
  notesの表示は変わらないので、`blocker` の場所と本文は従来どおりnotesに出ます
- **Verification logs**: 検証の試行ごとの終了コードと、`stdout.log` / `stderr.log` の
  パス。JSONでは `attempts[].measurement.verificationLog` で、`exitCode`、
  `stdoutPath`、`stderrPath` に加え、中断した試行には `interrupted: true`、
  書き込みに失敗したログには `writeError` が入ります。Markdownでは中断した試行の
  行に `interrupted, not part of the verdict` を付け、書き込みエラーを
  `log write error:` の行に出します。検証失敗で止まったrunでは、最後の検証の
  全試行の終了コードとログのパスを `failure.details` にも載せます
  （`check attempt: `、`check exit code: `、`check stdout log: `、
  `check stderr log: `、`check log write error: `）
- **Repair session**: `repair` が `code` と違うrunで、effortをまたいで実装の
  sessionを継続するか（JSONの `repairSession`、Markdownの `repair session` の行）。
  setupの判定（`eligible` と理由）と、事前確認のあとに確定した判定（`continues`、
  model、理由）を持ちます。reportの `configVersion` はこの確定のあとの版です
- **Repair calls**: 修正の呼び出しごとの行（JSONの `repairCalls`）。sessionの扱い
  （`continued` は同じprofileで継続、`continued-effort-change` はeffortだけ違う
  profileで継続、`fresh` は新しいsession）とその理由（`sessionReason`）、input、
  cache read、その呼び出しの
  cache-read比率（`cacheReadTokens / inputTokens`）を持ちます。usageが無いときや
  inputが0のとき、比率は `null` です。回収した呼び出しも1行で、`(recovered)` を
  付けます。継続した修正の比率が高く、新しいsessionの修正が0に近ければ、cacheが
  効いています
- **Triage**: 事前判定（`routine` / `probe` / `unknown`）とその理由、四つの
  較正材料（不明なら `unknown`）。判定の無いrunは `none`
- **Stage usage**: 工程ごとの visits / reworked（同じ工程への再突入＝手戻り）、
  invocation数、in / cache-read / cache-write / out / total、cost。
  いずれかの呼び出しが未計上なら PARTIAL、価格不明なら unknown
- **Role usage**: `code`、`correctness`、`edge-cases`（修正を呼んだかrepair
  profileがあれば `repair`、triage profileがあれば `triage` も）ごとのrequested
  provider/model/effort、invocation数、token、cost、usageとcostそれぞれの完全性。二つのレビューを
  別の行に分けるので、役割ごとに違うmodelを使ったrunでも内訳が混ざりません
- **Timing / Attempts / Waits**: 従来どおりの工程別 work / wall 時間、
  呼び出しごとの生データ、承認待ちの inputWait / executionSlotWait
- **Versions**: `ai` と provider パッケージの版に加え、providerが実際に起動した
  CLIの版とパス。Codexは `codexCli` / `codexCliPath`、Claudeは `claudeCli` /
  `claudeCliPath` です。Codexは `codexPath` が無ければPATH上の `codex` を起動し、
  無いときだけproviderが解決できる `@openai/codex` を
  `node <パッケージ>/bin/codex.js` として起動します。Claude Agent SDKは同梱のネイティブバイナリを起動し、PATH上の `claude`
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

### 止めた呼び出しの使用量

最後まで終わらなかった呼び出しも、止めるまでに使った分を残します
（[ADR-0034](../../docs/adr/0034-local-agent-loop-stopped-call-usage.md)）。
ClaudeとCodexは、呼び出しの途中でもその時点までの累計を報告します。

- **Claude**: Agent SDKのassistantメッセージごとの使用量を、message IDごとに
  一度だけ（最新の値で）足し、モデル別にも分けます。Claude Codeが自分で作る
  `<synthetic>` のメッセージと、tokenの無いメッセージは数えません。最終の
  usageと同じ範囲で数えるので、subagentはcommandモードのレビューでだけ数えます。
  session IDは各メッセージから、結果を待たずに読みます。
- **Codex**: app-serverの `thread/tokenUsage/updated` を、providerの最終集計と
  同じく、threadの累計の増えた分で足します。最初の通知は直前の応答の分だけを
  足すので、`--context reuse` で再開したthreadの前回分は入りません。この通知を
  読むためにraw通知を有効にしますが、raw通知は活動として数えず、agentのログにも
  書きません。無通信時間をやり直すのは、tokenのある使用量の通知だけです
  （ほかの途中の使用量と同じ）。それ以外のraw通知とtokenの無い使用量の通知では
  やり直しません。thread IDは、turnを始める前に `onSessionCreated` で受け取ります。

検証の失敗でレビューを止めたとき（`superseded-by-verify`）と、factoryの時間の
上限で止めたとき（`timeout`）は、止めた時点までの使用量、モデル別の内訳、
session ID、報告の回数と最後の報告の時刻を、完了のcheckpointにも保存します。
workerが再開してcheckpointを読み直した試行にも、送り直さずに同じ値が入ります。
runの取り消しやleaseの喪失で止まった呼び出しは、結果が分からないので今までどおり
`uncertain` のままにし、完了のcheckpointは作りません。それまでに受け取った値は
試行の計測にだけ残します。

止めた呼び出しの結果は今までどおり使いません。採点、承認、レビュー回数には
入らず、残るのは使用量だけです。最終のusageを受け取った呼び出しでは、途中の
累計を最終の値で置き換え、最終の値にモデル別の内訳が無ければ途中の内訳も消します。
最終の結果にusageやsession IDが無いまま終わった呼び出しは、途中で受け取った値を
計測に残し、完了のcheckpointにも保存するので、読み直した試行にも同じ値が入ります。

計測の `usageUntilStop` が、使用量が途中までであることを示します（止めた理由、
報告の回数、最後の報告の時刻と呼び出し開始からの時間）。報告が一度も無かった
呼び出しは、`usage` が `null` で報告の回数が0です。0 tokenとは扱いません。
reportのJSONは `stoppedCalls` に、Markdownは「Usage of stopped calls」に、
呼び出しごとの止めた理由、報告の回数、最後の報告の時点、使用量とモデル別の内訳、
session IDを出します。止めた呼び出しを含む合計は、tokenがそろっていても
`complete` と `costComplete` を false にし、下限として扱います。途中の報告
（`provider-partial`）のままのusageも同じです。最終のusageが無いまま終わった
呼び出しや、呼び出し中にworkerが落ちて `started` のまま残った試行が当たります。
同じ呼び出しの試行が複数あるときは、完了した試行、止めた呼び出しとして確定した
試行（`cancelled`、`timed-out`）、それ以外の順に1つを選んで集計します。
Markdownの集計行も工程や役割の合計と同じ試行から数えます。試行の表では、途中の
報告のままのusageに `(partial)` と付けます。

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
run の数と、停止理由（`rejected-invocation`、`uncertain-invocation` など）ごとの
run 数です。`routine` の列が判定の見逃しで、shadow mode で測りたい値です。
続く表は、同じ判定ごとに四つの較正材料（task と spec の文字数、受け入れ基準の
項目数、変更予定ファイルの数）の統計を並べます。cost や較正材料が
不明の run は統計から外して unknown 件数に数えます。triage 呼び出しのtokenと
costは `triage` 工程と `triage` 役割に1回ずつ計上します。

外部の指摘からの修正 run（`demo repair`）は、通常の run と別のグループに
まとめます。子 run の数字はその run 自身のもので、親の時間、費用、工程は足しません。

週ごとの推移は `--trend` で見ます。`--runs` は取らず、run ではなく task を数えます。
task は一覧と同じく、最初の run とその下の修正 run（`demo repair`）をまとめたものです。
最後に作った run が終わり、その完了時刻が直近 `--days` 日（既定 30）に入る task だけを
読みます。最後の run が動いている task、完了時刻のない task、期間の外で終わった task は
数えません。

```bash
pnpm --filter example-local-agent-loop demo compare --trend
pnpm --filter example-local-agent-loop demo compare --trend --days 14 --include-fake --format json
```

- 最初の run の実装に使ったモデルと推論量（code profile の `effectiveModel` と
  `effectiveEffort`）の組でまとめ、最後の run が終わった週（月曜始まり、この PC の
  時刻）で分けます。CLI の版はまとまりに含めません。
- 週ごとと期間全体について、task 数、初回承認の数と率、最終承認の数と率、task の
  所要時間と費用の中央値 / 最小 / 最大と欠測数、修正 run 数の中央値を出します。
- 初回承認は、修正 run なしに最初の run で承認された task です。最終承認は、最後の
  run が承認されて納品された task です。レビューの上限で止まった run を修正 run で
  直して承認された task は、最終承認に数え、初回承認には数えません。
- task の所要時間と費用は、期間の外で終わった run も含めた全 run の合計です。修正 run
  数は最初の run の下にある run の本数で、run の中で修正した回数とは別のものです。
- 最初の run が fake provider の task は除き、除いた task の数を `fakeExcluded` に
  出します。含めるときは `--include-fake` を付けます。
- `--days` は 1 から `Number.MAX_SAFE_INTEGER` までの整数だけを受け付けます。0、
  負の数、`NaN`、`Infinity`、小数、それより大きい数は DB を開く前に拒否します。
- 費用や時間が分からない run を1つでも含む task は、その中央値から外して欠測数に
  数え、0 として混ぜません。task のない週は件数 0 とし、率や中央値は出しません。

reuse と fresh を比べるときは、`code` 工程の cache-read 比と
repairs の中央値を見ます。unknown は統計から外して件数だけ残し、0 として
平均に混ぜません。

## 権限と制約

- Codex implement/repairはworkspace-write、reviewはread-only sandboxです。
- triageはCodexではread-only sandbox、ClaudeではReadのみで動きます。
- Claude reviewはReadのみです。implement/repairは `canUseTool` と `PreToolUse`
  hookの双方でworkdir外パスを拒否します。これは入力検査であり、OS sandboxでは
  ありません。`command` か `local-instructions` を使うClaude reviewは `Read`、
  `Grep`、`Glob`、`Agent` だけで、読める場所は自分の作業ディレクトリ、worktree、
  レビュー資料のディレクトリです（「レビュー役の呼び出しと出力」を参照）。この
  reviewが読み込む設定はbase commitの `CLAUDE.md` と `.claude/` だけで、candidateの
  ものは読みません。hook、コマンド内のshell、MCPサーバーは動かしません。
- 仕様の作成と修正は、リポジトリを読み、run所有の仕様ファイル
  （`runs/<runId>/spec/spec.md`）だけを書けます。仕様レビューは読むだけです
  （「仕様を先に作ってレビューする」の節）。
- 同じsessionへ並列送信しません。並列なのは新規sessionを使うreviewと仕様レビュー
  だけです。
- model、effort、指示版、tool、cwdを途中で替えるhandoffは未実装です。
  trigger時に解決した三役割のprofileをrun中固定します。
- 実装と修正のsession継続は、`code` 役割のprovider、profile ID、cwd、指示版が
  一致するときだけです。レビューのprofileは関係しません。`code` と違う
  `repair` profileの修正は、実装のsessionを継続しません。例外はClaudeでeffortだけ
  が違う場合で、profile IDの代わりに、事前確認でClaude Codeが報告したmodelの
  一致を確かめて継続します（「effortだけ違う修正は実装のsessionを継続する」の節）。
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
呼び出しが明示的に拒否されます。`rejects-*` は無料の確認で通り、その後の
実装、修正、レビュー、triageの呼び出しがすべて明示的に拒否されます。それ以外は
無料の確認で通ります。

`FAKE_LATENCY_MS=20000-90000` を付けると、各呼び出しがその範囲のランダムな時間
待ちます。cancel と timeout では待ちを打ち切ります。`FAKE_USAGE=realistic` を
付けると、役割に応じたそれらしい token 数を返し、requested model の価格で費用を
計算します。付けなければ、これまでどおり token と費用は不明です。

job input の `fakeScenario` は run ごとに fake の振る舞いを変える、デモとテスト
専用の欄です。上の環境変数と同じ項目を run ごとに上書きします。`reviewSequence` と
`reviewNotes` はレビューの回ごとに correctness、edge-cases の順で2つずつ並べ、回と
観点で引くので、呼び出しの順番や再起動後のやり直しで判定が入れ替わりません。
`reviewOutputs` は同じ並びでレビューの返答そのものを指定します（`findings-json` の
壊れた返答や途中で切れた返答も書けます）。`reviewDenials` は同じ並びで、その呼び出し
が道具の使用を拒否されたことにします（空文字列なら拒否なし）。テストが記録を
始めている間（`recordFakeReviewCalls`）だけ、`command`、`context`、`output` を
設定したレビューの呼び出しについて、受け取った入力、作業ディレクトリとその中の
ファイル、読めるディレクトリのファイルと中身、呼び出しの開始時と返答時の
作業ディレクトリの `CLAUDE.local.md` の有無と中身を記録します。記録して
いないworkerは何も溜めません。`output` は `{ chunks, intervalMs }` で、各呼び出しが
返答の前に `intervalMs` ごとに `chunks` を1つずつエージェントの出力として書きます。
指定がなくても、fake の呼び出しは返答の本文を出力の最後に書きます。`FAKE_REVIEW_SLOW_MS` は
これらの呼び出しでも edge-cases のレビューを遅らせます。すべての
役割が fake の run でしか受け付けず、trigger の時点で断ります。`configVersion` にも
入りません。`demo seed` がこれを使います。

テスト専用の `claudeEffortResume: true` を付けると、fake は「effortを変えて
sessionを再開してもcacheが残るClaude Code」の代わりをします。呼び出しごとに渡された
effortをそのまま使います（`low` に固定しません）。Claude providerと同じく、実効modelは
指定どおり（未指定なら `fake-model`）で、別名の解決は「CLI」側が行います。各呼び出しは
実際に動いたmodelを報告し、`fake` は `fake-model` として報告され、`unobserved-*` は
何も報告しません。Claude Codeと同じく無料の確認が無いので、事前確認は最小呼び出しを
行ってそのmodelを読みます。実装と修正の呼び出しでは、sessionを再開したときに
cache readの多いusageを、新しいsessionのときにcache read 0のusageを返します。
setupもこの欄を読み、effortだけ違う修正は事前確認でmodelを確かめたうえで継続します。
setupの判定は `configVersion` に入ります。実providerには影響しません。

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

境界の形は `engine/verification.ts` と `factory/target.ts` によく出ています。
前者は start/complete checkpoint、計測、signalの転送までを持ち、「何をもって
検証とするか」は `grade` コールバックとして受け取ります。後者は、作業場所、
封印の仕方、採点、レビューに渡す文脈、成果物の渡し方という、ターゲットごとに
必ず違う5つだけを切り出しています。

移植の手順は [docs/porting.md](docs/porting.md) にあります。
