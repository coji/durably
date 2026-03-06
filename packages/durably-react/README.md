# @coji/durably-react

React bindings for [Durably](https://github.com/coji/durably) - step-oriented resumable batch execution.

**[Documentation](https://coji.github.io/durably/)** | **[GitHub](https://github.com/coji/durably)**

> **Note:** This package is ESM-only. CommonJS is not supported.

## Installation

```bash
# Fullstack mode (connects to Durably server)
npm install @coji/durably-react

# SPA mode (runs Durably in the browser with SQLocal)
npm install @coji/durably-react @coji/durably kysely zod sqlocal
```

## Quick Start (Fullstack Mode)

```tsx
import { createDurablyHooks } from '@coji/durably-react'
import type { durably } from './durably.server'

// Create type-safe hooks from server's Durably type
export const durably = createDurablyHooks<typeof durably>({
  api: '/api/durably',
})

function MyComponent() {
  const { trigger, isRunning, isCompleted, output } = durably.myJob.useJob()

  return (
    <button onClick={() => trigger({ id: '123' })} disabled={isRunning}>
      Run
    </button>
  )
}
```

## SPA Mode

For browser-only apps, import from `@coji/durably-react/spa`:

```tsx
import { createDurably, defineJob } from '@coji/durably'
import { DurablyProvider, useJob } from '@coji/durably-react/spa'
import { SQLocalKysely } from 'sqlocal/kysely'
import { z } from 'zod'

const myJob = defineJob({
  name: 'my-job',
  input: z.object({ id: z.string() }),
  run: async (step, input) => {
    await step.run('step-1', async () => {
      /* ... */
    })
  },
})

// Initialize Durably
async function initDurably() {
  const sqlocal = new SQLocalKysely('app.sqlite3')
  const durably = createDurably({
    dialect: sqlocal.dialect,
    jobs: { myJob },
  })
  await durably.init() // migrate + start
  return durably
}
const durablyPromise = initDurably()

function App() {
  return (
    <DurablyProvider durably={durablyPromise} fallback={<div>Loading...</div>}>
      <MyComponent />
    </DurablyProvider>
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

## Documentation

For full documentation, visit [coji.github.io/durably](https://coji.github.io/durably/).

- [SPA Hooks](https://coji.github.io/durably/api/durably-react/browser) - Browser mode with OPFS
- [Fullstack Hooks](https://coji.github.io/durably/api/durably-react/client) - Server-connected mode

## License

MIT
