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

Terminal 1でworkerを常駐させる手順です。常駐させなくても、Terminal 2の
`trigger` などがworkerを自動で起動します（「workerの自動起動とアイドル終了」の節）。

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

### workerの自動起動とアイドル終了

Terminal 1でworkerを常駐させなくても、runを進めるコマンドが必要なときにworkerを
起動します。

- `trigger`、`repair`、`retrigger`、`approve`、`reject`、`spec-revise` が成功した
  あと、workerの仕事があれば、workerのロックを調べます。workerがいなければ
  `demo worker --exit-when-idle` を起動し、既にいれば何もしません。ロックが読めず
  workerの有無が不明なとき（`running: null`）は起動せず、理由をstderrに出します。
  失敗したコマンドや入力の検証で拒否したコマンドは起動しません。
- workerの仕事とは、`pending` と `leased` のrun（leaseの期限は問いません）と、
  いま待っているwaitが判断済み（`resolved`）の `waiting` のrunです。判断済みの
  waitを持つrunは、pendingに戻るのを待たずにworkerが再開します。誰も判断して
  いないwaitだけを待つrunは数えません。
- 起動したworkerは起動元と別のセッション（別のプロセスグループ）で動き、
  コマンドの終了を待たせません。エージェントが起動元のシェルやプロセスグループを
  片付けても、workerは止まりません。
- 起動の知らせと警告はすべてstderrに出します。stdoutはこれまでどおりコマンドの
  出力（`trigger` のJSONなど）だけです。起動に失敗しても、コマンドの終了コードは
  変わりません（runはもう保存されています）。成功すると、workerのpidとログの
  場所を1行出します。
- workerの標準出力と標準エラーは、state rootの
  `~/.local/state/local-agent-loop/logs/worker-YYYY-MM-DD.log`（起動した日、
  ローカル時刻）に追記します。同じ日に何度起動しても既存のログは消しません。
- 止めるには、各コマンドに `--no-auto-worker` を付けるか、環境変数
  `LOCAL_AGENT_LOOP_NO_AUTO_WORKER=1` を設定します。runはworkerが来るまで
  pendingのままです。
- 自動起動したworkerのアイドル期間は `LOCAL_AGENT_LOOP_IDLE_MS`（既定30000）で
  変えられます。1から2147483647までの整数ミリ秒だけを受け付け、範囲外ならworker
  を起動せずに警告します。
- 自動起動したworkerは、コマンドを実行したcheckoutのCLIで動きます（どのcheckout
  かは `worker.json` の `checkout` に残ります）。同じstate rootを共有していると、
  固定したcheckout（「durably checkoutを固定して呼ぶ」の節）とは別のcheckoutから
  実行したコマンドが、そのcheckoutのworkerを起動することがあります。固定した
  checkoutのworkerで処理したいときは、そのcheckoutでworkerを動かしておくか、
  自動起動を止めてください。

`demo worker --exit-when-idle [--idle-ms <ms>]` は、仕事がない状態が `--idle-ms`
（既定30000、1から2147483647までの整数）続くと終了します。オプションなしの
`demo worker` はこれまでどおり常駐します。

- 仕事の有無は500ミリ秒ごと（`--idle-ms` がそれより短ければその間隔）に確かめ、
  前の確認が終わってから次を始めます。DBを読めなかった確認はアイドルと数えず、
  エラーをstderrに出してアイドル期間を数え直します。
- アイドル期間が過ぎたら、ポーリングを止めてからもう一度確かめます。そこで仕事が
  見つかれば、ポーリングを再開して処理します。
- この最後の確認からロックを手放すまでの間にrunが作られると、起動元のコマンドは
  まだworkerがいると見て新しく起動しません。そのため、アイドル終了するworkerは
  ロックを手放したあとにもう一度仕事を確かめ、仕事があれば自動起動と同じ方法で
  後継のworkerを起動し、ログに `[idle] work arrived as the worker stopped; started
a successor (pid N)` を書きます。後継も同じようにアイドル終了するので、workerが
  ロックを握っている間に作られたrunは、そのworkerがロックを手放す前か後のどちらか
  で必ず見つかります。後継が起動しない場合（起動の失敗、自動起動を止めている場合）
  はrunがpendingのまま残ります。`demo wait` は `--worker-timeout`（既定10秒）で
  workerがいない状態を検出して終了コード6で知らせるので、そのときは
  `demo worker` を起動してください。
- SIGTERM、SIGINT、アイドル終了では、`[shutdown] reason=SIGTERM`、
  `[shutdown] reason=SIGINT`、`[shutdown] reason=idle` をログに書きます。その後、
  実行中のエージェントCLIを止め、進行中のアイドル確認を待ち、ポーリングを止めて
  ロックを手放します。アイドル終了ならここで上の後継の確認をし、最後にDBを閉じ、
  出力を書き終えてから終了コード0で終わります。終了処理中に届いたシグナルで終了処理を重ねることはありません。

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
  保存したtask、spec、dispositions、context、issue、対象リポジトリはそのままで、
  `factory.json` だけを読み直します。読み直すのはtrigger時に `--config` で
  渡したファイルで、渡していなければリポジトリ直下の `factory.json` です。
  直下の `factory.json` を消した場合は、設定なしのtriggerと同じに扱います。
  `--config` で渡したファイル（パスが直下の `factory.json` でも）が無くなって
  いれば、設定なしとはみなさずエラーにします。
  profile、`check`、`selfCheck`、`testProbe`、`setup`、`base`、`codexPath`、timeout、
  `baselineCheck`、`baselineReuse` は `trigger` と同じ規則で解決・検証し、trigger時の `--check`、`--setup`、`--base`
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
はworkerの起動コマンドを案内します。ただし `trigger` がworkerを自動起動したときは、
`start` を `null` にし、起動したworkerのpidとログの場所を `autoStarted` に入れます。
起動したworkerがまだロックを握っていなければ `running` は `false` のことがあります。
自動起動しなかったとき（止めている、不要、workerがいる）のJSONは下の例のとおりで、
`autoStarted` はありません。

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

```json
"worker": {
  "running": false,
  "pid": null,
  "startedAt": null,
  "start": null,
  "unknownReason": null,
  "autoStarted": {
    "pid": 51234,
    "log": "~/.local/state/local-agent-loop/logs/worker-2026-10-22.log"
  }
}
```

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

止まったまま誰も手を打たない run は、アーカイブすると `status` の上部
（`wait on a person or stopped`）と web UI の「止まったもの」から外れます。

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
  setup の途中で失敗した run（`pnpm install` の失敗など）は setup の記録がないので、
  git の登録から `runs/<runId>/work` とそこにチェックアウトしたブランチを探して
  片付けます。消すブランチは、setup がその run に付ける名前のものだけです。人が
  切り替えた別のブランチは残します。登録もディレクトリもなければ、何もせず警告も
  出しません。
- `git worktree remove` には 10 分の上限があります。依存パッケージを入れた大きな
  worktree は、消すのに数分かかることがあるためです。上限で止まったときは、worktree が
  一部だけ消えて残ることがあり、警告がそのパスとともにそう伝えます。消せなかったときは、
  git がまだそのディレクトリを worktree として登録しているかを確かめ、警告に書きます。
  登録が残っていれば `demo prune --apply` で続きを消せます。残っていなければ、git は
  そのディレクトリを worktree として扱えず、ほかの方法では消さないので、手で消すと書きます。
  setup をやり直す前に前回の worktree を消すときも同じ上限で、キャンセルや lease の
  喪失があればそこで止めます。アーカイブ、prune、納品後、test probe の base の片付けは
  キャンセルのあとにも走らせる必要があるので、止めずに上限まで待ちます。
  web UI は書き込みを1つずつ処理するので、片付けのあいだはほかの操作が待ちます。
- アーカイブの印を付けた時点で応答を返し、worktree を後で消す形はとっていません。
  消せなかったことを応答で伝えられなくなり、CLI と web UI が同じ関数から同じ結果を
  受け取れなくなるためです。
- ブランチは残します。`--delete-branch` を付けたときだけ、その run が記録した
  factory のブランチ（issue 付きの run は `factory/issue-<番号>-<runId>`）と
  `factory/<runId>-squashed` を消します。
- `--series` は、指定した run が属する task（最初の run とその下の修正 run すべて）の
  止まった run をまとめてアーカイブします。task のどの run の ID を渡してもかまいません。
  `--series` を繰り返すと複数の task を順にアーカイブし、1つが失敗しても残りは続けます。
  `unarchive` も `--run` を繰り返すと、複数の run をまとめて戻します。
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
worktree、レビュー用スナップショット（`runs/<runId>/review-snapshots`）、
`testProbe` のbaseのworktree（`runs/<runId>/base-work`）だけです。

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
  「同じ操作の CLI コマンド」を開くと、レポートや状態確認を含む次のコマンドの
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
同梱題材は「同梱題材: calc の add を直す」です。一覧には run ID を出さず、
完全な ID は run 詳細とコピーしたコマンドにあります。作成時刻は「3分前」のような
相対表記で、正確な時刻はマウスを重ねると出ます。

各行と run 詳細には、その run のリポジトリ名を名前の横に出します。名前は
`factory.json` の `name`（trigger の時点で入力の `target.name` に保存したもの）で、
同じリポジトリの run のうち名前を持ついちばん新しい run のものを使うので、`name` を
書く前の run も同じ名前で出ます。どの run にも無ければ保存済みの入力の
`target.repoPath` のディレクトリ名です。同じ名前のリポジトリがほかにあるときや、
「すべて」「同梱題材」「不明」と同じ名前のときだけ、見分けられるところまで親
ディレクトリを前に付けます（`a/public` と `b/public` など）。それでも見分けられない
ときはパスで出します。修正 run は、修正元の最初の run のリポジトリに
数えます。同梱題材の run は「同梱題材」です。完全なパスは、run 詳細と切り替えのリポジトリ名に
マウスを重ねると出ます。

run のリポジトリが2つ以上あるときは、タスク一覧と集計の上に「リポジトリ」の
切り替えが出ます。既定は「すべて」です。リポジトリを選ぶと、一覧の各節、件数の
並び、止まったものの「すべて選ぶ」、集計（週ごとの推移と設定ごとの比較）が、
そのリポジトリの task と run だけになります。選んだリポジトリは
`#/?repo=<パス>`、`#/compare?repo=<パス>` のように URL に残るので、読み込み直しても
変わらず、一覧と集計のあいだを移っても、run 詳細（その URL にも残ります）から一覧へ戻っても続きます。
API も同じく `/api/runs`、`/api/trend`、`/api/compare` に `?repo=<パス>` を付けると
そのリポジトリだけを返し、どの run にもないパスは「すべて」として扱います（画面の
URL からも外します）。リポジトリは保存された `--repo` のパスを git のトップレベルに
直して見分けるので、末尾の `/` やリポジトリ内のディレクトリを渡した run も同じ
リポジトリに数えます。git が答えられないとき（リポジトリが消えたときなど）はパスを
そのまま正規化して使い、ほかの run のリポジトリのパスの下にあれば、いちばん近い
そのリポジトリに数えます。git には画面の応答を止めない形で聞き、答えたパスは覚えておき、答えられなかったパスは
1分たってから聞き直します。
リポジトリが1つだけのときは切り替えを出しません。

**タスク一覧**は task ごとに1行で、先頭の件数の並びと4つの節に分かれます。並びと
区分は `demo status` と同じ関数（`groupTasks`）で決めます。行の末尾には、実行が
2件以上あるときの件数、所要時間、費用、代表の run の作成時刻を、列をそろえて
出します。所要時間と費用は、終わった task か実行が2件以上ある task だけに出し、
2件以上なら全 run の合計です（マウスを重ねると合計と出ます）。どれかの run の値が
不明なら不明です（`demo status` の `total` と同じ値）。

- **件数の並び**：判断待ち、動いているもの、止まったもの、終わったの件数です。
  押すとその節へ移ります。0 件は色を付けません。「動いているもの」は、実行中の
  run があるときだけ青にします。判断待ちも止まったものもなければ「人の手が要る
  ものはありません」と出します。
- **判断待ち**：承認、仕様の判断、承認以外の入力を待つ task。行は開いた状態で、
  理由、工程の並び、その run にできる操作と、同じ操作の CLI コマンドを出します。
  コマンドの補足はボタンにマウスを重ねると出ます。
- **動いているもの**：実行中（期限内の lease）、ワーカー停止中（lease が切れて
  worker が止まった。worker を起動すれば再開）、順番待ち、判断済み・再開待ちの task。
  行は開いた状態で、実行中なら名前の下にいまの工程と経過時間を出します。
- **止まったもの**：未解決の停止（検証失敗、レビュー上限、未確定の外部呼び出しなど）の
  task。新しいものから 5 件だけを出し、残りは「さらに N 件表示」で出します。節の件数はすべてを数えます。
  各行のチェックボックスか節の「すべて選ぶ」でタスクを選ぶと、画面の下に操作バーが出ます。
  「すべて選ぶ」は、まだ表示していない行も含めて節の全件を選びます。「N 件をアーカイブ」は、
  選んだタスクの名前と `demo archive --series <id> --series <id> …` を並べて確認してから、
  タスクごとに `archive --series` と同じ関数で、1件ずつ順に止まった実行をアーカイブします。
  進むあいだは知らせに「N 件中 M 件」を出し、1件終わるごとに更新します。まとめて操作は
  それぞれ自分の知らせを持ち、途中で別の操作をしても、その知らせは上書きされません。終わると件数と、
  作業ツリーやブランチを片付けられなかったタスクとgitの理由、できなかったタスクとその理由を
  知らせ、「まとめて戻す」で今アーカイブした実行を戻せます。一部の実行だけアーカイブできた
  タスクも、アーカイブした実行は戻せ、警告も出します。行は閉じた状態で、状態のバッジと名前だけを1行で出します。開くと止まった
  理由、工程の並び、再実行の可否、操作とコマンド、各 run が出ます。同じ task に
  動いている run か判断を待つ run がほかにあるとき（再実行した修正など）は、行を
  開いた状態で出し、各 run の状態が開かずに見えるようにします。前に止まった run が
  残っているだけでは開きません。表示のあとでそうなったときも 3 秒ごとの読み直しで
  開き、そうした run がなくなればまた閉じます。自分で開け閉めした行は、task が同じ節にあるあいだはその状態を保ちます。別の
  節へ移ったとき、run の詳細を開いてから一覧へ戻ったとき、ページを読み込み直した
  ときは、その節の既定の状態に戻ります。後の修正 run の承認で解決した停止と、アーカイブした停止は
  出ません。
- **終わったタスク**：新しい順に 30 件ずつ出し、「さらに表示」で次を出します。
  アーカイブした task は既定で隠し、「アーカイブ済みも表示」で出します。タスク名で
  絞り込めます。どちらも表示だけの切り替えで、task や数値は変えません。節の件数は
  全件で、隠したり絞り込んだりしているときは「144 件中 104 件」のように添えます。
  行の名前は代表の run の詳細へのリンクで、左の矢印で開くと工程の並びと、run が
  複数ある task では「最初の実行」「指摘からの修正 1」…のように各 run とその
  所要時間と費用を出します。後の修正で解決した run には「後の修正で解決」と添えます。
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

1. **いまの状況**：停止や判断待ちの理由、人が確認すること、再実行の可否、
   その run にできる操作と、同じ操作の CLI コマンド。主な操作（承認、仕様を直す、
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
   出します。採点値のある指摘は、題名の横に頻度と深刻さを添えます。最後のレビューが通過したと言えるのは、両方のレビュアーの判定がそろい、
   どちらも通過したときだけです。通らなかった run では、そこで出た直すべき指摘を
   「残っている直すべき指摘」として別に出し、判定がそろっていない回はそう書きます。
   指摘を回をまたいで突き合わせることはしません。見出しの件数は report と同じ指摘の
   数です。判定だけを返すレビュー（verdict）は回、観点、判定だけを題名の下に出し
   （直した側では「〜が求めた修正」）、件数には数えません。最後のレビューで通過した
   verdict は何も残していないので、「残した指摘」ではなく、最後のレビューの結果の
   下に出します。メモの本文は記録の詳細の節で読みます。
3. **工程の時系列**と**工程ごとの時間と費用**：工程ごとに作業時間（呼び出しの時間の
   合計）、所要時間（時計の時間）、費用を1行で並べます。費用の「–」はモデルを
   呼ばなかった工程、「不明」は値の分からない呼び出しを含む工程です。終わった run の
   時系列は全行を出し、動いている run だけが枠の中でスクロールします。レビューのように並んで動いた
   工程は作業時間を重ねて数えるので、作業時間の合計は所要時間を超えることが
   あります。spec 工程のある run には「仕様の工程まとめ」として、仕様の作成、
   仕様レビュー、採点コマンドの決定を合わせた経過時間（report の `specWallMs`）を
   出します。並んだレビューは一度だけ数え、人の判断を待った時間は含みません。
4. **記録の詳細**（初期状態は閉じています）：仕様、レビューの全回の判定とメモ（メモは
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

- **週ごとの推移**：`demo compare --trend --format json` と同じ値です（リポジトリで
  絞ったときは、そのリポジトリの task だけで数えます）。run ではなく
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

## 実際のリポジトリで動かす

同梱の題材ではなく、実際のリポジトリの作業を渡す場合です。リポジトリごとに変わらない
設定は、対象のリポジトリの直下に置いた `factory.json` に書きます。

```json
{
  "name": "myapp",
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

これがあれば、作業の内容を書いたファイルを渡すだけで始められます。

```bash
pnpm --filter example-local-agent-loop demo trigger \
  --repo ~/progs/myapp --task-file ~/work/task.md \
  [--spec-file ~/work/spec.md] [--dispositions-file ~/work/dispositions.md] \
  [--context-file ~/work/decisions.md]
```

- `--repo` のリポジトリから `git worktree` で作業ツリーを作り、その中だけで作業
  します。あなたが開いているチェックアウトは、まったく変わりません。
- 作業の内容は、`--task-file`、`--task "..."`、`--issue 234` のどれか 1 つで渡します。
  `--issue` は、`gh issue view` で本文を取ります。
- `--spec-file` は実装とレビューの全員に、`--dispositions-file`（過去のレビューの
  指摘をどう扱ったか）はレビューだけに渡します。どちらも中身を解釈しない UTF-8 の
  テキストで、1 ファイル 256 KiB までです。プロンプトでは「信頼しないデータ」として
  区切った区画に入り、factory の指示や出力の形式とは混ざりません。
- `--context-file` は、依頼した人が確定した決定やテストの結果など、**信頼できる
  情報**を渡すファイルです。UTF-8 の空でないテキストで、32 KiB（32,768 バイト）
  までです。これを超えるもの、空のもの、UTF-8 として読めないものは、実行を作る前に
  受け付けません。実装と修正のプロンプトには、TASK や FINDINGS とは別の、信頼できる
  区画として入れます。そのうえで「依頼した人が確定した決定に反する変更をしない。
  反すると判断したら変更せず、返答の NOTES で理由を述べる」と指示します。両方の
  レビューには、factory が作る TRUSTED CONTEXT の中に入れます。`--dispositions-file`
  はこれまでどおり、レビューだけに渡す信頼しないデータで、信頼できる情報には
  格上げしません。
- 実装と修正の返答には、変更したファイルの短い要約を書きます。わざと直さなかった
  指摘や変更があるときだけ、続けて `NOTES:` の節に、どれをなぜ直さなかったかを
  書きます。節が無い返答も、空の節も、`none` や `特にありません` だけの節も、
  これまでどおり受け付けます。節は、プロンプトのとおり大文字で `NOTES` と書いた、
  字下げのない最初の行から始まります。`NOTES:` だけの行も、`## NOTES` や
  `**NOTES:**` のような見出しも、これに含みます。そういう行が無いときは、`notes:`
  のような `NOTES:` だけの行から読みます。それも無いときは、`## Notes` のような
  最初の見出しから読みます。`## Notes` で始めた節の本文に、字下げのない `NOTES:`
  の行があると、その行から読みます。
  factory は、決着した返答から一度だけ読み取り（UTF-8 で 4 KiB まで）、候補の
  `step` に保存します。記録からの再開（replay）では、保存したものを読み、返答は
  読み直しません。その候補の両方のレビューには、TRUSTED CONTEXT の後ろに、
  「信頼しないデータ」の `REPAIR_NOTES` 区画として渡します。あわせて、理由を候補、
  タスク、仕様、確定事項と照らして判断すること、理由が書いてあるだけでは指摘は
  片付かないことを指示します。factory は写しを工程の結果と同じ場所にも置き、
  読めるファイルと、command 形式の `CLAUDE.local.md` に載せます。TRUSTED CONTEXT
  にも DISPOSITIONS にも入れません。次の実装か修正が終わると、その返答の分に
  置き換わります。写しは新しい候補を封印したときに消え、次のレビューの回で、新しい
  候補の分が書かれます。
  レポートの `implementerNotes[]`、Markdown のレポート、実行の詳細に、回と役割
  ごとに出ます。
- `check` は、**エージェントが動き出す前に固定する採点コマンド**です。argv として
  そのまま実行し、シェルは通しません。設定ファイルにもフラグにも無ければ、
  始めません。何を直せば通るのかが決まっていない依頼は、そもそも factory に
  向きません。
- `setup` は、新しい作業ツリーに依存パッケージをインストールするためのものです。
  省くと、インストールせずに `check` を実行します。`base` の既定は `HEAD` です。
- `name` は、web UI に出すリポジトリ名です（空でない文字列）。省くと、ディレクトリ
  名を出します。`trigger` のときに実行の入力の `target.name` に保存するので、
  リポジトリが消えても名前は残ります。表示だけに使い、設定のバージョンには入れません。
- `--check`、`--setup`、`--base` を付けると、設定ファイルの値より優先します。別の
  場所の設定ファイルは、`--config <path>` で選べます。相対パスは、CLI のプロセスの
  カレントディレクトリから解決します。`pnpm --filter` はパッケージのディレクトリで
  CLI を動かすので、パスは絶対パスで渡してください。
- `profiles` では、`code`（実装と、`repair` が無ければ修正も）、`review.correctness`、
  `review.edge-cases` の 3 つの役割を、別々に指定できます。修正だけを別の設定にする
  `repair` と、事前判定の `triage` は任意です（下の節を参照）。設定ファイルが省いた
  役割と、役割の中で省いた項目だけを、`--provider`、`--model`、`--effort` と
  プリセットで補います（`repair` で省いた項目は、`code` から補います）。ただし、
  `--provider` と違うプロバイダーを指定した役割は、`--model` と `--effort` を
  引き継がず、そのプロバイダーの既定のプリセットを使います。はっきり書いた役割の
  値が、ほかの役割やフラグで上書きされることはありません。fake と実際のプロバイダー
  を、役割ごとに混ぜることはできません。
- エージェントの呼び出しには、2 つの時間の上限があります。`agentTimeoutMs` は、
  呼び出しを始めてからの全体の上限です。`agentIdleTimeoutMs` は無通信の上限です。
  エージェントの活動（文章、推論、ツールの呼び出しとその結果、実行中のツールの
  進み具合）、出力、使用量の報告が、この時間届かなければ止めます。どれかが届く
  たびに数え直すので、動き続けている呼び出しは、無通信の上限を超えても続き、全体の
  上限で止まります。プロバイダーに渡す上限は factory の全体の上限より長くして
  あり、止めるのはいつも factory のタイマーです。
- 時間の上限の既定値は、対象によって変わります。実際のリポジトリでは、エージェントの
  呼び出しが全体 2 時間、無通信 15 分、検査 15 分です。同梱の題材では、全体 5 分、
  無通信 5 分、検査 2 分です。`factory.json` の `agentTimeoutMs`、
  `agentIdleTimeoutMs`、`checkTimeoutMs`（ミリ秒）がいちばん優先されます。無ければ
  `trigger` を実行したプロセスの `AGENT_TIMEOUT_MS`、`AGENT_IDLE_TIMEOUT_MS`、
  `TEST_TIMEOUT_MS` を、それも無ければ既定値を使います。無通信の既定値は、全体の
  上限を超えないように、全体の上限に合わせて短くします。どれも 2147483647 以下の
  正の整数に限ります。`0`、負の数、小数、`NaN`、`Infinity`、2147483647 を超える値は、
  `trigger` のときに受け付けません。これより大きい値では Node のタイマーがあふれて
  約 1 ミリ秒で発火し、呼び出しを始めた直後に打ち切ってしまうからです。無通信の
  上限が全体の上限より長い組み合わせも、作業ツリーを作る前に `trigger` で受け付け
  ません。解決した値は実行の入力に保存し、ワーカーの環境変数は読みません（この変更
  より前に保存した実行だけは、これまでどおりワーカーの環境変数を読みます）。修正の
  実行は、親が保存した値を引き継ぎます。`factory.json` から読み直すのは
  `retrigger --reload-config` だけです。レポートには、解決した全体と無通信の上限を
  出します。
- 実装や修正の呼び出しを factory が時間の上限で止めたときは、その呼び出しを始めた
  ときの候補（最初の実装ならベース）から、作業ツリーに変更があるかを見ます。変更が
  あれば、終わった呼び出しと同じ手順でコミットして候補にし、いつもどおり検証します。
  検証に落ちれば、修正の回数を 1 つ使って、次の修正に進みます。次の修正には、前の
  呼び出しが時間の上限で止まったこと、その途中の作業が今の候補であることを伝えます。
  レポートと工程の時系列には、その候補が時間切れの呼び出しから作られたことを出します。
  変更が無ければ候補を作らず、`agent-timeout` で止まります。
- 反復ごとにコミットして封印します。検証、レビュー、納品物は、同じコミットを見ます。
- 既定の納品物は `~/.local/state/local-agent-loop/runs/<runId>/delivery/<candidate>.patch`
  です。パッチは、ベースのコミットと最後の候補の差分です。イシューの無い実行の
  ブランチは `factory/<runId>`（イシューのある実行は `factory/issue-<番号>-<runId>`）
  で、反復ごとのコミットと承認されたコミットは、このブランチに残ります。`status` と
  レポートに、ブランチ名とコミットの SHA を出します。承認されず納品物が無い実行
  （却下、検証の失敗、レビューの上限）でも、最後に封印した候補のブランチとコミットを、
  `candidate` として出します。
- 承認されて納品物を作るときは、もう 1 つ、`factory/<runId>-squashed` を作ります
  （イシューのある実行も同じ名前です）。記録したベースのコミットをただ 1 つの親と
  し、最後の候補と同じ tree を持つコミットが 1 つだけ乗ったブランチです。候補が
  ベースと同じ tree でも空のコミットを 1 つ作るので、ベースからのコミット数はいつも
  1 です。ref だけで作るので、元のブランチ、作業ツリー、あなたのチェックアウトは
  変わりません。納品物を作る `step` が途中で止まって再実行されたときは、まず
  `git commit-tree` で期待するコミットを組み立てます。すでにあるこのブランチが、
  そのコミットを指しているときだけ使い回します。作者、メッセージ、親、tree の
  すべてが一致している必要があります。それ以外のブランチは受け付けず、手を付けずに
  残します。承認されなかった実行には作りません。ブランチ名とコミットの SHA は、
  `delivery.squashedBranch` と `delivery.squashedCommit` に記録し、`status --run`
  の JSON と、レポートの JSON・Markdown に出ます。web UI の納品物には、ブランチ名
  だけを出します。この記録が無い以前の実行では `null` です。
- `--publish` を付けると、反復の履歴のあるブランチをプッシュして、下書きの PR を
  作ります。`commit.publishSquashed` が `true` のときだけ、代わりに 1 コミットに
  まとめたブランチをプッシュして、下書きの PR の head にします。どちらの場合も、同じ
  head で開いている PR がすでにあれば（PR を作ったあと、記録する前に止まった `step`
  の再実行など）、新しく作らずにそれを使います。`delivery.location` は、実際に
  公開したブランチの PR の URL です。

`--publish` を付けない限り、外に向けた操作は起きません。まずパッチで確かめてから
PR に進むのが安全です。

実際のリポジトリでは、既定で人の承認待ちを入れません。下書きの PR そのものを人が
レビューし、マージするのも人だからです。`--approve manual` を付けると、同梱の題材
と同じ承認の `wait` を挟めます。

### コミットの作者とメッセージ（commit）

`factory.json` の `commit` で、factory が作るコミットの作者とメッセージを決められます。
どの項目も省けます。文字列が空のもの（空白だけのものも含む）は、`trigger` のときに
受け付けません。

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

- `authorName` と `authorEmail` は、反復のコミットとまとめたコミットの、作者と
  コミッターになります。省いた項目は、`durably-factory` と `durably-factory@localhost`
  です。
- `messageTemplate` の `{iteration}`、`{runId}`、`{task}` を置き換えます。`{task}` は
  保存したタスクの 1 行目です。`{iteration}` は、反復のコミットではその反復の番号、
  まとめたコミットでは最後の候補を封印した反復の番号です。省くと、反復のコミットは
  `factory iteration <番号>`、まとめたコミットは `factory run <runId>` になります。
- 変更の無い反復では、これまでどおり、空の反復のコミットを作りません。
- `publishSquashed` の既定は `false` です。`--publish` が無ければ、この値に
  かかわらず、プッシュも PR の作成もしません。
- 設定は `trigger` のときに解決して、実行の入力に保存します。`trigger` のあとで
  `factory.json` を書き換えても、すでにある実行は変わりません。
  `retrigger --reload-config` で作った実行は、書き換えたあとの値を使います。
- 作者とメッセージのテンプレートは、反復のコミットとして作業ツリーの履歴に残り、
  エージェントが読めるので、`configVersion` に入れます。どちらも省いた実行の版は、
  これまでと同じです。`publishSquashed` は、`--publish` と同じく公開先を選ぶだけ
  なので入れません。

### ベースの採点を先に確かめる（baselineCheck）

`factory.json` に `"baselineCheck": true` を書くと、準備が終わった直後、
エージェントを呼ぶ前に、ベースのコミットの作業ツリーで、固定した `check` を
一度だけ実行します。既定は `false` で、そのときは実行しません。実際のリポジトリを
対象にするときだけの設定です。

- ベースで `check` が失敗したら、`baseline-check-failed` で止まります。エージェントの
  呼び出し（事前判定と事前確認を含む）は 0 回です。`retry: yes` で、次の手順は
  「採点コマンドか環境（準備、依存、ベース）を直す」です。
- 終了コードと、標準出力・標準エラー出力の全文のログのパス
  （`runs/<id>/baseline-logs/<attempt>/`）を、`status`、レポートの JSON（`baseline`、
  `failure.details`）と Markdown（「Baseline check」節）、web UI の停止の理由に
  出します。時間の上限で打ち切られたときは、終了コードを不明（`unknown`）とし、
  打ち切るまでの時間を出します。
- 検証と同じチェックポイントで記録します。完了した結果は、ワーカーが再開したときに
  読み戻して、もう一度は実行しません。途中で止まった採点はやり直します。中断した
  試行の途中までのログは、合否の根拠にしません。
- 準備や採点が、作業ツリーの git が追跡しているファイルを書き換えた場合は、最初の
  候補に混ざるので、`baseline-check-failed` で止め、エラーにそのことを出します。
  採点コマンドを起動できない場合（コマンドが見つからないなど）も、同じ分類で
  止めます。
- 準備は、`.gitignore` の対象外の未追跡ファイルを残してはいけません。空の
  ディレクトリも同じです。採点のあとの片付けで消えてしまうからです。判定には
  片付けと同じ `git clean -ffdn` の結果を使うので、無視されるファイルだけが
  入ったディレクトリは残してかまいません。
  `baselineCheck` がオンのときは、準備の直後、採点の前に確かめます。残って
  いれば、採点もエージェントの呼び出しもせずに `baseline-check-failed` で止め、
  最初の数件のパスを `failure.details` に出します。次の手順は「準備が
  `.gitignore` にないファイルを作っているので、そのファイルを `.gitignore` に
  入れるか、`baselineCheck` を外す」です。無視されるファイル（`node_modules`
  など）は残してかまいません。
- 採点が通ったら、`git clean -ffd` で、`.gitignore` の対象外の未追跡ファイルを、
  入れ子の git リポジトリも含めてすべて消します。カバレッジやテスト結果の
  ファイルが、最初の候補に入らないようにするためです。上の前提があるので、
  消えるのは採点が残したものだけです。途中で止まった採点を、ワーカーが再開した
  ときにやり直した場合も、前の試行が残したファイルごと消えます。無視される
  ファイルは残ります。消したあとも対象外の未追跡ファイルが残っていれば、
  `baseline-check-failed` で止めます。

### ベースの採点結果を使い回す（baselineReuse）

同じリポジトリの同じベースのコミットから続けて実行を始めると、実行ごとに数分
かかるベースの採点を繰り返します。`baselineCheck` と一緒に `baselineReuse` を
書くと、条件が同じで期限内の、ほかの実行の成功した結果を使い、採点を省きます。

```json
{
  "baselineCheck": true,
  "baselineReuse": { "maxAgeMs": 3600000 }
}
```

- `maxAgeMs` はミリ秒の正の整数で、上限は 7 日分のミリ秒です。索引の記録は
  7 日より古くなると消えるので、上限もそれに合わせています。0、負の数、
  小数、7 日を超える値は、`trigger` が受け付けません。省略すると使い回しは
  しません。`baselineCheck` がオフの実行では読みません。
- 使い回すのは、同じ状態の DB にある、ほかの実行のベースの採点のうち、その実行が
  自分で採点して成功した結果だけです。失敗した結果、終わっていない結果、別の
  結果を使い回した結果、この機能より前の形式の結果は使いません。
- 次の値がすべて一致する結果だけを使います。リポジトリのルート（シンボリック
  リンクを解決したパス）、ベースのコミット、`check` と `setup` の argv、
  `checkTimeoutMs`、Node.js の版、OS の種類（platform）、CPU の種類
  （architecture）、`check` の先頭のコマンドが実際に起動するファイル（PATH から
  探し、シンボリックリンクを解決したパス。作業ツリーの中のファイルは、作業ツリー
  からの相対パス）。起動するファイルは、`spawn` と同じ順で探します。PATH の空の
  要素は作業ツリーを指します。PATH が設定されていないときと Windows では、
  分からないものとします。どれかが分からない実行は、結果を使わず、ほかの実行に
  使わせる結果も残しません。
- これらの値は、準備のときに一度だけ求めて記録します。準備とベースの採点の間で
  ワーカーが再起動し、Node.js や PATH が変わっても、準備のときに記録した値で
  照らし合わせます。
- 比べるのはこれだけです。依存パッケージの中身、環境変数、`check` が内部で
  呼ぶほかのコマンド、無視されるファイル（`node_modules` など）は比べません。
  これらが変わったときは、`baselineReuse` を外すか、期限を短くします。
- 採点して成功した実行は、状態のルートの
  `baseline-index/<条件のSHA-256>/<run ID>.json` に、実行 ID と採点の完了時刻を
  書きます。実行ごとに自分のファイルだけを書き、ほかの実行のファイルは
  上書きしません。同時に書く実行があっても、書く操作そのものが互いの記録を
  消すことはありません。
- 使い回すかどうかを決めるときは、条件のディレクトリを 1 つ読みます。読めない
  記録と期限切れの記録を除き、残りを新しい順に試します。記録にある実行の
  ベースの採点を状態の DB から読み直し、採点して成功した結果であることと、条件が
  一致することを確かめ、最初に通ったものを使います。どれも通らなければ、
  ふつうに採点します。読むのはその条件の記録だけで、過去の実行を全部は
  読みません。
- 自分の記録を書いたあと、その条件の記録のうち、`checkedAt` が 7 日より古いものと
  読めないものを消します。それより新しい記録は消さないので、同時に書いた実行の
  記録も残ります。ほかの実行が同時に消していても、失敗にはしません。
  `maxAgeMs` の上限は 7 日なので、期限内の記録がこの整理で消えることは
  ありません。
- 期限は、元の実行で採点が完了した時刻（チェックポイントの記録）から、この実行が
  使い回すかどうかを決める時刻までで測ります。元の実行が再開したあとにベースの
  採点を保存していても、再開した時刻からは測りません。時計の変更は扱いません。
  起きても、採点が 1 回増えるか、このマシンの時計で判断した結果を使うだけです。
- 使い回すときも、準備は毎回実行し、新しい作業ツリーを作ります。準備の直後の
  未追跡ファイルの確認も省きません。採点を省く前に、作業ツリーがベースの
  コミットにあること、git が追跡しているファイルに変更がないこと、`.gitignore` の
  対象外の未追跡ファイルがないことを確かめ、満たさなければ、ふつうの
  `baseline-check-failed` で止めます。
- 使い回すかどうかの判断は、ベースの採点の結果として記録します。ワーカーが
  再開したときは記録を読み戻し、使える結果を探し直しません。この実行で採点を
  始めたあとに再開した場合は、使い回さずに採点をやり直します。
- 使い回した結果には、ログをコピーせず、元の実行のログのパスを記録します。元の
  ログが消えていれば、レポートのログは `null` になり、理由を出します。
  チェックポイントから読み戻したかどうかの表示は、元の実行の記録に従います。
- レポートの JSON（`baseline.reusedFrom` に、元の `runId` と採点の完了時刻
  `checkedAt`）と Markdown（「Baseline check」節の `source`）、web UI の
  「工程ごとの時間」の事前検証の行に、使い回したかどうかと、使い回した
  ときの元の実行と時刻を出します。
- 運用のための最適化で、エージェントに見せるものも採点の基準も変えないので、
  `configVersion` には入りません。

### 検証とレビューを同時に始める（parallelReview）

既定では、封印した候補を検証し、通ったものだけをレビューします。
`factory.json` に `"parallelReview": true` を書くと、候補を封印した直後に、
検証と 2 つのレビューを同時に始めます。検証がほぼ毎回通るリポジトリでは、
レビューを待つ時間の分だけ、実行が短くなります。

```json
{
  "parallelReview": true
}
```

- 書かなければオフで、工程の順序、Durably の `step` の名前、レビューの呼び出しの
  回数と費用は、これまでと同じです。値は `trigger` のときに、実行の入力に保存
  します。`retrigger` は保存した値を引き継ぎ、`--reload-config` はファイルを
  読み直します。`demo repair` の修正の実行は、修正元の実行の値を引き継ぎます。
  いつレビューするかを選ぶだけで、レビューの中身は変えないので、`configVersion` には
  入りません。
- オンのとき、レビュアーが読む候補のコードは、封印したコミットから取り出した
  tree（head のスナップショット）と、候補の差分と、変更したファイルの一覧だけです。
  検証が動いている作業ツリーは、作業ディレクトリにも、プロンプトにも、読める
  場所にも入れません。プロンプトで渡すレビューは、head のスナップショットの中で
  動きます。`command` や `local-instructions` のレビューは、これまでどおり自分用の
  ディレクトリで動き、ベースのスナップショットも読めます。Codex、Claude の
  どちらでも同じです。
- 検証とレビューの両方が通った候補だけが、これまでどおり承認に進みます。
  レビューが修正を求めたときは、これまでどおり修正に回ります。
- レビューの途中で検証が失敗すると、その回のレビューを止めます。止めた
  呼び出しは、それまでに分かった使用量と、完了のチェックポイントを、
  `cancelled`（理由は `superseded-by-verify`）として残します。ワーカーが再開しても
  その呼び出しを送り直さず、`uncertain-invocation` にもしません。まだ送って
  いなかったレビューは送らず、呼び出しとしても費用としても数えません
  （計測の記録は `not-sent`）。すべてのレビューが終わってから、次の工程に進みます。
- レビューが先に終わってから検証が失敗した回は、判定を記録に残したうえで、
  `discarded`（理由は `verify-failed`）として使いません。
- 止めた回と使わなかった回の判定は、承認に使わず、`review-cap-reached` までの
  レビューの回数にも数えません。
- 検証が失敗したとき、次の修正には、まず検証の失敗を渡し、先にそれを直すよう
  求めます。その回で最後まで終わったレビューの判定と指摘は、そのあとに、
  信頼しない入力として区切って渡します。検証に落ちた候補へのレビューなので、
  修正したあとには当てはまらない指摘もある、と添えます。止めたレビューからは
  何も渡しません。
- レビューの途中でワーカーが止まり、開始のチェックポイントしかない呼び出しは、
  これまでどおり `uncertain-invocation` で止め、送り直しません。
- 検証が失敗する前に、レビューがそれ自体の理由で失敗したとき（返答を読めない、
  プロバイダーが拒否した）は、順に動かすときと同じく、実行を失敗にします。
  ツールの呼び出しを拒まれただけなら、返答が読める限り、レビューは失敗に
  しません（後述）。

レポートの「Review rounds」では、数えなかった回に、`cancelled` か `discarded` と
理由が付きます。検証がまだ終わっていない回と、検証がエラーで終わった回は
`pending`（理由は `verify-pending`）で、これも数えず、レビューの要点にも
使いません。「検証に落ちた候補へのレビュー」の呼び出しの数と費用は、
レポートの要約、`demo compare` の設定ごとの行、`demo compare --trend` の列に、
総費用とは別に出ます。この費用は総費用に含まれています。使用量や価格が
分からない呼び出しがあれば、0 ではなく不明と出します。止めたレビューは、
止めるまでにプロバイダーが報告した使用量（モデル別）とセッション ID を残します
（後述の「止めた呼び出しの使用量」）。この使用量は止めた時点までの下限なので、
それを含む合計は完全な値としては出さず、その実行の総費用も不明と出ます。
web UI では、レビューの欄と工程の時系列の詳細に、「中止」「不採用」「検証待ち」と
理由が出ます。工程の時系列では、検証とレビューの重なりが実際の時刻どおりに
見えます。

### 終える前にエージェントに確かめさせる（selfCheck）

`factory.json` の `"selfCheck"` に短いコマンドを書くと、実装と修正のプロンプトに、
「終える前に作業ツリーでこれらを実行し、出た問題を直す」という規則が 1 つ
加わります。未使用の export のように、手元ですぐ見つかる問題のために、修正の
1 回を使わないためです。

```json
{
  "check": ["pnpm", "validate"],
  "selfCheck": [
    ["pnpm", "lint"],
    ["pnpm", "typecheck"]
  ]
}
```

- 1 から 5 個のコマンドを書けます。各コマンドは `check` と同じく argv の配列で、
  空の配列と空の文字列は、`trigger` のときに受け付けません。
- プロンプトには、各コマンドを 1 行ずつ、バッククォートで囲んで載せます。あわせて、
  採点コマンドも同じ問題を見つけることと、実行の合否を決めるのは採点コマンド
  だけであることを伝えます。
- factory はこれらのコマンドを実行しません。工程も、やり直しも、反復の数え方も
  増えません。合否は、これまでどおり `check` だけで決めます。
- 書かなければ、プロンプトはこれまでと同じです。値は `trigger` のときに、実行の
  入力に保存します。`retrigger` は保存した値を引き継ぎ、`--reload-config` は
  ファイルを読み直します。`demo repair` の修正の実行は、修正元の実行の値を
  引き継ぎます。プロンプトが変わるので、書いたときは `configVersion` に入ります。

### 新しいテストをベースと候補で動かす（testProbe）

レビュアーはコマンドを実行できないので、新しいテストが変更を本当に確かめて
いるかは、コードを読んで推測するしかありません。`factory.json` に
`"testProbe"` を書くと、候補を封印したあと、検証とレビューの前に、候補が追加・
変更したテストファイルをベースと候補の両方で実行します。その結果は、両方の
レビュアーに信頼できる情報として渡します。

```json
{
  "testProbe": [
    {
      "glob": "test/**/*.test.ts",
      "command": ["pnpm", "vitest", "run", "{files}"]
    }
  ]
}
```

- `{ glob, command }` を 1 個以上書けます。`glob` は、リポジトリ直下からの相対
  パスに当てはめます。`command` は argv の配列で、`"{files}"` だけの要素を 1 つ以上
  含める必要があります。テストファイルごとに 1 回起動し、`"{files}"` の要素を、
  そのファイルのパス 1 つ（`./test/a.test.ts` のように `./` を付けたもの）に置き換え
  ます。`-` で始まる名前のファイルが、オプションとして読まれることはありません。
  シェルを通さないので、パスが展開されたり分割されたりすることもありません。
  `"--file={files}"` のようにほかの文字と混ぜた要素、`"{files}"` のないコマンド、
  空の配列と空の文字列、21 個以上の項目、200 文字を超える `glob` は、`trigger` の
  ときに受け付けません。
- 対象は、封印した候補の変更ファイルの一覧（`changed-files.txt`）で `added` か
  `modified` のファイルのうち、どれかの `glob` に合うものだけです。`deleted`、
  `renamed`、`copied` のファイルは実行しません。複数の `glob` に合うファイルは、
  最初に合った項目のコマンドで 1 回だけ実行します。合うファイルがない候補では
  コマンドを実行せず、「実行するテストが無かった」と結果に書きます。
- 準備の工程では、エージェントの作業ツリーと並べて、ベースのコミットを切り離した
  作業ツリー（`runs/<id>/base-work`）を作り、同じ `setup` を実行します。候補ごとに
  この作業ツリーをベースに戻し（前の候補のテストが書いた未追跡のファイルと、
  ファイルを 1 つも含まない未追跡のディレクトリも、ファイルのあるディレクトリの
  中のものまで消します。
  `setup` が終わった直後に残っていた未追跡のファイルは、
  `runs/<id>/test-probe/base.json` に中身の指紋（ファイルは sha256）と一緒に記録
  してあり、それは消しません。`setup` が作った、`.gitignore` に当たらない
  フィクスチャも、候補の側と同じようにベースに残ります。前のテストが記録した
  ファイルを書き換えたり消したりしていたら、ベースの作業ツリーを作り直して
  `setup` を実行し直し、記録も取り直します。作り直しに失敗したら、ベースの側は
  理由つきで「実行できなかった」になります）、対象のテストファイルだけを候補から
  持ってきて実行します。まとめて持ってこられなかったときは 1 つずつ持ってきて、
  持ってこられなかったファイルだけ、ベースの側を理由つきで「実行できなかった」に
  します。候補の側は、エージェントの作業ツリーで同じファイルを実行します。
  テストが追跡中のファイルを書き換えても、新しいファイルを書いても、レビューの前に
  封印した内容に戻し（`.gitignore` に当たる依存などは残します）、候補が封印どおり
  であることを確かめます。封印が gitlink としてコミットした入れ子のリポジトリ
  （`setup` が作ったものなど）の中で、テストがファイルを書き換えたりコミットしたり
  したときは、そのリポジトリを gitlink の指すコミットに `reset --hard` で戻します
  （1 階層だけで、その中の未追跡のファイルは残します）。次の封印に
  テストの出力が入ることはありません。テストの実行中にワーカーが止まったときは、
  再開した検証が候補の作業ツリーを封印した内容に戻してから、試し実行をやり直します。
- コマンドはどれも、`CI=true` を足した環境で実行します。Vitest や Jest は、
  スナップショットがないときに、書いて通すのではなく、落ちます。ベースに持って
  くるのは対象のテストファイルだけです。そのため、候補が一緒に追加したフィクスチャ
  やヘルパーで、どの `glob` にも合わないものを使うテストは、ベースではそれが
  ないために落ちます。結果の中でも、出力の末尾からそれを見分けるよう求めます。
- 実行ごとの時間の上限は `checkTimeoutMs` と同じで、出力は末尾だけを残します。
  標準出力の末尾のあとに標準エラー出力の末尾を並べ、片方が長くても、もう片方の
  末尾が押し出されないようにします。時間切れのときも、それまでの出力を残します。
  結果は `runs/<id>/test-probe/<候補ID>.txt` に書き、`step` の出力として保存します。
  32 KiB に収まるように出力の末尾を短くし、それでも収まらないときは、件数には
  含めたまま、後ろのファイルの詳細を省きます。
- 結果には、ファイルごとに、ベースと候補の終了コード、所要時間、出力の末尾と、
  「ベースで落ちて候補で通った」「両方で通った」「候補で落ちた」「実行できなかった」
  のどれかを書きます。factory は、この結果を判定に使いません。ベースで落ちても、
  新しいテストが読み込むモジュールがベースにないだけのことがあるので、結果の中で、
  出力の末尾から落ちた理由を読むよう求めます。結果を添えたレビューでは、
  規則も「添付の結果を根拠に判断し、結果が無いテストだけコードを読んで判断する」
  に変わります。
- 実行できなかった場合（ベースの作業ツリーを作れない、ベースの `setup` が失敗した、
  コマンドが起動しない、時間切れ）も、実行は止めません。理由を結果とレポートに
  残して、検証とレビューに進みます。ベースの準備に失敗したときも、候補の側は
  実行します。
- 結果は、候補ごとの `stage:<n>:verify:test-probe` の `step` に保存します。
  `parallelReview` でも、検証と 2 つのレビューを始める前に終わらせます。結果は
  検証のイベントで実行の状態に入り、順に動くレビューは、その状態から作った
  `target` で受け取ります。ワーカーが止まって再開しても、保存した結果を使い、
  同じ候補のテストを 2 度実行しません。保存する出力の末尾は、結果のテキストに
  載らなかったファイルの分も含めて、すべて残ります。
- ベースの作業ツリーは、実行が終わるとき（完了、失敗、取り消し、準備や事前確認での
  失敗）に、git の登録も含めて消します。仕様や承認を人が決めるのを待つあいだは、
  実行が終わっていないので残し、待ちのあとの試し実行はそのまま使います。消えて
  いれば作り直します。別のプロセスからの取り消しでもその場で消し、それと行き違って
  残ったものは、ワーカーの起動時に消します。git の登録は `git worktree remove -f -f`
  で、ディレクトリと一緒か、ディレクトリより先に消します（途中で止まった
  `git worktree add` が残した、ロック付きの登録も消します）。`base.json` は、
  `git worktree list` にベースが出なくなってから消します。片付けの途中でワーカーが
  止まったり git が失敗したりしても、起動時の片付けが `base.json` から登録の残りを
  見つけて消します。`demo archive` と `demo prune --apply` も、
  作業ツリーと一緒に消します。
- レポートの JSON（`testProbes`）と Markdown（「Test probe」の節）には、候補ごとに、
  対象のファイル数、ベースで落ちて候補で通った数（両方で落ちたファイルは数えません）、
  所要時間、実行できなかった理由が出ます。
  保存した `step` から読むので、レポートのためにテストを実行し直すことはありません。
- 書かなければ、ベースの作業ツリーも試し実行の `step` も作らず、工程はこれまでと
  同じです。値は `trigger` のときに、実行の入力に保存します。`retrigger` は保存した
  値を引き継ぎ、`--reload-config` はファイルを読み直します。`demo repair` の修正の
  実行は、修正元の実行の値を引き継ぎます。`configVersion` には入りません。
- 次の制約は、直さずに残しています（詳しくは ADR-0039 の「Known limits」）。
  - 同じ候補の中では、先に走ったテストが変えたものを、後のテストがそのまま見ます。
    ファイルごとに戻すと、git の処理がファイルの数だけ繰り返されるためです。出力の
    末尾で見分けられます。
  - 削除の途中でリースを失い、別のワーカーが引き継いだとき、古いワーカーの後片付けが、
    新しいワーカーの試し実行の出力や印を消すことがあります。リースを失い、しかも
    そのあいだに引き継がれたときだけ起きるので、削除ごとにリースで守る仕組みは
    入れていません。
  - `base.json` が指すリポジトリがなくなっても、マウントされていないボリュームと
    見分けられないので、起動時の片付けは毎回やり直します。
  - ベースを戻すときは、追跡外のファイルを 1 つずつ消し、記録したファイルの指紋も
    毎回取り直します。遅くなるのは `setup` が大量の追跡外のファイルを残すときだけで、
    `setup` のファイルを残すには、この作業が要ります。
  - 試し実行の全体には、時間の上限がありません（最大でファイル数×2×`checkTimeoutMs`）。
    上限を入れるには、その設定と、途中で止まった試し実行の扱いが要ります。今の
    ところ必要になっていません。
  - Durably の待ちと失敗を、エラーの文言 `Durably execution suspended` で見分けて
    います。判定の型や関数はライブラリの側でエクスポートするもので、この例の範囲外
    です。
  - 作業ツリーの外を指すかどうかの判定が重複していることと、`verify-review` の工程が
    reducer と同じ登録と `target` の作り直しをしていること（そのための `services` の
    `createTarget`）は、動作の変わらないリファクタリングなので、別に行います。
  - 古い git に対応するため、`git worktree list --porcelain` を `-z` なしで読むので、
    改行を含む作業ツリーのパスは扱えません。factory がそういうパスを作ることは
    ありません。
- 判断の理由は [ADR-0039](../../docs/adr/0039-local-agent-loop-test-probe.md)
  にあります。

### レビューの `blocker` を頻度と深刻さで決める（review.blockerThreshold）

`findings-json` のコードレビューでは、製品の動きについての指摘ごとに、実際に起きる
頻度（likelihood）と、起きたときの深刻さ（impact）を、1 から 10 の整数でレビュアーに
付けさせます。2 つの積が閾値より小さければ `non-blocker` にするよう伝えます。めったに
起きない指摘のために、修正とレビューのやり直しを繰り返さないためです（ADR-0040）。

```json
{
  "check": ["pnpm", "validate"],
  "review": { "blockerThreshold": 5 }
}
```

- `blockerThreshold` は 0 から 100 の整数で、書かなければ 5 です。負の数、101 以上、
  小数、数でない値は、`trigger` のときに受け付けません。0 にすると、レビューの
  プロンプトにはこの規則を入れません（この設定ができる前のレビューと同じです）。
  ただし、修正の回に伝える一文（この節の最後の項目）は、0 でも止まりません。
- 積が閾値以上の指摘は、これまでどおり、`blocker` か `non-blocker` かをレビュアーが
  決めます。テストが足りるか、タスクの範囲を外れた変更か、誘導（steering）、秘密の
  情報が混ざっていないか、のように製品の動きでない指摘には、積の規則を当てず、
  これまでどおりに判断させます。タスク、仕様、確定した文脈（`--context-file`）が
  はっきり求めていることを変更が満たしていない、という指摘にも当てません。求められた
  要件は、めったに起きない場合についてのものでも、頻度を理由に外しません。
- 分けるのはレビュアーです。factory は、返ってきた `severity` を採点値から書き換え
  ません。これまでどおり、`blocker` が 1 件でもあれば `needsChanges` にします。指摘が
  製品の動きについてのものかどうかは、JSON の値からは分からないからです。
- 規則はレビューの文脈の CHECK に入れます。そのため、通常のプロンプト、`command` の
  後ろに続く文脈、`local-instructions` の `CLAUDE.local.md` の、どれで渡しても届き
  ます。`verdict` のレビューと仕様のレビューには入れません。重さで振り分けたい
  レビューは、`output` を `findings-json` にします。
- 値は `trigger` のときに、実行の入力に保存します。`retrigger` は保存した値を引き継ぎ、
  `--reload-config` はファイルを読み直します。`demo repair` の修正の実行は、修正元の
  実行の値を引き継ぎます。この設定ができる前に保存した実行と、その修正の実行には、
  規則を入れません。閾値が変わるとレビューの基準が変わるので、0 も含めて
  `configVersion` に入れます。
- レポートには、固定した閾値を出します（JSON の `reviewBlockerThreshold`、Markdown の
  `review blocker threshold` の行）。JSON の `reviewBlockerRuleLenses` は、規則が
  届いたレビュアーです。`output` が `findings-json` で、レビューの記録があるか、
  レビューの呼び出しを送ったものを数えます。送ったあとに取り消したレビューは数え、
  送る前に取り消したものは数えません。送ったかどうかは、呼び出しを渡すときの記録で
  見ます。モデルが読む前に止まったかどうかは分かりません。Markdown の行には、規則が
  届いたレビュアーと、規則の対象外を書きます。どのレビューにも届いていない実行
  （コードレビューがすべて `verdict` の実行や、最初のレビューを送る前に止まった実行）
  では、そう書きます。
- 積が閾値より小さいのに `blocker` にする指摘には、理由として `thresholdException` を
  書かせます。値は `not-product`（製品の動きでない指摘）か、`explicit-requirement`
  （タスク、仕様、確定した文脈がはっきり求めている要件が満たされていない）です。
  ほかの値は欄だけを捨て、指摘はそのまま受け付けます。この値はレビュアーの自己申告で、
  factory は正しいかどうかを確かめません。
- レポートは、2 つの採点値を持ち、積が閾値より小さい `blocker` を、レビューの回と
  観点ごとに、例外ありと例外なしに分けて数えます（JSON の `belowThresholdBlockers`、
  Markdown の `blockers below threshold` の行）。検査の失敗で使わなかった回と、検査が
  まだ終わらず `pending` の回も含めます。`pending` の回は、走っている途中の実行の
  レポートにも、検査が終わる前に終わった実行のレポートにも出ます。閾値が 0 のとき、
  採点値がそろっていない指摘、`non-blocker` は数えません。数えるのは、レポートに残した
  指摘（レビューごとに先頭の 20 件）だけです。
- 同じ実行の中でレビューの指摘を受けて直す回にも、めったに起きない場合や将来の場合の
  ために設計しないよう伝えます。新しいセッションで直す回も、会話を続けて直す回も同じ
  です。閾値には関係なく、0 でも伝えます。検査だけが落ちて直す回と、最初の実装の回
  には伝えません。

### 設定の事前確認（preflight）

ベースの採点のあと、事前判定を含む最初のエージェントの呼び出しの前に、すべての
役割（実装、2 つのレビュー、設定した事前判定）のプロバイダー、モデル、推論量を
確かめます。同じ組み合わせは一度だけ確かめ、その結果を、組み合わせを使う役割の
すべてに対応付けます。

- Codex は、無料の `model/list`（固定した Codex CLI の app server）で、そのログインで
  使えるモデルと、そのモデルが受け付ける推論量を確かめます。一覧にあるモデルが
  その推論量を受け付けなければ、プロンプトを送らずに止めます。app server が起動
  しない場合（CLI が見つからない、`app-server` に対応していない古い版、初期化に
  失敗した）も、プロンプトを送らずに止めます。初期化が時間切れになっただけの
  場合は、起動が遅いだけかもしれないので、止めずに最小の呼び出しで確かめます。
  最小の呼び出しの初期化も時間切れになったときは、送ったかどうか分からない
  呼び出しとして、`uncertain-invocation`（`retry: NO`）で止まります。一覧は
  1 ページ目だけを読みます。一覧には隠しモデルが入らないので、一覧にない
  モデルを使えないとは決めず、一覧を読めないときと同じく、最小の呼び出しで確かめます。
  一覧は、同じ CLI のファイルにつき 1 回だけ読みます。
- Claude Code には、プロンプトを送らずに確かめる手段がありません。そのため、
  組み合わせごとに最小の呼び出し（「OK」とだけ返させる、読み取り専用の呼び出し）を
  1 回します。
- 最小の呼び出しは、通常の呼び出しと同じチェックポイントと計測を通ります。使用量と
  推定の費用は、工程も役割も `preflight` として分けて集計します（実装やレビューには
  混ぜません）。プロバイダーがはっきり拒否した場合（知らないモデル、使えないモデル、
  ログインが切れている、Codex CLI が起動しない、など）は、完了として記録し、
  `preflight-failed`（`retry: yes`）で止まります。Claude Code のログイン切れや
  モデルの誤りは、プロバイダーが種別を付けて返さず、本文から判定することもあります。
  その場合も拒否として扱います。送ったかどうか分からない呼び出しは送り直さず、
  `uncertain-invocation`（`retry: NO`）になります。
- 使えない組み合わせがあると、実装を呼び出す前に `preflight-failed` で止まり、
  役割、設定、確かめ方、原因をエラーに出します。レポートの `preflight`（JSON）と
  「Preflight」節には、役割ごとの結果、確かめ方、CLI のパスと版、最小の呼び出しの
  使用量と費用（分からなければ `unknown`）が残ります。

### Codex CLI を固定する（codexPath）

`factory.json` の `"codexPath"` で、起動する Codex CLI を指定できます。相対パスは
`factory.json` のあるディレクトリから解決します。実行できる通常のファイルでなければ、
`trigger` が失敗します。解決した絶対パスを実行の入力に固定し、事前確認、本番の
呼び出し、版の取得のどれにも、そのファイルを使います。`.js` などのスクリプトは
`node` で起動します。指定しなければ、PATH にある `codex` を優先して使い、なければ
同梱の `@openai/codex` を使います。同梱の版は、新しいモデルに追いついていない
ことがあるためです。CLI のパスと版は、レポートの「Versions」と「Preflight」に
出ます。`configVersion` にも入るので、違う CLI で動いた実行は、別の設定として比べます。

### `trigger` のときに固定されるもの

`factory.json`、タスク、仕様、dispositions、確定した文脈（context）は、`trigger` の
ときに一度だけ読みます。フラグを反映したあとの、役割ごとに指定した設定と、入力
ファイルのパスと本文を、実行の入力に保存します。実際に使うモデルと推論量は、
その指定した設定から、ワーカーがプロバイダーのプリセットで決めます。ワーカーは
元のファイルを読み直さないので、`trigger` のあとにファイルを書き換えても、その実行の
設定とプロンプトは変わりません。時間の上限、`codexPath`、`baselineCheck`、
`baselineReuse`、`parallelReview`、`selfCheck`、`testProbe`、`review.blockerThreshold`、`commit` も、
同じように解決した値を実行の入力に保存します。レポートには、入力ファイルごとの
パスと、保存した本文から計算した SHA-256 が出ます。確定した文脈は、本文もレポートに
出します。Markdown では、本文の中のどのバッククォートの並びよりも長いフェンスで
囲むので、本文の見出しがレポートの見出しと混ざりません。設定を直したあとに、同じ
タスクでやり直すには、`demo retrigger --run <id> --reload-config` を使います（上の
「止まった実行と次の手順を見る」を参照）。

### タスクの事前判定（shadow mode）

`factory.json` に `profiles.triage` を書くと、準備のあと、実装の前に一度だけ、
LLM にタスクを判定させます。書かなければ判定の呼び出しはなく、これまでと同じ
流れで動きます。

```json
{
  "profiles": {
    "triage": { "provider": "codex", "model": "gpt-5.6-sol", "effort": "low" }
  }
}
```

- 項目の補い方は、ほかの役割と同じです。`"triage": {}` でも有効になり、
  `--provider`、`--model`、`--effort` とプリセットの値を使います。fake と実際の
  プロバイダーを混ぜられない規則も同じです。
- 判定は、`routine`（そのまま実装とレビューで終わりそう）か `probe`（試しに実装
  してみるべき）のどちらかと、1〜2 文の理由です。新しいセッションで、読み取り専用の
  権限で動きます。渡すのは保存済みのタスクと仕様だけで、「信頼しないデータ」の
  区画に入れます。dispositions は渡しません。
- 今は、判定だけを記録するモード（**shadow mode**）です。判定は記録するだけで、
  工程やプロファイルを選ぶのには使いません。`routine` の実行も `probe` の実行も、
  同じ工程を同じプロファイルで進みます。判定で進め方を切り替えるのは、
  [ADR-0018](../../docs/adr/0018-local-agent-loop-adaptive-routing.md) の後の段階で、
  判定の精度を測ってから入れます。
- 形式に合わない応答（空、JUDGMENT がない、2 つある、`routine`/`probe` 以外、
  REASON がないか 500 文字を超える）と、プロバイダーのエラーや時間切れは、`unknown`
  として理由と一緒に記録し、実行は実装へ進みます。判定に失敗しても、実行は
  止まりません。時間の上限は最長 5 分です。事前判定の呼び出しの使用量が分からない
  ときは、その実行の合計のトークンと費用も不明として扱います（0 とは数えません）。
  ただし、再開したときに開始だけのチェックポイントが見つかった場合は、ほかの
  呼び出しと同じく、結果が確かでないものとして止まります。
- 判定と理由は、`report --format json` の `triage`、Markdown の「Triage」節、
  `status --run` の `triage` に出ます。承認待ちの途中でも読めます。判定の
  ない実行は `null`（Markdown では `none`）で、`unknown` とは区別します。
- `profiles.triage` があるかどうかと、その中身は `configVersion` に入ります。
  事前判定のない実行の `configVersion` は、以前と変わりません。

- 事前判定の完了の記録には、判定と理由と一緒に、保存済みのタスクと仕様から測った
  較正の材料を残します。タスクの文字数、仕様の文字数、仕様の受け入れ基準の項目数、
  仕様が挙げる変更予定のファイルの数の 4 つです。文字数は Unicode のコードポイントで
  数えます。項目数とファイル数は、次の 1 つの規則で数えます。
  - `#` 〜 `######` の見出しのうち、題が `Acceptance Criteria`、
    `Completion Criteria`、`受け入れ基準`、`完了条件`、`完了基準` のもの
    （受け入れ基準）と、`Files to Change`、`Files to Modify`、`Changed Files`、
    `変更するファイル`、`変更予定のファイル`、`変更対象のファイル` のもの
    （変更予定のファイル）を対象にします。題の大文字と小文字、末尾のコロンは
    区別しません。
  - 節は、次の同じ階層か上の階層の見出しまでで、その中の小見出しも含みます。
  - 数えるのは、行頭から始まる箇条書き（`-`、`*`、`+`、`1.`、`1)`。
    `[ ]` / `[x]` が付いたものも可）だけです。字下げした入れ子は上の項目の一部として
    扱い、数えません。フェンスで囲んだコードブロックの中は読みません。
  - 同じ記述は一度だけ数えます。受け入れ基準は、空白をまとめて小文字にした本文で
    比べます。変更予定のファイルは、項目の最初の `` `code` ``（なければ最初の語）の
    パスで比べます。
  - 仕様のない実行では、仕様から測る 3 つの値は「不明」（`null`）です。仕様に当てはまる
    見出しがない場合も、その値は「不明」にします。0 とは数えません。この値の
    ない古い事前判定の記録も、「不明」として読みます。
    較正の材料は、承認待ちの途中のレポート（事前判定の完了の `step`）と、終わった
    あとのレポート（実行の出力）に、同じ値で出ます。
- 事前判定の呼び出しをプロバイダーがはっきり拒否した場合は、`unknown` として
  進まずに、`rejected-invocation` で止まります。

### 修正だけのプロファイル（profiles.repair）

`factory.json` に `profiles.repair` を書くと、修正（検証の失敗やレビューの
指摘を受けた、2 回目以降の実装）だけを、別のプロバイダー、モデル、推論量で動かせます。

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

- 書かなければ、修正はこれまでどおり `code` の設定で動き、`--context reuse` では
  実装のセッションを続けます。`configVersion` も変わりません。
- 書かなかった項目は、フラグやプリセットからではなく、解決した `code` から補います。
  `"repair": { "effort": "high" }` なら、プロバイダーとモデルは `code` のままで、
  推論量だけが変わります。プロバイダーを `code` と違うものにした場合は、`code` の
  モデルと推論量は使わず、そのプロバイダーの既定のプリセットで補います。
- fake と実際のプロバイダーを混ぜられない規則と、事前確認の対象になることは、
  ほかの役割と同じです。事前確認は同じ設定を一度だけ確かめるので、`code` と同じ
  設定の `repair` は、追加で確かめません。
- `repair` のプロバイダー、モデル、推論量が `code` と同じなら、書かなかった場合と
  同じです。セッションを続け、`configVersion` も変わりません。
- 違う場合は、修正のたびに新しいセッションを始めます。プロンプトには、保存済みの
  タスク、仕様、実装の規則と、検証やレビューから作った修正の指示を渡し、前の実装が
  作業ディレクトリに残っていることを伝えます。`configVersion` はこの設定を含むので、
  `repair` のない実行とは別のグループとして比べます。
- ただし、Claude で推論量だけが違う場合は、実装のセッションを続けます（次の節）。
- `--context fresh` の修正は、`repair` があってもなくても、毎回新しいセッションです。
- 修正の呼び出しと使用量は、レポートの役割ごとの集計で、`code` ではなく `repair` の
  行に入ります。
- 修正の呼び出しをプロバイダーがはっきり拒否すると、`rejected-invocation` で止まります。
  `factory.json` の `repair` を直してから、`demo retrigger --run <id>
--reload-config` でやり直します。

### 推論量だけが違う修正では、実装のセッションを続ける（Claude）

Claude Code は、再開したセッションの推論量を変えても、プロンプトのキャッシュを
保ちます（[公式ドキュメント](https://code.claude.com/docs/en/prompt-caching#changing-effort-level)。
Claude Code 2.1.280 で測ったときも、新しいセッションのキャッシュの読み込みは 0、
推論量を変えて再開したセッションは、同じ推論量で再開したときと同じ 43,628
トークンでした）。そこで、次の条件をすべて満たすときは、`repair` が `code` と
違っていても、修正で実装のセッションを続けます。

- `--context reuse`
- プロバイダーが両方とも Claude で、実際に使う推論量だけが違う
- 事前確認（preflight）の最小の呼び出しで、Claude Code が報告したモデルが
  両方で同じ（下の「モデルの確かめ方」）
- そのモデルが Opus 5.5（`claude-opus-5-5`）か Fable 5.1（`claude-fable-5-1`）
- Claude Code CLI が 2.1.260 以降（`claudeCli` の版から読みます。読めなければ続けません）。
  2.1.260 は公式ドキュメントが挙げる版で、測ったのは 2.1.280 です。
  なお、`claude-opus-5-5` そのものを使うには 2.1.280 以上が要ります（「モデルの選び方とサブスクでの制約」の節）
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

- モデルの確かめ方：`opus` のような別名を実際のモデルに対応させるのは Claude Code
  自身で、このサンプルは別名の対応表を持ちません。factory から見た実際のモデルは、
  指定したとおり（`opus` なら `opus`）です。そこで、事前確認の最小の呼び出しで、
  Claude Code が `init` メッセージで報告したモデル（`opus` なら、2.1.280 では
  `claude-opus-5-5`）を読み、`code` と `repair` で比べます。
  - `opus` と `opus`、`opus` と `claude-opus-5-5` は、両方の報告が
    `claude-opus-5-5` なら続けます。
  - 報告がないモデル（報告を記録するようになる前の事前確認を含む）は、分からないもの
    として、新しいセッションにします。
  - `claude-` で始まる完全なモデル ID は、Claude Code がそのまま使います。どちらか
    片方でも対象外の完全な ID のとき（`opus` と `claude-sonnet-5` など）と、完全な
    ID どうしが違うときは、準備の時点で続けないと決めます。
- 判定は 2 段に分かれます。準備のときに、モデル以外の条件（`--context`、プロバイダー、
  推論量、CLI の版、環境変数、完全な ID の確認）を一度だけ判定し、実行の
  `setup.repairSession` に、候補になったかどうか（`eligible`）と理由を記録します。
  候補になっても、続けるかはまだ決まっていません。事前確認のあとで、報告された
  モデルを確かめて決め、`preflight:repair-session` の `step` に、準備のときの判定、
  決まった判定（`continues` と理由）、実行の `configVersion` を記録します。どちらも
  記録済みの `step` の出力だけから決まるので、あとでワーカーを別の環境変数で起動し
  直しても、その実行の扱いは変わりません。
- 決まった判定と理由は、JSON のレポートの `repairSession` と、Markdown のレポートの
  `repair session` の行に出ます。修正の呼び出しごとの扱いは、`repairCalls` の
  `sessionHandling` と `sessionReason` で確かめられます。
- 続ける修正では、記録したセッション ID を `resume` に、`repair` の実際の推論量を
  `effort` に渡して呼びます。プロンプトは、新しいセッション向けではなく、前の会話の
  続きとして書きます。修正が返したセッション ID は、次の修正のために記録します。
- 続けてよいかは、プロバイダー、事前確認で確かめたモデル、作業ディレクトリ、指示の
  版が一致するかで確かめます（推論量の一致は求めません）。そのため、実装と修正の
  セッションには、その呼び出しで Claude Code が報告したモデルを記録します。事前確認と
  実装のあいだに Claude Code が更新されて、別名の対応先が変わった場合などで、記録した
  モデルが決まったモデルと違えば、止まらずに新しいセッションにして、理由を
  `sessionReason` に残します。モデルを記録していない古いセッション（`null` を含む）も、
  推論量をまたいで続けず、新しいセッションにします。
- 事前確認で続けると決まった実行だけ、`configVersion` にこの方針が入ります。準備の
  ときは方針を含まない版を記録し、決まったときだけ、事前確認のあとの呼び出しと
  レポートが、方針を含む版になります。候補になったのに続けないと決まった実行
  （たとえば `sonnet` どうしで、Claude Code が `claude-sonnet-5` を報告した場合）を
  含め、それ以外の実行の `configVersion` は変わりません。事前確認の最小の呼び出しの
  計測には、決まる前の版が残ります。
- Codex、プロバイダーやモデルが違う修正、`--context fresh`、外部の指摘から始まる
  子の実行の最初の修正は、これまでどおり新しいセッションです。子の実行は、親の
  セッションを引き継ぎません。
- 環境の判定では、環境変数だけを見ます。設定ファイルやゲートウェイなど、環境変数
  以外の方法で Bedrock や Vertex を使っている場合は判定できず、続けてしまうことが
  あります。そのときはキャッシュが効かないだけで、結果は変わりません。レポートの、
  修正の呼び出しごとのキャッシュの読み込みの割合で確かめられます。
- 判断の理由は [ADR-0024](../../docs/adr/0024-local-agent-loop-claude-effort-session-reuse.md)
  にあります。

### レビュー役の呼び出しと出力（command、context、output）

`profiles.review.correctness` と `profiles.review.edge-cases` には、プロバイダー、
モデル、推論量のほかに、呼び出し方と返答の読み方を役割ごとに書けます。

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

- `command` は、factory のレビューのプロンプトの代わりに送る入力です。使える
  プレースホルダーは、`{effort}`（その役割の推論量）、`{base}`（実行が固定した
  ベースのコミット）、`{head}`（レビューする候補のコミット）の三つだけです。
  展開した文字列を一度だけ送り、送り直しはしません。空白だけの値、ほかの `{…}`、
  閉じていない `{` や対応しない `}`、推論量が決まらない役割での `{effort}` は、
  `trigger` のときに理由を付けて受け付けません。factory は特定のコマンド名を知りません。
- `context` は、レビューの文脈をどこに置くかです。レビューの文脈とは、確認事項、
  信頼できる文脈（trusted context）、ハッシュ付きの `TASK`／`SPEC`／`DISPOSITIONS`／
  `FINDINGS`、差分と変更ファイルの一覧とスナップショットの場所、返答の形です。
  `prompt`（既定）は入力に含めます。`command` があれば、その後ろに続けます。
  `local-instructions` は、factory がその呼び出しのために作る作業ディレクトリ（後述）の
  `CLAUDE.local.md` に置き、入力は `command` だけにします（`command` がなければ、
  「`CLAUDE.local.md` のレビューをする」という短い文です）。候補の作業ツリーには
  何も書きません。
  `prompt` でも、`command` があるとき（コマンドモード）は、作業ディレクトリに短い
  `CLAUDE.local.md` を置きます。入力が届くのは親のセッションだけで、作業ディレクトリ
  にはコードがないからです。このファイルには、候補の作業ツリー、差分、変更ファイルの
  一覧、ベースと head の tree の場所と、あれば工程の結果のコピー（信頼できる情報）と
  実装担当の NOTES のコピー（信頼しない情報）の場所を書きます。そのうえで、サブ
  エージェントも含めて、コードはそこから絶対パスで読むよう伝えます。
- `output` は返答の読み方です。`verdict`（既定）は、これまでどおりの `DECISION`／`NOTES` です。
  `findings-json` は、返答の最後の ` ```json ` ブロックにある配列を読みます。
  指摘の形は `{"severity": "blocker" | "non-blocker", "title": "...", "body": "...",
"file": "...", "line": 12, "likelihood": 2, "impact": 3}` で、`file`、`line`、
  `likelihood`、`impact` は省けます。書くときは、`file` は空でない文字列、`line` は
  1 以上の整数、`likelihood` と `impact` は 1 から 10 の整数でなければなりません
  （前の「レビューの `blocker` を頻度と深刻さで決める」を参照）。ファイル全体への
  指摘は `line` を省きます（`0` は形の違う指摘として扱います）。`null` は省いたものとは
  みなさず、形の違う指摘として止めます。レビュアーに示す返答の形にも、`likelihood` と
  `impact` を省ける欄として載せ、値のない欄は `null` を書かずに省くよう伝えます。
  返答の最終行は、改行 1 つ（`\n` または `\r\n`）を除いて、`REVIEW_STATUS: COMPLETE`
  とちょうど同じでなければなりません。末尾に空白やタブがあれば、完了の行とは
  認めません。`blocker` が 1 件でもあれば `needsChanges` です。`blocker` だけを
  `- [file:line] title — body` の形で 1 行ずつ notes にし、修正に渡します。notes の
  長さには上限があります。各行は 1,000 文字まで、並べるのは最初の 20 件まで（最大で
  およそ 20 × 1,000 文字）で、残りは件数だけを書きます。`title`、`body`、`file` の改行
  （LF、CR、垂直タブ、改ページ、U+0085、Unicode の行区切りと段落区切り）は、前後の
  空白ごと 1 つの空白にするので、1 件が複数行になることはありません。
  空の配列か、`non-blocker` だけなら `pass` です。完了の行がない、最終行にない、別の
  状態が書いてある、JSON がない、壊れている、指摘の形が違う、途中で切れている、の
  どれも `review-incomplete` で止まり、`pass` にはなりません。同じ呼び出しを自動で
  送り直すこともしません。
- レビューのツールの呼び出しをガードが拒んでも、それだけでは `review-incomplete` に
  しません。ガードが拒むのは、レビュー自身の作業ディレクトリ、候補の作業ツリー、
  差分と変更ファイルの一覧のディレクトリ、ベースと head の tree の外だけです。拒まれた
  読み取りで候補の中身が見えなくなることはありません。返答が読めれば、その判定を
  そのまま使います。返答が読めなければ、拒まれた呼び出しがあってもなくても
  `review-incomplete` で止まります。`command` のないレビューも、仕様のレビューも
  同じです。
  拒まれた呼び出しは、ツール名とガードが示した理由（`Glob` ならパターンと `path`
  引数）を、件数と先頭の 10 件、1 件 300 文字までで記録します。記録はレビューの `step` の
  出力と、呼び出しの試行の計測値（measurement）に残します。レポートでは、JSON の
  レビューの `permissionDenials` と、Markdown のレビューの行の下の 1 行に出します。
  拒まれた呼び出しがないレビューには出しません。
  指摘の本文にコードフェンスがあっても、JSON の配列として読める最初の閉じフェンス
  までを読むので、途中で切れません。
  読めた返答の指摘は、判定と notes とは別に、構造のあるデータとしてレビューの `step` の
  出力に保存し、レポートに出します（後述の **Review rounds**）。`blocker` と
  `non-blocker` は、それぞれ先頭の 20 件までを元の順に残すので、`blocker` が多くても
  `non-blocker` は消えません。各指摘の `title` と `file` は 200 文字、`body` は 600 文字
  までに切り、省いた項目は付けません。`review-incomplete` で止まった返答の指摘は
  保存しません。
- `findings-json` は、どのプロバイダーでも使えます。`command` と `local-instructions` は、
  Claude と fake のレビューだけが使えます。Codex のレビューに書くと、`trigger` の
  ときに役割名と項目を示して受け付けません。CLI を通さずにジョブを直接 `trigger`
  した場合も、入力の検査で受け付けず、実行は作られません。fake で使えるのはテストの
  ためで、fake の判定は実際の LLM の判定としては数えません。
- 三つとも書かない役割は、これまでどおりのプロンプトと verdict で動きます。どれか
  一つでも書いた役割だけ、三つの確定した値が `configVersion` に入ります。どの役割も
  書かなければ、`configVersion` は変わりません。`demo repair` の子の実行は、
  `--max-iterations` を除いて、親の設定をそのまま使います。

`command` か `local-instructions` を使う役割がある実行では、候補をレビューする
直前に、次のものを `runs/<runId>/review-snapshots/` に作ります。どれも作業ツリーの
外にあり、候補の差分、反復ごとのコミット、1 コミットにまとめたブランチには入りません。

- `base/`：ベースのコミットの tree。実行の中で一度だけ書き出し、使い回します。
- `<candidate>/head/`：候補のコミットの tree。
- `<candidate>/<役割>/cwd/`：その役割のレビューの作業ディレクトリ。ベースのコミットの
  `CLAUDE.md` と `.claude/`（あれば）と、factory が書く `CLAUDE.local.md`
  （`local-instructions` ならレビューの指示全体、`prompt` なら候補の場所）を
  置きます。リンクは、たどった先がベースの tree の中にあるときだけ、中身をコピー
  します。tree の外（ホストのファイルやディレクトリ）を指すリンク、どこも指さない
  リンク、コピーしているディレクトリに戻るリンクはコピーしません。役割ごとに別の
  ディレクトリなので、二つのレビューが互いの指示を読むことはなく、これまでどおり
  並行して呼びます。

tree は、コミットを一時的な index に読み込み、`git checkout-index` で書き出します。
`git archive` と違って、`.gitattributes` の `export-ignore` や `export-subst` で
中身が変わることはありません（チェックアウトの filter や改行の変換は、作業ツリーと
同じように働きます）。アーカイブファイルは作りません。書き出す git のプロセスは、
ほかの子プロセスと同じく登録するので、取り消し、リースを失ったとき、ワーカーの停止で
止まります。やり直したレビューは、中断した書き出しが残した途中の tree、一時的な
index、そのロックファイルを消してから、足りない tree を書き出し直し、作業
ディレクトリを作り直します。

消すのはワーカーです。候補の tree と作業ディレクトリは、そのレビューの回が終われば
消します（失敗や中断でも、記録済みの結果を読むだけのやり直しでも消します）。
もうレビューが来ない工程（承認、完了、停止）の前には、ベースの tree も消します。
そのため、レビューの記録の直後にワーカーが止まっても、承認待ちのあいだに残りません。
実行が失敗する、取り消される、終わる、準備をやり直す、のどの場合も全体を消します。
失敗と取り消しでは、ジョブの中で消し終えてから、実行の状態を記録します。別の
プロセスから `demo cancel` したときは、ワーカーにはリースを失ったようにしか見えず、
ほかのワーカーが実行を取り出し直す場合に備えて、ワーカーは消しません。代わりに取り消した
側が消しますが、そのときワーカーが書き出していた tree は残ることがあります。
ワーカーは起動したときに、終わった実行（完了、失敗、取り消し）の `review-snapshots/`
をすべて消すので、そうした残りも次の起動で消えます。このとき見るのはワーカー自身の
状態のルートにある実行だけで、データベースを調べるのは `review-snapshots/` が
残っている実行だけです。

`command` か `local-instructions` を使う Claude のレビューは、次の設定で動きます。
通常の Claude の呼び出しの設定は変わりません。

- `cwd` は上の作業ディレクトリです。`settingSources` は `project` と `local` なので、
  読み込む設定は、ベースのコミットの `CLAUDE.md` と `.claude/`（settings、コマンド、
  スキル、エージェントの定義）と、factory の `CLAUDE.local.md` だけです。候補の
  `CLAUDE.md` や `.claude/` は、実装役が書き換えられるので読み込みません。ベースは
  すでにマージされたコードなので信頼します。`CLAUDE.md` が `@` で取り込む別のファイルは、
  作業ディレクトリにないので読まれません。Claude Code はカレントディレクトリより上の
  ディレクトリの `CLAUDE.md` も読みますが、そこに候補のファイルはありません。
- 候補は、データとしてだけ読みます。作業ツリー、差分と変更ファイルの一覧のある
  ディレクトリ、二つの tree は `additionalDirectories` にしません。Claude Code は、
  追加したディレクトリの `.claude/` にあるスキル、コマンド、エージェントの定義を
  読み込むからです。これらは、許可したツールと下の検査を通して読みます。
- 使えるツールは `Read`、`Grep`、`Glob`、`Agent` だけで、`permissionMode` は `dontAsk`
  です。
- 読み込んだ設定のうち、プログラムを動かすものは止めます。`--settings` と同じ層
  （project と local より優先）で `disableAllHooks` と `disableSkillShellExecution` を
  指定し、settings やプラグインのフックとステータスライン、コマンドやスキルに
  埋め込んだシェル（`!` の行）を動かしません。`strictMcpConfig` と空の `mcpServers` で、
  `.mcp.json` や settings の MCP サーバーも起動しません。`!` の出力に頼るコマンドは、
  出力の代わりにプレースホルダーを受け取ります。factory の検査は SDK に渡す
  コールバックなので、これらの影響を受けません。ベースの settings にある `env` や
  認証用の helper は、ベースを信頼するので止めていません。
- 読めるのは、作業ディレクトリ、作業ツリー、差分と変更ファイルの一覧のある
  ディレクトリ、二つの tree だけです。`canUseTool` と `PreToolUse` フックが、サブ
  エージェントの呼び出しも含めて、Bash、書き込み、ほかの場所の読み取りを拒みます。
  パスはシンボリックリンクを解決してから比べるので、候補や tree の中から外を指す
  リンクは通りません。`~` で始まるパスも拒みます。`Grep` と `Glob` がディレクトリを
  たどる途中のリンクについては、ツールがリンクをたどらないこと（ripgrep の既定）に
  頼っています。
- `Agent` は、`isolation`（`worktree` や `remote`）を指定した呼び出しを拒みます。
  `mode` が `acceptEdits`、`auto`、`bypassPermissions` の呼び出しも拒みます。
  これは念のための守りで、境界そのものではありません。サブエージェントは、親の
  権限のモードを引き継ぐか、エージェントの定義の `permissionMode` に従います。その
  定義は、ベースの `.claude/` からしか読みません。チームのメンバーを起動するツールも
  なく、サブエージェントの呼び出しも上の検査を通ります。
- セッションは保存しません（`persistSession: false`）。レビューは再開せず、呼び出し
  ごとに作業ディレクトリが違うので、保存すると `~/.claude/projects/` に、呼び出しの
  数だけ項目が増えるからです。
- 使用量は、最終結果の `modelUsage` から、サブエージェントの分も含めて 1 回分として
  数えます。親の使用量に重ねて足すことはしません。モデルが報告しない項目は、不明の
  ままです。費用は、モデルごとにそのモデルの単価で計算して合計し、単価の分からない
  モデルが一つでもあれば不明にします。親のモデルの単価で代わりに計算することは
  しません。
- これは、このモードのレビューだけです。ほかの Claude の呼び出し（既定のレビューを
  含む）の使用量は、これまでどおり親のループの値です。

`command` も `local-instructions` も使わず、`output: findings-json` だけを書いた
Claude のレビューは、使えるツールを `Read` だけにして呼びます。ガードが拒むツールは、
はじめから見せません。

### 仕様を先に作ってレビューする（spec）

`factory.json` に `spec` を書くと、`--spec-file` を渡さなかったリポジトリの実行は、
実装の前に仕様を作ってレビューします。`--spec-file` を渡した実行と、`spec` のない
実行は、これまでどおりの工程で動き、`configVersion` も変わりません。ただし、
`--spec-file` を渡した実行でも、`spec.checkFromSpec` があれば、ベースの採点の前に
`spec-check` を動かし、それが選んだチェックで採点して、`checkFromSpec` を
`configVersion` に入れます（後述の `checkFromSpec` を参照）。

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
2. 事前確認（preflight）。実装とレビューの役割に加えて、仕様の作成、修正、
   すべてのレビュー役を確かめます。使えない役割があれば、仕様を書き始める前に止まります。
3. 仕様の作成。`author` がリポジトリを読み、仕様を書きます。
4. 仕様レビュー。`review` に名前を付けて並べたレビュー役が、同じ仕様を並行して
   レビューします。1 人ずつ別の `step` として記録するので、再開したときは、終わった
   レビューの記録を読み戻します。
5. 仕様の修正。`blocker` があれば `fix` が仕様を直し、4 に戻ります。`blocker` が
   なくなった時点の仕様を確定します。`non-blocker` は直す条件にしません。
6. `checkFromSpec` があれば、確定した仕様から採点コマンドを決めます。
7. そのあと、事前の検証（`baselineCheck` のとき）、事前判定、実装と続きます。

- 仕様のファイルは `runs/<runId>/spec/spec.md` にあり、作業ツリーの外です。
  `author` と `fix` はリポジトリを読めますが、書けるのはこのファイルだけです。
  Claude は `Read`、`Grep`、`Glob`、`Edit`、`Write` だけを持ち、`Edit` と `Write` は
  このファイルに限ります。Codex は、このファイルのディレクトリを作業ディレクトリにして
  workspace-write で動かすので、作業ツリーには書けません。ただし、同じディレクトリに
  ほかのファイルは作れます。そのため、`author` と `fix` の呼び出しが終わるたびに
  （成功しても失敗しても）`spec.md` 以外を消し、成功したときは、消したものを
  その `step` の出力（`removed` と `warning`）に残します。この片付けで実行は止めません。
  そのうえで、`spec.md` 自体が通常のファイルでなければ（シンボリックリンクなど）、
  それを消して `step` を失敗させます。レビュー役は読むだけです。
- `fix` を書かなければ、`author` の設定で直します。`fix` で省いた項目は、`author` から
  補います。`maxRounds` の既定は 3 で、正の整数に限ります。0、負の数、小数、
  `Number.MAX_SAFE_INTEGER` を超える値は、`trigger` のときに受け付けません。
- `template`（仕様の雛形）と `reviewTemplate`（レビューの指示）は、`factory.json`
  のあるディレクトリからの相対パスで、`trigger` のときに一度だけ読みます。中身は
  実行の入力に保存し、`configVersion` に入れます。あとでファイルを直しても、
  始まった実行は変わりません。
- レビュー役の `command`、`context`、`output` は、候補のレビュー役と同じ規則で
  読みます（前の節）。違うのは、候補がまだないので `{head}` を使えないことです。
  使えるのは `{effort}` と `{base}` だけです。仕様のファイルの場所は、
  `local-instructions` なら `CLAUDE.local.md` に、`prompt` なら入力に書きます。
  壊れた `findings-json` は通過にせず、実行を止めます。
- 仕様を直す `fix` には、`blocker` の指摘、前の回で直した指摘、人のメモを、
  「信頼しないデータ」の区画に入れて渡します。
- 確定した仕様は、実装とレビューに `SPEC` として渡します。最後の回の `non-blocker`
  （人が承認したときは、残った `blocker` も）は、助言の `SPEC_ADVICE` として、実装に
  だけ「信頼しないデータ」の区画に入れて渡します。

#### 上限の回まで直らなかったとき

`maxRounds` 回レビューしても `blocker` が残ると、`spec-wait:<n>` という Durably の
`wait` で人の判断を待ちます。`status` と `wait` は、候補の承認待ちとは別の
「仕様の判断待ち」として表示し、次のコマンドを示します。

```bash
pnpm --filter example-local-agent-loop demo approve --run <id> --wait <waitId>
pnpm --filter example-local-agent-loop demo spec-revise --run <id> --notes-file notes.md
pnpm --filter example-local-agent-loop demo reject --run <id> --wait <waitId>
```

- `approve` は、いまの仕様を確定して実装に進みます。
- `spec-revise` は、メモのファイルを読み、その中身を `signal` に入れます。仕様の
  修正とレビューを 1 回ずつ足し、まだ `blocker` が残れば、もう一度判断を待ちます。メモの
  ファイルは、入力ファイルと同じく 256 KiB までの UTF-8 で、空のものは受け付けません。
- `reject` は、実装を始めずに実行を終えます。結論は `rejected` です。
- `signal` には、実行 ID、待っている仕様の SHA-256、判断が入ります。別の実行や、
  別の版の仕様に向けた判断は受け付けません。再開したワーカーは、記録した判断とメモを
  そのまま使います。

#### 仕様から採点コマンドを決める（checkFromSpec）

`checkFromSpec` は argv です。実行が固定した仕様（`spec` の工程で確定した仕様か、
`--spec-file`）の絶対パスを最後の引数に足し、作業ツリーで、`checkTimeoutMs` 以内に
一度だけ実行します。成功したときの標準出力は、次の形の JSON に限ります。

```json
{
  "check": ["pnpm", "vitest", "run", "src/calc.test.ts"],
  "notes": "calcだけで足りる"
}
```

- `check` は空でない文字列の配列です。`factory.json` の `check` と `--check` の
  代わりに、事前の検証、その結果の識別（baselineReuse）、すべての検証で使います。
  `checkFromSpec` があるときは、`check` を省けます。
- `notes` は任意です。実装と候補のレビューに、`CHECK_NOTES` として「信頼しないデータ」
  の区画に入れて渡し、レポートに残します。
- 失敗、時間切れ、JSON でない出力、形の違う `check` は `spec-check-failed` で止まり、
  事前の検証も実装も始めません。スクリプトを直したら、`retrigger --reload-config`
  で新しい実行を始めます。同じ実行を再開して、スクリプトの結果を読み替えることは
  しません。
- `checkFromSpec` があるのに仕様がない（`spec` の工程も `--spec-file` もない）実行は、
  `trigger` のときに受け付けません。

#### レポートと web UI

- レポートの `specRounds[]` は `reviewRounds[]` と同じ形で、回ごとに、レビュー役ごとの
  結果を持ちます（`lens` はレビュー役の名前です）。終わった `step` から読むので、
  途中の実行でも出ます。
- `spec` には、確定した仕様、確定した回、残った指摘を人が承認して進めたか
  （`blocked`）、助言、`checkFromSpec` が決めた採点コマンドと notes が入ります。
  確定する前は、最後に書かれた仕様を `content` と `sha256` に入れ、`round` は
  `null` のままです。仕様の判断を待つあいだも、判断する仕様をここで読めます。
  `--spec-file` の実行には `spec:final` がないので、`spec-check` がまだ終わって
  いなくても（失敗していても）、実行の入力の仕様を `source: "input"` として入れます。
- 使用量は `spec-author`、`spec-fix`、`spec-review:<名前>` の役割に分けて数え、
  工程の時間は `spec`、`spec-review`、`spec-check` として出します。`compare` にも
  同じ工程が並びます。3 つを合わせた経過時間は `specWallMs` です。各試行（attempt）の
  区間を重ねて数えるので、並んだ仕様レビューは一度だけ入り、区間のあいだ（仕様の
  判断を人が待った時間など）は入りません。
- web UI は、`spec` の工程がある実行にだけ「仕様」「仕様レビュー」を工程として出し、
  仕様の判断待ちを、候補の承認待ちとは別の状態で見せます。

### 外部の指摘から修正する（repair）

承認して納品まで終わったリポジトリの実行に、あとから UI の確認、正式なレビュー、CI
など、factory の外で指摘が見つかることがあります。そのときは `demo repair` で、その
実行の候補を直す子の実行を始めます。終わった実行を再開するのではなく、候補の
コミットを引き継ぐ新しい実行として記録するので、修正の時間、費用、回数も factory で
測れます。

次の実行も、同じ `demo repair` で最後の候補から続けられます。修正の回数を使い切っても
チェックが通らずに止まった実行（`verification-failed`）、チェックは通ったのに
レビューが修正を求めたまま止まった実行（`review-cap-reached`）、最後の候補がチェックを
通ったあとにレビューが終わらずに失敗した実行（`review-incomplete`）です。`retrigger`
と違って、実装を最初からやり直さず、修正の回数を新しくして最後の候補を直します。

```bash
pnpm --filter example-local-agent-loop demo repair --run <親の runId> \
  [--findings-file findings.md] [--dispositions-file dispositions.md] \
  [--context-file decisions.md] [--max-iterations 4]
```

- 親にできるのは、リポジトリの実行のうち、次の 4 種類です。
  - `completed` で、結論が `approved` で、納品が記録されていて、最後の候補と納品の
    コミットが一致する実行。
  - `completed` で、結論が `verification-failed` で、最後の候補のコミットとブランチが
    記録されている実行。納品は要りません。
  - `completed` で、結論が `review-cap-reached` で、最後の候補のコミットとブランチが
    記録されている実行。納品は要りません。
  - `failed` で、実行のエラーか、失敗したレビューの `step` のエラーが
    `review-incomplete` で始まり、最後に封印した候補の `step` にコミットとブランチが
    あり、その候補のあとの検証の `step` が完了して通った実行。失敗した実行には出力が
    ないので、候補と検証の結果は、その実行が残した `step` から読みます。

  却下した実行、取り消した実行、承認待ちの実行と、ほかの理由で失敗した実行は、候補が
  残っていても親にできません。最後の候補を封印していない、その候補の検証がないか
  落ちた、という失敗した実行も親にできません。
  子の実行が同じ条件を満たせば、さらにその子を作れます。

- 始める前に、親の候補のコミットが対象のリポジトリにあり、記録された候補のブランチの
  先端がそのコミットのままであることを確かめます。ブランチが動いていれば、何も
  作りません。子の実行の準備でも、作業ツリーとブランチを候補のコミットから作る直前
  （CLI の確認のあと、`setupCommand` の前）に、同じことを確かめます。途中で止まった
  準備をやり直すときは、前回の作業ツリーとブランチを片付けてから確かめます。
  `demo repair` が確かめたあとでブランチが動いた場合や、子の実行を `demo retrigger`
  した場合も、ここで `candidate-moved`（`retry: yes`）として止まります。作業ツリー、
  ブランチ、実行のディレクトリは残さず、エージェントは呼びません。ブランチを候補の
  コミットに戻せば、`retrigger` で続けられます。
- `demo repair` が受け付けるのは、`--run`、`--findings-file`、`--dispositions-file`、
  `--context-file`、`--max-iterations` だけです。`--publish`、`--check`、`--config`
  など、ほかのフラグは黙って無視せず、エラーにします。
- 子の実行は、親が保存したタスク、仕様、イシュー、プロファイル（事前判定も含む、
  解決済みの値）、チェック、`selfCheck`、`testProbe`、準備、時間の上限、`codexPath`、
  コミットと公開の設定、`--max-iterations` を引き継ぎます。`--max-iterations`（1 から
  5 の整数）を渡したときだけ、子の実行の修正の回数をその値にします。値は子の実行の
  入力に保存し、`configVersion` にも入れます。親の準備が記録した値は、`null` でも
  そのまま使います。準備に項目がない古い親だけ、保存済みの入力から補います。子の子も
  同じです。いまの `factory.json` と環境変数は読みません。`--reload-config` は
  受け付けません。設定を変えたいときは、通常の `trigger` から始めます。
- 親が `approved` なら、指摘のファイルは必須です。親が `verification-failed`、
  `review-cap-reached`、`review-incomplete` なら任意で、渡せばそのファイルを使います。
  渡さなければ、親が保存した記録から指摘を作ります。
  - `verification-failed` の親では、最後の候補で失敗したチェックの出力の末尾
    （標準出力と標準エラー出力）、終了コード、親が使った採点コマンドを指摘にします。
    ログファイルは読まず、前の候補の結果で代わりにすることもしません。最後の候補の
    失敗の結果が保存されていなければ、指摘のファイルを求めて止まります。親の実行の
    中で検証に落ちた候補へのレビューは、子の実行には渡しません。渡したいときは、
    指摘のファイルに書いて渡します。
  - `review-cap-reached` の親では、実行の出力に保存した各レビューの最後の判定の
    うち、`needsChanges` のものを、レビューの種類ごとの見出しとメモにまとめます。
    `pass` のレビューのメモは入れません。`findings-json` で答えるレビューのメモは、
    保存済みの直すべき指摘の行です。途中の回の工程やログは読みません。
    `needsChanges` のレビューがないか、メモが空白だけなら、指摘のファイルを求めて
    止まります。
  - `review-incomplete` の親では、最後の候補の回のレビューの `step` のうち、完了して
    `needsChanges` を返したものを、同じようにレビューの種類ごとの見出しとメモに
    まとめます。前の候補のレビューと、終わらなかったレビュー、取り消したレビュー、
    失敗したレビューは入れません。当てはまるレビューがないか、メモが空白だけなら、
    指摘のファイルを求めて止まります。
- 指摘の扱い（処分）のファイルは任意です。指定すると親の指摘の扱いを置き換え、
  省略すると親の指摘の扱いを引き継ぎます。指摘のファイルも指摘の扱いのファイルも、
  `--task-file` と同じ検査（256 KiB まで、UTF-8、空白だけは不可）を通し、内容と
  読み込んだパスを子の実行に保存します。
  指摘は、修正担当と両方のレビュアーに、タスクや仕様と同じ「信頼しない入力」として
  渡します。記録から作った指摘も同じです。
  指摘の扱いは、これまでどおり両方のレビュアーにだけ渡します。親が `approved` なら、
  承認済みの候補に対する修正だけの差分を見て、指摘に応えているか、承認済みの候補を
  壊していないかを判断するよう、レビュアーに伝えます。親が `verification-failed`
  なら、もとにした候補はチェックが通らず承認されていないことを、修正担当と
  レビュアーに伝えます。親が `review-cap-reached` なら、チェックは通ったものの、
  レビューの上限のあとも指摘が残り、承認されていないことを伝えます。親が
  `review-incomplete` なら、チェックは通ったもののレビューが終わらず、候補全体を
  まだ誰もレビューしていないことを伝えます。どの場合も、もとにした候補と修正を
  合わせた候補全体を、タスクと仕様に照らして判断するよう、レビュアーに伝えます。
  レビュアーに渡す変更ファイルの一覧は修正の分だけなので、もとにした候補の変更は、
  CANDIDATE FILES の節が示す候補の tree を読んで確かめるよう伝えます。節が tree を
  示していなければ、作業ディレクトリを読みます。
- 子の実行のもとにするのは、親の最後の候補のコミットです。親のもとのベースや、
  始めたときの `HEAD` は使いません。修正を重ねるブランチは、イシューの有無に
  かかわらず `factory/<子の runId>`、1 コミットにまとめたブランチは
  `factory/<子の runId>-squashed` です。差分、パッチ、まとめたコミットの親は、
  どれも親の候補のコミットです。
- 子の実行でも、準備、事前確認と、設定していればベースの採点（baselineCheck）を
  実行します。`baselineReuse` も親の設定を引き継ぎます。ただし、親が
  `verification-failed` の子の実行では、ベースの採点を実行しません。もとにするのは
  親のチェックが失敗した候補なので、必ず `baseline-check-failed` で止まり、その
  失敗はすでに指摘として渡しているからです。設定は記録して孫の実行へ引き継ぎ、
  レポートの「Baseline check」の節は `none` になります。親が `review-cap-reached`
  か `review-incomplete` の子の実行では、もとにするのがチェックを通った候補なので、
  ベースの採点を通常どおり実行します。事前判定と最初の実装は行いません（事前判定の
  プロファイルは記録するだけで、呼び出しも、事前確認も、CLI の確認もしません）。
  最初の code の工程を `repair` の 1 回目として、新しいセッションで始めます。
  `profiles.repair` があれば、それを使います。そのあとは通常どおり、検証、両方の
  レビュー、承認、納品に進みます。
- 子の実行の `--max-iterations` は、引き継いだ値でも指定した値でも、子の実行自身の
  修正の回数だけを数え、親が使った回数は差し引きません。最初の修正も、修正の回数と
  使用量に入ります。
- `--context-file` を渡すと、子の実行の確定した文脈は、親のものと置き換わります。
  渡さなければ、親が保存した文脈と読み込み元を引き継ぎます。上限は `trigger` と同じ
  32 KiB です。
- 同じ親、同じ指摘の内容、同じ指摘の扱いの内容、同じ修正の回数、同じ文脈の内容で
  始めると、パスが違っても同じ子の実行を返し、実行もブランチも増やしません。記録から
  作った指摘は親の記録だけで決まるので、繰り返しても同じ子の実行です。指摘、指摘の
  扱い、文脈の内容か、修正の回数が変われば、別の子の実行です。親と同じ修正の回数を
  指定したときは、省略したときと同じ子の実行です。文脈のない子の実行は、文脈を
  渡せるようになる前と同じ子の実行です。
- `--publish` の下書きの PR は、通常の実行と同じく、既定のブランチに向けて作ります。
  親がまだマージされていなければ、PR には親の変更も含まれます。
- 子の実行には、どの経路（`demo repair`、`demo retrigger`、`demo seed`）で始めても、
  実行のラベル `repairOf=<親の runId>` を付けます。1 件の `report`、`status --run`、
  CLI の `compare`、web UI の詳細は、このラベルで子を 1 回問い合わせます。SQLite は
  この問い合わせで、ジョブの実行を順に見てラベルを引くので、問い合わせの手間は
  履歴の長さに比例します。web UI の一覧と比較は、読み込んだすべての実行のラベル
  （なければ入力の `repairOf`）から、親ごとの子を一度にまとめ、実行ごとには問い合わせ
  ません。
- `report` と `status --run` には、親の ID と子の ID の一覧が出ます。レポートには、
  指摘のファイルのパスと、保存した内容の SHA-256 も出ます。記録から作った指摘は、
  パスの代わりに、作った元の親の実行を示します（JSON では `parentRun`）。web UI では、
  一覧と詳細で、親と子をタスクの名前でリンクします。`compare` は、通常の実行と子の
  実行を別のグループに分け、親の時間、費用、工程を子の値に足しません。子の実行
  どうしは `configVersion` ごとにまとめます。
- 判断の理由は、[ADR-0022](../../docs/adr/0022-local-agent-loop-external-repair-runs.md)
  と、`verification-failed`、`review-cap-reached`、`review-incomplete` の親を加えた
  [ADR-0030](../../docs/adr/0030-local-agent-loop-verification-failed-repair.md)
  にあります。
- `verification-failed` か `review-cap-reached` で止まったリポジトリの実行では、次に
  できる操作として、`retrigger` と並べて `demo repair --run <id>` を出します。
  `review-incomplete` で失敗したリポジトリの実行では、最後の候補が記録されていて、
  その検証が通っているときだけ、次にできる操作に `demo repair --run <id>` を出します。

### durably のチェックアウトを固定して呼ぶ

コードを対象のリポジトリへコピーせず、durably のチェックアウトを特定のコミットに
固定して、そのまま呼ぶこともできます。

```bash
git -C ~/src/durably fetch
git -C ~/src/durably checkout <commit>
pnpm -C ~/src/durably install --frozen-lockfile
pnpm -C ~/src/durably --filter example-local-agent-loop demo worker     # Terminal 1
pnpm -C ~/src/durably --filter example-local-agent-loop demo trigger \
  --repo "$PWD" --task-file "$PWD/task.md"                                # Terminal 2
```

Terminal 1 のワーカーは省略できます。ただしそのときは、`trigger` が自動で起動する
ワーカーが、コマンドを実行したチェックアウトの CLI で動きます（「workerの自動起動と
アイドル終了」の節）。固定したチェックアウトのワーカーで処理させるには、先にそこで
ワーカーを起動しておきます。

対象のリポジトリに置くのは、`factory.json` と作業内容のファイルだけです。固定する
コミットは利用する側で記録し、上げるときは、意図してチェックアウトし直します。
コピーする方式との比較は [docs/porting.md](docs/porting.md) にあります。

### DB と作業物の置き場所

DB（データベース）と、すべての実行のデータは、`~/.local/state/local-agent-loop/`
に置きます。

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

- **検証のログ**: 採点コマンドの出力は、検証の実際の試行（step attempt）ごとに、
  `verification-logs/` へ切り詰めずに保存します。レポートの抜粋や、修正の
  プロンプトに渡す出力は、これまでどおり末尾だけですが、ログファイルには途中の
  失敗した箇所も残ります。時間の上限で打ち切った試行は、終了コードを `null` にし、
  打ち切るまでの出力を残します。完了のチェックポイントから復旧した試行は、採点を
  やり直さず、元の試行のログと終了コードを指します。開始のチェックポイントだけが
  残った試行は、採点し直し、新しい試行のログを別のディレクトリに書きます。止まった
  試行のログも消しません。
  取り消しやリースを失ったことで中断した試行も、終了コードを `null` にして途中までの
  ログを記録し、`interrupted: true` を付けます。この試行は判定を出していないので、
  検証の結果には数えません。子プロセスを起動する前に中断した試行は、ログを記録
  しません。ログファイルへの書き込みに失敗しても、検証の結果は変えず、エラーを
  `writeError` に残します。そのログファイルは、中身が欠けているかもしれません。
- **エージェントの出力**: LLM を呼ぶ試行は、送る前に `agent-logs/<attempt>.log` を
  作り、そのパスを試行の `agentLog.path` に記録してから呼び出します。ファイルには、
  アシスタントの本文を届いた順に追記します。ツールの呼び出しは、名前と短い引数
  （コマンド、検索語、パスを優先）で `> exec pnpm test` のように 1 行ずつ、
  コマンドの終了コードは `< exec exit 1` のように 1 行ずつ追記します。プロンプト、
  思考や推論のブロック、使用量は書きません。完了のチェックポイントから復旧した
  試行と、送る前に取りやめた試行は、ファイルを作りません。追記に失敗しても呼び出しの
  結果は変えず、エラーを `agentLog.writeError` に残します。作業ツリーの片付けや
  `demo prune` では消しません。保存の期限やローテーションはありません。
- **候補の差分**: リポジトリの実行では、候補を封印するたびに、記録済みのベースの
  コミットと候補のコミットの差分を `candidates/<candidate>/` に書き出します。
  作業ツリーの外なので、エージェントが書き換えることはできません。検証で止まって
  レビューに進まなかった候補にも書きます。両方のレビュアーのプロンプトには、この
  2 つのファイルの絶対パスが入り、全文を読むよう指示します。Claude のレビュアーは、
  作業場所の外では、この 2 つのファイルだけを読めて、書き込みはできません。

`worker`、`trigger`、`status`、`waits`、`approve`、`report`、`compare` は、どれも引数なしで同じ
DB を見ます。ディレクトリがなければ、DB を開く前に作ります。durably の
チェックアウトの中にも、対象のリポジトリの中にも、DB や `runs/` は作りません。
チェックアウトをどのコミットに切り替えても、過去の実行はそのまま読めます。置き場所を
変える引数や環境変数はありません。2 つのプロセスが別の DB を見ると、実行が黙って
見えなくなるからです。

### 以前の版から移行する

以前の版は、DB を `examples/local-agent-loop/local-agent-loop.db`（または
`DURABLY_DB` の指す場所）に、作業物を `examples/local-agent-loop/runs/` に置いて
いました。この版はそれらを読まず、移行もしません。チェックアウトに古い DB が
残っていると、ワーカーと CLI は、起動したときに、その場所と新しい場所を標準エラー
出力に一度だけ警告します。承認待ちの実行や、走っている途中の実行が残っているなら、上げる前に、
以前の版で終わらせるか、破棄してください。そのあと、古い DB と `runs/` は消して
かまいません。作業ツリーを消したときは、対象のリポジトリで `git worktree prune` を
実行します。

### 使用量の責任範囲

factory が責任を持つのは、factory の DB と `report --format json` までです。利用する
側で使用量の台帳をつけている場合は、実行が終わったあとに、利用する側がレポートを
読んで取り込みます。factory から台帳へ書き込むことはしません。

```bash
pnpm --filter example-local-agent-loop demo report --run <runId> --format json \
  | jq '{runId, configVersion, inputs, delivery, roleUsage, summary}'
```

`roleUsage` は `code`、`correctness`、`edge-cases` の 3 行で、それぞれ、指定した
プロバイダー、モデル、推論量、呼び出しの回数、トークンの内訳、合計のトークン、
費用、`complete`、`costComplete` を持ちます。fake のプロバイダーのように使用量を
返さない呼び出しは、0 にせず、トークンと費用を `null`、`complete` を `false` に
します。トークンがそろっていても、価格表にないモデルなら、費用は `null`、
`costComplete` は `false` です。

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
- **Inputs / Candidate / Delivery**: task、spec、dispositions、contextの各ファイルの
  SHA-256（contextは読込元と本文も）、最後に封印したcandidateのbranchとcommit、成果物の場所、branch名、commit SHA、
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
  `findings.nonBlocker` は保存した指摘（`severity`、`title`、`body`、あれば `file`、
  `line`、`likelihood`、`impact`）の配列で、それぞれ先頭20件までです。`findings.counts` は省いた分も
  含めたseverityごとの総件数なので、配列の長さではなくこちらを件数として読みます。
  指摘は完了したチェックポイントの返答をレビューstepが読んだときに保存したもので、
  レポートを作るときにreviewerを呼び直したり、チェックポイントを読み直したりしません。
  `verdict` のレビューと、指摘を保存する前のrunのレビューは `findings: null` です。
  runの出力（`output.reviews`）には指摘を入れません。Markdownと画面には、総件数と
  保存した指摘のタイトル、省いた件数だけを出し、本文、ファイル、行番号は出しません。
  Markdownでは、採点値のある指摘のタイトルの後ろに `(likelihood 2, impact 3)` の
  形で付けます。レビューの要点（`reviewHighlights` の各群の `kept`）の題名にも同じく
  付けます。画面では、レビューの要点と、各レビューの指摘の一覧の題名の横に、頻度と
  深刻さを添えます。
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

- **Claude**: APIの応答ごとの使用量を、message IDごとに一度だけ足し、
  モデル別にも分けます。assistantメッセージの使用量は応答を始めた時点の値で、
  outputはほぼ入っていません。そのため、途中の使用量を記録する呼び出しでは
  Agent SDKのストリームイベント（`includePartialMessages`）も受け取り、
  `message_start` で応答を、`message_delta` でその応答のその時点までの
  outputを読みます。各legは応答の中で増えるだけなので、見えた最大の値を
  使います。Claude Codeが自分で作る
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
報告のままのusageとその費用に `(partial)` と付けます。Summaryのtotal tokensも、
数えた合計のどれかが不完全なら `tokensComplete: false` にし、Markdownでは
`(PARTIAL)` と付けます。`demo compare` は、不完全な token の合計と、不完全な工程の token・cache read の合計を、不明として扱います。

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
pnpm --filter example-local-agent-loop demo trigger \
  --provider fake --context reuse --max-iterations 3
```

workerは `trigger` が自動で起動し、runが終わってしばらく仕事がなければ自分で
終了します（「workerの自動起動とアイドル終了」の節）。

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
