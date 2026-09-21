/**
 * Cancel-aware subprocess spawning for local agent execution.
 *
 * - Every spawn registers its pid in a process-local owned set; abort or
 *   timeout kills ONLY that child (never a process-group broadcast, never an
 *   unrelated pid).
 * - The caller awaits the exit after killing, so a restarted worker resumes
 *   only after the previous child is confirmed gone.
 * - A pid marker file lets a restarted worker reconcile a child left behind
 *   by a `kill -9` (pid + start-time checked before any signal is sent).
 *
 * Durably's lease protects DB writes; it does NOT make the external CLI run
 * exactly once. This module narrows the gap but does not close it — see README.
 */
import { execFileSync, spawn, type SpawnOptions } from 'node:child_process'
import { readFile, rm, writeFile } from 'node:fs/promises'

/** Pids owned by this process (spawned through this module, still running). */
const owned = new Set<number>()

export function ownedChildPids(): number[] {
  return [...owned]
}

export interface SpawnResult {
  code: number | null
  stdout: string
  stderr: string
  elapsedMs: number
  killed: boolean
}

export class SpawnCancelledError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SpawnCancelledError'
  }
}

export interface RunChildOptions extends SpawnOptions {
  /** Durably step signal (cancel / lease-loss). */
  signal?: AbortSignal
  timeoutMs: number
  /** Kill signal for timeout/cancel (default SIGKILL). */
  killSignal?: NodeJS.Signals
  /** Truncate captured output to this many chars (default 8000). */
  maxOutputChars?: number
  /** Write a pid marker for post-kill reconciliation (optional path). */
  pidFile?: string
}

/** Start time of a live pid (`ps -o lstart=`), or null when not alive. */
function pidStartTime(pid: number): string | null {
  try {
    const out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      timeout: 5000,
    }).trim()
    return out.length > 0 ? out : null
  } catch {
    return null
  }
}

/**
 * Reconcile a pid marker left by a previous worker that died (e.g. kill -9).
 * Sends a signal ONLY when the pid is alive AND its start time still matches
 * the marker (guards against pid reuse). Returns what happened.
 */
export async function reconcilePidFile(
  pidFile: string,
  killSignal: NodeJS.Signals = 'SIGKILL',
): Promise<'clean' | 'stale-marker-removed' | 'residual-killed'> {
  let raw: string
  try {
    raw = await readFile(pidFile, 'utf8')
  } catch {
    return 'clean'
  }
  let marker: { pid?: number; startedAt?: string }
  try {
    marker = JSON.parse(raw) as { pid?: number; startedAt?: string }
  } catch {
    await rm(pidFile, { force: true })
    return 'stale-marker-removed'
  }
  if (typeof marker.pid !== 'number') {
    await rm(pidFile, { force: true })
    return 'stale-marker-removed'
  }
  const liveStart = pidStartTime(marker.pid)
  if (liveStart === null) {
    await rm(pidFile, { force: true })
    return 'clean'
  }
  if (marker.startedAt && liveStart !== marker.startedAt) {
    // Pid was reused by an unrelated process — never touch it.
    await rm(pidFile, { force: true })
    return 'clean'
  }
  try {
    process.kill(marker.pid, killSignal)
  } catch {
    // Already gone (race); fall through to cleanup.
  }
  await rm(pidFile, { force: true })
  return 'residual-killed'
}

export async function runChild(
  command: string,
  args: string[],
  options: RunChildOptions,
): Promise<SpawnResult> {
  const {
    signal,
    timeoutMs,
    killSignal = 'SIGKILL',
    maxOutputChars = 8000,
    pidFile,
    ...spawnOptions
  } = options
  const started = Date.now()
  if (signal?.aborted) {
    throw new SpawnCancelledError('aborted before spawn')
  }
  const child = spawn(command, args, {
    ...spawnOptions,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (child.pid !== undefined) owned.add(child.pid)
  if (pidFile && child.pid !== undefined) {
    const liveStart = pidStartTime(child.pid)
    await writeFile(
      pidFile,
      JSON.stringify({ pid: child.pid, startedAt: liveStart }),
    ).catch(() => {})
  }
  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (d: Buffer) => {
    stdout += d.toString()
  })
  child.stderr?.on('data', (d: Buffer) => {
    stderr += d.toString()
  })

  let killed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const cleanup = () => {
    if (timer) clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
  const kill = () => {
    killed = true
    try {
      child.kill(killSignal)
    } catch {
      // Already exited; exit handler below still resolves.
    }
  }
  const onAbort = () => kill()

  const exit = new Promise<SpawnResult>((resolve, reject) => {
    timer = setTimeout(() => {
      kill()
      reject(
        new Error(`${command} timed out after ${timeoutMs}ms (child killed)`),
      )
    }, timeoutMs)
    timer.unref?.()
    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', (err) => {
      cleanup()
      reject(err)
    })
    child.on('close', (code) => {
      cleanup()
      if (signal?.aborted && killed) {
        reject(
          new SpawnCancelledError(
            `${command} cancelled (lease lost or run cancelled); child killed`,
          ),
        )
        return
      }
      resolve({
        code,
        stdout: stdout.slice(-maxOutputChars),
        stderr: stderr.slice(-maxOutputChars),
        elapsedMs: Date.now() - started,
        killed,
      })
    })
  })

  try {
    return await exit
  } finally {
    if (child.pid !== undefined) owned.delete(child.pid)
    if (pidFile) await rm(pidFile, { force: true }).catch(() => {})
  }
}
