/**
 * Immutable acceptance tests.
 *
 * The agent must never be able to rewrite the tests it is graded by:
 *
 * - At `prepare`, `subject/test/*` is copied to `<run>/acceptance/` and its
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
 */
import { createHash } from 'node:crypto'
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
} from 'node:fs/promises'
import { join } from 'node:path'

import { runChild } from './child.js'

export async function hashFiles(
  files: { path: string; content: string }[],
): Promise<string> {
  const h = createHash('sha256')
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : 1))
  for (const f of sorted) {
    h.update(f.path)
    h.update('\0')
    h.update(f.content)
    h.update('\0')
  }
  return h.digest('hex')
}

async function readTree(
  root: string,
): Promise<{ path: string; content: string }[]> {
  const out: { path: string; content: string }[] = []
  async function walk(dir: string, rel: string) {
    const entries = await readdir(dir)
    for (const name of entries) {
      const full = join(dir, name)
      const rp = rel.length > 0 ? `${rel}/${name}` : name
      const st = await lstat(full)
      if (st.isSymbolicLink()) {
        throw new Error(`snapshot contains a symbolic link: ${rp}`)
      }
      if (st.isDirectory()) {
        await walk(full, rp)
      } else if (st.isFile()) {
        out.push({ path: rp, content: await readFile(full, 'utf8') })
      }
    }
  }
  await walk(root, '')
  return out
}

/** Hash every file under a directory (relative paths + contents). */
export async function hashDir(root: string): Promise<string> {
  return hashFiles(await readTree(root))
}

/** Snapshot the pristine subject tests for this run. */
export async function snapshotAcceptance(
  subjectTestDir: string,
  acceptanceDir: string,
): Promise<{ files: number; hash: string }> {
  await mkdir(acceptanceDir, { recursive: true })
  await cp(subjectTestDir, acceptanceDir, { recursive: true })
  const hash = await hashDir(acceptanceDir)
  const files = (await readTree(acceptanceDir)).length
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
    actual = await hashDir(workdirTestDir)
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
  /** Pid marker so a restarted worker can reconcile this grading process. */
  pidFile?: string
}

export interface AcceptanceRunResult {
  passed: boolean
  stdout: string
  exitCode: number | null
  elapsedMs: number
}

/**
 * Grade the agent's `src/` against the pristine snapshot tests.
 *
 * Fail-closed order: tamper check first (throws `acceptance-tampered`), then
 * the sample-fixed `node --test` argv over the SNAPSHOT test files (no shell,
 * no workdir `package.json`, no `npm`). The workdir's `npm test` is never
 * executed, so a rewritten test script cannot fake a pass; an empty snapshot
 * (nothing to grade) throws instead of passing vacuously.
 */
export async function runAcceptanceSuite(
  spec: AcceptanceRunSpec,
  expectedHash: string,
): Promise<AcceptanceRunResult> {
  const started = Date.now()
  await verifyAcceptanceIntact(join(spec.workdir, 'test'), expectedHash)
  const acceptanceHash = await hashDir(spec.acceptanceDir)
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
    .map((f) => f.path)
    .filter((p) => p.endsWith('.test.js'))
    .sort()
    .map((p) => join('test', p))
  if (testFiles.length === 0) {
    throw new Error(
      'acceptance-tampered: snapshot contains no *.test.js files to grade',
    )
  }
  try {
    const res = await runChild('node', ['--test', ...testFiles], {
      cwd: spec.scratchDir,
      timeoutMs: spec.timeoutMs,
      ...(spec.signal ? { signal: spec.signal } : {}),
      ...(spec.pidFile ? { pidFile: spec.pidFile } : {}),
    })
    return {
      passed: res.code === 0,
      stdout: `${res.stdout}${res.stderr}`.slice(-8000),
      exitCode: res.code,
      elapsedMs: Date.now() - started,
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'SpawnCancelledError') throw err
    if (err instanceof Error && err.message.includes('timed out')) {
      return {
        passed: false,
        stdout: `acceptance suite timed out after ${spec.timeoutMs}ms`,
        exitCode: null,
        elapsedMs: Date.now() - started,
      }
    }
    throw err
  }
}
