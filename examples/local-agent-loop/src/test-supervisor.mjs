/**
 * Crash-surviving acceptance-test watchdog.
 *
 * If the Durably worker is SIGKILLed, this process is re-parented but keeps
 * its own deadline and terminates the permission-restricted test child.
 */
import { spawn } from 'node:child_process'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'

const [timeoutText, cwd, ...args] = process.argv.slice(2)
const timeoutMs = Number(timeoutText)
if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !cwd) {
  console.error('invalid test supervisor arguments')
  process.exit(125)
}

const child = spawn(process.execPath, args, {
  cwd,
  env: { ...process.env, NODE_OPTIONS: '' },
  stdio: 'inherit',
})

const cleanup = () => {
  try {
    process.chdir(tmpdir())
    rmSync(cwd, { recursive: true, force: true })
  } catch (error) {
    console.error(`test scratch cleanup failed: ${String(error)}`)
  }
}

let timedOut = false
const timer = setTimeout(() => {
  timedOut = true
  child.kill('SIGKILL')
}, timeoutMs)
timer.unref?.()

const stop = () => child.kill('SIGKILL')
process.once('SIGINT', stop)
process.once('SIGTERM', stop)

child.once('error', (error) => {
  clearTimeout(timer)
  cleanup()
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(125)
})
child.once('close', (code, signal) => {
  clearTimeout(timer)
  cleanup()
  if (timedOut) {
    console.error(`acceptance suite timed out after ${timeoutMs}ms`)
    process.exit(124)
  }
  if (signal) process.exit(128)
  process.exit(code ?? 1)
})
