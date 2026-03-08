# コアランタイム設計

## Durably とは

Durably は Node.js とブラウザで動くジョブランタイムです。ジョブをステップの連続として定義し、各ステップの結果はデータベースに永続化されます。ワーカーが途中でダウンしても、別のワーカーが続きから再開できます。プロセスではなくデータベースが唯一の信頼源です。

### なぜ Durably なのか

アプリにバックグラウンド処理があって、プロセスの再起動をまたいでも確実に完了しなければならないとき——サインアップ後のメール送信、定期的なデータ同期、複数ステップの AI パイプラインなど——「どこまで終わったか」を覚えておく仕組みが必要になります。

BullMQ のようなジョブキューはディスパッチとリトライに強いですが、Redis と常駐ワーカーが前提です。Cloudflare Workflows は耐久性をプラットフォーム側で解決しますが、Cloudflare に縛られます。Durably はその中間にいます。普通のデータベース（SQLite か PostgreSQL）をバックエンドに、チェックポイント付きの再開可能な実行を提供し、Vercel でも Cloudflare でも AWS でもローカルでも同じように動きます。

### Durably を使わなくていい場面

- **失敗したら再試行すれば済む単純なタスク** — 普通のキューのほうがシンプル
- **Cloudflare 専用のプロジェクト** — Cloudflare Workflows で十分なら、そちらが手軽
- **サブミリ秒のスケジューリングが必要な場面** — Durably は正確性を優先しており、リアルタイムディスパッチ向けではない

## 目標

Durably は、データベースを中心としたシンプルで信頼性の高いジョブランタイムを目指します。

### 推奨する導入パス

個人開発者が最小限のコストとセットアップで始めるための推奨構成:

| 優先度       | 構成                         | 選択の目安                                                                           |
| ------------ | ---------------------------- | ------------------------------------------------------------------------------------ |
| **第一候補** | `Vercel + Turso`             | Web 中心のプロジェクト、無料枠で始めやすい、常駐ファイル不要の SQLite 風データモデル |
| **第二候補** | `Cloudflare Workers + Turso` | Edge デプロイ、イベント駆動型の実行                                                  |
| **本番向け** | `Vercel + PostgreSQL`        | 最も明快なデータベースセマンティクス、Turso からの自然な移行先                       |
| **本番向け** | `Fly.io + PostgreSQL`        | 常駐ワーカー、長時間稼働プロセス                                                     |

> **Cloudflare に関する注記:** プロジェクトが Cloudflare 専用であれば、まず [Cloudflare Workflows](https://developers.cloudflare.com/workflows/) を検討してください。同様の問題をより少ないセットアップで解決できます。Vercel・Cloudflare・AWS・ローカル開発をまたいで同じ実行モデルを保ちたい場合は、Durably が適しています。

常駐ワーカーとサーバーレスプラットフォームをまたぐデプロイ構成は `deployment-models-ja.md` を参照してください。
データベースごとの適合性とトレードオフは `database-runtime-fit-ja.md` を参照してください。

### コアプロパティ

- ジョブの実行は永続化されたチェックポイントから再開できる
- 複数のワーカーが同一の claim 済み run を同時に実行してはならない
- ワーカーが実行途中で停止した場合、別のワーカーが安全に続行できる
- 実行モデルが長時間稼働プロセスに依存しない
- ストレージモデルが SQLite に依存しない（SQLite がデフォルト実装であっても）

このドキュメントでは、後方互換性を維持せずに目標アーキテクチャを記述します。

意図的に2つのフェーズに分割しています。

- Phase 1: コアジョブランタイムの再設計
- Phase 2: ランタイムの上に構築するアンビエントエージェント拡張

ポイントはスコープの制御です。Durably のコアバリューは永続的で再開可能なジョブ実行であり、アンビエントエージェントは有効な拡張ですが、最小限のコアではありません。

## Phase 1: コアランタイム再設計

## 設計原則

1. データベースが唯一の信頼源である
2. ジョブの実行はデフォルトで再開可能にする
3. 実行権の claim はアトミックでなければならない
4. 実行権は期限付きのリースとして扱う
5. 障害回復は通常の制御フローの一部として扱う
6. ランタイムはデーモン型とサーバーレス型の両方をサポートする
7. ストレージ固有の振る舞いは明示的な契約の背後に隔離する
8. 正確性は利便性や暗黙の自動処理よりも優先する

## コアモデル

中心的なオブジェクトは run です。

run とは、入力・ステータス・チェックポイント・リース状態を持つジョブの単一実行を指します。

> **用語 — リース:** リースとは「一時的な実行権」のことです。どのワーカーがその run を所有しているか、いつその権利が切れるかを記録します。ワーカーがクラッシュしたりリースが期限切れになった場合、別のワーカーが安全に引き継げます。

> **用語 — リース世代（フェンシングトークン）:** `leaseGeneration` は、run が claim されるたびにインクリメントされる単調増加カウンタです。リース保持者のすべての書き込みは `workerId` ではなくこの世代番号で検証されます。これにより、同じ `workerId` を再利用した場合でも、古いワーカーがリース期限切れ後にデータを書き込むことを構造的に防止できます。`leaseOwner` はデバッグやログのための人間向けメタデータとして残ります。

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
  leaseGeneration: number

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

`running` は意図を表しますが、権限は表しません。

ランタイムには、現在誰が実行を所有し、いつまで有効かを明示的に表現する仕組みが必要です。リースベースのモデルにより、ワーカーの所有権・有効期限・回収・競合処理が暗黙的ではなく第一級の概念になります。

## 実行セマンティクス

### 1. エンキュー

ジョブのトリガーは `pending` の run を作成します。

エンキュー操作には冪等性ルールを適用できますが、そのルールはアプリケーションコードのベストエフォートな事前読み取りではなく、ストアの契約によって強制される必要があります。

### 2. run の取得（claim）

ワーカーは pending な run を読み取ってから後で更新するということは行いません。

代わりに、1回のアトミックな操作で実行権を排他的に取得します。

- claim 可能な run を1つ選択する
- `status = leased` に設定する
- `leaseOwner` を設定する
- `leaseExpiresAt` を設定する
- `leaseGeneration` をインクリメントする
- 初回 claim の場合は `startedAt` を設定する

2つのワーカーが競合した場合、リースを受け取れるのは1つだけです。インクリメントされた `leaseGeneration` が、当選ワーカーのすべての後続書き込みにおけるフェンシングトークンになります。

### 3. 実行時間の延長（リース更新）

実行中、ワーカーは定期的にリースを延長します。

更新が成功するのは、データベースの `leaseGeneration` が現在の値と一致する場合のみです。これにより、古いワーカーが、すでに回収された run を延長することを防ぎます。

### 4. 完了または失敗

完了と失敗は世代番号ガード付きの書き込みです。

ランタイムは、`leaseGeneration` が一致する場合にのみ、run を `leased` から `completed` または `failed` に遷移させます。これはステップの永続化やリース更新で使われるのと同じガードです。

### 5. 放棄された run の回収（reclaim）

`leaseExpiresAt` が過去の場合、その run はもう誰にも所有されていません。

別のワーカーがそれを引き取り、永続化されたチェックポイントから実行を続行できます。

これは特別なリカバリモードではなく、通常の取得フローの一部として動作します。

### 最小構成のイメージ

具体的に見せると、Vercel + Turso での Durably アプリの最小形はこうなります。

```ts
// 1. ジョブを定義する
const sendWelcome = defineJob('send-welcome', async (step, payload) => {
  const user = await step.run('fetch-user', () => db.getUser(payload.userId))
  await step.run('send-email', () => email.send(user.email, 'Welcome!'))
})

// 2. API ルートからエンキューする
await durably.trigger('send-welcome', { userId: 'abc' })

// 3. run を処理する（Vercel Cron またはエンキュー直後に呼ぶ）
await durably.processOne()
```

Redis は不要。常駐ワーカーも不要。状態はすべてデータベースが保持します。`processOne()` がステップ間で中断されても、次の呼び出しで最後に完了したステップから再開されます。

## チェックポイントモデル

ジョブはステップに分割されます。各成功ステップはチェックポイントとして永続化されます。

再実行時:

- ステップがすでに完了していれば、永続化された出力が返される
- そうでなければ、ステップ関数が通常通り実行される

このモデルにより、副作用が適切なステップ境界で分離されている限り、プロセスの再起動やワーカーのフェイルオーバーを安全に行えます。

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

### アトミックなステップ永続化

ステップの永続化は、以下をすべて含む単一のアトミック操作でなければなりません。

1. `leaseGeneration` によるリース所有権の検証
2. ステップレコードの挿入
3. run の `currentStepIndex` の更新（completed ステップの場合のみ）

この操作は `persistStep` と呼びます。以前の `createStep` + `advanceRunStepIndex` の2段階シーケンスを置き換えます。旧方式には TOCTOU（Time-of-Check-Time-of-Use）の窓があり、個別の所有権ガードを付け忘れやすい問題がありました。

実装は `INSERT...SELECT` を使用し、所有権チェックと挿入を単一の SQL 文で行います（read-then-write の競合なし）。インデックスの更新もトランザクション内で行います。

### 完了ステップの一意性

データベースは、completed ステップに対して `(run_id, name)` の部分ユニーク制約を強制します。

```sql
CREATE UNIQUE INDEX idx_durably_steps_completed_unique
ON durably_steps(run_id, name) WHERE status = 'completed';
```

これにより、`getCompletedStep(runId, name)` が最大1行を返すことをデータベースレベルで保証し、リプレイの決定性を確保します。failed や cancelled のステップレコードは制約の対象外です — あるステップが1回目に失敗しても、同じ run 内のリトライで成功する可能性があるためです。

### 副作用の境界

ランタイムはステップの「永続化」については at-most-once を保証しますが、「実行」については at-least-once です。ワーカーが `fn()` を完了してもリースを失って結果を永続化できなかった場合、別のワーカーがそのステップを最初から再実行します。

つまり、外部副作用を持つステップ関数（API 呼び出し、メール送信、Webhook など）は冪等に設計する必要があります。ランタイムは副作用の重複を防止する手段を持たず、それはステップ実装の責務です。典型的には、ダウンストリーム API レベルでの冪等性キーを使用します。

### チェックポイントの保持

現在の実装では、ランがターミナル状態に達した時点でステップ出力データをデフォルトで削除します（`preserveSteps: false`）。`preserveSteps: true` を指定すると、ステップ履歴を保持し、監査やデバッグに活用できます。将来的には、時間ベースのポリシーやメンテナンスジョブによるクリーンアップも検討します。

## アーキテクチャの分離

現在の実装は、ランタイムセマンティクス・ポーリング動作・Kysely ベースの永続化を密結合しすぎています。

目標アーキテクチャではそれらを4つのレイヤーに分離します。

1. ランタイム
2. ストア
3. ワーカーループ
4. トランスポートと UI の統合

### ランタイム

ランタイムはジョブの登録・実行セマンティクス・リース処理・再開可能性を管理します。

デーモン向けとサーバーレス向けの両方のエントリーポイントを公開します。

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

`processOne()` が重要な追加点です。これにより、常駐ポーリングループを必要とせずに、cron ジョブ・HTTP ハンドラ・キュートリガー関数・サーバーレスプラットフォームでのワンショット実行が可能になります。

### ストア

ストアはすべての永続化を管理します。run のライフサイクル・リースセマンティクス・ステップチェックポイント・進捗・ログを含みます。
ランタイムの主要なパブリック API ではなく、adapter の契約です。

```ts
interface Store<TLabels = Record<string, string>> {
  // Run ライフサイクル
  enqueue(input: CreateRunInput<TLabels>): Promise<Run<TLabels>>
  enqueueMany(inputs: CreateRunInput<TLabels>[]): Promise<Run<TLabels>[]>
  getRun(runId: string): Promise<Run<TLabels> | null>
  getRuns(filter?: RunFilter<TLabels>): Promise<Run<TLabels>[]>
  updateRun(runId: string, data: UpdateRunData): Promise<void>
  deleteRun(runId: string): Promise<void>

  // リース管理（すべて leaseGeneration でガード）
  claimNext(
    workerId: string,
    now: string,
    leaseMs: number,
    options?: ClaimOptions,
  ): Promise<Run<TLabels> | null>
  renewLease(
    runId: string,
    leaseGeneration: number,
    now: string,
    leaseMs: number,
  ): Promise<boolean>
  releaseExpiredLeases(now: string): Promise<number>
  completeRun(
    runId: string,
    leaseGeneration: number,
    output: unknown,
    completedAt: string,
  ): Promise<boolean>
  failRun(
    runId: string,
    leaseGeneration: number,
    error: string,
    completedAt: string,
  ): Promise<boolean>
  cancelRun(runId: string, now: string): Promise<boolean>

  // ステップ（チェックポイント）
  persistStep(
    runId: string,
    leaseGeneration: number,
    input: CreateStepInput,
  ): Promise<Step | null>
  getSteps(runId: string): Promise<Step[]>
  getCompletedStep(runId: string, name: string): Promise<Step | null>
  deleteSteps(runId: string): Promise<void>

  // 進捗 & ログ
  updateProgress(runId: string, progress: ProgressData | null): Promise<void>
  createLog(input: CreateLogInput): Promise<Log>
  getLogs(runId: string): Promise<Log[]>
}
```

> **設計判断 — なぜガードに `workerId` ではなく `leaseGeneration` を使うのか:**
>
> 当初の設計では WHERE 句に `workerId` を使ってリース所有権を検証していました。これには2つの弱点がありました。
>
> - `workerId` はプロセス再起動後に再利用される可能性があり、古い所有者と現在の所有者を区別できない
> - ガードがメソッドごとに個別適用されており、いずれかの書き込み操作でガードを付け忘れると（実際に `createStep` と `advanceRunStepIndex` で起きた）、サイレントなレースコンディションが発生する
>
> `leaseGeneration` は各 claim でインクリメントされる単調カウンタです。偽造不可能であり、リースサイクル間で衝突しません。リース保持者のすべての書き込み — ステップ永続化・run 完了・run 失敗・リース更新 — が同じ `WHERE lease_generation = ?` ガードを使用します。このガードは構造的です。run の状態を書き込む新しいストアメソッドは、インターフェースで表現するために `leaseGeneration` を受け取る必要があります。

> **設計判断 — なぜ QueueStore + CheckpointStore ではなく統一 Store なのか:**
>
> 当初の RFC では、永続化を `QueueStore`（run ライフサイクルとリース）と `CheckpointStore`（ステップ・進捗・ログ）に分割する案を提示していました。これらの関心事は独立して進化するという理由でした。
>
> しかし実装の結果、この分割はリーキーな抽象であることが判明しました。
>
> - `CheckpointStore` が `durably_runs` テーブルに書き込んでいた（`advanceRunStepIndex`、`updateProgress`）— データレベルで 2 つのストア間の境界はすでに崩れていた。
> - ストア間のトランザクションが不可能だった。`deleteRun` のような操作はステップ・ログ・run 行のアトミックなクリーンアップを必要とするが、独立した 2 つのストアインターフェース間では調整できない。
> - 両ストアをラップする `Storage` ファサードが `updateRun` と `deleteRun` で両ストアをバイパスしており、抽象化の意味を失わせていた。
> - バックエンド固有の振る舞い（SQLite と PostgreSQL の claim 戦略の違いなど）は単一ストア実装内の関心事であり、インターフェースを分割する理由にはならない。
>
> 統一された `Store` インターフェースはよりシンプルで、関心事をまたぐアトミック操作を可能にし、run・ステップ・ログが密結合しているデータモデルを正直に反映しています。

この契約はセマンティクスを定義するものであり、SQL の形状を定義するものではありません。実装は同じ保証を維持する限り、SQLite・libSQL・PostgreSQL・その他のバックエンドを使用できます。

特に:

- Durably はバックエンド間で1つのポータブルな `claimNext()` 実装を必要としない
- adapter は同じランタイム動作を維持するために異なる claim 戦略を使用できる
- バックエンドがより専門的な内部 claim パスを通じてのみ正しさを守れる場合、それは許容される

### ワーカーループ

ワーカーループは薄く保ちます。

その役割は `runtime.processOne()` をスケジュールに従って繰り返し呼び出すことだけです。

独自の実行セマンティクスを含めるべきではありません。セマンティクスはランタイムに属し、長時間稼働型とワンショット型の両方の実行モードで再利用できるようにします。

### トランスポートと UI

HTTP・SSE・React バインディングは外側のレイヤーのままです。

これらはランタイムインターフェースとイベントストリームに依存し、Kysely やワーカーの内部実装には依存しません。

## 同時実行セマンティクス

2つの同時実行に関する関心事を明示的に扱う必要があります。

### 1つの run を実行できるワーカーは同時に1つだけ

ある時点で1つの run に対してアクティブなリースを保持できるワーカーは最大1つです。

これはストアの取得およびリース更新操作によって保証します。

### 同じ種類の run を同時に実行しない

一部のジョブは、異なる run であっても同時に実行すべきではありません。

これは取得ロジックの責務です。ストアは `concurrencyKey` を共有する run を除外またはシリアライズできる必要があります。

この制約は取得時に強制し、インメモリの協調に依存してはなりません。

## 重複 run の防止（冪等性）

冪等性はストレージの保証であり、ユーザーランドの最適化ではありません。

ランタイムは以下のルールを定義します。

- `idempotencyKey` がない場合、エンキューは常に新しい run を作成する
- `idempotencyKey` がある場合、エンキューはその `(jobName, idempotencyKey)` ペアの既存 run を返すか、ちょうど1つの新しい run を作成する

実装はデータベース制約と conflict-aware write を使用し、read-then-insert の競合に頼ってはなりません。

## 障害モデル

ランタイムは以下のすべてが起こりうることを前提とします。

- ワーカーのクラッシュ
- プロセスの再起動
- ネットワークの中断
- 部分的なステップ実行
- 古いリース保持者が遅れて復帰すること

設計上の対応:

- ステップチェックポイントを永続化する
- リース保持者のすべての書き込みを `leaseGeneration`（フェンシングトークン）でガードする
- 世代番号の不一致により、古い完了・ステップ書き込み・リース更新を拒否する
- 期限切れの run を claim セマンティクスにより自動的に回収する（世代番号がインクリメントされる）

障害処理はアドオンではありません。コアの実行モデルそのものです。

探索で明らかになった重要な境界を明示すべきです:

- ランタイムは世代番号ガード付き書き込みにより永続化状態を保護できる — これが正確性の保証
- ベストエフォートの協調停止（AbortSignal、リースデッドラインタイマー）はリース喪失後の古い実行を削減できる — これは最適化
- 任意の同期ユーザーコードのハード中断は現実的な目標ではない
- `fn()` の外部副作用はいかなるリース機構によっても保護できない — ステップの冪等性はユーザーの責務

## ストレージ独立性

Durably はコア契約において SQLite 固有の振る舞いを露出すべきではありません。

現在の実装は、JSON クエリ構文・ページネーションの癖・`RETURNING` の前提など、ストレージ固有の詳細が漏れています。新しいアーキテクチャではそれらの詳細を adapter 実装の内部に留めます。

パブリックコンストラクタはストレージ adapter を直接受け取ります。

```ts
interface DurablyOptions<TLabels, TJobs> {
  store: Store<TLabels>
  migrations?: MigrationDriver
  jobs?: TJobs
  labels?: z.ZodType<TLabels>

  leaseMs?: number
  heartbeatIntervalMs?: number
  pollingIntervalMs?: number
}
```

その上で、便利なコンストラクタを別途用意できます。

- `createDurablyWithKysely(...)`
- `createDurablyWithLibsql(...)`
- `createDurablyWithPostgres(...)`

重要なのは、これらは adapter であり、ランタイムそのものではないという点です。

## 推奨イベントモデル

イベントは UI の関心事ではなく、ランタイムのセマンティクスを反映します。

推奨される run 単位のイベント:

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

`run:leased` は `run:start` よりも正確です。実行権限の取得を反映しているためです。

## 現在の設計からの変更点

この設計はいくつかの前提を意図的に変更します。

1. `running` が `leased` になる
2. ハートビートが明示的なリース更新になる
3. claim と回収がストレージレベルのセマンティクスになる
4. `processOne()` が第一級のランタイム API になる
5. 長時間稼働ポーリングがコアモデルではなく、オプションのループになる
6. ストレージがランタイム内部で dialect から作成されるのではなく、adapter として注入される
7. ステップのクリーンアップがデフォルトの実行動作でなくなる
8. `leaseGeneration`（フェンシングトークン）がリース保持者のすべての書き込みのガードとして `workerId` に代わる
9. ステップの永続化が `createStep` + `advanceRunStepIndex` の分離から単一のアトミック操作（`persistStep`）になる
10. 完了ステップの `(runId, name)` ユニーク制約がデータベースレベルで強制される

## 非目標

この設計は以下を提供しようとするものではありません。

- 分散トレーシング
- ワークフローグラフスケジューリング
- データベース外での exactly-once 副作用
- 汎用メッセージブローカーセマンティクス

Durably は、永続的で再開可能なリースベースのジョブ実行に集中します。

## まとめ

目標とするシステムは、永続化されたチェックポイントを持つリースベースのランタイムです。

そのコア保証は:

- アトミックな run 取得
- チェックポイントからの再開可能な実行
- 安全なリース期限切れと自動回収
- 実行モデルの独立性（デーモン型とサーバーレス型の両対応）
- ストレージ adapter の可搬性（SQLite, PostgreSQL, libSQL, ...）

これがアーキテクチャの重心です。ワーカーループ・HTTP ハンドラ・React バインディングを含む他のすべては、このモデルを定義するのではなく、このモデルの上に位置します。

## Phase 2: アンビエントエージェント拡張

アンビエントエージェントはこのランタイムの有効なターゲットですが、コアランタイムの上に構築される拡張レイヤーまたは別パッケージとしてモデル化します。

アンビエントエージェントのより具体的なプロダクト像と代表的な適用分野は `ambient-agent-concepts-ja.md` を参照してください。

妥当なパッケージ境界:

- コアランタイムは `@coji/durably`
- アンビエントエージェントレイヤーは `@coji/durably-agent` のような上位パッケージ

理由はシンプルです。

- Durably のコアバリューは永続的で再開可能なジョブ実行にある
- エージェントセッション・ストリーミング UI 出力・スナップショットリカバリはより上位の関心事である
- これらの関心事は同じリースおよびチェックポイントモデルの恩恵を受けるが、最小限のコアを複雑にすべきではない

### 拡張モデル

拡張はコアランタイムの上に3つの概念を追加します。

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

- `Session` は UI とエージェント状態の連続性の境界にあたる
- `Run` はセッションにオプションで紐づく1回のリース付き実行の試行である
- `Step` は run 内のチェックポイントされた実行単位のまま
- `AgentEvent` は UI に見える出力を再構築するための追記専用ストリームである

### セッションと run の関係

コアランタイムにおいて、run はセッションを必要としません。

セッションの紐づけはオプションであり、エージェントレイヤーによってのみ導入します。これにより通常のジョブ実行がシンプルに保たれ、明確な分離が維持されます。

- 通常のジョブランタイム: run とステップ
- アンビエントエージェントランタイム: セッション・run・ステップ・永続イベントストリーム

### 永続ストリーミング要件

ランタイムがエージェントワークロードに使用される場合、ユーザーに見えるストリーミング出力は、クライアントへのライブ配信の前またはそれと同時に、順序付きイベントとして永続化する必要があります。

これにより以下が実現されます。

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

クライアントは以下が可能である必要があります。

1. セッションをロードする
2. スナップショットがあれば最新のものをロードする
3. 既知のカーソル以降の永続化されたイベントをリプレイする
4. そのカーソルからライブイベントにサブスクライブする

これにより、リロードと再接続が特殊な振る舞いではなく、通常のリカバリパスになります。

### スナップショットの所有権

スナップショットの作成はコアランタイムに暗黙的に含めるべきではありません。

エージェントレイヤーがスナップショットポリシーを明示的に定義します。そのポリシーは以下のいずれかです。

- ユーザー管理のスナップショット
- フレームワーク管理の定期スナップショット
- N イベントまたは N バイト後の閾値ベースのスナップショット

重要なルールは、スナップショット戦略はエージェント拡張レイヤーに属するという点です。コアの run 実行セマンティクスではなく、UI とエージェント状態の再構築ニーズによって駆動されるためです。

### 拡張ストア

エージェントレイヤーが実装される場合、コアの `store` 契約を拡張するのではなく、独自のストアを明示的に追加します。

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

これも Phase 1 のランタイム再設計からこの機能を除外するもう1つの理由です。これらのストアが必要な場合、それはコアジョブランタイムではなくエージェントパッケージによって必要とされるべきです。
