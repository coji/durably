/**
 * Immutable acceptance tests for the bundled sample subject.
 *
 * The agent must never be able to rewrite the tests it is graded by:
 *
 * - At `setup`, `subject/test/*` is copied to `<run>/acceptance/` and its
 *   sha256 recorded.
 * - Before every verification, the workdir's `test/` tree is hashed and
 *   compared to the snapshot. A mismatch fails the run with
 *   `acceptance-tampered` — the agent cannot green its own suite by editing
 *   tests.
 * - Grading runs the PRISTINE snapshot files with a sample-fixed command
 *   (`node --test test/`), never the workdir's `npm test`: rewriting
 *   `package.json`'s test script cannot bypass grading either.
 *
 * Execution layout: the snapshot test files are copied into a scratch dir
 * whose `src` is a symlink to the workdir `src`, so the exact bytes graded
 * are the snapshot bytes, linked against the agent's live code. The command
 * argv is fixed in code; no agent-editable file is consulted.
 *
 * This whole file is policy for one subject. A factory pointed at a real
 * repository replaces it with that repository's own pinned check.
 */
import { cp, mkdir, rm, symlink } from 'node:fs/promises'
import { join } from 'node:path'

import { runChild } from '../engine/child.js'
import type { VerificationLog } from '../engine/providers/types.js'
import { hashDir, readTree } from '../engine/tree.js'
import { checkLog, prepareCheckLogs } from '../engine/verification.js'

/** Snapshot the pristine subject tests for this run. */
export async function snapshotAcceptance(
  subjectTestDir: string,
  acceptanceDir: string,
): Promise<{ files: number; hash: string }> {
  await mkdir(acceptanceDir, { recursive: true })
  await cp(subjectTestDir, acceptanceDir, { recursive: true })
  const hash = await hashDir(acceptanceDir, false)
  const files = (await readTree(acceptanceDir)).filter(
    (entry) => entry.type === 'file',
  ).length
  return { files, hash }
}

/**
 * Verify the workdir tests still match the snapshot. Throws on tamper so the
 * run fails closed instead of grading edited tests.
 */
export async function verifyAcceptanceIntact(
  workdirTestDir: string,
  expectedHash: string,
): Promise<{ hash: string }> {
  let actual: string
  try {
    actual = await hashDir(workdirTestDir, false)
  } catch (err) {
    throw new Error(
      `acceptance-tampered: cannot read workdir tests: ${err instanceof Error ? err.message : String(err)}`,
    )
  }
  if (actual !== expectedHash) {
    throw new Error(
      `acceptance-tampered: workdir test/ differs from the immutable snapshot (expected ${expectedHash.slice(0, 12)}, got ${actual.slice(0, 12)}). Acceptance tests must not be modified.`,
    )
  }
  return { hash: actual }
}

export interface AcceptanceRunSpec {
  workdir: string
  acceptanceDir: string
  /** Rebuilt on every grading run (outside the agent's workdir). */
  scratchDir: string
  timeoutMs: number
  signal?: AbortSignal
  /**
   * Directory for this grading attempt's full stdout and stderr. Outside the
   * scratch dir, which is removed after grading.
   */
  logDir?: string
}

export interface AcceptanceRunResult {
  passed: boolean
  stdout: string
  exitCode: number | null
  elapsedMs: number
  log: VerificationLog | null
}

/**
 * Grade the agent's `src/` against the pristine snapshot tests.
 *
 * Fail-closed order: tamper check first (throws `acceptance-tampered`), then
 * the sample-fixed `node --test` argv over the SNAPSHOT test files (no shell,
 * no workdir `package.json`, no `npm`). The workdir's `npm test` is never
 * executed, so a rewritten test script cannot accidentally become the pass
 * criterion; an empty snapshot (nothing to grade) throws instead of passing
 * vacuously. This is consistency checking for a local development demo, not
 * a sandbox for adversarial Candidate code.
 */
export async function runAcceptanceSuite(
  spec: AcceptanceRunSpec,
  expectedHash: string,
): Promise<AcceptanceRunResult> {
  const started = Date.now()
  await verifyAcceptanceIntact(join(spec.workdir, 'test'), expectedHash)
  const acceptanceHash = await hashDir(spec.acceptanceDir, false)
  if (acceptanceHash !== expectedHash) {
    throw new Error(
      `acceptance-tampered: fixed acceptance snapshot differs from its saved hash (expected ${expectedHash.slice(0, 12)}, got ${acceptanceHash.slice(0, 12)})`,
    )
  }
  const scratchTestDir = join(spec.scratchDir, 'test')
  await rm(spec.scratchDir, { recursive: true, force: true })
  await mkdir(scratchTestDir, { recursive: true })
  await cp(spec.acceptanceDir, scratchTestDir, {
    recursive: true,
  })
  await symlink(
    join(spec.workdir, 'src'),
    join(spec.scratchDir, 'src'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  const testFiles = (await readTree(scratchTestDir))
    .filter((entry) => entry.type === 'file')
    .map((f) => f.path)
    .filter((p) => p.endsWith('.test.js'))
    .sort()
    .map((p) => join(spec.scratchDir, 'test', p))
  if (testFiles.length === 0) {
    throw new Error(
      'acceptance-tampered: snapshot contains no *.test.js files to grade',
    )
  }
  // Node's own per-test timeout must get a chance to fire before the hard
  // kill. Given the same deadline the SIGKILL wins, and the verdict degrades
  // to a bare "timed out" with no indication of which test hung — that string
  // is exactly what the repair prompt receives. The headroom stays small
  // because a synchronous infinite loop blocks node's timer entirely, leaving
  // the kill as the only way out.
  const killDeadlineMs =
    spec.timeoutMs + Math.min(5000, Math.max(1000, spec.timeoutMs / 4))
  const logs = await prepareCheckLogs(spec.logDir)
  try {
    const res = await runChild(
      process.execPath,
      [
        '--test',
        '--test-isolation=none',
        `--test-timeout=${spec.timeoutMs}`,
        ...testFiles,
      ],
      {
        cwd: spec.scratchDir,
        timeoutMs: killDeadlineMs,
        env: { NODE_OPTIONS: '' },
        ...(spec.signal ? { signal: spec.signal } : {}),
        ...logs,
      },
    )
    return {
      passed: res.code === 0,
      stdout: `${res.stdout}${res.stderr}`.slice(-8000),
      exitCode: res.code,
      elapsedMs: Date.now() - started,
      log: checkLog(logs, res.code),
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'SpawnCancelledError') throw err
    if (err instanceof Error && err.message.includes('timed out')) {
      return {
        passed: false,
        stdout:
          `acceptance suite timed out: killed after ${killDeadlineMs}ms. ` +
          `node --test-timeout=${spec.timeoutMs}ms never fired, so the suite ` +
          'blocked the event loop instead of failing one test.',
        exitCode: null,
        elapsedMs: Date.now() - started,
        // What the suite printed before the kill is still in the log.
        log: checkLog(logs, null),
      }
    }
    throw err
  } finally {
    await rm(spec.scratchDir, { recursive: true, force: true })
  }
}
