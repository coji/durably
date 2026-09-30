/**
 * What a person does to a run, shared by the CLI and the web UI: approve or
 * reject a candidate or a blocked spec, revise a blocked spec with notes,
 * start a stopped run again with its stored input, and archive or unarchive
 * a stopped run. Both callers go through these functions, so a run acted on
 * from the page ends up exactly as one acted on from the terminal. Reading
 * files and reloading factory.json stay with the CLI, as does `demo prune`,
 * whose choice of runs is here too.
 */
import { existsSync, readdirSync } from 'node:fs'
import { lstat, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import type { Run } from '@coji/durably'

import {
  signalApproval,
  signalSpecDecision,
  type ApprovalDecision,
} from './approval.js'
import type { AgentLoopDurably } from './durably.js'
import { classifyRun } from './engine/failure-reasons.js'
import { branchCommit, deleteBranch } from './engine/git.js'
import { archivable, deliveredRun, diagnose } from './engine/status.js'
import { TERMINAL_STATUSES } from './engine/terminal.js'
import {
  archiveDirOf,
  archiveMarkerOf,
  removableRunPathsOf,
  runRootOf,
} from './factory/layout.js'
import { repairLabels } from './factory/repair.js'
import { removeRunWorktree, squashedBranchFor } from './targets/repo.js'

type Log = (line: string) => void

async function stored(durably: AgentLoopDurably, runId: string) {
  const run = await durably.getRun(runId)
  if (!run) throw new Error(`no run ${runId}`)
  return run
}

/**
 * `demo approve` / `demo reject`: decide the wait the run is suspended on,
 * bound to the candidate or the spec version its metadata names.
 */
export async function decideRun(
  durably: AgentLoopDurably,
  runId: string,
  waitId: string,
  decision: ApprovalDecision,
  log?: Log,
) {
  return signalApproval(durably, runId, waitId, decision, log)
}

/**
 * `demo spec-revise`: fix the blocked spec once more with `notes`, the
 * content the CLI reads from its notes file, on the wait the run is
 * suspended on. `signalSpecDecision` refuses it unless that is the run's own
 * pending blocked-spec wait, and refuses blank notes.
 */
export async function reviseSpec(
  durably: AgentLoopDurably,
  runId: string,
  notes: string,
  log?: Log,
) {
  const run = await stored(durably, runId)
  if (!run.waitingOnWaitId)
    throw new Error(
      `run ${runId} is not waiting for a decision on a blocked spec`,
    )
  return signalSpecDecision(
    durably,
    runId,
    run.waitingOnWaitId,
    'revise',
    notes,
    log,
  )
}

/**
 * The run, when its stop is one the failure table calls safe to repeat: a
 * fresh run resends every agent call, so an uncertain call or a possible
 * push must be checked by a person first. Both retriggers check this.
 */
export async function retriggerableRun(
  durably: AgentLoopDurably,
  runId: string,
) {
  const run = await stored(durably, runId)
  const failure = await classifyRun(durably, run)
  if (!failure?.retryable)
    throw new Error(
      `refusing to retrigger ${runId}: ${failure ? failure.reason : `it is ${run.status}, not stopped`}`,
    )
  return run
}

/**
 * `demo retrigger` without `--reload-config`: a new run with the stored
 * input. One retry per stopped run: asking again returns the run it already
 * started instead of paying for another, or pushing twice. A repair run's
 * retry names the same parent, and its setup checks the parent's candidate
 * branch again before creating anything.
 */
export async function retriggerRun(durably: AgentLoopDurably, runId: string) {
  const run = await retriggerableRun(durably, runId)
  type Input = Parameters<typeof durably.jobs.agentLoop.trigger>[0]
  const next = await durably.jobs.agentLoop.trigger(run.input as Input, {
    idempotencyKey: `retrigger-of-${runId}`,
    labels: repairLabels(run.input),
  })
  return { runId: next.id, disposition: next.disposition }
}

/**
 * A repository run's files as its stored record names them: the setup's
 * repository, its worktree only when it is this run's own `runs/<id>/work`,
 * the factory branch setup recorded (`factory/issue-<n>-<id>` for a run from
 * an issue) with the squashed branch beside it, and whether the run was
 * approved and delivered. Null for any other run.
 */
async function repoRunFiles(durably: AgentLoopDurably, run: Run) {
  const setup = (await durably.storage.getCompletedStep(run.id, 'setup'))
    ?.output as {
    target?: {
      kind?: string
      repoPath?: string
      workdir?: string
      branch?: string
    }
  } | null
  const target = setup?.target
  if (target?.kind !== 'repo' || !target.repoPath || !target.workdir)
    return null
  const runRoot = runRootOf(durably.stateRoot, run.id)
  const own = removableRunPathsOf(runRoot)
  if (resolve(target.workdir) !== resolve(own.worktree)) return null
  return {
    repoPath: target.repoPath,
    runRoot,
    worktree: own.worktree,
    reviewSnapshots: own.reviewSnapshots,
    branches: [
      ...(target.branch ? [target.branch] : []),
      squashedBranchFor(run.id),
    ],
    delivered: deliveredRun(run),
  }
}

type RepoRunFiles = NonNullable<Awaited<ReturnType<typeof repoRunFiles>>>

/** The recorded branches still in the repository. */
async function existingBranches(files: RepoRunFiles): Promise<string[]> {
  const found: string[] = []
  for (const branch of files.branches) {
    const tip = await branchCommit(files.repoPath, branch).catch(() => null)
    if (tip) found.push(branch)
  }
  return found
}

/** What a cleanup of one run did. */
export interface RunCleanup {
  /** The run's worktree was there and git removed it. */
  worktreeRemoved: boolean
  deletedBranches: string[]
  /** Why git could not remove the worktree or delete a branch. */
  warnings: string[]
}

/**
 * Remove a repository run's worktree and review snapshots, if any are left,
 * and with `deleteBranches` its recorded branches too, after the worktree,
 * since git refuses to delete a branch a worktree has checked out. Branches
 * of a delivered run are never deleted. The caller decides the run may be
 * cleaned up.
 */
async function cleanUpRun(
  files: RepoRunFiles,
  deleteBranches: boolean,
): Promise<RunCleanup> {
  const done: RunCleanup = {
    worktreeRemoved: false,
    deletedBranches: [],
    warnings: [],
  }
  // Called also when the directory is gone, so a worktree deleted outside
  // git leaves no stale registration that would keep its branch checked out.
  const present = existsSync(files.worktree)
  const warning = await removeRunWorktree(files.repoPath, files.runRoot)
  if (warning) done.warnings.push(`worktree ${files.worktree}: ${warning}`)
  else done.worktreeRemoved = present
  if (deleteBranches && !files.delivered)
    for (const branch of await existingBranches(files)) {
      const warning = await deleteBranch(files.repoPath, branch)
      if (warning) done.warnings.push(`branch ${branch}: ${warning}`)
      else done.deletedBranches.push(branch)
    }
  return done
}

/**
 * `demo archive`: take a stopped run out of the runs that need a person.
 * A marker file under the state root is written; the run, its steps and
 * its waits stay as they are. `changed` is false when it already was.
 * Refused for any run `archivable` refuses: one still open is decided or
 * worked instead, and one that finished needs no one.
 *
 * A repository run's worktree and review snapshots are removed with it,
 * also when it already was archived, so asking again retries a removal
 * that failed. Its branches are kept unless `deleteBranches` says
 * otherwise (`demo archive --delete-branch`). A failed removal is a
 * warning in the answer, not a refusal: the run is archived either way.
 */
export async function archiveRun(
  durably: AgentLoopDurably,
  runId: string,
  options: { deleteBranches?: boolean } = {},
): Promise<{ changed: boolean } & RunCleanup> {
  const run = await stored(durably, runId)
  const { kind } = await diagnose(durably, run, Date.now())
  if (!archivable(kind))
    throw new Error(
      `refusing to archive ${runId}: ${
        kind === 'finished'
          ? `it finished (${(run.output as { conclusion?: string } | null)?.conclusion ?? run.status}) and needs no one; only a stopped run is archived`
          : `it is ${run.status}, not stopped${kind === 'approval' || kind === 'spec-approval' ? '; decide it with approve, reject or spec-revise instead' : ''}`
      }`,
    )
  const marker = archiveMarkerOf(durably.stateRoot, runId)
  const changed = !existsSync(marker)
  if (changed) {
    await mkdir(archiveDirOf(durably.stateRoot), { recursive: true })
    await writeFile(
      marker,
      `${JSON.stringify({ archivedAt: new Date().toISOString() })}\n`,
    )
  }
  const files = await repoRunFiles(durably, run)
  const cleanup: RunCleanup = files
    ? await cleanUpRun(files, options.deleteBranches === true)
    : { worktreeRemoved: false, deletedBranches: [], warnings: [] }
  return { changed, ...cleanup }
}

/**
 * `demo unarchive`: remove the marker, so the run reads as before. Any
 * stored run with a marker can be brought back; looking the run up first
 * keeps an ID that is not a run's out of the marker path. A worktree the
 * archive removed is not made again: a fix starts a new run.
 */
export async function unarchiveRun(durably: AgentLoopDurably, runId: string) {
  await stored(durably, runId)
  const marker = archiveMarkerOf(durably.stateRoot, runId)
  if (!existsSync(marker)) return { changed: false }
  await rm(marker, { force: true })
  return { changed: true }
}

/** The IDs of every archived run; empty before anything was archived. */
export function archivedRunIds(stateRoot: string): Set<string> {
  try {
    return new Set(readdirSync(archiveDirOf(stateRoot)))
  } catch {
    return new Set()
  }
}

/** Bytes of `path` and every file under it; links are counted, not followed. */
async function sizeOf(path: string): Promise<number> {
  let info
  try {
    info = await lstat(path)
  } catch {
    return 0
  }
  if (!info.isDirectory()) return info.size
  let names: string[]
  try {
    names = await readdir(path)
  } catch {
    return info.size
  }
  let total = info.size
  for (const name of names) total += await sizeOf(join(path, name))
  return total
}

/** One run whose worktree `demo prune` removes. */
export interface PruneWorktree {
  runId: string
  path: string
  bytes: number
  /** Why it may go: its approved delivery is recorded, or it was archived. */
  reason: 'delivered' | 'archived'
}

/** One archived run whose recorded branches `--delete-branches` deletes. */
export interface PruneBranches {
  runId: string
  branches: string[]
}

export interface PrunePlan {
  worktrees: PruneWorktree[]
  /** Empty unless branches were asked for. */
  branches: PruneBranches[]
  totalBytes: number
}

/**
 * What `demo prune` would remove, read from the stored runs, their setup,
 * their delivery and the archive markers, never from directory names alone.
 * Only a run that has ended counts, whatever marker it has: a pending,
 * leased or waiting run is never touched. A worktree still on disk goes
 * when its run was approved and delivered, or is a stop that was archived.
 * With `deleteBranches`, an archived stop's recorded branches that are
 * still in the repository go too, whether or not its worktree is left. A
 * stop nobody archived, a rejected run and one that completed without a
 * delivery keep everything.
 */
export async function planPrune(
  durably: AgentLoopDurably,
  options: { deleteBranches?: boolean } = {},
): Promise<PrunePlan> {
  const archived = archivedRunIds(durably.stateRoot)
  const runs = await durably.getRuns({ jobName: durably.jobs.agentLoop.name })
  const plan: PrunePlan = { worktrees: [], branches: [], totalBytes: 0 }
  const now = Date.now()
  for (const run of runs) {
    if (!TERMINAL_STATUSES.includes(run.status)) continue
    const files = await repoRunFiles(durably, run)
    if (!files) continue
    const shelved =
      !files.delivered &&
      archived.has(run.id) &&
      archivable((await diagnose(durably, run, now)).kind)
    if (!files.delivered && !shelved) continue
    if (existsSync(files.worktree)) {
      const bytes = await sizeOf(files.worktree)
      plan.worktrees.push({
        runId: run.id,
        path: files.worktree,
        bytes,
        reason: files.delivered ? 'delivered' : 'archived',
      })
      plan.totalBytes += bytes
    }
    if (options.deleteBranches && shelved) {
      const branches = await existingBranches(files)
      if (branches.length > 0) plan.branches.push({ runId: run.id, branches })
    }
  }
  return plan
}

/**
 * `demo prune --apply`: remove what `planPrune` chose, each run's worktree
 * before its branches. Asking again after it succeeded finds nothing left.
 */
export async function applyPrune(
  durably: AgentLoopDurably,
  plan: PrunePlan,
): Promise<{
  removed: PruneWorktree[]
  deletedBranches: string[]
  warnings: string[]
}> {
  const done = {
    removed: [] as PruneWorktree[],
    deletedBranches: [] as string[],
    warnings: [] as string[],
  }
  const ids = new Set([
    ...plan.worktrees.map((w) => w.runId),
    ...plan.branches.map((b) => b.runId),
  ])
  for (const runId of ids) {
    const run = await durably.getRun(runId)
    const files = run ? await repoRunFiles(durably, run) : null
    if (!files) continue
    const result = await cleanUpRun(
      files,
      plan.branches.some((b) => b.runId === runId),
    )
    const listed = plan.worktrees.find((w) => w.runId === runId)
    if (listed && result.worktreeRemoved) done.removed.push(listed)
    done.deletedBranches.push(...result.deletedBranches)
    done.warnings.push(...result.warnings.map((w) => `${runId}: ${w}`))
  }
  return done
}
