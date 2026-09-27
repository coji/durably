/**
 * Reusing another run's passing baseline result (ADR-0025).
 *
 * A measured, passing baseline is recorded in an index under the state root,
 * one file per identity, naming the newest such run. A reuse decision reads
 * that one file and then that one run's completed baseline step, which is
 * the only thing trusted: an entry whose step no longer parses, passed or
 * matches is ignored, and the check runs.
 */
import { createHash, randomUUID } from 'node:crypto'
import { constants, existsSync } from 'node:fs'
import {
  access,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { arch, platform } from 'node:os'
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path'

import type { AnyDurably } from '@coji/durably'
import { z } from 'zod'

import { baselineRecoveredOf } from '../engine/build-report.js'
import { toAttemptRow } from '../engine/report.js'
import { checkpointPaths } from '../engine/runner.js'
import { baselineIndexDirOf } from './layout.js'
import type { RepoTargetConfig } from './target.js'
import {
  BASELINE_STEP,
  type BaselineIdentity,
  type BaselineRecord,
  type BaselineReuse,
  type FactorySetup,
} from './types.js'

/**
 * The file a check command's first word runs, found the way `spawn` finds
 * it from the worktree on POSIX: a word with a slash is a path from the
 * worktree; otherwise each PATH entry in order, an empty entry meaning the
 * worktree itself. Symbolic links are resolved, and a file inside the
 * worktree is named relative to it, so runs in different worktrees name the
 * same file alike. Null when it cannot be found or run, when PATH is unset,
 * and on Windows, whose lookup (PATHEXT, the current directory first) this
 * does not reproduce.
 */
export async function checkExecutableOf(
  command: string | undefined,
  workdir: string,
  path: string | undefined = process.env['PATH'],
): Promise<string | null> {
  if (!command || platform() === 'win32') return null
  let candidates: string[]
  if (command.includes('/')) candidates = [resolve(workdir, command)]
  else if (path === undefined) return null
  else
    candidates = path
      .split(delimiter)
      .map((dir) => resolve(workdir, dir, command))
  let found: string | null = null
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK)
      if (!(await stat(candidate)).isFile()) continue
      found = candidate
      break
    } catch {
      // Not here.
    }
  }
  if (!found) return null
  try {
    const [file, root] = await Promise.all([realpath(found), realpath(workdir)])
    const inside = relative(root, file)
    return inside && !inside.startsWith('..') && !isAbsolute(inside)
      ? `./${inside}`
      : file
  } catch {
    return null
  }
}

/**
 * What a baseline result of this run is valid for, or null when a value
 * cannot be resolved: such a run neither reuses a result nor leaves one
 * another run can reuse.
 */
export async function baselineIdentityOf(
  target: RepoTargetConfig,
): Promise<BaselineIdentity | null> {
  const checkExecutable = await checkExecutableOf(
    target.checkCommand[0],
    target.workdir,
  )
  if (!checkExecutable) return null
  let repoPath: string
  try {
    repoPath = await realpath(target.repoPath)
  } catch {
    return null
  }
  return {
    repoPath,
    baseCommit: target.baseCommit,
    checkCommand: target.checkCommand,
    setupCommand: target.setupCommand,
    checkTimeoutMs: target.checkTimeoutMs,
    node: process.version,
    platform: platform(),
    arch: arch(),
    checkExecutable,
  }
}

const baselineIdentitySchema = z
  .object({
    repoPath: z.string().min(1),
    baseCommit: z.string().min(1),
    checkCommand: z.array(z.string()).min(1),
    setupCommand: z.array(z.string()).nullable(),
    checkTimeoutMs: z.number(),
    node: z.string().min(1),
    platform: z.string().min(1),
    arch: z.string().min(1),
    checkExecutable: z.string().min(1),
  })
  .strict() satisfies z.ZodType<BaselineIdentity>

/**
 * The values two identities must share: every field of the strict schema,
 * in the schema's order, so a field added there is compared without a
 * second list to keep in step. Throws on an identity the schema refuses.
 */
function identityKey(identity: BaselineIdentity): string {
  return JSON.stringify(baselineIdentitySchema.parse(identity))
}

/**
 * A stored baseline result another run may reuse: measured in its own run,
 * passing, and carrying the identity it was measured under. A failed, a
 * reused or an older record without an identity does not parse.
 */
const reusableRecordSchema = z.object({
  source: z.literal('measured'),
  passed: z.literal(true),
  identity: baselineIdentitySchema,
  checkedAt: z.string().optional(),
  stdout: z.string(),
  exitCode: z.number().nullable(),
  log: z.custom<BaselineRecord['log']>().optional(),
})

/** The index entry for one identity: the newest measured passing result. */
const indexEntrySchema = z.object({
  runId: z.string().min(1),
  /** When that run's check completed. */
  checkedAt: z.string().min(1),
  log: z.object({ stdoutPath: z.string(), stderrPath: z.string() }).nullable(),
})
type IndexEntry = z.infer<typeof indexEntrySchema>

function indexPathOf(stateRoot: string, identity: BaselineIdentity): string {
  const id = createHash('sha256').update(identityKey(identity)).digest('hex')
  return join(baselineIndexDirOf(stateRoot), `${id}.json`)
}

async function readIndexEntry(path: string): Promise<IndexEntry | null> {
  try {
    const parsed = indexEntrySchema.safeParse(
      JSON.parse(await readFile(path, 'utf8')),
    )
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/**
 * Point the index at `record` when it is a measured pass with an identity
 * that is newer than the entry already there. Written through a temporary
 * file and a rename, so a reader sees the old entry or the new one. Best
 * effort: a failed write only means a later run measures again.
 */
export async function recordBaselineInIndex(args: {
  stateRoot: string
  runId: string
  record: BaselineRecord
}): Promise<void> {
  const { record } = args
  if (
    record.source !== 'measured' ||
    !record.passed ||
    !record.identity ||
    !record.checkedAt
  )
    return
  try {
    const path = indexPathOf(args.stateRoot, record.identity)
    const current = await readIndexEntry(path)
    if (
      current &&
      (current.runId === args.runId ||
        Date.parse(current.checkedAt) >= Date.parse(record.checkedAt))
    )
      return
    const entry: IndexEntry = {
      runId: args.runId,
      checkedAt: record.checkedAt,
      log: record.log
        ? {
            stdoutPath: record.log.stdoutPath,
            stderrPath: record.log.stderrPath,
          }
        : null,
    }
    await mkdir(baselineIndexDirOf(args.stateRoot), { recursive: true })
    const temporary = `${path}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(entry)}\n`, 'utf8')
      await rename(temporary, path)
    } finally {
      await rm(temporary, { force: true })
    }
  } catch {
    // Best effort.
  }
}

/** The Durably reads a reuse decision makes, all about the one source run. */
export interface BaselineStore {
  getCompletedStep(
    runId: string,
    name: string,
  ): Promise<{ output: unknown; completedAt: string | null } | null>
  getStepAttempts: AnyDurably['getStepAttempts']
}

/**
 * The source run's result as this run may use it, or null: the source's
 * completed baseline step must be a measured pass with an identity equal to
 * `identity`, checked at most `maxAgeMs` before `now` and not after it (as
 * a clock set back can make one).
 */
export function validReusable(args: {
  runId: string
  identity: BaselineIdentity
  maxAgeMs: number
  now: number
  source: {
    runId: string
    output: unknown
    completedAt: string | null
  } | null
}): { runId: string; checkedAt: string; record: BaselineRecord } | null {
  const { source } = args
  if (!source || source.runId === args.runId) return null
  const parsed = reusableRecordSchema.safeParse(source.output)
  if (!parsed.success) return null
  if (identityKey(parsed.data.identity) !== identityKey(args.identity))
    return null
  // The check's own completion; a record from before it was kept falls back
  // to its step's.
  const checkedAt = parsed.data.checkedAt ?? source.completedAt
  if (!checkedAt) return null
  const at = Date.parse(checkedAt)
  if (!Number.isFinite(at) || at > args.now || args.now - at > args.maxAgeMs)
    return null
  const { checkedAt: _measuredAt, ...record } = parsed.data
  return {
    runId: source.runId,
    checkedAt,
    record: { ...record, log: record.log ?? null },
  }
}

/**
 * Another run's result this baseline may use, as this step's record, or
 * null to run the check. Null too when this run has already started
 * measuring: an interrupted check is finished, never swapped for a reused
 * result. A failed lookup also runs the check. One index read and one read
 * of the source run's step and attempts; no scan of the history.
 */
export async function reusedBaseline(args: {
  stateRoot: string
  runId: string
  setup: FactorySetup
  reuse: BaselineReuse
  store: BaselineStore
  operationKey: string
}): Promise<BaselineRecord | null> {
  const { setup } = args
  const identity = setup.baselineIdentity ?? null
  if (!identity) return null
  const paths = checkpointPaths(setup.checkpointsDir, args.operationKey)
  if (existsSync(paths.started) || existsSync(paths.completed)) return null
  try {
    const entry = await readIndexEntry(indexPathOf(args.stateRoot, identity))
    if (!entry) return null
    const step = await args.store.getCompletedStep(entry.runId, BASELINE_STEP)
    const chosen = validReusable({
      runId: args.runId,
      identity,
      maxAgeMs: args.reuse.maxAgeMs,
      now: Date.now(),
      source: step ? { runId: entry.runId, ...step } : null,
    })
    if (!chosen) return null
    const attempts = await args.store.getStepAttempts(chosen.runId)
    return {
      ...chosen.record,
      source: 'reused',
      identity,
      reusedFrom: {
        runId: chosen.runId,
        checkedAt: chosen.checkedAt,
        recovered: baselineRecoveredOf(attempts.map(toAttemptRow)),
      },
    }
  } catch {
    return null
  }
}
