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

`src/job.ts` は、保存済みstateからPolicy判断を記録し、実関数を持つregistryを
呼び、返ったeventをreduceするだけです。ファイルコピー、固定テスト、並列
レビュー、waitは `src/stages.ts` 内の各Stageが組み立てます。Stage全体を一律に
`step.run()` で包まないため、承認waitはDurablyの正しい境界にあります。

```text
decision:N
  └─ stages[decision.stage](...)
       ├─ code: agent call → immutable Candidate
       ├─ verify: fixed acceptance command against Candidate
       ├─ review: correctness + edge-cases (step.all, new sessions)
       ├─ approve: prepareWait → waitFor(Candidate ID)
       └─ finish/stop: approved Candidate or terminal failure
```

Candidateは次の参照を持ちます。

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
合否判定に使いません。Candidate自身も検証・レビュー前にhashを確認します。

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

## reuse / fresh 比較

同じ題材、provider、model、effort、最大反復数で二つのrunを作ります。

```bash
pnpm --filter example-local-agent-loop demo trigger \
  --provider codex --context reuse --model gpt-5.6-sol --effort medium

pnpm --filter example-local-agent-loop demo trigger \
  --provider codex --context fresh --model gpt-5.6-sol --effort medium
```

両方を承認まで進め、JSON reportで修正回数、cache read/write、実作業時間、
並列review区間、人間待ち、run全体時間を比較します。session継続はcache hitを
保証しません。効果はproviderが報告したcache usageで判断します。

## 呼び出し識別と復旧

次のIDを混同しません。

```text
sessionId      provider-native conversation/thread
operationKey   一つの論理的な仕事
invocationId   実際に送った一回の依頼
attempt.id     Durably step callbackの実行試行
```

共通runnerは送信前に `operationKey` と `invocationId` のstart checkpointを保存し、
provider結果を受け取ったらcomplete checkpointをatomicに保存してからstepを完了
します。復旧時にcomplete checkpointがあれば同じ結果を読み、promptは再送しません。
startだけが残った場合、外部呼び出しが完了したか安全に判定できないため、自動再送
せず `uncertain external invocation` で停止します。作業物とcheckpointは
`runs/<runId>/` に残ります。独自daemonや送信管理DBはありません。

この契約は「結果受信後、Durably checkpoint前」の重複を防ぎます。一方、CLIが
作業を終えた直後かつcomplete checkpoint前にプロセスを強制終了した場合は未確定
として止まります。初版ではprovider-native履歴を推測して自動採用しません。

## 計測

LLM呼び出しはすべて `src/runner.ts` を通り、attempt metadataへ以下を保存します。

- effective model/effortとprovider-reported model/effort（未報告値は `null`）
- `sessionId`、`operationKey`、`invocationId`、回収結果かどうか
- 通常input、cache read、cache write、output、total token
- usageの単位（このサンプルは一provider invocation）と取得元
- elapsed、result、error、interruption reason、API換算参考価格

集計は `invocationId` で一度だけ数えます。同じcomplete checkpointを別attemptが
読み直してもtokenを二重計上しません。ローカルテストやPolicyはusage対象外です。
LLMを呼んだのにusageが無い場合は欠測として件数を残し、完全な合計にはしません。
レポートはSQLiteのrun、attempt、waitから再生成する純粋な処理です。

```bash
pnpm --filter example-local-agent-loop demo report --run <runId> --format json
pnpm --filter example-local-agent-loop demo report --run <runId> --format md \
  --out reports/<runId>.md
```

価格はsubscription請求額ではなく `api-equivalent-estimate` です。未知のmodelや
欠けたusageを0円として扱いません。

## 権限と制約

- Codex implement/repairはworkspace-write、reviewはread-only sandboxです。
- Claude reviewはReadのみです。implement/repairは `canUseTool` と `PreToolUse`
  hookの双方でworkdir外パスを拒否します。これは入力検査であり、OS sandboxでは
  ありません。
- 同じsessionへ並列送信しません。並列なのは新規sessionを使う二つのreviewだけ
  です。
- model、effort、指示版、tool、cwdを途中で替えるhandoffは未実装です。初版では
  setup時に解決したprofileをrun中固定します。
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

- `src/job.ts` — decision保存とStage dispatchだけを行うDurably job
- `src/stages.ts` — code / verify / review / approve / finish / stop
- `src/candidate.ts` —非上書きCandidate作成とintegrity check
- `src/types.ts`, `events.ts`, `reducer.ts`, `policy.ts` — 状態機械
- `src/providers/` — AI SDK v7のCodex / Claude / fake adapter
- `src/runner.ts` — session、operation checkpoint、共通計測
- `src/acceptance.ts`, `test-step.ts` — 固定受け入れテスト
- `src/report.ts`, `usage.ts`, `pricing.ts` — 永続記録からの集計
- `subject/` — 変更しないバグ入り題材
- `runs/`, `local-agent-loop.db` — gitignored runtime data
