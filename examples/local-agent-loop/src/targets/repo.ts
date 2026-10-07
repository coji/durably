/**
 * A real repository as the factory's target.
 *
 * The agent works in a git worktree cut from a recorded base commit, never in
 * the checkout the user is sitting in. Sealing a candidate is a commit, so the
 * candidate's identity is its tree sha and the delivered patch comes for free.
 *
 * The candidate is graded in that same worktree rather than in a second
 * checkout. A fresh worktree has no installed dependencies, so a second one
 * would either have to repeat the install or borrow the first one's, and both
 * defeat the point. Instead `assertIntact` proves the bytes about to be graded
 * are exactly the sealed ones: the worktree must be clean and its `HEAD` must
 * still be the candidate's commit. Like the directory-hash check on the sample
 * target, this detects an unintended change; it is not a sandbox.
 */
import { constants as fsConstants, existsSync } from 'node:fs'
import {
  copyFile,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'

import { runChild } from '../engine/child.js'
import {
  BASELINE_FAILED_MESSAGE,
  setupUntrackedError,
} from '../engine/failure-reasons.js'
import {
  branchCommit,
  cleanUntracked,
  commitAll,
  DEFAULT_COMMIT_AUTHOR,
  defaultBranch,
  describeCommitChanges,
  diffStat,
  ensureSquashedBranch,
  forceRemoveWorktree,
  isDirty,
  writePatch,
  pushBranch,
  resolveCommit,
  someUntracked,
  treeOf,
  type CommitAuthor,
} from '../engine/git.js'
import type {
  CandidateChanges,
  CandidateRef,
  ReviewSnapshots,
} from '../engine/types.js'
import {
  checkLog,
  logAfterError,
  prepareCheckLogs,
  withPartialLog,
  type GradeResult,
} from '../engine/verification.js'
import {
  removableRunPathsOf,
  reviewBaseTreeOf,
  reviewHeadTreeOf,
  reviewWorkdirOf,
  specReviewWorkdirOf,
  worktreeRetiredMarkerOf,
} from '../factory/layout.js'
import { changedPathsLine } from '../factory/prompts.js'
import {
  DEFAULT_COMMIT_SETTINGS,
  type CommitSettings,
  type Delivery,
  type DeliverArgs,
  type GradeArgs,
  type RepairParentConclusion,
  type RepoTargetConfig,
  type SealArgs,
  type Target,
  type UntrustedInput,
} from '../factory/target.js'
import type { ProfileRole } from '../factory/types.js'

/** Why a repair run's unapproved base was never approved (ADR-0030). */
const UNAPPROVED_BASE: Record<
  Exclude<RepairParentConclusion, 'approved'>,
  string
> = {
  'verification-failed': 'the pinned check still failed on it',
  'review-cap-reached':
    'reviewers still found blocking issues in it after the review cap',
  'review-incomplete':
    'its reviews did not finish after the pinned check passed on it',
}

/**
 * The candidate commit must still be in the repository and still be the tip
 * of the branch the parent recorded. A branch moved since means someone
 * changed the work after approval, so nothing is started from it. `demo
 * repair` checks this before it triggers, and a repair run's setup checks it
 * again right before it cuts its worktree and branch, after discarding any an
 * earlier attempt left, since the branch can move in between and a retrigger
 * does not go through `demo repair`.
 */
export async function assertCandidateUnmoved(
  repoPath: string,
  commit: string,
  branch: string,
): Promise<void> {
  let found: string | null
  try {
    found = await resolveCommit(repoPath, commit)
  } catch {
    found = null
  }
  if (found !== commit)
    throw new Error(
      `candidate commit ${commit.slice(0, 12)} is not in ${repoPath}`,
    )
  const tip = await branchCommit(repoPath, branch)
  if (tip !== commit)
    throw new Error(
      tip
        ? `candidate branch ${branch} moved to ${tip.slice(0, 12)}; the parent's candidate is ${commit.slice(0, 12)}`
        : `candidate branch ${branch} no longer exists in ${repoPath}`,
    )
}

/** The branch holding a run's approved candidate as one commit on the base. */
export function squashedBranchFor(runId: string): string {
  return `factory/${runId}-squashed`
}

/**
 * A commit message from the run's template: `{iteration}`, `{runId}` and
 * `{task}` (the stored task's first line) are replaced in one pass, so text
 * the task brings in is never expanded again.
 */
export function renderCommitMessage(
  template: string,
  values: { iteration: number; runId: string; task: string },
): string {
  const task = values.task.trim().split('\n')[0]?.trim() ?? ''
  return template.replace(
    /\{(iteration|runId|task)\}/g,
    (_, name: 'iteration' | 'runId' | 'task') =>
      name === 'iteration'
        ? String(values.iteration)
        : name === 'runId'
          ? values.runId
          : task,
  )
}

/** The author a run's commits carry, each field falling back on its own. */
export function commitAuthorOf(settings: CommitSettings): CommitAuthor {
  return {
    name: settings.authorName ?? DEFAULT_COMMIT_AUTHOR.name,
    email: settings.authorEmail ?? DEFAULT_COMMIT_AUTHOR.email,
  }
}

/** Hash-free identity of the pinned check, recorded so it cannot drift. */
export function checkFingerprint(command: string[]): string {
  return command.join(' ')
}

export class RepoTarget implements Target {
  readonly kind = 'repo' as const

  constructor(private readonly config: RepoTargetConfig) {}

  get workdir(): string {
    return this.config.workdir
  }

  /** The run's directory, which holds the worktree. */
  private get runRoot(): string {
    return dirname(this.config.workdir)
  }

  /**
   * The run removed its worktree after recording its delivery (see
   * `worktreeRetiredMarkerOf`), so this execution only replays recorded
   * steps and must not look for the worktree.
   */
  private get retired(): boolean {
    return existsSync(worktreeRetiredMarkerOf(this.runRoot))
  }

  private get commitSettings(): CommitSettings {
    return this.config.commit ?? DEFAULT_COMMIT_SETTINGS
  }

  /** An iteration commit's message, or the squash commit's when `squash`. */
  private commitMessage(
    iteration: number,
    runId: string,
    squash = false,
  ): string {
    const template = this.commitSettings.messageTemplate
    if (template)
      return renderCommitMessage(template, {
        iteration,
        runId,
        task: this.config.task,
      })
    return squash ? `factory run ${runId}` : `factory iteration ${iteration}`
  }

  checkDescription(): string {
    return this.config.checkFromSpec
      ? `\`${checkFingerprint(this.config.checkCommand)}\`, chosen from the spec before you started`
      : `\`${checkFingerprint(this.config.checkCommand)}\`, pinned when the run started`
  }

  taskBrief(): string {
    return this.config.spec
      ? 'Carry out the work described in the untrusted TASK block below, as specified by the SPEC block.'
      : 'Carry out the work described in the untrusted TASK block below.'
  }

  /** The task as the caller gave it, with the issue header when there is one. */
  private taskText(): string {
    const issue = this.config.issue
    const header = issue
      ? `Issue #${issue.number}: ${issue.title}\n${issue.url}\n\n`
      : ''
    return `${header}${this.config.task}`
  }

  untrustedInputs(role: ProfileRole): UntrustedInput[] {
    const inputs: UntrustedInput[] = [
      { label: 'TASK', content: this.taskText() },
    ]
    if (this.config.spec)
      inputs.push({ label: 'SPEC', content: this.config.spec })
    // The spec reviewers' advice is for the implementer; the check script's
    // notes go to the reviewers too. Both are data, like the task.
    if (role === 'code' && this.config.specAdvice)
      inputs.push({ label: 'SPEC_ADVICE', content: this.config.specAdvice })
    if (this.config.checkNotes)
      inputs.push({ label: 'CHECK_NOTES', content: this.config.checkNotes })
    // Dispositions record how earlier review findings were settled. They
    // matter to a reviewer deciding whether a finding is new, and would only
    // invite the implementer to argue with its reviewers.
    if (role !== 'code' && this.config.dispositions)
      inputs.push({ label: 'DISPOSITIONS', content: this.config.dispositions })
    // Outside findings are what a repair run is for. They stay data like the
    // task: never verified feedback, never a factory instruction.
    const findings = this.config.repairOf?.findings
    if (findings) inputs.push({ label: 'FINDINGS', content: findings })
    return inputs
  }

  implementationRules(): string[] {
    return [
      'Work only inside this worktree. Do not touch any other checkout.',
      'Follow the conventions already present in the repository: match neighbouring code, and read the project instructions if the repository ships any.',
      `Grading runs ${this.checkDescription()}. The command was fixed before you started, so editing scripts cannot change what is run.`,
      'Add or update tests that would fail without your change. Tests that pass whether or not the fix is present do not count.',
      'Do not commit; the factory commits for you. Do not push, open pull requests, or run network commands.',
      ...this.selfCheckRule(),
    ]
  }

  /**
   * The `selfCheck` commands, as one rule; none without them. The factory
   * never runs them: only the grading command judges the run (ADR-0031).
   */
  private selfCheckRule(): string[] {
    const commands = this.config.selfCheck ?? []
    if (commands.length === 0) return []
    return [
      [
        'Before you finish, run each of these commands in this worktree and fix what they report:',
        ...commands.map((command) => `  \`${checkFingerprint(command)}\``),
        'They are quick checks that the grading command also covers. Only the grading command judges this run.',
      ].join('\n'),
    ]
  }

  reviewRules(): string[] {
    return [
      'Judge the change against the task and the trusted context below. You are reading a real repository, so follow its own conventions rather than any assumed layout.',
      'Check that the change is minimal and that nothing unrelated was touched.',
      'Check the tests: a test that passes whether or not the change is present does not count as coverage. Say needsChanges when the new tests would pass against the base commit.',
      'Check that no dependency was added without need and that no secret, credential or absolute local path was introduced.',
    ]
  }

  async seal(args: SealArgs): Promise<CandidateRef> {
    const sealed = await commitAll(
      this.config.workdir,
      this.commitMessage(args.iteration, args.runId),
      { signal: args.signal, author: commitAuthorOf(this.commitSettings) },
    )
    const tree = await treeOf(this.config.repoPath, sealed.commit)
    const id = `candidate-${args.iteration}-${tree.slice(0, 12)}`
    return {
      id,
      // The worktree holds the sealed content; `assertIntact` keeps it honest.
      snapshotDir: this.config.workdir,
      sourceHash: tree,
      acceptanceHash: checkFingerprint(this.config.checkCommand),
      branch: this.config.branch,
      commit: sealed.commit,
      changes: await this.writeChanges(id, sealed.commit),
    }
  }

  async hasChanges(since: CandidateRef | null): Promise<boolean> {
    // Uncommitted work, or a commit the agent made itself, or the commit a
    // seal of that work already made: each moves away from `since`.
    if (await isDirty(this.config.workdir)) return true
    return (
      (await resolveCommit(this.config.workdir, 'HEAD')) !==
      (since?.commit ?? this.config.baseCommit)
    )
  }

  /**
   * Write the candidate's full diff and changed-file list outside the
   * worktree, and count its size. Done at sealing, so a candidate that never
   * reaches review still has them. Rewriting on a replay yields the same
   * bytes, because both commits are fixed.
   */
  private async writeChanges(
    id: string,
    commit: string,
  ): Promise<CandidateChanges> {
    const dir = join(
      this.config.candidatesDir ??
        join(dirname(this.config.deliveryDir), 'candidates'),
      id,
    )
    await mkdir(dir, { recursive: true })
    const diffPath = join(dir, 'changes.diff')
    const changedFilesPath = join(dir, 'changed-files.txt')
    const { repoPath, baseCommit } = this.config
    const [, lines, stat] = await Promise.all([
      writePatch(repoPath, baseCommit, commit, diffPath),
      describeCommitChanges(repoPath, baseCommit, commit),
      diffStat(repoPath, baseCommit, commit),
    ])
    await writeFile(
      changedFilesPath,
      lines.map((line) => `${line}\n`).join(''),
      'utf8',
    )
    return { diffPath, changedFilesPath, ...stat }
  }

  async prepareReviewSnapshots(
    candidate: CandidateRef,
    signal: AbortSignal,
  ): Promise<ReviewSnapshots> {
    const dir = this.config.reviewSnapshotsDir
    if (!dir || !candidate.commit)
      throw new Error(
        `review snapshots were not set up for ${candidate.id}; no configured reviewer reads them`,
      )
    const baseDir = reviewBaseTreeOf(dir)
    const headDir = reviewHeadTreeOf(dir, candidate.id)
    // One after the other: each already on disk is kept, so the base is
    // extracted once per run and the candidate once per review.
    await extractCommit(
      this.config.repoPath,
      this.config.baseCommit,
      baseDir,
      signal,
    )
    await extractCommit(this.config.repoPath, candidate.commit, headDir, signal)
    return { baseDir, headDir }
  }

  async prepareReviewWorkdir(
    candidate: CandidateRef,
    lens: 'correctness' | 'edge-cases',
    localFile: string,
  ): Promise<string> {
    const dir = this.config.reviewSnapshotsDir
    if (!dir)
      throw new Error(
        `review snapshots were not set up for ${candidate.id}; no configured reviewer reads them`,
      )
    const cwd = reviewWorkdirOf(dir, candidate.id, lens)
    // Whatever an interrupted attempt left is discarded, not trusted.
    await rm(cwd, { recursive: true, force: true })
    await mkdir(cwd, { recursive: true })
    await copyReviewConfig(reviewBaseTreeOf(dir), cwd)
    await writeFile(join(cwd, 'CLAUDE.local.md'), localFile, {
      encoding: 'utf8',
      flag: 'wx',
    })
    return cwd
  }

  async prepareSpecReviewBase(signal: AbortSignal): Promise<string> {
    const dir = this.config.reviewSnapshotsDir
    if (!dir)
      throw new Error(
        'review snapshots were not set up for spec review; no configured reviewer reads them',
      )
    const baseDir = reviewBaseTreeOf(dir)
    await extractCommit(
      this.config.repoPath,
      this.config.baseCommit,
      baseDir,
      signal,
    )
    return baseDir
  }

  async prepareSpecReviewWorkdir(
    round: number,
    name: string,
    localFile: string,
  ): Promise<string> {
    const dir = this.config.reviewSnapshotsDir
    if (!dir)
      throw new Error(
        `review snapshots were not set up for spec reviewer ${name}; no configured reviewer reads them`,
      )
    const baseDir = reviewBaseTreeOf(dir)
    const cwd = specReviewWorkdirOf(dir, round, name)
    // Whatever an interrupted attempt left is discarded, not trusted.
    await rm(cwd, { recursive: true, force: true })
    await mkdir(cwd, { recursive: true })
    await copyReviewConfig(baseDir, cwd)
    await writeFile(join(cwd, 'CLAUDE.local.md'), localFile, {
      encoding: 'utf8',
      flag: 'wx',
    })
    return cwd
  }

  async releaseReviewSnapshots(options: { base: boolean }): Promise<void> {
    const dir = this.config.reviewSnapshotsDir
    if (!dir) return
    if (options.base) return removeQuietly(dir)
    const base = basename(reviewBaseTreeOf(dir))
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      return
    }
    // The base tree, and a base extraction in progress, stay for the next
    // candidate; every candidate's tree and working directories go.
    await Promise.all(
      entries
        .filter((name) => name !== base && !name.startsWith(`${base}.`))
        .map((name) => removeQuietly(join(dir, name))),
    )
  }

  async assertIntact(candidate: CandidateRef): Promise<void> {
    // Every step this check guards was recorded before the worktree went.
    if (this.retired) return
    // Untracked files do not count. A real check command leaves build output
    // behind (`.turbo/`, `*.tsbuildinfo`, coverage), and none of it is in the
    // commit the candidate names, so a passing check would otherwise fail the
    // run every time. Tracked changes still do count: those would mean the
    // sealed content moved.
    const head = await this.cleanHead(
      `candidate-mutated: ${candidate.id} has uncommitted changes to tracked files in ${this.config.workdir}`,
    )
    const tree = await treeOf(this.config.repoPath, head)
    if (tree !== candidate.sourceHash) {
      throw new Error(
        `candidate-mutated: ${candidate.id} expected tree ${candidate.sourceHash.slice(0, 12)}, worktree is at ${tree.slice(0, 12)}`,
      )
    }
  }

  async grade(args: GradeArgs): Promise<GradeResult> {
    await this.assertIntact(args.candidate)
    return this.runCheck(args.logDir, args.signal)
  }

  /**
   * The worktree is as a measured baseline would require it before the
   * check: at the base commit, with no changes to tracked files and no
   * untracked file `.gitignore` does not cover. Stops the run as a baseline
   * failure otherwise. A reused baseline result is taken only after this.
   */
  async assertReadyForBase(signal: AbortSignal): Promise<void> {
    await this.assertAtBase(
      `setup left uncommitted changes to tracked files in ${this.config.workdir} before the check`,
    )
    await assertSetupLeftNoUntracked(this.config.workdir, signal)
  }

  /**
   * Run the pinned check once on the base commit, before any agent call. The
   * worktree was just cut from that commit and set up, so it is graded in
   * place, as a candidate is; it must still be clean and at the base.
   *
   * Every way the base cannot be graded stops the run as a baseline failure:
   * setup or the check leaving tracked changes, and a check that cannot
   * start. After a passing check, every untracked file `.gitignore` does not
   * cover is removed, so none of its output is sealed into the first
   * candidate. Setup is not allowed to leave such files (see
   * `assertSetupLeftNoUntracked`), so this removes only what the check wrote,
   * including on a resume after an interrupted check.
   */
  async gradeBase(args: {
    logDir: string
    signal: AbortSignal
  }): Promise<GradeResult> {
    const { workdir } = this.config
    await this.assertAtBase(
      `setup left uncommitted changes to tracked files in ${workdir} before the check`,
    )
    let result: GradeResult
    try {
      result = await this.runCheck(args.logDir, args.signal)
    } catch (err) {
      // A cancel or lost lease is not a verdict on the base.
      if (args.signal.aborted || (err as Error).name === 'SpawnCancelledError')
        throw err
      throw new Error(
        `${BASELINE_FAILED_MESSAGE}: \`${checkFingerprint(this.config.checkCommand)}\` could not run on the base commit ${this.config.baseCommit.slice(0, 12)} (${(err as Error).message}) before any agent call`,
        { cause: err },
      )
    }
    // A check that edits tracked files would slip its edits into the first
    // candidate, so the worktree must come out of it as it went in.
    await this.assertAtBase(
      `the check changed tracked files in ${workdir}; it must leave the base commit as it found it`,
    )
    if (result.passed) {
      try {
        await cleanUntracked(workdir, args.signal)
      } catch (err) {
        if (args.signal.aborted) throw err
        throw new Error(
          `${BASELINE_FAILED_MESSAGE}: baseline-mutated: the check's untracked output could not be removed (${[(err as Error).message, (err as { stderr?: string }).stderr].filter(Boolean).join(': ')}); stopped before any agent call`,
        )
      }
      // Whatever the clean could not remove would reach `git add -A` at the
      // first sealing, so the worktree must come out empty of it.
      const left = await someUntracked(workdir, 5, args.signal)
      if (left.length > 0)
        throw new Error(
          `${BASELINE_FAILED_MESSAGE}: baseline-mutated: the check left untracked files that could not be removed (${left.join(', ')}); stopped before any agent call`,
        )
    }
    return result
  }

  /** HEAD of a worktree with no tracked changes; `dirty` is the error. */
  private async cleanHead(dirty: string): Promise<string> {
    if (await isDirty(this.config.workdir, { includeUntracked: false }))
      throw new Error(dirty)
    return resolveCommit(this.config.workdir, 'HEAD')
  }

  private async assertAtBase(changed: string): Promise<void> {
    const stop = (why: string) =>
      `${BASELINE_FAILED_MESSAGE}: baseline-mutated: ${why}; stopped before any agent call`
    const head = await this.cleanHead(stop(changed))
    if (head !== this.config.baseCommit)
      throw new Error(
        stop(
          `${this.config.workdir} is at ${head.slice(0, 12)}, not the base ${this.config.baseCommit.slice(0, 12)}`,
        ),
      )
  }

  private async runCheck(
    logDir: string | undefined,
    signal: AbortSignal,
  ): Promise<GradeResult> {
    const started = Date.now()
    const [command, ...rest] = this.config.checkCommand
    if (!command) throw new Error('repo target has an empty check command')
    const killDeadlineMs =
      this.config.checkTimeoutMs +
      Math.min(5000, Math.max(1000, this.config.checkTimeoutMs / 4))
    const logs = await prepareCheckLogs(logDir)
    try {
      const res = await runChild(command, rest, {
        cwd: this.config.workdir,
        timeoutMs: killDeadlineMs,
        maxOutputChars: 20_000,
        signal,
        ...logs,
      })
      return {
        passed: res.code === 0,
        stdout: `${res.stdout}${res.stderr}`.slice(-8000),
        exitCode: res.code,
        elapsedMs: Date.now() - started,
        log: checkLog(logs, res.code, res.logError),
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'SpawnCancelledError')
        throw withPartialLog(err, logAfterError(logs, err))
      if (err instanceof Error && err.message.includes('timed out')) {
        // What the check printed before the kill is still in the log.
        const log = logAfterError(logs, err)
        return {
          passed: false,
          stdout: `check timed out: killed after ${killDeadlineMs}ms running ${checkFingerprint(this.config.checkCommand)}`,
          exitCode: null,
          elapsedMs: Date.now() - started,
          log: log ? { ...log, timedOutAfterMs: killDeadlineMs } : null,
        }
      }
      throw err
    }
  }

  reviewCwd(candidate: CandidateRef): string {
    return candidate.snapshotDir
  }

  async reviewContext(candidate: CandidateRef): Promise<string> {
    // A replay after the worktree was removed reads the sealed commit; the
    // review it would inform is already recorded.
    const head =
      this.retired && candidate.commit
        ? candidate.commit
        : await resolveCommit(this.config.workdir, 'HEAD')
    const changes = await describeCommitChanges(
      this.config.repoPath,
      this.config.baseCommit,
      head,
    )
    const parent = this.config.repairOf
    return [
      'TRUSTED CONTEXT (produced by the factory, not by the implementer):',
      `Base commit: ${this.config.baseCommit}`,
      ...(parent
        ? [
            parent.parentConclusion && parent.parentConclusion !== 'approved'
              ? `The base commit is the last candidate of factory run ${parent.runId}, which stopped because ${UNAPPROVED_BASE[parent.parentConclusion]}, so it was never approved. This run repairs it from the findings in the untrusted FINDINGS block, so the changes below are the repair alone; the base's own changes are not listed: read them in the candidate tree the CANDIDATE FILES section names, or in your working directory when it names none.`
              : `The base commit is the approved candidate of factory run ${parent.runId}. This run repairs it from the findings in the untrusted FINDINGS block, so the changes below are the repair alone.`,
          ]
        : []),
      `Candidate: ${candidate.id}`,
      changedPathsLine(changes, candidate.changes?.changedFilesPath),
      '',
      'The task the implementer was given is in the untrusted TASK block below.',
    ].join('\n')
  }

  async deliver(args: DeliverArgs): Promise<Delivery> {
    // The sealed commit, which `assertIntact` proved the worktree is at, so
    // a delivery made again never needs the worktree.
    const head =
      args.candidate.commit ??
      (await resolveCommit(this.config.workdir, 'HEAD'))
    await mkdir(this.config.deliveryDir, { recursive: true })
    const patchPath = join(
      this.config.deliveryDir,
      `${args.candidate.id}.patch`,
    )
    await writePatch(
      this.config.repoPath,
      this.config.baseCommit,
      head,
      patchPath,
    )
    // The candidate's tree as one commit on the base, beside the branch that
    // keeps every iteration. Built from refs alone, so no checkout moves; a
    // replay finds the branch it made and keeps it.
    const squashedBranch = squashedBranchFor(args.runId)
    const squashed = await ensureSquashedBranch({
      repo: this.config.repoPath,
      branch: squashedBranch,
      baseCommit: this.config.baseCommit,
      sourceCommit: head,
      message: this.commitMessage(args.iteration, args.runId, true),
      author: commitAuthorOf(this.commitSettings),
      signal: args.signal,
    })
    const recorded = {
      branch: this.config.branch,
      commit: head,
      squashedBranch,
      squashedCommit: squashed.commit,
    }
    if (!this.config.publish) {
      // The branches and commits stay in the source repository, so the patch
      // is not the only way back to the work.
      return {
        kind: 'patch',
        location: patchPath,
        summary: `patch for ${args.candidate.id} against ${this.config.baseCommit.slice(0, 12)}`,
        ...recorded,
      }
    }
    const published = this.commitSettings.publishSquashed
      ? squashedBranch
      : this.config.branch
    const url = await this.publishPullRequest(args, published)
    return {
      kind: 'pull-request',
      location: url,
      summary: `draft pull request for ${args.candidate.id} from ${published} (patch kept at ${patchPath})`,
      ...recorded,
    }
  }

  /**
   * Push `head` and open a draft pull request from it, or return the open one
   * a run interrupted after creating it left behind, so a replay never opens
   * a second.
   */
  private async publishPullRequest(
    args: DeliverArgs,
    head: string,
  ): Promise<string> {
    await pushBranch(this.config.repoPath, head, 'origin', {
      signal: args.signal,
    })
    const existing = await this.openPullRequest(head, args.signal)
    if (existing) return existing
    const issue = this.config.issue
    const title = issue
      ? `${issue.title} (#${issue.number})`
      : `factory: ${this.config.task.split('\n')[0]?.slice(0, 60) ?? 'change'}`
    const body = [
      issue ? `Closes #${issue.number}` : '',
      '',
      '## Task',
      '',
      this.config.task,
      '',
      '## Verification',
      '',
      `- check: ${this.checkDescription()}`,
      `- base: ${this.config.baseCommit}`,
      `- candidate: ${args.candidate.id}`,
      `- durably run: ${args.runId}`,
      '',
      '## Independent reviews',
      '',
      ...args.reviews.map((r) => `- ${r.lens}: ${r.decision} — ${r.notes}`),
      '',
      'Opened as a draft by the local Durably factory. A human decides whether it is ready and whether it merges.',
    ].join('\n')
    const res = await runChild(
      'gh',
      [
        'pr',
        'create',
        '--draft',
        '--base',
        await this.baseBranch(),
        '--head',
        head,
        '--title',
        title,
        '--body',
        body,
      ],
      {
        cwd: this.config.repoPath,
        timeoutMs: 120_000,
        signal: args.signal,
      },
    )
    if (res.code !== 0) {
      throw new Error(
        `gh pr create failed (${res.code ?? 'null'}): ${res.stderr.slice(-1000)}`,
      )
    }
    return res.stdout.trim().split('\n').at(-1) ?? ''
  }

  /** URL of the open pull request from `head`, or null when there is none. */
  private async openPullRequest(
    head: string,
    signal: AbortSignal,
  ): Promise<string | null> {
    const res = await runChild(
      'gh',
      [
        'pr',
        'list',
        '--head',
        head,
        '--state',
        'open',
        '--json',
        'url',
        '--limit',
        '1',
      ],
      { cwd: this.config.repoPath, timeoutMs: 120_000, signal },
    )
    // Opening a pull request without knowing none is open could make a
    // second one, so a failed lookup stops the delivery.
    if (res.code !== 0)
      throw new Error(
        `gh pr list failed (${res.code ?? 'null'}): ${res.stderr.slice(-1000)}`,
      )
    let found: unknown
    try {
      found = JSON.parse(res.stdout)
    } catch {
      throw new Error(`gh pr list printed no JSON: ${res.stdout.slice(0, 200)}`)
    }
    const url = Array.isArray(found)
      ? (found[0] as { url?: unknown } | undefined)?.url
      : undefined
    return typeof url === 'string' && url.length > 0 ? url : null
  }

  private async baseBranch(): Promise<string> {
    return defaultBranch(this.config.repoPath)
  }

  async cleanup(): Promise<void> {
    // The review snapshots are only read during a review. The worktree is
    // left here whatever the run came to: only an approved delivery removes
    // it (`retireWorktree`), and a stop keeps it for a person to look at.
    // The branches are always kept; they are the delivery.
    if (this.config.reviewSnapshotsDir)
      await removeQuietly(this.config.reviewSnapshotsDir)
  }

  /**
   * Remove the worktree once the approved delivery is recorded (ADR-0028).
   * The marker goes first, so a replay after this point never asks for the
   * worktree. Returns why git could not remove it, or null; never throws,
   * so a failed removal never fails a delivered run.
   */
  async retireWorktree(): Promise<string | null> {
    try {
      await writeFile(
        worktreeRetiredMarkerOf(this.runRoot),
        `${JSON.stringify({ at: new Date().toISOString() })}\n`,
      )
      return await removeRunWorktree(this.config.repoPath, this.runRoot)
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  }
}

/**
 * Remove a repository run's worktree with `git worktree remove --force`,
 * prune git's registration of it, and remove its review snapshots. Nothing
 * else of the run is touched. Asking again after a removal succeeds and
 * does nothing. Returns why git could not remove the worktree, or null.
 */
export async function removeRunWorktree(
  repoPath: string,
  runRoot: string,
): Promise<string | null> {
  const paths = removableRunPathsOf(runRoot)
  await removeQuietly(paths.reviewSnapshots)
  return forceRemoveWorktree(repoPath, paths.worktree)
}

/** Remove a directory, ignoring every failure; for best-effort cleanup. */
export async function removeQuietly(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}

/** How long one tree extraction may take before it is killed. */
const EXTRACT_TIMEOUT_MS = 300_000

/**
 * Extract one commit's tree into `dir`, outside every worktree, unless it is
 * already there. The commit is read into a temporary index of its own and
 * checked out from it with `git checkout-index`, so the tree is the commit's
 * whole tree: `export-ignore` and `export-subst` in its `.gitattributes`,
 * which `git archive` would honour, change nothing. Checkout filters and
 * line-ending rules still apply, as they do in the worktree. No archive file
 * is written. The tree lands in `dir.partial` first and is renamed into place
 * whole, so `dir` either holds the full tree or does not exist; a partial
 * extraction an interrupted attempt left, with its index and the index's
 * lock, is discarded first. Both git
 * processes are registered like every other child, so a cancel, a lost lease
 * or the worker's shutdown kills them.
 *
 * Symbolic links in the commit are extracted as links, and git never writes
 * through one. They may point anywhere, so the review guard resolves every
 * path before it lets a reviewer read it.
 */
export async function extractCommit(
  repo: string,
  commit: string,
  dir: string,
  signal: AbortSignal,
): Promise<void> {
  if (existsSync(dir)) return
  signal.throwIfAborted()
  // Absolute: git runs in the repository, and a relative prefix would land
  // there.
  const partial = resolve(`${dir}.partial`)
  const index = resolve(`${dir}.index`)
  // A git process killed mid-read can also leave the index's lock file,
  // which would make every retry fail.
  const discard = () =>
    Promise.all([
      rm(index, { force: true }),
      rm(`${index}.lock`, { force: true }),
    ])
  await rm(partial, { recursive: true, force: true })
  await discard()
  await mkdir(partial, { recursive: true })
  const deadline = Date.now() + EXTRACT_TIMEOUT_MS
  const gitStep = async (args: string[]) => {
    const res = await runChild('git', args, {
      cwd: repo,
      env: { GIT_INDEX_FILE: index },
      signal,
      timeoutMs: Math.max(1, deadline - Date.now()),
    })
    if (res.code !== 0)
      throw new Error(
        `git ${args[0]} of ${commit.slice(0, 12)} failed (${res.code ?? 'null'}): ${res.stderr.slice(-1000)}`,
      )
  }
  try {
    await gitStep(['read-tree', commit])
    await gitStep(['checkout-index', '--all', `--prefix=${partial}/`])
  } catch (error) {
    await rm(partial, { recursive: true, force: true })
    signal.throwIfAborted()
    throw error
  } finally {
    await discard()
  }
  await rm(dir, { recursive: true, force: true })
  await rename(partial, dir)
}

/**
 * Copy the base commit's `CLAUDE.md` and `.claude/` from its tree into a
 * review's working directory, whichever of them exist. The base is code the
 * user already merged, so a link whose target stays inside the base tree is
 * followed and its content copied: `CLAUDE.md` is often a link to another
 * file of the repository. A link that leaves the base tree, or leads
 * nowhere, is left out, so no host file outside the tree reaches the
 * reviewer's directory through a committed link. A linked directory already
 * being copied on the same path is left out too, so a link cycle ends.
 */
async function copyReviewConfig(baseTree: string, cwd: string) {
  const root = await realpath(baseTree)
  const inside = (real: string) => {
    const rel = relative(root, real)
    return (
      rel === '' ||
      (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
    )
  }
  const copy = async (from: string, to: string, open: Set<string>) => {
    let real: string
    try {
      real = await realpath(from)
    } catch {
      return
    }
    if (!inside(real) || open.has(real)) return
    const info = await stat(real)
    if (info.isFile()) {
      await copyFile(real, to, fsConstants.COPYFILE_EXCL)
      return
    }
    if (!info.isDirectory()) return
    await mkdir(to)
    const within = new Set(open).add(real)
    for (const name of await readdir(real))
      await copy(join(from, name), join(to, name), within)
  }
  for (const name of ['CLAUDE.md', '.claude'])
    await copy(join(root, name), join(cwd, name), new Set())
}

/**
 * With the baseline check on, setup must not leave untracked files that
 * `.gitignore` does not cover. A passing baseline removes every such file,
 * so setup output there would be deleted before the first agent call; and
 * the baseline could not tell it from the check's own output. Stops the run
 * as a baseline failure, naming the first few paths, before the check runs.
 */
export async function assertSetupLeftNoUntracked(
  workdir: string,
  signal?: AbortSignal,
): Promise<void> {
  const paths = await someUntracked(workdir, 5, signal)
  if (paths.length > 0) throw new Error(setupUntrackedError(workdir, paths))
}
