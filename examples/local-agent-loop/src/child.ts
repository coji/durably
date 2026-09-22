/** Cancel-aware subprocess execution for the process that spawned it. */
import { spawn, type SpawnOptions } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

const owned = new Set<number>()

export function ownedChildPids(): number[] {
  return [...owned]
}

/**
 * Kill every child this process still owns. Children lead their own process
 * group, so a terminal Ctrl-C no longer reaches them; the worker's shutdown
 * path calls this so an interrupted run leaves no agent CLI behind.
 */
export function killOwnedChildren(signal: NodeJS.Signals = 'SIGKILL'): void {
  for (const pid of owned) {
    try {
      if (ownsProcessGroup) process.kill(-pid, signal)
      else process.kill(pid, signal)
    } catch {
      // Already exited.
    }
  }
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

function appendTail(current: string, text: string, limit: number): string {
  const next = current + text
  return next.length <= limit ? next : next.slice(-limit)
}

/** POSIX only: a detached child leads its own group, so a negative pid
 * signals the CLI wrapper together with the model and tool subprocesses it
 * spawned. Windows has no process groups here, so the child is signalled
 * directly. */
const ownsProcessGroup = process.platform !== 'win32'

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
    // Own a process group so a timeout or a lost lease kills the agent CLI's
    // own subprocesses too. Signalling only the wrapper orphans them, and they
    // keep writing into the workdir after the candidate has been sealed.
    ...(ownsProcessGroup ? { detached: true } : {}),
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
      const pid = child.pid
      if (ownsProcessGroup && pid !== undefined) process.kill(-pid, killSignal)
      else child.kill(killSignal)
    } catch {
      // ESRCH means the group already exited; the close/error listener
      // remains authoritative either way.
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
      // Decoding each chunk on its own splits any multi-byte character that
      // straddles a chunk boundary into replacement characters, and that text
      // is fed back to the agent as the repair prompt.
      const outDecoder = new StringDecoder('utf8')
      const errDecoder = new StringDecoder('utf8')
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout = appendTail(stdout, outDecoder.write(chunk), maxOutputChars)
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = appendTail(stderr, errDecoder.write(chunk), maxOutputChars)
      })
      child.once('error', rejectOnce)
      child.once('close', (code) => {
        if (settled) return
        settled = true
        cleanup()
        stdout = appendTail(stdout, outDecoder.end(), maxOutputChars)
        stderr = appendTail(stderr, errDecoder.end(), maxOutputChars)
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
