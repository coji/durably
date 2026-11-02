/**
 * Git operations used to give a factory a real repository to work in.
 *
 * Every call goes through `runChild`, so each one inherits the cancel-aware,
 * process-group-contained subprocess handling and cannot outlive a lost lease.
 * Nothing here interprets a repository's contents; it only creates isolated
 * worktrees, seals work as commits, reads back what changed, and removes a
 * finished run's worktree and, when asked, its branches.
 */
import { existsSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

import { runChild, SpawnTimeoutError } from './child.js'
import { DEMO } from './demo-command.js'
import { formatDuration } from './format.js'

const DEFAULT_TIMEOUT_MS = 120_000

/**
 * How long `git worktree remove` may take. A worktree with installed
 * dependencies holds tens of thousands of files or more, and one such
 * removal has taken over two minutes.
 */
export const WORKTREE_REMOVE_TIMEOUT_MS = 600_000

export class GitError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message)
    this.name = 'GitError'
  }
}

async function git(
  cwd: string,
  args: string[],
  options: {
    signal?: AbortSignal
    timeoutMs?: number
    maxOutputChars?: number
    env?: Record<string, string>
  } = {},
): Promise<string> {
  const result = await runChild('git', args, {
    cwd,
    ...(options.env ? { env: options.env } : {}),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxOutputChars: options.maxOutputChars ?? 1_000_000,
    ...(options.signal ? { signal: options.signal } : {}),
  })
  if (result.code !== 0) {
    throw new GitError(
      `git ${args.join(' ')} failed with code ${result.code ?? 'null'}`,
      result.stderr.slice(-2000),
    )
  }
  return result.stdout
}

/** Absolute path of the repository root containing `cwd`. */
export async function repoRoot(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim()
}

/** Resolve any ref to a full commit sha. */
export async function resolveCommit(
  repo: string,
  ref: string,
): Promise<string> {
  return (await git(repo, ['rev-parse', `${ref}^{commit}`])).trim()
}

/**
 * Tree sha of a commit. This is the identity a sealed candidate is checked
 * against: two commits with different messages but identical content share a
 * tree, and any change to the content changes it.
 */
export async function treeOf(repo: string, commit: string): Promise<string> {
  return (await git(repo, ['rev-parse', `${commit}^{tree}`])).trim()
}

/**
 * True when the working tree differs from `HEAD`.
 *
 * `includeUntracked` decides whether files git does not track count. They are
 * not part of any commit, so they cannot change a sealed candidate's tree —
 * but a later `commitAll` would pick them up, so sealing and integrity
 * checking want opposite answers here.
 */
export async function isDirty(
  cwd: string,
  options: { includeUntracked?: boolean } = {},
): Promise<boolean> {
  const args = ['status', '--porcelain=v1']
  // Without untracked files, a nested repository counts as changed when a
  // tracked file in it is edited or its `HEAD` moved, as `changedGitlinks`
  // sees it, whatever `diff.ignoreSubmodules` or `submodule.<name>.ignore`
  // config would hide; one git cannot read makes this throw.
  if (options.includeUntracked === false)
    args.push('--untracked-files=no', '--ignore-submodules=untracked')
  const out = await git(cwd, args)
  return out.trim().length > 0
}

export interface WorktreeSpec {
  repo: string
  dir: string
  /** Commit the worktree starts from. */
  baseCommit: string
  /** Create and check out this branch; omit for a detached worktree. */
  branch?: string
  signal?: AbortSignal
}

/**
 * Add an isolated worktree. The agent edits one of these instead of the
 * repository the user is sitting in, so an interrupted run never leaves the
 * working checkout in a half-finished state.
 */
export async function addWorktree(spec: WorktreeSpec): Promise<void> {
  const args = ['worktree', 'add']
  if (spec.branch) args.push('-b', spec.branch)
  else args.push('--detach')
  args.push(spec.dir, spec.baseCommit)
  await git(spec.repo, args, spec.signal ? { signal: spec.signal } : {})
}

/**
 * Remove a worktree. Never throws: cleanup must not fail a finished run.
 * It gets the same limit as every other worktree removal, since the
 * worktree an earlier setup left may hold installed dependencies, and
 * `signal` stops it sooner.
 */
export async function removeWorktree(
  repo: string,
  dir: string,
  signal?: AbortSignal,
): Promise<boolean> {
  try {
    await git(repo, ['worktree', 'remove', '--force', dir], {
      timeoutMs: WORKTREE_REMOVE_TIMEOUT_MS,
      ...(signal ? { signal } : {}),
    })
    return true
  } catch {
    return false
  }
}

/** A failed git call as one line: the command and what git printed. */
export function describeGitFailure(error: unknown): string {
  if (error instanceof GitError) {
    const stderr = error.stderr.trim()
    return stderr ? `${error.message}: ${stderr}` : error.message
  }
  return error instanceof Error ? error.message : String(error)
}

/**
 * Why git could not remove a worktree. `byHand` says no retry can remove
 * it, so asking again would only repeat the warning: git no longer lists
 * the directory, and it is not removed any other way (ADR-0028).
 */
export interface RemoveFailure {
  message: string
  byHand: boolean
}

/**
 * A failed `git worktree remove` of `dir` as one line: git's words, or, when
 * it was stopped at its limit, that `dir` may be partly removed. `listed`
 * says whether git still lists `dir` as a worktree afterwards, null when it
 * could not tell: while it does, `demo prune --apply` continues the removal;
 * once git has deleted `dir/.git` it no longer does, and since the directory
 * is not removed any other way (ADR-0028), a person removes it.
 */
function describeRemoveFailure(
  error: unknown,
  dir: string,
  listed: boolean | null,
): RemoveFailure {
  const failure =
    error instanceof SpawnTimeoutError
      ? `git worktree remove was stopped at its ${formatDuration(error.timeoutMs, 'en')} limit before it finished; ${dir} may be partly removed`
      : describeGitFailure(error)
  if (listed === false)
    return {
      message: `${failure}. git no longer lists ${dir} as a worktree, so neither archive nor ${DEMO} prune --apply can remove it: remove the directory by hand`,
      byHand: true,
    }
  // Not by hand while git may still list it: a retry can still finish it.
  if (error instanceof SpawnTimeoutError)
    return {
      message: listed
        ? `${failure}. git still lists it, so ${DEMO} prune --apply continues the removal`
        : `${failure}. If git worktree list in the run's repository still names it, ${DEMO} prune --apply continues the removal; otherwise remove the directory by hand`,
      byHand: false,
    }
  return { message: failure, byHand: false }
}

/**
 * Force-remove a finished run's worktree, then prune git's registration of
 * it, so neither the directory nor a stale `git worktree list` entry stays.
 * A directory that is already gone is only pruned, so asking again after a
 * removal succeeds. Returns why git could not, or null. The directory is
 * never removed any other way: a worktree git refuses to remove is left for
 * a person to look at. A removal stopped at `timeoutMs` may have deleted
 * part of the directory; the warning says so, and whether a retry can
 * still finish it or a person removes it.
 */
export async function forceRemoveWorktree(
  repo: string,
  dir: string,
  timeoutMs = WORKTREE_REMOVE_TIMEOUT_MS,
): Promise<RemoveFailure | null> {
  let refused: unknown = null
  const present = existsSync(dir)
  if (present) {
    try {
      await git(repo, ['worktree', 'remove', '--force', dir], { timeoutMs })
    } catch (error) {
      refused = error
    }
  }
  try {
    await git(repo, ['worktree', 'prune'])
  } catch (error) {
    return refused
      ? describeRemoveFailure(refused, dir, null)
      : { message: describeGitFailure(error), byHand: false }
  }
  if (!refused) {
    // A locked registration outlives the prune once its directory is gone.
    // The lock is a person's to lift, so it is named, not overridden; once
    // it is, asking again takes the registration.
    if (present || !(await worktreeRegistered(repo, dir).catch(() => false)))
      return null
    return {
      message: `git still lists ${dir} as a locked worktree, though the directory is gone: run git worktree unlock ${dir} in ${repo}, then archive again`,
      byHand: false,
    }
  }
  // Whether a retry can still finish it: git refuses a directory it no
  // longer lists, as after a removal stopped once dir/.git was deleted.
  const listed = await worktreeRegistered(repo, dir).catch(() => null)
  // Stopped after it removed the directory, and the prune took the rest:
  // nothing is left to remove.
  if (listed === false && !existsSync(dir)) return null
  return describeRemoveFailure(refused, dir, listed)
}

/**
 * Remove a worktree that holds nothing anyone works in, such as the test
 * probe's base, and git's registration of it: `git worktree remove -f -f`,
 * which also takes a registration left locked by a `git worktree add` that
 * was killed, and a registration whose directory is already gone, then a
 * prune. Returns null only once `git worktree list` no longer names `dir`,
 * else why git could not tell or remove it. The directory itself is left
 * to the caller when git refuses it.
 */
export async function removeWorktreeRegistration(
  repo: string,
  dir: string,
  timeoutMs = WORKTREE_REMOVE_TIMEOUT_MS,
): Promise<string | null> {
  let failure: string | null = null
  try {
    await git(repo, ['worktree', 'remove', '--force', '--force', dir], {
      timeoutMs,
    })
  } catch (error) {
    // Also refused when git never registered it, which the list tells; the
    // failure is answered only while git still lists it.
    failure = describeRemoveFailure(error, dir, true).message
  }
  try {
    await git(repo, ['worktree', 'prune'])
    return (await worktreeRegistered(repo, dir))
      ? (failure ?? `${dir} is still a registered worktree`)
      : null
  } catch (error) {
    return describeGitFailure(error)
  }
}

/**
 * Whether `git worktree list` names `dir`, compared also through the real
 * path of its nearest existing ancestor, since git records real paths and
 * `dir` may be gone. Throws when git cannot list them.
 */
async function worktreeRegistered(repo: string, dir: string): Promise<boolean> {
  return (await registeredWorktrees(repo, [dir])).has(dir)
}

/**
 * `dir` as given and through the real path of its nearest existing
 * ancestor: git records real paths, and `dir` may be gone.
 */
async function pathsGitMayRecord(dir: string): Promise<Set<string>> {
  const wanted = new Set([resolve(dir)])
  let rest = ''
  for (let at = resolve(dir); ; at = dirname(at)) {
    const real = await realpath(at).catch(() => null)
    if (real) {
      wanted.add(rest ? join(real, rest) : real)
      break
    }
    if (dirname(at) === at) break
    rest = rest ? join(basename(at), rest) : basename(at)
  }
  return wanted
}

/**
 * Of `dirs`, the ones `git worktree list` in `repo` names, each with the
 * branch git has checked out there, or null when it is detached. Compared
 * like `worktreeRegistered`. Throws when git cannot list them.
 */
export async function registeredWorktrees(
  repo: string,
  dirs: string[],
): Promise<Map<string, string | null>> {
  const out = await git(repo, ['worktree', 'list', '--porcelain'])
  const entries = porcelainWorktreeEntries(out)
  const found = new Map<string, string | null>()
  for (const dir of dirs) {
    const wanted = await pathsGitMayRecord(dir)
    const entry = entries.find((e) => wanted.has(e.path))
    if (entry) found.set(dir, entry.branch)
  }
  return found
}

/**
 * Each worktree a `git worktree list --porcelain` output names, one per
 * `worktree <path>` line, with the branch of its `branch refs/heads/<name>`
 * line, or null when it has none, as a detached one. Without `-z`, which
 * needs git 2.36, the lines are newline-separated, so a path that holds a
 * newline cannot be read back; such a path is not supported and never
 * matches.
 */
export function porcelainWorktreeEntries(
  out: string,
): { path: string; branch: string | null }[] {
  const entries: { path: string; branch: string | null }[] = []
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree '))
      entries.push({ path: line.slice(9), branch: null })
    else if (line.startsWith('branch refs/heads/')) {
      const last = entries.at(-1)
      if (last) last.branch = line.slice(18)
    }
  }
  return entries
}

/**
 * Delete one local branch, whatever it has merged. Returns why git could
 * not, or null; a branch checked out in a worktree is refused by git.
 */
export async function deleteBranch(
  repo: string,
  branch: string,
): Promise<string | null> {
  try {
    await git(repo, ['branch', '-D', branch])
    return null
  } catch (error) {
    return describeGitFailure(error)
  }
}

/** Who a factory commit is by: both its author and its committer. */
export interface CommitAuthor {
  name: string
  email: string
}

/** The identity factory commits carry when the run names none. */
export const DEFAULT_COMMIT_AUTHOR: CommitAuthor = {
  name: 'durably-factory',
  email: 'durably-factory@localhost',
}

/**
 * Child environment that makes `author` both author and committer of a commit.
 *
 * git reads `GIT_AUTHOR_*` and `GIT_COMMITTER_*` before `user.name` and
 * `user.email`, so setting identity through `-c` would lose to variables the
 * worker happened to inherit. Setting the variables themselves always wins.
 */
function identityEnv(
  author: CommitAuthor,
  date?: string,
): Record<string, string> {
  return {
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
    ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}),
  }
}

/**
 * Commit everything the agent changed, honouring `.gitignore`.
 *
 * Returns the resulting commit. When the agent changed nothing, `HEAD` is
 * returned with `created: false` rather than an empty commit, so an iteration
 * that did no work seals the same candidate it started from and the caller can
 * see that nothing moved.
 */
export async function commitAll(
  dir: string,
  message: string,
  options: { signal?: AbortSignal; author?: CommitAuthor } = {},
): Promise<{ commit: string; created: boolean }> {
  const pass = options.signal ? { signal: options.signal } : {}
  await git(dir, ['add', '-A'], pass)
  const staged = await git(dir, ['diff', '--cached', '--name-only'], pass)
  if (staged.trim().length === 0) {
    return { commit: await resolveCommit(dir, 'HEAD'), created: false }
  }
  await git(dir, ['commit', '--no-verify', '--no-gpg-sign', '-m', message], {
    ...pass,
    env: identityEnv(options.author ?? DEFAULT_COMMIT_AUTHOR),
  })
  return { commit: await resolveCommit(dir, 'HEAD'), created: true }
}

export interface SquashSpec {
  repo: string
  /** Branch to create; an existing one is checked, never moved. */
  branch: string
  /** The squash commit's only parent. */
  baseCommit: string
  /** The commit whose tree the squash commit carries. */
  sourceCommit: string
  message: string
  author: CommitAuthor
  signal?: AbortSignal
}

/**
 * Put `sourceCommit`'s tree on `branch` as one commit whose only parent is
 * `baseCommit`, without touching any checkout or worktree.
 *
 * The commit is dated from the source commit, so building it again gives the
 * same sha. The expected commit is always written first (`commit-tree` adds an
 * object but no ref); a branch that already exists is kept only when it points
 * at exactly that commit, which is what a replay after an interruption finds.
 * Any other branch by that name, even one with the same parent and tree but a
 * different author or message, is refused, never overwritten. The same tree
 * as the base still gets its own commit, so the branch is always one commit
 * ahead of the base.
 */
export async function ensureSquashedBranch(
  spec: SquashSpec,
): Promise<{ commit: string; created: boolean }> {
  const pass = spec.signal ? { signal: spec.signal } : {}
  const tree = await treeOf(spec.repo, spec.sourceCommit)
  const date = `${(
    await git(spec.repo, ['log', '-1', '--format=%ct', spec.sourceCommit])
  ).trim()} +0000`
  const commit = (
    await git(
      spec.repo,
      [
        'commit-tree',
        '--no-gpg-sign',
        tree,
        '-p',
        spec.baseCommit,
        '-m',
        spec.message,
      ],
      { ...pass, env: identityEnv(spec.author, date) },
    )
  ).trim()
  const existing = await branchCommit(spec.repo, spec.branch)
  if (existing) {
    if (existing !== commit)
      throw new Error(
        `squashed branch ${spec.branch} already exists at ${existing.slice(0, 12)}, not at the expected squash ${commit.slice(0, 12)} on ${spec.baseCommit.slice(0, 12)}; it was left as it is`,
      )
    return { commit: existing, created: false }
  }
  // An empty old value makes the update fail if the branch appeared since.
  await git(
    spec.repo,
    ['update-ref', `refs/heads/${spec.branch}`, commit, ''],
    pass,
  )
  return { commit, created: true }
}

/** The commit a local branch points at, or null when there is no such branch. */
export async function branchCommit(
  repo: string,
  branch: string,
): Promise<string | null> {
  const res = await runChild(
    'git',
    ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`],
    { cwd: repo, timeoutMs: DEFAULT_TIMEOUT_MS },
  )
  const out = res.stdout.trim()
  return res.code === 0 && out.length > 0 ? out : null
}

/**
 * `added:`/`modified:`/`deleted:` lines between two commits. Uncapped: a
 * truncated list would silently hide changed files from whoever reads it.
 */
export async function describeCommitChanges(
  repo: string,
  baseCommit: string,
  headCommit: string,
): Promise<string[]> {
  const out = await git(
    repo,
    ['diff', '--name-status', '-z', baseCommit, headCommit],
    { maxOutputChars: Number.POSITIVE_INFINITY },
  )
  const fields = out.split('\0').filter((f) => f.length > 0)
  const labels: Record<string, string> = {
    A: 'added',
    M: 'modified',
    D: 'deleted',
    R: 'renamed',
    C: 'copied',
    T: 'modified',
  }
  const lines: string[] = []
  for (let i = 0; i < fields.length;) {
    const status = fields[i] ?? ''
    const code = status.charAt(0)
    // Rename and copy entries carry two paths.
    const takesTwo = code === 'R' || code === 'C'
    const from = fields[i + 1] ?? ''
    const to = takesTwo ? (fields[i + 2] ?? '') : from
    lines.push(
      `${labels[code] ?? 'changed'}: ${takesTwo ? `${from} -> ${to}` : from}`,
    )
    i += takesTwo ? 3 : 2
  }
  return lines
}

/** How big a change is, as git counts it. */
export interface DiffStat {
  /** Changed files, binary ones included; a rename counts once. */
  files: number
  /** Added and deleted text lines; binary files add none. */
  additions: number
  deletions: number
}

/**
 * Size of the change between two commits, from `git diff --numstat -z`.
 * NUL separation keeps paths with spaces, tabs or newlines intact, and a
 * rename record carries its two paths in separate fields.
 */
export async function diffStat(
  repo: string,
  baseCommit: string,
  headCommit: string,
): Promise<DiffStat> {
  const out = await git(
    repo,
    ['diff', '--numstat', '-z', baseCommit, headCommit],
    { maxOutputChars: Number.POSITIVE_INFINITY },
  )
  const fields = out.split('\0')
  const stat: DiffStat = { files: 0, additions: 0, deletions: 0 }
  for (let i = 0; i < fields.length;) {
    const record = fields[i] ?? ''
    if (record.length === 0) {
      i++
      continue
    }
    const [added = '', deleted = '', path = ''] = record.split('\t')
    stat.files++
    // `-` marks a binary file: counted as changed, with no lines.
    if (added !== '-') stat.additions += Number(added)
    if (deleted !== '-') stat.deletions += Number(deleted)
    // A rename or copy leaves the path empty and puts both paths next.
    i += path.length === 0 ? 3 : 1
  }
  return stat
}

/**
 * Write the unified diff between two commits to a file.
 *
 * git writes the file itself rather than streaming through this process,
 * because a captured diff is subject to the output cap and a patch truncated
 * from the front is worse than no patch at all: it still looks like a patch,
 * and `git apply` rejects it with nothing to explain why.
 */
export async function writePatch(
  repo: string,
  baseCommit: string,
  headCommit: string,
  outPath: string,
): Promise<void> {
  await git(repo, [
    'diff',
    '--binary',
    '--no-color',
    `--output=${outPath}`,
    baseCommit,
    headCommit,
  ])
}

/**
 * Drop a worktree and its branch, ignoring every failure.
 *
 * Setup is a durable step: a worker killed part way through re-runs it, and
 * `git worktree add -b` refuses a directory or branch that already exists.
 * Clearing both first makes preparation replayable. Safe because no candidate
 * has been sealed yet at that point, and the branch name carries the run id.
 * `signal`, the setup's, stops it on a cancel or a lost lease.
 */
export async function discardWorktree(
  repo: string,
  dir: string,
  branch: string,
  signal?: AbortSignal,
): Promise<void> {
  await removeWorktree(repo, dir, signal)
  for (const args of [
    ['worktree', 'prune'],
    ['branch', '-D', branch],
  ]) {
    try {
      await git(repo, args, signal ? { signal } : {})
    } catch {
      // Nothing to remove; a fresh run takes this path every time.
    }
  }
}

/**
 * Put a worktree's tracked files, its index and its `HEAD` back at `commit`.
 * Files the index holds that `commit` does not are removed; untracked ones
 * stay. The test probe uses it to bring each worktree back after a run.
 */
export async function resetHard(
  dir: string,
  commit: string,
  signal?: AbortSignal,
): Promise<void> {
  await git(
    dir,
    ['reset', '--hard', '--quiet', commit],
    signal ? { signal } : {},
  )
}

/**
 * Write `paths` as `commit` has them into a worktree of the same repository,
 * and nothing else. Each path is taken literally, never as a pathspec
 * pattern, and git refuses one beyond a symbolic link.
 */
export async function checkoutPathsFrom(
  dir: string,
  commit: string,
  paths: string[],
  signal?: AbortSignal,
): Promise<void> {
  if (paths.length === 0) return
  await git(dir, ['checkout', commit, '--', ...paths], {
    env: { GIT_LITERAL_PATHSPECS: '1' },
    ...(signal ? { signal } : {}),
  })
}

/**
 * Remove untracked files and directories that `.gitignore` does not cover,
 * including nested repositories (the second `-f`). Ignored files, such as
 * installed dependencies, stay.
 */
export async function cleanUntracked(
  cwd: string,
  signal?: AbortSignal,
): Promise<void> {
  await git(cwd, ['clean', '-ffd'], signal ? { signal } : {})
}

/**
 * The nested repositories `commit` records as gitlinks, each with the commit
 * it records, that the worktree `dir` reports as changed: a file edited, or
 * a commit made, inside one. Run it after `resetHard` to `commit`, which
 * puts back everything else but leaves what is inside a nested repository.
 */
export async function changedGitlinks(
  dir: string,
  commit: string,
  signal?: AbortSignal,
): Promise<{ path: string; commit: string }[]> {
  const pass = signal ? { signal } : {}
  const status = await git(
    dir,
    [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=no',
      // Unlike `none`, this skips listing each nested repository's untracked
      // files, which no reset touches, while still overriding config that
      // hides changed nested repositories.
      '--ignore-submodules=untracked',
    ],
    pass,
  )
  const paths = status
    .split('\0')
    .filter((entry) => entry.length > 3)
    .map((entry) => entry.slice(3))
  if (paths.length === 0) return []
  const listed = await git(dir, ['ls-tree', '-z', commit, '--', ...paths], {
    env: { GIT_LITERAL_PATHSPECS: '1' },
    ...pass,
  })
  return listed.split('\0').flatMap((entry) => {
    const found = /^160000 commit ([0-9a-f]+)\t(.+)$/s.exec(entry)
    return found?.[1] && found[2] ? [{ path: found[2], commit: found[1] }] : []
  })
}

/** The longest `untrackedPaths` listing read, in characters. */
const UNTRACKED_LIST_CHARS = 10_000_000

/**
 * Every untracked path `.gitignore` does not cover, relative to `cwd`, a
 * worktree's top: each file, and a nested repository as its directory with
 * a trailing `/`. Throws when the listing is too long to read in full,
 * since a cut one would leave some out.
 */
export async function untrackedPaths(
  cwd: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const out = await git(
    cwd,
    ['ls-files', '--others', '--exclude-standard', '-z'],
    {
      maxOutputChars: UNTRACKED_LIST_CHARS,
      ...(signal ? { signal } : {}),
    },
  )
  if (out.length >= UNTRACKED_LIST_CHARS)
    throw new Error(`too many untracked files in ${cwd} to list`)
  return out.split('\0').filter(Boolean)
}

/**
 * Up to `limit` paths that `cleanUntracked` would remove, as `git clean`
 * itself reports them in a dry run. Using the same command keeps this check
 * and the clean in step: an empty directory counts, a directory holding only
 * ignored files does not, and a nested repository does. Empty when the clean
 * would remove nothing; for a finite `limit` only that and the first few
 * names matter, so a long listing is not read in full, while an infinite
 * one reads it all. Each path is the literal name relative to `cwd`, with
 * git's quoting undone.
 */
export async function someUntracked(
  cwd: string,
  limit: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const cap = Number.isFinite(limit) ? 100_000 : Number.POSITIVE_INFINITY
  // `git clean` has no `-z`; with `core.quotePath` off it quotes only a
  // name holding `"`, `\` or a control character, which `unquotePath`
  // undoes, and a newline in a name never splits a line.
  const out = await git(cwd, ['-c', 'core.quotePath=false', 'clean', '-ffdn'], {
    // The dry run's "Would remove" wording is translated in other locales.
    env: { LC_ALL: 'C' },
    maxOutputChars: cap,
    ...(signal ? { signal } : {}),
  })
  const lines = out.split('\n')
  // A capped listing keeps its end, so its first line may be cut short.
  if (out.length >= cap) lines.shift()
  return lines
    .map((line) => /^Would remove (.+)$/.exec(line)?.[1])
    .filter((path): path is string => path !== undefined)
    .slice(0, limit)
    .map(unquotePath)
}

const C_ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  '\\': 92,
}

/**
 * A path as git prints it outside `-z` output, with its C-style quoting
 * undone: the surrounding double quotes go, and each escape, a three-digit
 * octal one for a byte included, becomes what it stands for, read as UTF-8.
 * A path git did not quote comes back as it is.
 */
function unquotePath(quoted: string): string {
  if (!(quoted.length >= 2 && quoted.startsWith('"') && quoted.endsWith('"')))
    return quoted
  const bytes: number[] = []
  const body = Buffer.from(quoted.slice(1, -1), 'utf8')
  for (let i = 0; i < body.length; i++) {
    const byte = body[i] ?? 0
    if (byte !== 92) {
      bytes.push(byte)
      continue
    }
    const next = String.fromCharCode(body[i + 1] ?? 0)
    const octal = /^[0-7]{3}$/.exec(body.subarray(i + 1, i + 4).toString())
    if (octal) {
      bytes.push(Number.parseInt(octal[0], 8))
      i += 3
    } else {
      bytes.push(C_ESCAPES[next] ?? body[i + 1] ?? 92)
      i += 1
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

/** Read one file's contents at a commit without checking it out. */
export async function readFileAt(
  repo: string,
  commit: string,
  path: string,
): Promise<string | null> {
  try {
    return await git(repo, ['show', `${commit}:${path}`])
  } catch {
    return null
  }
}

/** Push a branch to a remote, setting upstream. */
export async function pushBranch(
  repo: string,
  branch: string,
  remote = 'origin',
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  await git(repo, ['push', '--set-upstream', remote, branch], {
    timeoutMs: 300_000,
    ...(options.signal ? { signal: options.signal } : {}),
  })
}

/** Name of the remote's default branch, e.g. `main`. */
export async function defaultBranch(
  repo: string,
  remote = 'origin',
): Promise<string> {
  try {
    const out = await git(repo, [
      'symbolic-ref',
      '--short',
      `refs/remotes/${remote}/HEAD`,
    ])
    const name = out.trim()
    const prefix = `${remote}/`
    return name.startsWith(prefix) ? name.slice(prefix.length) : name
  } catch {
    return 'main'
  }
}
