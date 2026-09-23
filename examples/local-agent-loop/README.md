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

Codexは `ai-sdk-provider-codex-cli@2.2.1` のapp-server modeを使い、最初の
呼び出しでpersistent threadを作り、修正時は保存した `threadId` を明示します。
Claudeは `ai-sdk-provider-claude-code@4.3.1` が返す `sessionId` を保存し、修正時は
明示的な `resume` を使います。「cwdで最新の会話を選ぶ」動作は使いません。

## 実行

Terminal 1:

```bash
pnpm --filter example-local-agent-loop demo worker
```

workerは1つだけ動かしてください。同じDBを見るworkerを複数起動すると、どれがrunを
拾うか分かりません。leaseがあるので壊れはしませんが、環境変数はworkerごとに違うので、
`AGENT_TIMEOUT_MS` を変えたつもりが古いworkerに拾われる、という形で黙って効きません。

```bash
pgrep -f 'local-agent-loop.*cli.ts worker' | wc -l   # 1 であること
```

数えるのはpnpmのラッパーではなく実体のプロセスです。`pnpm demo worker` と
`pnpm worker` のどちらで起動しても同じ1つとして数えます。残ってしまったworkerは
`pkill -f 'local-agent-loop.*cli.ts worker'` で片付きます。

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
  next:    pnpm demo report --run 01M375ZAYC... (read the reviews first)
           pnpm demo approve --run 01M375ZAYC... --wait 01M375ZC2C...
           pnpm demo reject --run 01M375ZAYC... --wait 01M375ZC2C...
```

- 承認waitで止まっているrunだけに、そのrun IDとwait IDを入れた `approve` と
  `reject` を表示します。
- leasedは、lease期限内なら実行中、期限切れならworkerが止まったものとして
  区別します。期限切れは失敗ではないので、workerを起動すればcheckpointから
  再開します。
- 止まったrunには、理由、再試行の可否（`retry`）、人が確認すべき内容
  （`check`）を表示します。`retry: yes` は「新しいrunを始めても、結果の
  分からないagent呼び出しを重ねて送らない」という意味で、同じ入力で成功する
  保証ではありません。
- 開始checkpointだけが残ったagent呼び出しは `uncertain-invocation` として
  `retry: NO` になり、送り直すコマンドは出しません。providerの履歴と作業場所、
  表示されたcheckpointを人が確かめてください。分類できない失敗も `retry: NO`
  です。
- 終わったrepo runのworktreeが残っていれば、
  `git -C '<repo>' worktree remove '<workdir>'` を表示します。setupが記録した
  パスが存在するときだけ出し、強制削除やbranch削除は含みません。変更が残る
  worktreeではgitが削除を拒みます。実行するかどうかは利用者が決めます。

同じ理由と次の手順は、`status --run <runId>` の `diagnosis` と、reportの
`failure`（JSON）および「Stop reason」節（Markdown）にも出ます。

## 実リポジトリに対して動かす

同梱の題材ではなく、実際のリポジトリの作業を渡す場合です。リポジトリごとに変わらない
設定は、対象リポジトリ直下の `factory.json` で管理します。

```json
{
  "check": ["pnpm", "validate"],
  "setup": ["pnpm", "install", "--frozen-lockfile"],
  "base": "main",
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
  検査15分。同梱題材はそれぞれ5分と2分です。`AGENT_TIMEOUT_MS` と
  `TEST_TIMEOUT_MS` で上書きできます。
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

### trigger時点で固定されるもの

`factory.json`、task、spec、dispositionsは `trigger` の時点で一度だけ読みます。
フラグを適用した後の各役割のrequested設定と、入力ファイルのpathと本文をrun inputに
保存します。実際に使うmodelとeffortは、workerがそのrequested設定からproviderの
presetで解決します。workerは元のファイルを読み直さないので、trigger後にファイルを
書き換えても、そのrunの設定とpromptは変わりません。reportには各入力ファイルの
pathと、保存した本文から計算したSHA-256が出ます。

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
    delivery/<candidate>.patch     成果物
```

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
  反復上限、対象、timeoutのhash）

providerが返すusageは、一回の呼び出しの**全モデル応答の合計**でなければいけません。
エージェントCLIは一回の呼び出しの中で何十回もモデルを呼ぶので、最後の応答だけでは
桁が変わります。

- **Claude**: Agent SDKの `result` メッセージの累計をそのまま使います。Claude Codeの
  transcriptに記録された各応答の合計と一致することを確認済みです。
- **Codex**: `ai-sdk-provider-codex-cli@2.2.1` は応答ごとのイベントで usage を上書き
  するため、最後の応答分しか返しません。上流には
  [ben-vargas/ai-sdk-provider-codex-cli#49](https://github.com/ben-vargas/ai-sdk-provider-codex-cli/issues/49)
  で報告済みです。`patches/` のパッチでturn内の合計に直して
  います。thread累計の `total` は使いません。`--context reuse` では前回の呼び出し分
  まで含んでしまうからです。修正後の値はCodex自身のセッションログと一致することを
  確認済みです。同じパッチで、上流が `0` 固定にしていた cache write も
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
- **Stage usage**: 工程ごとの visits / reworked（同じ工程への再突入＝手戻り）、
  invocation数、in / cache-read / cache-write / out / total、cost。
  いずれかの呼び出しが未計上なら PARTIAL、価格不明なら unknown
- **Role usage**: `code`、`correctness`、`edge-cases` ごとのrequested
  provider/model/effort、invocation数、token、cost、usageとcostそれぞれの完全性。二つのレビューを
  別の行に分けるので、役割ごとに違うmodelを使ったrunでも内訳が混ざりません
- **Timing / Attempts / Waits**: 従来どおりの工程別 work / wall 時間、
  呼び出しごとの生データ、承認待ちの inputWait / executionSlotWait

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

グループごとに success 率、lead time、work、human wait、total tokens、cost、
cost per success、repairs、工程別の work / tokens / cache-read / cost / reworked
を並べます。reuse と fresh を比べるときは、`code` 工程の cache-read 比と
repairs の中央値を見ます。unknown は統計から外して件数だけ残し、0 として
平均に混ぜません。

## 権限と制約

- Codex implement/repairはworkspace-write、reviewはread-only sandboxです。
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
  cli.ts            factory.jsonと入力ファイルの読み込み、trigger時の固定
  durably.ts        固定state directoryのDB
subject/            変更しないバグ入り題材
```

境界の形は `engine/verification.ts` と `factory/target.ts` によく出ています。
前者は start/complete checkpoint、計測、signalの転送までを持ち、「何をもって
検証とするか」は `grade` コールバックとして受け取ります。後者は、作業場所、
封印の仕方、採点、レビューに渡す文脈、成果物の渡し方という、ターゲットごとに
必ず違う5つだけを切り出しています。

移植の手順は [docs/porting.md](docs/porting.md) にあります。
