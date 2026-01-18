# @coji/durably-react

React bindings for [Durably](https://github.com/coji/durably) - step-oriented resumable batch execution.

**[Documentation](https://coji.github.io/durably/)** | **[GitHub](https://github.com/coji/durably)**

> **Note:** This package is ESM-only. CommonJS is not supported.

## Installation

```bash
# Browser mode (with SQLocal)
npm install @coji/durably-react @coji/durably kysely zod sqlocal

# Server-connected mode (client only)
npm install @coji/durably-react
```

## Quick Start

```tsx
import { Suspense } from 'react'
import { createDurably, defineJob } from '@coji/durably'
import { DurablyProvider, useJob } from '@coji/durably-react'
import { SQLocalKysely } from 'sqlocal/kysely'
import { z } from 'zod'

const myJob = defineJob({
  name: 'my-job',
  input: z.object({ id: z.string() }),
  run: async (step, payload) => {
    await step.run('step-1', async () => {
      /* ... */
    })
  },
})

// Initialize Durably
async function initDurably() {
  const sqlocal = new SQLocalKysely('app.sqlite3')
  const durably = createDurably({ dialect: sqlocal.dialect }).register({
    myJob,
  })
  await durably.init() // migrate + start
  return durably
}
const durablyPromise = initDurably()

function App() {
  return (
    <Suspense fallback={<div>Loading...</div>}>
      <DurablyProvider durably={durablyPromise}>
        <MyComponent />
      </DurablyProvider>
    </Suspense>
  )
}

function MyComponent() {
  const { trigger, isRunning, isCompleted } = useJob(myJob)
  return (
    <button onClick={() => trigger({ id: '123' })} disabled={isRunning}>
      Run
    </button>
  )
}
```

## Server-Connected Mode

For full-stack apps, use hooks from `@coji/durably-react/client`:

```tsx
import { useJob } from '@coji/durably-react/client'

function MyComponent() {
  const {
    trigger,
    status,
    output,
    isRunning,
    isPending,
    isCompleted,
    isFailed,
    isCancelled,
  } = useJob<{ id: string }, { result: number }>({
    api: '/api/durably',
    jobName: 'my-job',
    autoResume: true, // Auto-resume running/pending jobs on mount (default)
    followLatest: true, // Switch to tracking new runs via SSE (default)
  })

  return (
    <button onClick={() => trigger({ id: '123' })} disabled={isRunning}>
      Run
    </button>
  )
}
```

## Documentation

For full documentation, visit [coji.github.io/durably](https://coji.github.io/durably/).

- [React Guide](https://coji.github.io/durably/guide/react) - Browser mode with hooks
- [Full-Stack Guide](https://coji.github.io/durably/guide/full-stack) - Server-connected mode

## License

MIT
