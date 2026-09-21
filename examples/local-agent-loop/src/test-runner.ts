/**
 * Local test runner: `node --test` inside the execution workdir.
 *
 * Runs through the cancel-aware `runChild` helper so Durably cancel /
 * lease-loss kills ONLY the owned test process and the caller awaits its
 * exit before resuming. Never broadcasts to unrelated processes.
 */
import { runChild } from './child.js'

export interface LocalTestResult {
  passed: boolean
  stdout: string
  exitCode: number | null
  elapsedMs: number
}

export function runLocalTests(
  workdir: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<LocalTestResult> {
  const started = Date.now()
  return runChild('npm', ['test', '--silent'], {
    cwd: workdir,
    timeoutMs,
    ...(signal ? { signal } : {}),
  }).then(
    (res) => ({
      passed: res.code === 0,
      stdout: `${res.stdout}${res.stderr}`.slice(-8000),
      exitCode: res.code,
      elapsedMs: Date.now() - started,
    }),
    (err: unknown) => {
      if (err instanceof Error && err.name === 'SpawnCancelledError') throw err
      if (err instanceof Error && err.message.includes('timed out')) {
        return {
          passed: false,
          stdout: `npm test timed out after ${timeoutMs}ms`,
          exitCode: null,
          elapsedMs: Date.now() - started,
        }
      }
      throw err
    },
  )
}
