/**
 * Content-addressed directory hashing and diffing.
 *
 * Every hash covers relative paths, file contents and, optionally, modes, so
 * a sealed tree can be re-verified byte for byte. Symbolic links are rejected
 * rather than followed: a link would let the hash describe something other
 * than the bytes that will actually be read.
 */
import { createHash } from 'node:crypto'
import { lstat, readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

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

export async function readTree(root: string): Promise<
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
