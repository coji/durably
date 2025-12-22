# イベント

Durablyはジョブ実行の監視と拡張性のためのイベントシステムを提供します。

## イベントの購読

```ts
durably.on(eventType: string, listener: (event) => void): void
```

## イベントタイプ

### 実行イベント

#### `run:start`

実行が開始されたときに発火します。

```ts
durably.on('run:start', (event) => {
  // event: {
  //   type: 'run:start',
  //   runId: string,
  //   jobName: string,
  //   payload: unknown,
  //   timestamp: string,
  //   sequence: number
  // }
})
```

#### `run:complete`

実行が正常に完了したときに発火します。

```ts
durably.on('run:complete', (event) => {
  // event: {
  //   type: 'run:complete',
  //   runId: string,
  //   jobName: string,
  //   output: unknown,
  //   duration: number,
  //   timestamp: string,
  //   sequence: number
  // }
})
```

#### `run:fail`

実行が失敗したときに発火します。

```ts
durably.on('run:fail', (event) => {
  // event: {
  //   type: 'run:fail',
  //   runId: string,
  //   jobName: string,
  //   error: string,
  //   failedStepName: string,
  //   timestamp: string,
  //   sequence: number
  // }
})
```

### ステップイベント

#### `step:start`

ステップの実行が開始されたときに発火します。

```ts
durably.on('step:start', (event) => {
  // event: {
  //   type: 'step:start',
  //   runId: string,
  //   jobName: string,
  //   stepName: string,
  //   stepIndex: number,
  //   timestamp: string,
  //   sequence: number
  // }
})
```

#### `step:complete`

ステップが正常に完了したときに発火します。

```ts
durably.on('step:complete', (event) => {
  // event: {
  //   type: 'step:complete',
  //   runId: string,
  //   jobName: string,
  //   stepName: string,
  //   stepIndex: number,
  //   output: unknown,
  //   duration: number,
  //   timestamp: string,
  //   sequence: number
  // }
})
```

#### `step:fail`

ステップが失敗したときに発火します。

```ts
durably.on('step:fail', (event) => {
  // event: {
  //   type: 'step:fail',
  //   runId: string,
  //   jobName: string,
  //   stepName: string,
  //   stepIndex: number,
  //   error: string,
  //   timestamp: string,
  //   sequence: number
  // }
})
```

### ログイベント

#### `log:write`

`step.log`のメソッドが呼び出されたときに発火します。

```ts
durably.on('log:write', (event) => {
  // event: {
  //   type: 'log:write',
  //   runId: string,
  //   stepName: string | null,
  //   level: 'info' | 'warn' | 'error',
  //   message: string,
  //   data: unknown,
  //   timestamp: string,
  //   sequence: number
  // }
})
```

### ワーカーイベント

#### `worker:error`

内部ワーカーエラーが発生したときに発火します（例：ハートビート失敗）。

```ts
durably.on('worker:error', (event) => {
  // event: {
  //   type: 'worker:error',
  //   error: string,
  //   context: string,  // 例: 'heartbeat'
  //   runId?: string,
  //   timestamp: string,
  //   sequence: number
  // }
})
```

## エラー処理

イベントリスナーでの例外は実行に影響しません。リスナーエラーをキャッチするには：

```ts
durably.onError((error, event) => {
  console.error('リスナーエラー:', error, 'イベント:', event.type)
})
```

## 型定義

すべてのイベントはDiscriminated Unionパターンを使用します：

```ts
interface BaseEvent {
  type: string
  timestamp: string
  sequence: number
}

type DurablyEvent =
  | RunStartEvent
  | RunCompleteEvent
  | RunFailEvent
  | StepStartEvent
  | StepCompleteEvent
  | StepFailEvent
  | LogWriteEvent
  | WorkerErrorEvent
```

## 例

```ts
const durably = createDurably({ dialect })

// すべてのイベントをログ
durably.on('run:start', (e) => {
  console.log(`[${e.jobName}] 実行開始: ${e.runId}`)
})

durably.on('run:complete', (e) => {
  console.log(`[${e.jobName}] 実行完了 ${e.duration}ms`)
})

durably.on('run:fail', (e) => {
  console.error(`[${e.jobName}] 実行失敗: ${e.error}`)
  // 監視サービスにアラートを送信
  alertService.notify({
    title: `ジョブ ${e.jobName} が失敗`,
    message: e.error,
    runId: e.runId,
  })
})

durably.on('step:complete', (e) => {
  console.log(`  ステップ "${e.stepName}" 完了 ${e.duration}ms`)
})

// リスナーエラーを処理
durably.onError((error, event) => {
  console.error('イベントリスナーがエラーをスロー:', error)
})
```
