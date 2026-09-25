/**
 * Target selection.
 *
 * `prepare*` runs once inside the run's setup step and produces the plain
 * JSON config that is persisted. `createTarget` rebuilds the live target from
 * that config on every replay, because a worker resuming the run has only the
 * database and the repository on disk to work from.
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'

import { runChild } from '../engine/child.js'
import {
  addWorktree,
  discardWorktree,
  repoRoot,
  resolveCommit,
} from '../engine/git.js'
import type {
  RepoTargetConfig,
  Target,
  TargetConfig,
} from '../factory/target.js'
import { RepoTarget } from './repo.js'
import { SubjectTarget } from './subject.js'

export { prepareSubjectTarget } from './subject.js'

export function createTarget(config: TargetConfig): Target {
  if (config.kind === 'subject') return new SubjectTarget(config)
  return new RepoTarget(config)
}

export interface PrepareRepoArgs {
  /** Any path inside the target repository. */
  repoPath: string
  /** Ref the work starts from. */
  baseRef: string
  branch: string
  /** Run directory under the fixed state root; never inside the repository. */
  root: string
  /** Fixed at trigger time; the source files are never read again. */
  task: string
  spec: string | null
  dispositions: string | null
  issue: { number: number; title: string; url: string } | null
  checkCommand: string[]
  setupCommand: string[] | null
  checkTimeoutMs: number
  publish: boolean
  signal?: AbortSignal
}

export async function prepareRepoTarget(
  args: PrepareRepoArgs,
): Promise<RepoTargetConfig> {
  if (args.checkCommand.length === 0)
    throw new Error('a repo target needs a check command to grade candidates')
  const repo = await repoRoot(args.repoPath)
  const baseCommit = await resolveCommit(repo, args.baseRef)
  const workdir = join(args.root, 'work')
  await mkdir(args.root, { recursive: true })
  // Setup is a durable step, so a worker killed part way through re-runs it.
  // `git worktree add -b` refuses an existing directory or branch, so clear
  // both first. Nothing has been sealed yet, and the branch carries the run id.
  await discardWorktree(repo, workdir, args.branch)
  await addWorktree({
    repo,
    dir: workdir,
    baseCommit,
    branch: args.branch,
    ...(args.signal ? { signal: args.signal } : {}),
  })
  if (args.setupCommand && args.setupCommand.length > 0) {
    const [command, ...rest] = args.setupCommand
    if (!command) throw new Error('empty setup command')
    // A fresh worktree has no installed dependencies, so the check would fail
    // for a reason that has nothing to do with the agent's work.
    const res = await runChild(command, rest, {
      cwd: workdir,
      timeoutMs: 900_000,
      maxOutputChars: 20_000,
      ...(args.signal ? { signal: args.signal } : {}),
    })
    if (res.code !== 0) {
      throw new Error(
        `worktree setup failed (${res.code ?? 'null'}): ${`${res.stdout}${res.stderr}`.slice(-2000)}`,
      )
    }
  }
  return {
    kind: 'repo',
    repoPath: repo,
    baseCommit,
    branch: args.branch,
    workdir,
    setupCommand: args.setupCommand,
    checkCommand: args.checkCommand,
    checkTimeoutMs: args.checkTimeoutMs,
    task: args.task,
    spec: args.spec,
    dispositions: args.dispositions,
    issue: args.issue,
    deliveryDir: join(args.root, 'delivery'),
    candidatesDir: join(args.root, 'candidates'),
    publish: args.publish,
  }
}
