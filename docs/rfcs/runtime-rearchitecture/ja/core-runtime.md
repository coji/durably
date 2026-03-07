# 設計: ランタイム再アーキテクチャ

## Durably とは

Durably は Node.js とブラウザで動くジョブランタイムである。ジョブをステップの連続として定義し、各ステップの結果はデータベースに保存される。ワーカーがジョブの途中で落ちても、別のワーカーが続きから再開できる。プロセスではなくデータベースが source of truth となる。

### なぜ Durably か

アプリにバックグラウンド処理があって、それがプロセスの再起動を跨いでも確実に完了しなければならないとき——サインアップ後のメール送信、定期的なデータ同期、複数ステップの AI パイプラインなど——「どこまで終わったか」を覚えておく仕組みが必要になる。

BullMQ のようなジョブキューはディスパッチとリトライに強いが、Redis と常駐ワーカーが前提になる。Cloudflare Workflows は耐久性をプラットフォーム側で解決するが、Cloudflare に縛られる。Durably はその中間にいる。普通のデータベース（SQLite か PostgreSQL）をバックエンドに、チェックポイント付きの再開可能な実行を提供し、Vercel でも Cloudflare でも AWS でもローカルでも同じように動く。

### Durably を使わなくていい場面

- **失敗したら再試行すれば済む単純なタスク** — 普通のキューのほうがシンプル。
- **Cloudflare 専用のプロジェクト** — Cloudflare Workflows で十分なら、そちらが手軽。
- **サブミリ秒のスケジューリングが必要な場面** — Durably は正確性を優先しており、リアルタイムディスパッチ向けではない。

## 目標

Durably は、データベースを中心としたシンプルで信頼性の高いジョブランタイムを目指す。

### 推奨する導入パス

個人開発者が最小限のコストとセットアップで Durably を始めるための推奨構成:

| 優先度       | 構成                         | 選択の目安                                                                           |
| ------------ | ---------------------------- | ------------------------------------------------------------------------------------ |
| **第一候補** | `Vercel + Turso`             | Web 中心のプロジェクト、無料枠で始めやすい、常駐ファイル不要の SQLite 風データモデル |
| **第二候補** | `Cloudflare Workers + Turso` | Edge デプロイ、イベント駆動型の実行                                                  |
| **本番向け** | `Vercel + PostgreSQL`        | もっとも明快なデータベースセマンティクス、Turso からの自然な移行先                   |
| **本番向け** | `Fly.io + PostgreSQL`        | 常駐ワーカー、長時間稼働プロセス                                                     |

> **Cloudflare に関する注記:** プロジェクトが Cloudflare 専用であれば、まず [Cloudflare Workflows](https://developers.cloudflare.com/workflows/) を検討してほしい。同様の問題をより少ないセットアップで解決できる。Vercel・Cloudflare・AWS・ローカル開発をまたいで同じ実行モデルを保ちたい場合は、Durably が適している。

常駐 worker と serverless platform をまたぐデプロイ指向のランタイム構成については `deployment-models-ja.md` を参照。
異なるデータベースに対する適合性とトレードオフについては `database-runtime-fit-ja.md` を参照。

### コアプロパティ

- ジョブの実行は永続化されたチェックポイントから再開できる。
- 複数のワーカーが同一の claim 済みランを同時に実行してはならない。
- ワーカーが実行途中で停止した場合、別のワーカーが安全に後から続行できる。
- 実行モデルが長時間稼働プロセスに依存しない。
- ストレージモデルが SQLite に依存しない（SQLite がデフォルト実装であっても）。

このドキュメントでは、後方互換性を維持せずに目標アーキテクチャを記述する。

意図的に2つのフェーズに分割している:

- Phase 1: コアジョブランタイムの再設計
- Phase 2: ランタイムの上に構築するアンビエントエージェント拡張

要点はスコープの制御にある。Durably のコアバリューは永続的で再開可能なジョブ実行であり、アンビエントエージェントは有効な拡張だが、最小限のコアではない。

## Phase 1: コアランタイム再設計

## 設計原則

1. データベースが source of truth となる。
2. ジョブの実行はデフォルトで再開可能にする。
3. 実行権の claim はアトミックである必要がある。
4. 実行権は期限付きの lease として扱う。
5. 障害回復は通常の制御フローの一部として扱う。
6. ランタイムはデーモン型とサーバーレス型の両方の実行をサポートする。
7. ストレージ固有の振る舞いは明示的な contract の背後に隔離する。
8. 正確性は利便性や暗黙のマジックよりも優先する。

## コアモデル

中心的なオブジェクトはランである。

ランとは、入力・ステータス・チェックポイント・lease 状態を持つジョブの単一実行を指す。

> **用語 — lease:** lease とは「一時的な実行権」のこと。どのワーカーがそのランを所有しているか、いつその権利が切れるかを記録する。ワーカーがクラッシュしたり lease が期限切れになった場合、別のワーカーが安全に引き継げる。

```ts
type RunStatus = 'pending' | 'leased' | 'completed' | 'failed' | 'cancelled'

interface RunRecord<TLabels = Record<string, string>> {
  id: string
  jobName: string
  input: unknown
  status: RunStatus

  idempotencyKey: string | null
  concurrencyKey: string | null
  labels: TLabels

  leaseOwner: string | null
  leaseExpiresAt: string | null

  currentStepIndex: number
  progress: { current: number; total?: number; message?: string } | null

  output: unknown | null
  error: string | null

  createdAt: string
  startedAt: string | null
  completedAt: string | null
  updatedAt: string
}
```

### なぜ `running` ではなく `leased` なのか

`running` は意図を表すが、権限は表さない。

ランタイムには、現在誰が実行を所有し、いつまで有効かを明示的に表現する仕組みが必要になる。lease ベースのモデルにより、ワーカーの所有権・有効期限・回収・競合処理が暗黙的ではなく第一級の概念になる。

## 実行セマンティクス

### 1. enqueue

ジョブのトリガーは `pending` ランを作成する。

enqueue 操作は冪等性ルールを適用できるが、そのルールはアプリケーションコードのベストエフォートな事前読み取りではなく、ストアの contract によって強制される必要がある。

### 2. ランを取得する（claim）

ワーカーは pending ランを読み取ってから後で更新するということは行わない。

代わりに、1回のアトミックな操作で実行権を排他的に取得する:

- claim 可能なランを1つ選択する
- `status = leased` に設定する
- `leaseOwner` を設定する
- `leaseExpiresAt` を設定する
- 初回 claim の場合は `startedAt` を設定する

2つのワーカーが競合した場合、lease を受け取れるのは1つだけとなる。

### 3. 実行時間を延長する（lease 更新）

実行中、ワーカーは定期的に lease を延長する。

更新が成功するのは以下の場合のみ:

- ランがまだ leased 状態である
- そのワーカーが lease を所有している

これにより、古いワーカーが、既に別の場所で回収されたランを延長したり完了したりすることを防げる。

### 4. 完了または失敗

完了と失敗は所有権を考慮した書き込みとなる。

ランタイムは、現在のワーカーがまだ lease を所有している場合にのみ、ランを `leased` から `completed` または `failed` に遷移させる。

### 5. 放棄されたランの回収（reclaim）

`leaseExpiresAt` が過去の場合、そのランはもう誰にも所有されていない。

別のワーカーがそれを引き取り、永続化されたチェックポイントから実行を続行できる。

これは特別なリカバリモードではなく、通常の取得フローの一部として動作する。

### 最小構成のイメージ

具体的に見せると、Vercel + Turso での Durably アプリの最小形はこうなる:

```ts
// 1. ジョブを定義する
const sendWelcome = defineJob('send-welcome', async (step, payload) => {
  const user = await step.run('fetch-user', () => db.getUser(payload.userId))
  await step.run('send-email', () => email.send(user.email, 'Welcome!'))
})

// 2. API ルートから enqueue する
await durably.trigger('send-welcome', { userId: 'abc' })

// 3. ランを処理する（Vercel Cron または enqueue 直後に呼ぶ）
await durably.processOne()
```

Redis は不要。常駐ワーカーも不要。状態はすべてデータベースが保持する。`processOne()` がステップ間で中断されても、次の呼び出しで最後に完了したステップから再開される。

## チェックポイントモデル

ジョブはステップに分割される。各成功ステップはチェックポイントとして永続化される。

再実行時:

- ステップが既に完了していれば、永続化された出力が返される
- そうでなければ、ステップ関数は通常通り実行される

このモデルにより、副作用が適切なステップ境界で分離されている限り、プロセスの再起動やワーカーのフェイルオーバーを安全に行える。

```ts
interface StepRecord {
  id: string
  runId: string
  name: string
  index: number
  status: 'completed' | 'failed' | 'cancelled'
  output: unknown | null
  error: string | null
  startedAt: string
  completedAt: string | null
}
```

### チェックポイントの保持

チェックポイントの削除はデフォルトの実行パスに含めるべきではない。

デフォルトの振る舞いとしてステップ履歴を保持する。再開可能性と監査可能性がそれに依存しているためである。保持とクリーンアップは、メンテナンスジョブや時間ベースのポリシーなどで明示的に処理する。

## アーキテクチャの分離

現在の実装は、ランタイムセマンティクス・ポーリング動作・Kysely ベースの永続化を密結合しすぎている。

目標アーキテクチャではそれらを5つのレイヤーに分離する:

1. ランタイム
2. キューストア
3. チェックポイントストア
4. ワーカーループ
5. トランスポートと UI の統合

### ランタイム

ランタイムはジョブの登録・実行セマンティクス・lease 処理・再開可能性を管理する。

デーモン向けとサーバーレス向けの両方のエントリーポイントを公開する。

```ts
interface DurablyRuntime<TJobs, TLabels = Record<string, string>> {
  readonly jobs: TJobs

  init(): Promise<void>
  migrate(): Promise<void>

  processOne(options?: { workerId?: string }): Promise<boolean>
  processUntilIdle(options?: {
    workerId?: string
    maxRuns?: number
  }): Promise<number>

  start(options?: { workerId?: string }): void
  stop(): Promise<void>

  getRun(runId: string): Promise<RunRecord<TLabels> | null>
  getRuns(filter?: RunFilter<TLabels>): Promise<RunRecord<TLabels>[]>

  cancel(runId: string): Promise<void>
  retrigger(runId: string): Promise<RunRecord<TLabels>>
}
```

`processOne()` が重要な追加点となる。これにより、常駐ポーリングループを必要とせずに、cron ジョブ・HTTP ハンドラー・キュートリガー関数・サーバーレスプラットフォームでのワンショット実行が可能になる。

### キューストア

キューストアはランのライフサイクルと lease セマンティクスを管理する。

```ts
interface QueueStore<TLabels = Record<string, string>> {
  enqueue(input: EnqueueRunInput<TLabels>): Promise<RunRecord<TLabels>>
  enqueueMany(inputs: EnqueueRunInput<TLabels>[]): Promise<RunRecord<TLabels>[]>

  getRun(runId: string): Promise<RunRecord<TLabels> | null>
  listRuns(filter?: RunFilter<TLabels>): Promise<RunRecord<TLabels>[]>

  claimNext(
    workerId: string,
    now: string,
    leaseMs: number,
    options?: { excludeConcurrencyKeys?: string[] },
  ): Promise<RunRecord<TLabels> | null>

  renewLease(
    runId: string,
    workerId: string,
    now: string,
    leaseMs: number,
  ): Promise<boolean>

  releaseExpiredLeases(now: string): Promise<number>

  completeRun(
    runId: string,
    workerId: string,
    output: unknown,
    completedAt: string,
  ): Promise<boolean>

  failRun(
    runId: string,
    workerId: string,
    error: string,
    completedAt: string,
  ): Promise<boolean>

  cancelRun(runId: string, now: string): Promise<void>
  deleteRun(runId: string): Promise<void>
}
```

この contract はセマンティクスを定義するものであり、SQL の形状を定義するものではない。実装は同じ保証を維持する限り、SQLite・libSQL・PostgreSQL・その他のバックエンドを使用できる。

### チェックポイントストア

チェックポイントストアはステップの永続化・進捗・ログを管理する。

```ts
interface CheckpointStore {
  saveStep(input: SaveStepInput): Promise<void>
  getCompletedStep(runId: string, stepName: string): Promise<StepRecord | null>
  listSteps(runId: string): Promise<StepRecord[]>

  updateProgress(runId: string, progress: Progress): Promise<void>

  appendLog(input: CreateLogInput): Promise<void>
  getLogs(runId: string): Promise<LogRecord[]>

  clearCheckpoints?(runId: string): Promise<void>
}
```

この分離は意図的なものである。lease の所有権とチェックポイントの永続化は異なる理由で進化するため、1つの肥大化したストレージインターフェースで結合すべきではない。

### ワーカーループ

ワーカーループは薄く保つ。

その役割は `runtime.processOne()` をスケジュールに従って繰り返し呼び出すことだけである。

独自の実行セマンティクスを含めるべきではない。セマンティクスはランタイムに属し、長時間稼働型とワンショット型の両方の実行モードで再利用できるようにする。

### トランスポートと UI

HTTP・SSE・React バインディングは外側のレイヤーのままとする。

これらはランタイムインターフェースとイベントストリームに依存し、Kysely やワーカーの内部実装には依存しない。

## 並行性セマンティクス

2つの並行性に関する concern を明示的に扱う必要がある。

### 1つのランを実行できるワーカーは同時に1つだけ

ある時点で1つのランに対してアクティブな lease を保持できるワーカーは最大1つとなる。

これはキューストアの取得および lease 更新操作によって保証する。

### 同じ種類のランを同時に実行しない

一部のジョブは、異なるランであっても同時に実行すべきではない。

これは取得ロジックの責務にあたる。キューストアは `concurrencyKey` を共有するランを除外またはシリアライズできる必要がある。

この制約は取得時に強制し、インメモリの調整に依存してはならない。

## 重複ランの防止（冪等性）

冪等性はストレージの保証であり、ユーザーランドの最適化ではない。

ランタイムは以下のルールを定義する:

- `idempotencyKey` がない場合、enqueue は常に新しいランを作成する
- `idempotencyKey` がある場合、enqueue はその `(jobName, idempotencyKey)` ペアの既存ランを返すか、正確に1つの新しいランを作成する

実装はデータベース制約と競合対応の書き込みを使用し、read-then-insert の競合に頼ってはならない。

## 障害モデル

ランタイムは以下のすべてが起こりうることを前提とする:

- ワーカーのクラッシュ
- プロセスの再起動
- ネットワークの中断
- 部分的なステップ実行
- 古い lease 保持者が遅れて復帰すること

設計上の対応:

- ステップチェックポイントを永続化する
- lease の変更を `workerId` に紐づける
- 古い完了と lease 更新を拒否する
- 期限切れのランを claim セマンティクスにより自動的に回収する

障害処理はアドオンではない。コアの実行モデルそのものである。

## ストレージ独立性

Durably はコア contract において SQLite 固有の振る舞いを露出すべきではない。

現在の実装は、JSON クエリ構文・ページネーションの癖・`returning` の前提など、ストレージ固有の詳細が漏れている。新しいアーキテクチャではそれらの詳細をアダプター実装の内部に留める。

パブリックコンストラクタはストレージアダプターを直接受け取る。

```ts
interface DurablyOptions<TLabels, TJobs> {
  store: {
    queue: QueueStore<TLabels>
    checkpoint: CheckpointStore
  }
  migrations?: MigrationDriver
  jobs?: TJobs
  labels?: z.ZodType<TLabels>

  leaseMs?: number
  heartbeatIntervalMs?: number
  pollingIntervalMs?: number
}
```

その上で、便利なコンストラクタを別途用意できる:

- `createDurablyWithKysely(...)`
- `createDurablyWithLibsql(...)`
- `createDurablyWithPostgres(...)`

重要なのは、これらはアダプターであり、ランタイムそのものではないという点である。

## 推奨イベントモデル

イベントは UI の concern ではなく、ランタイムのセマンティクスを反映する。

推奨されるラン単位のイベント:

- `run:enqueued`
- `run:leased`
- `run:lease-renewed`
- `run:completed`
- `run:failed`
- `run:cancelled`
- `run:deleted`
- `run:progress`

推奨されるステップ単位のイベント:

- `step:started`
- `step:completed`
- `step:failed`
- `step:cancelled`

推奨される内部エラーイベント:

- `worker:error`

`run:leased` は `run:start` よりも正確である。実行権限の取得を反映しているためである。

## 現在の設計からの変更点

この設計はいくつかの前提を意図的に変更する。

1. `running` が `leased` になる。
2. ハートビートが明示的な lease 更新になる。
3. claim と回収がストレージレベルのセマンティクスになる。
4. `processOne()` が第一級のランタイム API になる。
5. 長時間稼働ポーリングがコアモデルではなく、オプションのループになる。
6. ストレージがランタイム内部で dialect から作成されるのではなく、アダプターとして注入される。
7. ステップのクリーンアップがデフォルトの実行動作でなくなる。
8. 所有権を考慮した書き込みに `workerId` が必要になる。

## 非目標

この設計は以下を提供しようとするものではない:

- 分散トレーシング
- ワークフローグラフスケジューリング
- データベース外での exactly-once 副作用
- 汎用メッセージブローカーセマンティクス

Durably は、永続的で再開可能な lease ベースのジョブ実行に集中する。

## まとめ

目標とするシステムは、永続化されたチェックポイントを持つ lease ベースのランタイムである。

そのコア保証は:

- アトミックなラン取得
- チェックポイントからの再開可能な実行
- 安全な lease 期限切れと自動回収
- 実行モデルの独立性（デーモン型とサーバーレス型の両対応）
- ストレージアダプターの可搬性（SQLite, PostgreSQL, libSQL, …）

これがアーキテクチャの重心となる。ワーカーループ・HTTP ハンドラー・React バインディングを含む他のすべては、このモデルを定義するのではなく、このモデルの上に位置する。

## Phase 2: アンビエントエージェント拡張

アンビエントエージェントはこのランタイムの有効なターゲットだが、コアランタイムの上に構築される拡張レイヤーまたは別パッケージとしてモデル化する。

アンビエントエージェントのより具体的なプロダクト像と代表的な適用分野については `ambient-agent-concepts-ja.md` を参照。

妥当なパッケージ境界:

- コアランタイムは `@coji/durably`
- アンビエントエージェントレイヤーは `@coji/durably-agent` のような上位パッケージ

理由はシンプルである:

- Durably のコアバリューは永続的で再開可能なジョブ実行にある
- エージェントセッション・ストリーミング UI 出力・スナップショットリカバリはより上位の concern である
- これらの concern は同じ lease およびチェックポイントモデルの恩恵を受けるが、最小限のコアを複雑にすべきではない

### 拡張モデル

拡張はコアランタイムの上に3つの概念を追加する:

1. `Session`
2. `AgentEvent`
3. `Snapshot`

```ts
interface SessionRecord {
  id: string
  agentName: string
  status: 'active' | 'idle' | 'completed' | 'failed' | 'cancelled'
  input: unknown | null
  snapshot: unknown | null
  createdAt: string
  updatedAt: string
}

interface AgentEventRecord {
  id: string
  sessionId: string
  runId: string | null
  sequence: number
  type: string
  payload: unknown
  createdAt: string
}
```

このモデルでは:

- `Session` は UI とエージェント状態の継続性の境界にあたる
- `Run` はセッションにオプショナルに紐づく1回の lease 付き実行の試行である
- `Step` はラン内のチェックポイントされた実行単位のままである
- `AgentEvent` は UI に見える出力を再構築するための追記専用ストリームである

### セッションとランの関係

コアランタイムにおいて、ランはセッションを必要としない。

セッションの紐づけはオプショナルであり、エージェントレイヤーによってのみ導入する。これにより通常のジョブ実行がシンプルに保たれ、明確な分離が維持される:

- 通常のジョブランタイム: ランとステップ
- アンビエントエージェントランタイム: セッション・ラン・ステップ・永続イベントストリーム

### 永続ストリーミング要件

ランタイムがエージェントワークロードに使用される場合、ユーザーに見えるストリーミング出力は、クライアントへのライブ配信の前またはそれと同時に、順序付きイベントとして永続化する必要がある。

これにより以下が実現される:

1. 実行中のライブストリーミング
2. リロード後の UI 復元
3. 再接続後のリプレイ
4. ワーカーフェイルオーバー後の継続

推奨されるイベントカテゴリ:

- `token.delta`
- `message.started`
- `message.delta`
- `message.completed`
- `tool.call.started`
- `tool.call.completed`
- `tool.call.failed`
- `state.updated`

### カーソルベースのリカバリ

クライアントは以下が可能である必要がある:

1. セッションをロードする
2. スナップショットがあれば最新のものをロードする
3. 既知のカーソル以降の永続化されたイベントをリプレイする
4. そのカーソルからライブイベントにサブスクライブする

これにより、リロードと再接続が特殊な振る舞いではなく、通常のリカバリパスとなる。

### スナップショットの所有権

スナップショットの作成はコアランタイムに暗黙的に含めるべきではない。

エージェントレイヤーがスナップショットポリシーを明示的に定義する。そのポリシーは以下のいずれかでありうる:

- ユーザー管理のスナップショット
- フレームワーク管理の定期スナップショット
- N イベントまたは N バイト後の閾値ベースのスナップショット

重要なルールは、スナップショット戦略はエージェント拡張レイヤーに属するという点である。コアのラン実行セマンティクスではなく、UI とエージェント状態の再構築のニーズによって駆動されるためである。

### 拡張ストア

エージェントレイヤーが実装される場合、コアの `store` contract を拡張するのではなく、独自のストアを明示的に追加する:

```ts
interface SessionStore {
  createSession(input: CreateSessionInput): Promise<SessionRecord>
  getSession(sessionId: string): Promise<SessionRecord | null>
  updateSession(sessionId: string, patch: UpdateSessionInput): Promise<void>
}

interface AgentEventStore {
  append(event: AppendAgentEventInput): Promise<AgentEventRecord>
  list(
    sessionId: string,
    options?: { afterSequence?: number; limit?: number },
  ): Promise<AgentEventRecord[]>
  subscribe(
    sessionId: string,
    options?: { afterSequence?: number },
  ): ReadableStream<AgentEventRecord>
}
```

これも Phase 1 のランタイム再設計からこの機能を除外するもう1つの理由となる。これらのストアが必要な場合、それはコアジョブランタイムではなくエージェントパッケージによって必要とされるべきである。
