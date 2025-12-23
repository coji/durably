# React

このガイドでは、Reactアプリケーションでのhooks、StrictMode、状態管理のベストプラクティスについて説明します。

## 基本的なセットアップ

### Durablyインスタンスの作成

Reactコンポーネントの外部でシングルトンインスタンスを作成します：

```tsx
// lib/durably.ts
import { createDurably } from '@coji/durably'
import { SQLocalKysely } from 'sqlocal/kysely'

const { dialect } = new SQLocalKysely('app.sqlite3')

export const durably = createDurably({
  dialect,
  pollingInterval: 100,
  heartbeatInterval: 500,
  staleThreshold: 3000,
})
```

### 初期化フック

```tsx
// hooks/useDurably.ts
import { useEffect, useState } from 'react'
import { durably } from '../lib/durably'

export function useDurably() {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false

    async function init() {
      await durably.migrate()
      if (!cancelled) {
        durably.start()
        setReady(true)
      }
    }
    init()

    return () => {
      cancelled = true
      durably.stop()
    }
  }, [])

  return { ready, durably }
}
```

## StrictMode互換性

React StrictModeは開発時にコンポーネントを2回マウント・アンマウントします。Durablyはこれを適切に処理しますが、以下のパターンに従ってください：

### キャンセルフラグを使用

```tsx
useEffect(() => {
  let cancelled = false

  async function init() {
    await durably.migrate()
    if (cancelled) return  // 状態更新前にチェック

    durably.start()
    setReady(true)
  }
  init()

  return () => {
    cancelled = true
    durably.stop()
  }
}, [])
```

### シングルトンパターン

コンポーネント間で状態を共有する場合：

```tsx
// lib/durably.ts
let instance: Durably | null = null
let initPromise: Promise<void> | null = null

export async function getDurably() {
  if (!instance) {
    const { dialect } = new SQLocalKysely('app.sqlite3')
    instance = createDurably({ dialect })
    initPromise = instance.migrate()
  }
  await initPromise
  return instance
}

// hooks/useDurably.ts
export function useDurably() {
  const [durably, setDurably] = useState<Durably | null>(null)

  useEffect(() => {
    let cancelled = false

    getDurably().then((d) => {
      if (!cancelled) {
        d.start()
        setDurably(d)
      }
    })

    return () => {
      cancelled = true
    }
  }, [])

  return durably
}
```

## ジョブステータスの追跡

### 個別のジョブ実行を追跡

```tsx
function useJobStatus(job: JobHandle<string, unknown, unknown>) {
  const [runs, setRuns] = useState<Run[]>([])

  useEffect(() => {
    // 初期実行を読み込み
    job.getRuns().then(setRuns)

    // 更新を購読
    const unsubs = [
      durably.on('run:start', async (e) => {
        const run = await job.getRun(e.runId)
        if (run) setRuns((prev) => [...prev, run])
      }),
      durably.on('run:complete', async (e) => {
        setRuns((prev) =>
          prev.map((r) =>
            r.id === e.runId ? { ...r, status: 'completed', output: e.output } : r
          )
        )
      }),
      durably.on('run:fail', async (e) => {
        setRuns((prev) =>
          prev.map((r) =>
            r.id === e.runId ? { ...r, status: 'failed', error: e.error } : r
          )
        )
      }),
    ]

    return () => unsubs.forEach((fn) => fn())
  }, [job])

  return runs
}
```

### 処理状態フック

```tsx
function useProcessingState() {
  const [processing, setProcessing] = useState(false)
  const [currentRunId, setCurrentRunId] = useState<string | null>(null)

  useEffect(() => {
    const unsubs = [
      durably.on('run:start', (e) => {
        setProcessing(true)
        setCurrentRunId(e.runId)
      }),
      durably.on('run:complete', () => {
        setProcessing(false)
        setCurrentRunId(null)
      }),
      durably.on('run:fail', () => {
        setProcessing(false)
        setCurrentRunId(null)
      }),
    ]

    return () => unsubs.forEach((fn) => fn())
  }, [])

  return { processing, currentRunId }
}
```

## 進捗追跡

### 進捗イベントを使用

```tsx
function useProgress(runId: string | null) {
  const [progress, setProgress] = useState<{
    current: number
    total?: number
    message?: string
  } | null>(null)

  useEffect(() => {
    if (!runId) {
      setProgress(null)
      return
    }

    const unsub = durably.on('run:progress', (e) => {
      if (e.runId === runId) {
        setProgress({
          current: e.current,
          total: e.total,
          message: e.message,
        })
      }
    })

    return unsub
  }, [runId])

  return progress
}
```

### 進捗UIコンポーネント

```tsx
function ProgressBar({ runId }: { runId: string | null }) {
  const progress = useProgress(runId)

  if (!progress) return null

  const percent = progress.total
    ? Math.round((progress.current / progress.total) * 100)
    : null

  return (
    <div className="progress">
      {percent !== null && (
        <div className="bar" style={{ width: `${percent}%` }} />
      )}
      <span>{progress.message || `${progress.current}/${progress.total || '?'}`}</span>
    </div>
  )
}
```

## 完全な例

```tsx
import { useEffect, useState } from 'react'
import { z } from 'zod'
import { durably } from './lib/durably'

// コンポーネントの外でジョブを定義
const processDataJob = durably.register(defineJob(
  {
    name: 'process-data',
    input: z.object({ items: z.array(z.string()) }),
    output: z.object({ processed: z.number() }),
  },
  async (step, payload) => {
    let processed = 0

    for (const item of payload.items) {
      await step.run(`process-${item}`, async () => {
        // 作業をシミュレート
        await new Promise((r) => setTimeout(r, 500))
        processed++
      })
      step.progress(processed, payload.items.length)
    }

    return { processed }
  },
)

function App() {
  const [ready, setReady] = useState(false)
  const [processing, setProcessing] = useState(false)
  const [result, setResult] = useState<{ processed: number } | null>(null)

  useEffect(() => {
    let cancelled = false

    async function init() {
      await durably.migrate()
      if (cancelled) return
      durably.start()
      setReady(true)
    }
    init()

    const unsubs = [
      durably.on('run:start', () => setProcessing(true)),
      durably.on('run:complete', (e) => {
        setProcessing(false)
        setResult(e.output as { processed: number })
      }),
      durably.on('run:fail', () => setProcessing(false)),
    ]

    return () => {
      cancelled = true
      unsubs.forEach((fn) => fn())
      durably.stop()
    }
  }, [])

  const handleProcess = async () => {
    setResult(null)
    await processDataJob.trigger({
      items: ['item-1', 'item-2', 'item-3'],
    })
  }

  if (!ready) {
    return <div>初期化中...</div>
  }

  return (
    <div>
      <button onClick={handleProcess} disabled={processing}>
        {processing ? '処理中...' : 'データを処理'}
      </button>

      {result && <p>{result.processed}件のアイテムを処理しました</p>}
    </div>
  )
}
```

## Context Providerパターン

大規模なアプリケーション向け：

```tsx
// context/DurablyContext.tsx
import { createContext, useContext, useEffect, useState, ReactNode } from 'react'
import { durably, type Durably } from '../lib/durably'

interface DurablyContextValue {
  durably: Durably
  ready: boolean
}

const DurablyContext = createContext<DurablyContextValue | null>(null)

export function DurablyProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false

    durably.migrate().then(() => {
      if (!cancelled) {
        durably.start()
        setReady(true)
      }
    })

    return () => {
      cancelled = true
      durably.stop()
    }
  }, [])

  return (
    <DurablyContext.Provider value={{ durably, ready }}>
      {children}
    </DurablyContext.Provider>
  )
}

export function useDurablyContext() {
  const context = useContext(DurablyContext)
  if (!context) {
    throw new Error('useDurablyContextはDurablyProvider内で使用する必要があります')
  }
  return context
}
```

使用方法：

```tsx
// App.tsx
import { DurablyProvider, useDurablyContext } from './context/DurablyContext'

function JobRunner() {
  const { ready } = useDurablyContext()

  if (!ready) return <div>読み込み中...</div>

  return <button onClick={() => myJob.trigger({ data: 'test' })}>実行</button>
}

function App() {
  return (
    <DurablyProvider>
      <JobRunner />
    </DurablyProvider>
  )
}
```

## ベストプラクティス

1. **durablyインスタンスはコンポーネントの外で作成** - useEffect内でインスタンスを作成しない
2. **キャンセルフラグを使用** - アンマウント後の状態更新を防止
3. **イベントリスナーをクリーンアップ** - 必ずクリーンアップで購読解除
4. **ジョブはモジュールレベルで定義** - ジョブは一度だけ定義し、レンダーごとに定義しない
5. **StrictModeに対応** - 開発モードでアプリをテストして問題を早期に発見
