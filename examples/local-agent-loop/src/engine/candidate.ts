/** Fixed candidate snapshots shared by verification, review and approval. */
import { cp, mkdir, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { hashDir } from './tree.js'
import type { CandidateRef } from './types.js'

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
