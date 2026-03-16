# @coji/durably

Steps that survive crashes. SQLite to PostgreSQL.

**[Documentation](https://coji.github.io/durably/)** | **[GitHub](https://github.com/coji/durably)** | **[Live Demo](https://durably-demo.vercel.app)**

> **Note:** This package is ESM-only. CommonJS is not supported.

## Installation

```bash
# libSQL (recommended default)
npm install @coji/durably kysely zod @libsql/client @libsql/kysely-libsql

# PostgreSQL (multi-worker)
npm install @coji/durably kysely zod pg
```

See [Choosing a Database](https://coji.github.io/durably/guide/databases) for all backends.

## Quick Start

```ts
import { createDurably, defineJob } from '@coji/durably'
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

const durably = createDurably({ dialect, jobs: { myJob } })

await durably.init() // migrate + start
await durably.jobs.myJob.trigger({ id: '123' })
```

## Documentation

For full documentation, visit [coji.github.io/durably](https://coji.github.io/durably/).

### For LLMs / AI Agents

This package includes `docs/llms.md` with API documentation optimized for LLMs and coding agents. You can read it directly from `node_modules/@coji/durably/docs/llms.md` or access it at [coji.github.io/durably/llms.txt](https://coji.github.io/durably/llms.txt).

## License

MIT
