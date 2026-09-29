import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createDurably } from '@coji/durably'
/** Durably instance (local SQLite via better-sqlite3). */
import Database from 'better-sqlite3'
import { SqliteDialect } from 'kysely'

import { TERMINAL_STATUSES } from './engine/terminal.js'
import { createAgentLoopJob } from './factory/job.js'
import { reviewSnapshotsDirOf, runRootOf } from './factory/layout.js'
import { removeQuietly } from './targets/repo.js'

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

/** Who holds a state root's worker lock, as that worker recorded it. */
export interface WorkerLockHolder {
  pid: number
  /** The checkout the worker was started from. */
  checkout: string
  startedAt: string
}

export type WorkerLockResult =
  | { acquired: true; release: () => void }
  /** Held by a live worker; `holder` is null when it has not said who it is. */
  | { acquired: false; holder: WorkerLockHolder | null }

/** The file the operating system locks, and the note beside it. */
function workerLockPaths(stateRoot: string = defaultStateRoot()) {
  return {
    lock: join(stateRoot, 'worker.lock'),
    holder: join(stateRoot, 'worker.json'),
  }
}

/**
 * How long `acquireWorkerLock` retries a busy lock before refusing. This
 * rides out a `probeWorkerLock` caller's momentary shared lock (held only
 * for a single read); a second worker still holds the lock exclusively for
 * as long as it runs, so it is still refused once this window elapses.
 */
const WORKER_LOCK_ACQUIRE_TIMEOUT_MS = 2000

/**
 * Take the state root's worker lock: one worker per database. The lock is an
 * exclusive SQLite transaction on a file of its own, which SQLite holds with
 * the operating system's file lock, so it lasts exactly as long as the
 * process: a worker killed with `kill -9` leaves no lock behind, only its
 * note, which the next worker overwrites. The note says who holds the lock,
 * because a locked file cannot be read.
 */
export function acquireWorkerLock(
  stateRoot: string = defaultStateRoot(),
  checkout: string = join(dirname(fileURLToPath(import.meta.url)), '..'),
): WorkerLockResult {
  mkdirSync(stateRoot, { recursive: true })
  const paths = workerLockPaths(stateRoot)
  // Retry briefly: a `probeWorkerLock` caller holds a shared lock only for a
  // single read, so a short busy timeout lets a worker start while a probe
  // loop runs. A second worker keeps the lock exclusively for as long as it
  // runs, so it is still refused once the timeout elapses.
  const lock = new Database(paths.lock, {
    timeout: WORKER_LOCK_ACQUIRE_TIMEOUT_MS,
  })
  try {
    lock.exec('BEGIN EXCLUSIVE')
  } catch (error) {
    lock.close()
    if ((error as { code?: unknown }).code !== 'SQLITE_BUSY') throw error
    return { acquired: false, holder: readHolder(paths.holder) }
  }
  const holder: WorkerLockHolder = {
    pid: process.pid,
    checkout,
    startedAt: new Date().toISOString(),
  }
  const temporary = `${paths.holder}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(holder)}\n`)
  renameSync(temporary, paths.holder)
  let held = true
  return {
    acquired: true,
    release: () => {
      if (!held) return
      held = false
      // Only this worker's own note; a note is never left pointing at a
      // worker that has let go.
      if (readHolder(paths.holder)?.pid === process.pid)
        rmSync(paths.holder, { force: true })
      lock.close()
    },
  }
}

/** Whether a worker holds a state root's lock, and who it says it is. */
export interface WorkerPresence {
  running: boolean
  /** The holder's note; null when no worker runs or it has not written one. */
  holder: WorkerLockHolder | null
}

/**
 * Look at a state root's worker lock without taking it. The lock, not the
 * note, decides: a worker killed with `kill -9` leaves its note behind, but
 * not its lock. A read-only connection asks for a shared lock, which the
 * worker's exclusive one refuses. Nothing is created: no lock file means no
 * worker has ever started on this root.
 */
export function probeWorkerLock(
  stateRoot: string = defaultStateRoot(),
): WorkerPresence {
  const paths = workerLockPaths(stateRoot)
  let lock: Database.Database
  try {
    lock = new Database(paths.lock, {
      readonly: true,
      fileMustExist: true,
      timeout: 0,
    })
  } catch {
    return { running: false, holder: null }
  }
  try {
    lock.prepare('SELECT count(*) FROM sqlite_master').get()
    return { running: false, holder: null }
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'SQLITE_BUSY') throw error
    return { running: true, holder: readHolder(paths.holder) }
  } finally {
    lock.close()
  }
}

function readHolder(path: string): WorkerLockHolder | null {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as WorkerLockHolder
    return typeof v.pid === 'number' && typeof v.checkout === 'string'
      ? v
      : null
  } catch {
    return null
  }
}

export interface AgentDurablyOptions {
  /**
   * Test-only: put the database and all run data under another root. Not
   * exposed as a CLI flag or environment variable.
   */
  stateRoot?: string
  /**
   * Demo seeding only: runs one worker leases at once. The CLI worker keeps
   * Durably's default of one.
   */
  maxConcurrentRuns?: number
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
  return withDatabase(database, stateRoot, options.maxConcurrentRuns)
}

/** How long a run's lease lasts; a worker renews it only while running it. */
export const LEASE_MS = 10000

function withDatabase(
  database: Database.Database,
  stateRoot: string,
  maxConcurrentRuns?: number,
) {
  const dialect = new SqliteDialect({ database })
  const base = createDurably({
    dialect,
    pollingIntervalMs: 500,
    leaseRenewIntervalMs: 1000,
    leaseMs: LEASE_MS,
    preserveSteps: true,
    ...(maxConcurrentRuns ? { maxConcurrentRuns } : {}),
  })
  // A baseline reuse decision reads the one run the reuse index names from
  // this same database.
  const durably = base.register({
    agentLoop: createAgentLoopJob({
      stateRoot,
      baselineStore: {
        getCompletedStep: (runId, name) =>
          base.storage.getCompletedStep(runId, name),
        getStepAttempts: (runId) => base.getStepAttempts(runId),
      },
    }),
  })
  // The worker removes a run's review snapshots itself: after each review
  // round, before every other stage, when the run fails, is cancelled or
  // finishes, and at startup for runs that have already ended
  // (`sweepReviewSnapshots`). A cancel from another process is seen by the
  // worker only as a lost lease, after which it leaves the trees alone, so
  // the cancel also removes them here, best effort: an extraction the
  // worker had under way at that moment can still leave a tree, which the
  // next worker start removes. The cancel has happened, so a failure here is
  // not reported as a failed cancel.
  const cancel = durably.cancel.bind(durably)
  durably.cancel = async (runId: string) => {
    await cancel(runId)
    await removeQuietly(reviewSnapshotsDirOf(runRootOf(stateRoot, runId)))
  }
  // The state root travels with the instance, so a sweep never reads one
  // database's runs against another root's files.
  return Object.assign(durably, { stateRoot })
}

export type AgentLoopDurably = ReturnType<typeof build>

/**
 * Remove the review snapshots of every run that has ended, or no longer
 * exists. The worker calls it at startup: a worker that died, or a cancel
 * from another process that raced an extraction, can leave them behind, and
 * no step of an ended run will run again to remove them. A run that may
 * still run keeps its own. The runs are those under the instance's own
 * state root. Only a run directory that still has a `review-snapshots`
 * entry is looked up, so the cost is one existence check per retained run
 * and one lookup per run with snapshots. Returns the runs whose snapshots
 * were removed.
 */
export async function sweepReviewSnapshots(
  durably: AgentLoopDurably,
): Promise<string[]> {
  const { stateRoot } = durably
  let runIds: string[]
  try {
    runIds = await readdir(join(stateRoot, 'runs'))
  } catch {
    return []
  }
  const swept: string[] = []
  for (const runId of runIds) {
    const dir = reviewSnapshotsDirOf(runRootOf(stateRoot, runId))
    if (!existsSync(dir)) continue
    const run = await durably.getRun(runId)
    if (run && !TERMINAL_STATUSES.includes(run.status)) continue
    await removeQuietly(dir)
    swept.push(runId)
  }
  return swept
}

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
