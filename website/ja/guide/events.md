# イベント

Durablyはジョブ実行を監視するためのイベントシステムを提供します。

## 利用可能なイベント

| イベント | 説明 | ペイロード |
|-------|-------------|---------|
| `run:start` | ジョブ実行が開始 | `{ runId, jobName, input }` |
| `run:complete` | ジョブが正常に完了 | `{ runId, jobName, output }` |
| `run:fail` | ジョブがエラーで失敗 | `{ runId, jobName, error }` |
| `step:start` | ステップ実行が開始 | `{ runId, stepName, stepIndex }` |
| `step:complete` | ステップが完了 | `{ runId, stepName, stepIndex, output }` |
| `step:skip` | ステップがスキップ（キャッシュ済み） | `{ runId, stepName, stepIndex, output }` |
| `log:write` | ログメッセージが書き込まれた | `{ runId, level, message }` |

## イベントの購読

`durably.on()`を使用して購読します：

```ts
// 単一のイベント
const unsubscribe = durably.on('run:complete', (event) => {
  console.log(`ジョブ ${event.jobName} が完了:`, event.output)
})

// 複数のイベント
durably.on('run:start', (e) => console.log('開始:', e.jobName))
durably.on('run:fail', (e) => console.error('失敗:', e.error))
durably.on('step:complete', (e) => console.log('ステップ完了:', e.stepName))
```

## 購読解除

`on()`メソッドは購読解除関数を返します：

```ts
const unsubscribe = durably.on('run:complete', handler)

// 後で...
unsubscribe()
```

## React統合

イベントはUI状態の更新に便利です：

```tsx
function useDurably() {
  const [status, setStatus] = useState<'idle' | 'running' | 'done'>('idle')
  const [currentStep, setCurrentStep] = useState<string | null>(null)

  useEffect(() => {
    const unsubscribes = [
      durably.on('run:start', () => setStatus('running')),
      durably.on('run:complete', () => {
        setStatus('done')
        setCurrentStep(null)
      }),
      durably.on('step:complete', (e) => setCurrentStep(e.stepName)),
    ]

    return () => unsubscribes.forEach((fn) => fn())
  }, [])

  return { status, currentStep }
}
```

## ロギング

ジョブ内で`context.log()`を使用してログイベントを発行します：

```ts
durably.defineJob(
  { name: 'my-job', input: z.object({}) },
  async (context) => {
    context.log('info', '処理を開始')

    await context.run('step1', async () => {
      context.log('debug', 'ステップ1の詳細', { someData: 123 })
      return result
    })

    context.log('info', '完了')
  },
)

// ログを購読
durably.on('log:write', (event) => {
  console.log(`[${event.level}] ${event.message}`)
})
```

## イベント駆動パターン

### 進捗追跡

```ts
let totalSteps = 5
let completedSteps = 0

durably.on('step:complete', () => {
  completedSteps++
  updateProgressBar(completedSteps / totalSteps * 100)
})
```

### メトリクス収集

```ts
const metrics = {
  jobsCompleted: 0,
  jobsFailed: 0,
  avgDuration: 0,
}

const startTimes = new Map()

durably.on('run:start', (e) => {
  startTimes.set(e.runId, Date.now())
})

durably.on('run:complete', (e) => {
  metrics.jobsCompleted++
  const duration = Date.now() - startTimes.get(e.runId)
  // 平均を更新...
})

durably.on('run:fail', () => {
  metrics.jobsFailed++
})
```
