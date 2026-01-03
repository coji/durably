# @coji/durably

Step-oriented resumable batch execution for Node.js and browsers using SQLite.

**[Documentation](https://coji.github.io/durably/)** | **[GitHub](https://github.com/coji/durably)** | **[Live Demo](https://durably-demo.vercel.app)**

> **Note:** This package is ESM-only. CommonJS is not supported.

## Installation

```bash
npm install @coji/durably kysely zod better-sqlite3
```

See the [Getting Started Guide](https://coji.github.io/durably/guide/getting-started) for other SQLite backends (libsql, SQLocal for browsers).

## Quick Start

```ts
import { createDurably, defineJob } from '@coji/durably'
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

const durably = createDurably({ dialect }).register({ myJob })

await durably.init() // migrate + start
await durably.jobs.myJob.trigger({ id: '123' })
```

## Documentation

For full documentation, visit [coji.github.io/durably](https://coji.github.io/durably/).

### For LLMs / AI Agents

This package includes `docs/llms.md` with API documentation optimized for LLMs and coding agents. You can read it directly from `node_modules/@coji/durably/docs/llms.md` or access it at [coji.github.io/durably/llms.txt](https://coji.github.io/durably/llms.txt).

## License

MIT
