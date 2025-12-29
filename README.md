# durably

Step-oriented resumable batch execution for Node.js and browsers using SQLite.

**[Documentation](https://coji.github.io/durably/)** | **[Live Demo](https://durably-demo.vercel.app)**

## Packages

| Package | Description |
|---------|-------------|
| [@coji/durably](./packages/durably) | Core library - job definitions, steps, and persistence |
| [@coji/durably-react](./packages/durably-react) | React bindings - hooks for triggering and monitoring jobs |

## Features

- Resumable batch processing with step-level persistence
- Works in both Node.js and browsers
- Uses SQLite for state management (better-sqlite3/libsql for Node.js, SQLite WASM for browsers)
- Minimal dependencies - just Kysely and Zod as peer dependencies
- Event system for monitoring and extensibility
- Type-safe input/output with Zod schemas

## Quick Start

See the [Getting Started Guide](https://coji.github.io/durably/guide/getting-started) for installation and usage instructions.

## License

MIT
