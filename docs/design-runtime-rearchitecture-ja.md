# 設計: ランタイム再アーキテクチャ

## 目標

Durably は、データベースを中心としたシンプルで信頼性の高いジョブランタイムであるべきである。

コアランタイムは以下の性質を満たさなければならない:

- ジョブの実行は永続化されたチェックポイントから再開可能であること。
- 複数のワーカーが同一のクレーム済みランを同時に実行してはならないこと。
- ワーカーが実行途中で停止した場合、別のワーカーが安全に後から続行できること。
- 実行モデルが長時間稼働プロセスに依存しないこと。
- ストレージモデルが SQLite に依存しないこと（SQLite がデフォルト実装であっても）。

本ドキュメントでは、後方互換性を維持せずに目標アーキテクチャを記述する。

意図的に2つのフェーズに分割している:

- Phase 1: コアジョブランタイムの再設計
- Phase 2: ランタイムの上に構築するアンビエントエージェント拡張

要点はスコープの制御である。Durably のコアバリューは永続的で再開可能なジョブ実行である。アンビエントエージェントは有効な拡張だが、最小限のコアではない。

## Phase 1: コアランタイム再設計

## 設計原則

1. データベースが信頼の源泉である。
2. ジョブの実行はデフォルトで再開可能である。
3. 実行権のクレームはアトミックでなければならない。
4. 実行権は期限付きリースとしてモデル化される。
5. 障害回復は通常の制御フローの一部である。
6. ランタイムはデーモン型とサーバーレス型の両方の実行をサポートしなければならない。
7. ストレージ固有の振る舞いは明示的な契約の背後に隔離されなければならない。
8. 正確性は利便性や暗黙のマジックよりも優先される。

## コアモデル

中心的なオブジェクトはランである。

ランとは、入力・ステータス・チェックポイント・リース状態を持つジョブの単一実行である。

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

ランタイムには、現在誰が実行を所有し、いつまで有効かの明示的な表現が必要である。リースベースのモデルにより、ワーカーの所有権・有効期限・回収・競合処理が暗黙的ではなく第一級の概念となる。

## 実行セマンティクス

### 1. エンキュー

ジョブのトリガーは `pending` ランを作成する。

エンキュー操作は冪等性ルールを適用できるが、それらのルールはアプリケーションコードのベストエフォートな事前読み取りではなく、ストア契約によって強制されなければならない。

### 2. クレーム

ワーカーは pending ランを読み取ってから後で更新するということは決して行わない。

代わりに、1回のアトミックなクレーム操作を実行する:

- クレーム可能なランを1つ選択する
- `status = leased` に設定する
- `leaseOwner` を設定する
- `leaseExpiresAt` を設定する
- 初回クレームの場合は `startedAt` を設定する

2つのワーカーが競合した場合、リースを受け取れるのは1つだけである。

### 3. リース更新

実行中、ワーカーは定期的にリースを更新する。

更新が成功するのは以下の場合のみ:

- ランがまだ leased 状態である
- そのワーカーがリースを所有している

これにより、古いワーカーが、既に別の場所で回収されたランを延長したり完了したりすることを防ぐ。

### 4. 完了または失敗

完了と失敗は所有権を考慮した書き込みである。

ランタイムは、現在のワーカーがまだリースを所有している場合にのみ、ランを `leased` から `completed` または `failed` に遷移させなければならない。

### 5. 回収

`leaseExpiresAt` が過去の場合、そのランはもう誰にも所有されていない。

別のワーカーがそれを回収し、永続化されたチェックポイントから実行を続行できる。

回収は特別なリカバリモードではない。通常のクレームセマンティクスの一部である。

## チェックポイントモデル

ジョブはステップに分割される。各成功ステップはチェックポイントとして永続化される。

再実行時:

- ステップが既に完了していた場合、永続化された出力が返される
- それ以外の場合、ステップ関数は通常通り実行される

このモデルにより、副作用が適切なステップ境界で分離されている限り、プロセスの再起動やワーカーのフェイルオーバーが安全になる。

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

チェックポイントの削除はデフォルトの実行パスの一部であってはならない。

デフォルトの振る舞いはステップ履歴を保持すべきである。なぜなら、再開可能性と監査可能性がそれに依存しているからである。保持とクリーンアップは、例えばメンテナンスジョブや時間ベースのポリシーによって明示的に処理されるべきである。

## アーキテクチャの分離

現在の実装は、ランタイムセマンティクス・ポーリング動作・Kysely ベースの永続化を密結合しすぎている。

目標アーキテクチャはそれらを5つのレイヤーに分離する:

1. ランタイム
2. キューストア
3. チェックポイントストア
4. ワーカーループ
5. トランスポートと UI の統合

### ランタイム

ランタイムはジョブの登録・実行セマンティクス・リース処理・再開可能性を管理する。

デーモン向けとサーバーレス向けの両方のエントリーポイントを公開すべきである。

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

`processOne()` が重要な追加点である。これにより、常駐ポーリングループを必要とせずに、cron ジョブ・HTTP ハンドラー・キュートリガー関数・サーバーレスプラットフォームでのワンショット実行が可能になる。

### キューストア

キューストアはランのライフサイクルとリースセマンティクスを管理する。

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

この契約はセマンティクスを定義するものであり、SQL の形状を定義するものではない。実装は同じ保証を維持する限り、SQLite・libSQL・PostgreSQL・その他のバックエンドを使用してよい。

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

この分離は意図的である。リースの所有権とチェックポイントの永続化は異なる理由で進化するため、1つの肥大化したストレージインターフェースで結合すべきではない。

### ワーカーループ

ワーカーループは薄くあるべきである。

その役割は `runtime.processOne()` をスケジュールに従って繰り返し呼び出すことだけである。

独自の実行セマンティクスを含むべきではない。セマンティクスはランタイムに属し、長時間稼働型とワンショット型の両方の実行モードで再利用できるようにすべきである。

### トランスポートと UI

HTTP・SSE・React バインディングは外側のレイヤーのままである。

これらはランタイムインターフェースとイベントストリームに依存すべきであり、Kysely やワーカーの内部実装に依存すべきではない。

## 並行性セマンティクス

2つの並行性の関心事を明示的に扱わなければならない。

### クレームの排他性

ある時点で1つのランに対してアクティブなリースを保持できるワーカーは最大1つである。

これはキューストアのクレームおよびリース更新操作によって保証されなければならない。

### 並行性キー

一部のジョブは、異なるランであっても同時に実行すべきではない。

これはクレームセマンティクスに属する。キューストアは `concurrencyKey` を共有するランを除外またはシリアライズできるべきである。

この制約はクレーム時に強制されるべきであり、インメモリの調整によるものであってはならない。

## 冪等性セマンティクス

冪等性はストレージの保証であり、ユーザーランドの最適化ではない。

ランタイムは以下のルールを定義すべきである:

- `idempotencyKey` がない場合、エンキューは常に新しいランを作成する
- `idempotencyKey` がある場合、エンキューはその `(jobName, idempotencyKey)` ペアの既存ランを返すか、正確に1つの新しいランを作成する

実装はデータベース制約と競合対応の書き込みを使用すべきであり、read-then-insert の競合であってはならない。

## 障害モデル

ランタイムは以下のすべてが起こりうることを前提とする:

- ワーカーのクラッシュ
- プロセスの再起動
- ネットワークの中断
- 部分的なステップ実行
- 古いリース保持者が遅れて復帰すること

設計上の対応は:

- ステップチェックポイントを永続化する
- リースの変更を `workerId` に紐づける
- 古い完了とリース更新を拒否する
- 期限切れのランをクレームセマンティクスにより自動的に回収する

障害処理はアドオンではない。それがコアの実行モデルである。

## ストレージ独立性

Durably はコア契約において SQLite 固有の振る舞いを露出すべきではない。

現在の実装は、JSON クエリ構文・ページネーションの癖・`returning` の前提など、ストレージ固有の関心事を漏洩させている。新しいアーキテクチャではそれらの詳細をアダプター実装の内部に留めるべきである。

パブリックコンストラクタはストレージアダプターを直接受け取るべきである。

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

重要なのは、これらはアダプターであり、ランタイムそのものではないということである。

## 推奨イベントモデル

イベントは UI の関心事ではなく、ランタイムのセマンティクスを反映すべきである。

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

`run:leased` は `run:start` よりも正確である。なぜなら、実行権限の取得を反映しているからである。

## 現在の設計からの変更点

この設計はいくつかの前提を意図的に変更する。

1. `running` が `leased` になる。
2. ハートビートが明示的なリース更新になる。
3. クレームと回収がストレージレベルのセマンティクスになる。
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

Durably は、永続的で再開可能なリースベースのジョブ実行に集中すべきである。

## まとめ

目標とするシステムは、永続化されたチェックポイントを持つリースベースのランタイムである。

そのコア保証は:

- アトミックなクレーム
- 再開可能な実行
- 安全なリースの有効期限切れと回収
- 実行モデルの独立性
- ストレージアダプターの可搬性

これがアーキテクチャの重心である。ワーカーループ・HTTP ハンドラー・React バインディングを含む他のすべては、このモデルを定義するのではなく、このモデルの上に位置すべきである。

## Phase 2: アンビエントエージェント拡張

アンビエントエージェントはこのランタイムの有効なターゲットだが、コアランタイムの上に構築される拡張レイヤーまたは別パッケージとしてモデル化されるべきである。

妥当なパッケージ境界は:

- コアランタイムは `@coji/durably`
- アンビエントエージェントレイヤーは `@coji/durably-agent` のような上位パッケージ

理由は単純である:

- Durably のコアバリューは永続的で再開可能なジョブ実行である
- エージェントセッション・ストリーミング UI 出力・スナップショットリカバリはより上位の関心事である
- これらの関心事は同じリースおよびチェックポイントモデルの恩恵を受けるが、最小限のコアを複雑にすべきではない

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

- `Session` は UI とエージェント状態の継続性の境界である
- `Run` はセッションにオプショナルに紐づく1回のリース付き実行の試行である
- `Step` はラン内のチェックポイントされた実行単位のままである
- `AgentEvent` は UI に見える出力を再構築するために使用される追記専用ストリームである

### セッションとランの関係

コアランタイムにおいて、ランはセッションを必要としない。

セッションの紐づけはオプショナルであり、エージェントレイヤーによってのみ導入されるべきである。これにより通常のジョブ実行がシンプルに保たれ、明確な分離が維持される:

- 通常のジョブランタイム: ランとステップ
- アンビエントエージェントランタイム: セッション・ラン・ステップ・永続イベントストリーム

### 永続ストリーミング要件

ランタイムがエージェントワークロードに使用される場合、ユーザーに見えるストリーミング出力は、クライアントへのライブ配信の前またはそれと同時に、順序付きイベントとして永続化されなければならない。

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

クライアントは以下が可能であるべきである:

1. セッションをロードする
2. スナップショットがあれば最新のものをロードする
3. 既知のカーソル以降の永続化されたイベントをリプレイする
4. そのカーソルからライブイベントにサブスクライブする

これにより、リロードと再接続が特殊な振る舞いではなく、通常のリカバリパスとなる。

### スナップショットの所有権

スナップショットの作成はコアランタイムに暗黙的に含まれるべきではない。

エージェントレイヤーがスナップショットポリシーを明示的に定義すべきである。そのポリシーは以下のいずれかでありうる:

- ユーザー管理のスナップショット
- フレームワーク管理の定期スナップショット
- N イベントまたは N バイト後の閾値ベースのスナップショット

重要なルールは、スナップショット戦略はエージェント拡張レイヤーに属するということである。なぜなら、それはコアのラン実行セマンティクスではなく、UI とエージェント状態の再構築のニーズによって駆動されるからである。

### 拡張ストア

エージェントレイヤーが実装される場合、コアの `store` 契約を拡張するのではなく、独自のストアを明示的に追加すべきである:

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

これも Phase 1 のランタイム再設計からこの機能を除外するもう1つの理由である。これらのストアが必要な場合、それはコアジョブランタイムではなくエージェントパッケージによって必要とされるべきである。
