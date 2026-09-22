/**
 * Immutable acceptance tests.
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
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runChild } from './child.js'

const supervisorPath = join(
  dirname(fileURLToPath(import.meta.url)),
  'test-supervisor.mjs',
)

export async function hashFiles(
  files: {
    path: string
    content: string | Uint8Array
    type?: 'file' | 'directory'
    mode?: number
  }[],
): Promise<string> {
  const h = createHash('sha256')
  const sorted = [...files].sort((a, b) => (a.path < b.path ? -1 : 1))
  for (const f of sorted) {
    const path = Buffer.from(f.path)
    const content =
      typeof f.content === 'string' ? Buffer.from(f.content) : f.content
    const type = f.type ?? 'file'
    const mode = f.mode ?? 0
    const lengths = Buffer.allocUnsafe(20)
    lengths.writeBigUInt64BE(BigInt(path.length), 0)
    lengths.writeBigUInt64BE(BigInt(content.length), 8)
    lengths.writeUInt32BE(mode, 16)
    h.update(`${type}\0`)
    h.update(lengths)
    h.update(path)
    h.update(content)
  }
  return h.digest('hex')
}

async function readTree(root: string): Promise<
  {
    path: string
    content: Buffer
    type: 'file' | 'directory'
    mode: number
  }[]
> {
  const out: {
    path: string
    content: Buffer
    type: 'file' | 'directory'
    mode: number
  }[] = []
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
        out.push({
          path: rp,
          content: Buffer.alloc(0),
          type: 'directory',
          mode: st.mode & 0o777,
        })
        await walk(full, rp)
      } else if (st.isFile()) {
        out.push({
          path: rp,
          content: await readFile(full),
          type: 'file',
          mode: st.mode & 0o777,
        })
      }
    }
  }
  await walk(root, '')
  return out
}

/** Hash every file under a directory (relative paths + contents). */
export async function hashDir(
  root: string,
  includeMode = true,
): Promise<string> {
  const entries = await readTree(root)
  return hashFiles(
    includeMode ? entries : entries.map((entry) => ({ ...entry, mode: 0 })),
  )
}

/** Trusted changed-path summary for reviewers that only receive the Candidate. */
export async function describeTreeChanges(
  baselineDir: string,
  candidateDir: string,
): Promise<string[]> {
  const digest = (entry: Awaited<ReturnType<typeof readTree>>[number]) =>
    createHash('sha256')
      .update(entry.type)
      .update(String(entry.mode))
      .update(entry.content)
      .digest('hex')
  const baseline = new Map(
    (await readTree(baselineDir)).map((entry) => [entry.path, digest(entry)]),
  )
  const candidate = new Map(
    (await readTree(candidateDir)).map((entry) => [entry.path, digest(entry)]),
  )
  const paths = [...new Set([...baseline.keys(), ...candidate.keys()])].sort()
  return paths.flatMap((path) => {
    if (!baseline.has(path)) return [`added: ${path}`]
    if (!candidate.has(path)) return [`deleted: ${path}`]
    return baseline.get(path) === candidate.get(path)
      ? []
      : [`modified: ${path}`]
  })
}

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
  try {
    const res = await runChild(
      process.execPath,
      [
        supervisorPath,
        String(spec.timeoutMs),
        spec.scratchDir,
        '--permission',
        '--allow-fs-read=*',
        '--test',
        '--test-isolation=none',
        `--test-timeout=${spec.timeoutMs}`,
        ...testFiles,
      ],
      {
        cwd: spec.scratchDir,
        timeoutMs: spec.timeoutMs + 5000,
        killSignal: 'SIGTERM',
        env: { NODE_OPTIONS: '' },
        ...(spec.signal ? { signal: spec.signal } : {}),
      },
    )
    return {
      passed: res.code === 0,
      stdout:
        res.code === 124
          ? `acceptance suite timed out after ${spec.timeoutMs}ms`
          : `${res.stdout}${res.stderr}`.slice(-8000),
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
