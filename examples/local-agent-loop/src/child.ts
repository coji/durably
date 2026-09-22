/** Cancel-aware subprocess execution for the process that spawned it. */
import { spawn, type SpawnOptions } from 'node:child_process'

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
    env: explicitEnv,
    ...spawnOptions
  } = options
  if (signal?.aborted) throw new SpawnCancelledError('aborted before spawn')
  const started = Date.now()
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
  const kill = () => {
    killed = true
    try {
      child.kill(killSignal)
    } catch {
      // The close/error listener remains authoritative.
    }
  }
  const onAbort = () => {
    terminationError = new SpawnCancelledError(
      `${command} cancelled (lease lost or run cancelled); child killed`,
    )
    kill()
  }

  try {
    return await new Promise<SpawnResult>((resolve, reject) => {
      let settled = false
      const cleanup = () => {
        if (timer) clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
      }
      const rejectOnce = (error: Error) => {
        if (settled) return
        settled = true
        cleanup()
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
        cleanup()
        if (terminationError) return reject(terminationError)
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
  } finally {
    if (child.pid !== undefined) owned.delete(child.pid)
  }
}
