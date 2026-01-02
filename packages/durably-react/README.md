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
import { defineJob } from '@coji/durably'
import { DurablyProvider, useJob } from '@coji/durably-react'
import { SQLocalKysely } from 'sqlocal/kysely'

const myJob = defineJob({
  name: 'my-job',
  input: z.object({ id: z.string() }),
  run: async (step, payload) => {
    await step.run('step-1', async () => {
      /* ... */
    })
  },
})

function App() {
  return (
    <DurablyProvider
      dialectFactory={() => new SQLocalKysely('app.sqlite3').dialect}
    >
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

- [React Guide](https://coji.github.io/durably/guide/react) - Browser mode with hooks
- [Full-Stack Guide](https://coji.github.io/durably/guide/full-stack) - Server-connected mode

## License

MIT
