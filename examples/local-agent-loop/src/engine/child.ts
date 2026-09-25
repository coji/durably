/** Cancel-aware subprocess execution for the process that spawned it. */
import { spawn, type SpawnOptions } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import type { Readable, Writable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'

/**
 * The longest delay Node's timers keep: a larger one fires after about 1 ms,
 * which would kill a child or abort a call right after its start.
 */
export const MAX_TIMEOUT_MS = 2_147_483_647

/** A delay every timer can take: callers that add grace cannot overflow it. */
export function timerDelay(ms: number): number {
  return Math.min(ms, MAX_TIMEOUT_MS)
}

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
  /**
   * Why `stdoutFile` / `stderrFile` could not be written in full, or null. A
   * log failure never replaces the child's own exit code.
   */
  logError: string | null
}

export class SpawnCancelledError extends Error {
  /** False when the signal was already aborted: no child, no log files. */
  readonly spawned: boolean
  constructor(message: string, spawned = true) {
    super(message)
    this.name = 'SpawnCancelledError'
    this.spawned = spawned
  }
}

/**
 * The log write error carried by a timeout or cancel rejection from
 * `runChild`, so the incomplete log is still flagged when there is no result.
 */
export function childLogError(error: unknown): string | null {
  return (error as { logError?: string | null } | null)?.logError ?? null
}

export interface RunChildOptions extends SpawnOptions {
  signal?: AbortSignal
  timeoutMs: number
  killSignal?: NodeJS.Signals
  maxOutputChars?: number
  /**
   * Also write every byte of stdout / stderr to these files, uncapped. The
   * files are complete when the promise settles, including after a timeout
   * or a cancel, so whatever the child printed before it was killed is kept.
   */
  stdoutFile?: string
  stderrFile?: string
}

/**
 * A raw byte log fed from `source`. It honours the file's backpressure: when a
 * write fills the stream's buffer, `source` is paused until the file drains,
 * so a child that prints faster than the disk writes cannot grow memory
 * without bound. A write error is reported instead of crashing, and `source`
 * is resumed so the child is never left blocked on a full pipe.
 */
export function teeLog(source: Readable | null, stream: Writable) {
  let failure: Error | null = null
  const resume = () => source?.resume()
  stream.on('error', (error) => {
    failure ??= error
    stream.off('drain', resume)
    resume()
  })
  return {
    write: (chunk: Buffer) => {
      if (failure || stream.write(chunk)) return
      source?.pause()
      stream.once('drain', resume)
    },
    close: () =>
      new Promise<Error | null>((resolve) => {
        if (stream.destroyed) return resolve(failure)
        stream.end(() => resolve(failure))
        stream.once('error', () => resolve(failure))
      }),
  }
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
    stdoutFile,
    stderrFile,
    env: explicitEnv,
    ...spawnOptions
  } = options
  if (signal?.aborted)
    throw new SpawnCancelledError('aborted before spawn', false)
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
  const outLog = stdoutFile
    ? teeLog(child.stdout, createWriteStream(stdoutFile))
    : null
  const errLog = stderrFile
    ? teeLog(child.stderr, createWriteStream(stderrFile))
    : null
  const closeLogs = async (): Promise<Error | null> => {
    const [outError, errError] = await Promise.all([
      outLog?.close() ?? null,
      errLog?.close() ?? null,
    ])
    return outError ?? errError
  }

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
        void closeLogs().then(() => reject(error))
      }
      // Decoding each chunk on its own splits any multi-byte character that
      // straddles a chunk boundary into replacement characters, and that text
      // is fed back to the agent as the repair prompt.
      const outDecoder = new StringDecoder('utf8')
      const errDecoder = new StringDecoder('utf8')
      child.stdout?.on('data', (chunk: Buffer) => {
        outLog?.write(chunk)
        stdout = appendTail(stdout, outDecoder.write(chunk), maxOutputChars)
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        errLog?.write(chunk)
        stderr = appendTail(stderr, errDecoder.write(chunk), maxOutputChars)
      })
      child.once('error', rejectOnce)
      child.once('close', (code) => {
        if (settled) return
        settled = true
        cleanup()
        stdout = appendTail(stdout, outDecoder.end(), maxOutputChars)
        stderr = appendTail(stderr, errDecoder.end(), maxOutputChars)
        void closeLogs().then((logError) => {
          if (terminationError)
            return reject(
              Object.assign(terminationError, {
                logError: logError?.message ?? null,
              }),
            )
          resolve({
            code,
            stdout,
            stderr,
            elapsedMs: Date.now() - started,
            killed,
            logError: logError?.message ?? null,
          })
        })
      })
      timer = setTimeout(() => {
        terminationError = new Error(
          `${command} timed out after ${timeoutMs}ms (child killed)`,
        )
        kill()
      }, timerDelay(timeoutMs))
      timer.unref?.()
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  } finally {
    if (child.pid !== undefined) owned.delete(child.pid)
  }
}
