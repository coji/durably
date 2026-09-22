/** Cancel-aware subprocess execution with identity-checked restart recovery. */
import { execFileSync, spawn, type SpawnOptions } from 'node:child_process'
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

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
  signal?: AbortSignal
  timeoutMs: number
  killSignal?: NodeJS.Signals
  maxOutputChars?: number
  pidFile?: string
}

/** Stable identity used to distinguish a live process from a reused pid. */
export function processStartTime(pid: number): string | null {
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

async function waitForIdentityToDisappear(
  pid: number,
  startedAt: string,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const live = processStartTime(pid)
    if (live === null || live !== startedAt) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`process ${pid} did not exit after signal; marker retained`)
}

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
  if (
    typeof marker.pid !== 'number' ||
    typeof marker.startedAt !== 'string' ||
    marker.startedAt.length === 0
  ) {
    // An unauthenticated pid is never safe to signal.
    await rm(pidFile, { force: true })
    return 'stale-marker-removed'
  }
  const liveStart = processStartTime(marker.pid)
  if (liveStart === null || liveStart !== marker.startedAt) {
    await rm(pidFile, { force: true })
    return 'clean'
  }
  try {
    process.kill(marker.pid, killSignal)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
  }
  await waitForIdentityToDisappear(marker.pid, marker.startedAt)
  await rm(pidFile, { force: true })
  return 'residual-killed'
}

export interface PidReconcileSummary {
  checked: number
  cleaned: number
  residualKilled: number
}

export async function reconcileRunPidFiles(
  runsRoot: string,
): Promise<PidReconcileSummary> {
  const summary: PidReconcileSummary = {
    checked: 0,
    cleaned: 0,
    residualKilled: 0,
  }
  let runIds: string[]
  try {
    runIds = await readdir(runsRoot)
  } catch {
    return summary
  }
  for (const runId of runIds) {
    let entries: string[]
    try {
      entries = await readdir(join(runsRoot, runId))
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.endsWith('.pid')) continue
      summary.checked += 1
      const result = await reconcilePidFile(join(runsRoot, runId, entry))
      if (result === 'residual-killed') summary.residualKilled += 1
      else summary.cleaned += 1
    }
  }
  return summary
}

function appendTail(current: string, chunk: Buffer, limit: number): string {
  const next = current + chunk.toString()
  return next.length <= limit ? next : next.slice(-limit)
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
    env: explicitEnv,
    ...spawnOptions
  } = options
  const started = Date.now()
  if (signal?.aborted) throw new SpawnCancelledError('aborted before spawn')

  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...explicitEnv }
  for (const key of Object.keys(childEnv)) {
    if (key.startsWith('NODE_TEST_')) delete childEnv[key]
  }
  const child = spawn(command, args, {
    ...spawnOptions,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (child.pid !== undefined) owned.add(child.pid)

  let stdout = ''
  let stderr = ''
  let killed = false
  let terminationError: Error | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  let settled = false
  const kill = () => {
    killed = true
    try {
      child.kill(killSignal)
    } catch {
      // The close/error listener remains the authority for completion.
    }
  }
  const onAbort = () => {
    terminationError = new SpawnCancelledError(
      `${command} cancelled (lease lost or run cancelled); child killed`,
    )
    kill()
  }
  const cleanupListeners = () => {
    if (timer) clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }

  // Attach every lifecycle listener immediately after spawn. Marker setup may
  // perform synchronous `ps` and filesystem I/O, but a fast exit is retained.
  const exit = new Promise<SpawnResult>((resolve, reject) => {
    const rejectOnce = (error: Error) => {
      if (settled) return
      settled = true
      cleanupListeners()
      reject(error)
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout = appendTail(stdout, chunk, maxOutputChars)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = appendTail(stderr, chunk, maxOutputChars)
    })
    child.once('error', rejectOnce)
    child.once('close', (code) => {
      if (settled) return
      settled = true
      cleanupListeners()
      if (terminationError) {
        reject(terminationError)
        return
      }
      resolve({
        code,
        stdout,
        stderr,
        elapsedMs: Date.now() - started,
        killed,
      })
    })
    timer = setTimeout(() => {
      terminationError = new Error(
        `${command} timed out after ${timeoutMs}ms (child killed)`,
      )
      kill()
    }, timeoutMs)
    timer.unref?.()
    signal?.addEventListener('abort', onAbort, { once: true })
  })

  try {
    if (pidFile && child.pid !== undefined && child.exitCode === null) {
      const identity = processStartTime(child.pid)
      if (identity === null && child.exitCode === null) {
        terminationError = new Error(
          `cannot establish process identity for ${child.pid}; child killed`,
        )
        kill()
      } else if (identity !== null && child.exitCode === null) {
        try {
          await writeFile(
            pidFile,
            JSON.stringify({ pid: child.pid, startedAt: identity }),
          )
        } catch (error) {
          terminationError = new Error(
            `cannot persist pid marker: ${error instanceof Error ? error.message : String(error)}`,
          )
          kill()
        }
      }
    }
    return await exit
  } finally {
    if (child.pid !== undefined) owned.delete(child.pid)
    if (pidFile) await rm(pidFile, { force: true }).catch(() => {})
  }
}
