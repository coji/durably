import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

/** Where versions before the fixed state root kept the database. */
export function legacyDbPath(): string {
  return join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    'local-agent-loop.db',
  )
}

/**
 * A one-line warning when the checkout still has a database from before the
 * fixed state root. Runs in it are not read, and are not migrated.
 */
export function legacyDbWarning(
  legacy: string = legacyDbPath(),
  current: string = dbPath(),
): string | null {
  if (!existsSync(legacy)) return null
  return `warning: ${legacy} is from an older version and is no longer read; the database is now ${current}. Finish or discard runs in the old one with the older version (see README "Upgrading").`
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
  return withDatabase(database, stateRoot)
}

function withDatabase(database: Database.Database, stateRoot: string) {
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

/**
 * Open the existing database for reading only, for the web UI. Returns null
 * when there is no database yet: nothing is created, not even the state
 * directory. The connection is opened read-only, and the caller must never
 * call `migrate()` or `init()` on the result.
 */
export function openReadOnlyAgentDurably(
  options: AgentDurablyOptions = {},
): AgentLoopDurably | null {
  const stateRoot = options.stateRoot ?? defaultStateRoot()
  const path = dbPath(stateRoot)
  if (!existsSync(path)) return null
  return withDatabase(
    new Database(path, { readonly: true, fileMustExist: true }),
    stateRoot,
  )
}
