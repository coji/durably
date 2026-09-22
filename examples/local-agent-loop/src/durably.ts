import { fileURLToPath } from 'node:url'

import { createDurably } from '@coji/durably'
/** Durably instance (local SQLite via better-sqlite3). */
import Database from 'better-sqlite3'
import { SqliteDialect } from 'kysely'

import { agentLoopJob } from './project/job.js'

export function dbPath(): string {
  return (
    process.env.DURABLY_DB ??
    // `URL.pathname` is percent-encoded, so a checkout under a path with a
    // space would point better-sqlite3 at a `my%20name` directory that does
    // not exist — and the worker and CLI would disagree about the database.
    fileURLToPath(new URL('../local-agent-loop.db', import.meta.url))
  )
}

function build() {
  const dialect = new SqliteDialect({
    database: new Database(dbPath()),
  })
  return createDurably({
    dialect,
    pollingIntervalMs: 500,
    leaseRenewIntervalMs: 1000,
    leaseMs: 10000,
    preserveSteps: true,
    jobs: { agentLoop: agentLoopJob },
  })
}

export type AgentLoopDurably = ReturnType<typeof build>

/** Create a fresh instance per process so worker restarts share only SQLite. */
export function createAgentDurably(): AgentLoopDurably {
  return build()
}
