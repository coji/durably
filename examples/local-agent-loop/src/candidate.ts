/** Immutable candidate snapshots shared by verification, review and approval. */
import { chmod, cp, lstat, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { hashDir } from './acceptance.js'
import type { CandidateRef } from './types.js'

export async function makeTreeReadOnly(root: string): Promise<void> {
  const entries = await readdir(root)
  for (const name of entries) {
    const path = join(root, name)
    const stat = await lstat(path)
    if (stat.isSymbolicLink())
      throw new Error(`candidate contains a symbolic link: ${path}`)
    if (stat.isDirectory()) {
      await makeTreeReadOnly(path)
      await chmod(path, 0o755)
    } else if (stat.isFile()) {
      await chmod(path, 0o444)
    }
  }
  await chmod(root, 0o755)
}

export async function createCandidate(options: {
  workdir: string
  candidatesDir: string
  iteration: number
  acceptanceHash: string
  attemptId: string
}): Promise<CandidateRef> {
  await mkdir(options.candidatesDir, { recursive: true })
  const temporary = join(
    options.candidatesDir,
    `.candidate-${options.iteration}-${options.attemptId}`,
  )
  await rm(temporary, { recursive: true, force: true })
  await cp(options.workdir, temporary, { recursive: true })
  await makeTreeReadOnly(temporary)
  const sourceHash = await hashDir(temporary)
  const id = `candidate-${options.iteration}-${sourceHash.slice(0, 12)}`
  const snapshotDir = join(options.candidatesDir, id)
  try {
    await rename(temporary, snapshotDir)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error
    await rm(temporary, { recursive: true, force: true })
    if ((await hashDir(snapshotDir)) !== sourceHash)
      throw new Error(`existing candidate differs: ${id}`)
  }
  if ((await hashDir(snapshotDir)) !== sourceHash)
    throw new Error(`candidate changed while sealing: ${id}`)
  return {
    id,
    snapshotDir,
    sourceHash,
    acceptanceHash: options.acceptanceHash,
  }
}

export async function assertCandidateIntact(
  candidate: CandidateRef,
): Promise<void> {
  const actual = await hashDir(candidate.snapshotDir)
  if (actual !== candidate.sourceHash) {
    throw new Error(
      `candidate-mutated: ${candidate.id} expected ${candidate.sourceHash.slice(0, 12)}, got ${actual.slice(0, 12)}`,
    )
  }
}

export function candidatesDirFor(workdir: string): string {
  return join(dirname(workdir), 'candidates')
}
