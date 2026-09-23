import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { createDurably } from '@coji/durably'
/** Durably instance (local SQLite via better-sqlite3). */
import Database from 'better-sqlite3'
import { SqliteDialect } from 'kysely'

import { createAgentLoopJob } from './factory/job.js'

/**
 * Where the database and every run's data live: outside both the durably
 * checkout and the target repository, so every command finds the same
 * database without arguments. Deliberately not overridable by users.
 */
export function defaultStateRoot(): string {
  return join(homedir(), '.local', 'state', 'local-agent-loop')
}

export function dbPath(stateRoot: string = defaultStateRoot()): string {
  return join(stateRoot, 'local-agent-loop.db')
}

export interface AgentDurablyOptions {
  /**
   * Test-only: put the database and all run data under another root. Not
   * exposed as a CLI flag or environment variable.
   */
  stateRoot?: string
}

function build(options: AgentDurablyOptions) {
  const stateRoot = options.stateRoot ?? defaultStateRoot()
  // better-sqlite3 creates the file but not its directory.
  mkdirSync(stateRoot, { recursive: true })
  const database = new Database(dbPath(stateRoot))
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
    jobs: { agentLoop: createAgentLoopJob({ stateRoot }) },
  })
}

export type AgentLoopDurably = ReturnType<typeof build>

/** Create a fresh instance per process so worker restarts share only SQLite. */
export function createAgentDurably(
  options: AgentDurablyOptions = {},
): AgentLoopDurably {
  return build(options)
}
