/** Local test runner: Mac subprocess (`npm test`) inside the execution workdir. */
import { spawn } from 'node:child_process'

export interface LocalTestResult {
  passed: boolean
  stdout: string
  exitCode: number | null
  elapsedMs: number
}

export function runLocalTests(
  workdir: string,
  timeoutMs: number,
): Promise<LocalTestResult> {
  const started = Date.now()
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['test', '--silent'], {
      cwd: workdir,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString()
    })
    child.stderr.on('data', (d: Buffer) => {
      out += d.toString()
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`npm test timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    timer.unref()
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        passed: code === 0,
        stdout: out.slice(-8000),
        exitCode: code,
        elapsedMs: Date.now() - started,
      })
    })
  })
}
