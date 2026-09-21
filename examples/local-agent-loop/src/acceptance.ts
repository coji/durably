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
 * - The suite itself runs from the snapshot-laid files via `node --test`
 *   with cwd pinned to the workdir (so relative imports resolve to the
 *   agent's `src/`), while the test files executed are the pristine copies.
 *
 * Implementation detail: the snapshot test files are bind-copied over a
 * scratch dir whose `src` is a symlink to the workdir `src`, so the exact
 * bytes graded are the snapshot bytes, linked against the agent's code.
 */
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'

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
      const st = await stat(full)
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
