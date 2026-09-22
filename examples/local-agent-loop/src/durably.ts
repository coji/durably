import { fileURLToPath } from 'node:url'

import { createDurably } from '@coji/durably'
/** Durably instance (local SQLite via better-sqlite3). */
import Database from 'better-sqlite3'
import { SqliteDialect } from 'kysely'

import { agentLoopJob } from './factory/job.js'

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
  const database = new Database(dbPath())
  // The documented workflow is two processes: a polling worker in one
  // terminal and the CLI in another. Under the default rollback journal a
  // writer locks the whole database, so `demo approve` and `demo report`
  // contend with the worker's 500ms poll and eventually die on SQLITE_BUSY.
  database.pragma('journal_mode = WAL')
  const dialect = new SqliteDialect({ database })
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
