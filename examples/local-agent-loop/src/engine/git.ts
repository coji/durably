/**
 * Git operations used to give a factory a real repository to work in.
 *
 * Every call goes through `runChild`, so each one inherits the cancel-aware,
 * process-group-contained subprocess handling and cannot outlive a lost lease.
 * Nothing here interprets a repository's contents; it only creates isolated
 * worktrees, seals work as commits, and reads back what changed.
 */
import { runChild } from './child.js'

const DEFAULT_TIMEOUT_MS = 120_000

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
  if (options.includeUntracked === false) args.push('--untracked-files=no')
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

/** Remove a worktree. Never throws: cleanup must not fail a finished run. */
export async function removeWorktree(
  repo: string,
  dir: string,
): Promise<boolean> {
  try {
    await git(repo, ['worktree', 'remove', '--force', dir])
    return true
  } catch {
    return false
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

function identityArgs(author: CommitAuthor): string[] {
  return ['-c', `user.name=${author.name}`, '-c', `user.email=${author.email}`]
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
  await git(
    dir,
    [
      ...identityArgs(options.author ?? DEFAULT_COMMIT_AUTHOR),
      'commit',
      '--no-verify',
      '--no-gpg-sign',
      '-m',
      message,
    ],
    pass,
  )
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
 * same sha. A branch that already exists is kept when it is exactly one
 * commit on the base with the source's tree, which is what a replay after an
 * interruption finds; any other branch by that name is refused, never
 * overwritten. The same tree as the base still gets its own commit, so the
 * branch is always one commit ahead of the base.
 */
export async function ensureSquashedBranch(
  spec: SquashSpec,
): Promise<{ commit: string; created: boolean }> {
  const pass = spec.signal ? { signal: spec.signal } : {}
  const tree = await treeOf(spec.repo, spec.sourceCommit)
  const existing = await branchCommit(spec.repo, spec.branch)
  if (existing) {
    // Parents on the first line, the tree on the second.
    const [parents, existingTree] = (
      await git(spec.repo, ['log', '-1', '--format=%P%n%T', existing])
    )
      .trimEnd()
      .split('\n')
    if (parents !== spec.baseCommit || existingTree !== tree)
      throw new Error(
        `squashed branch ${spec.branch} already exists at ${existing.slice(0, 12)} and is not one commit on ${spec.baseCommit.slice(0, 12)} with tree ${tree.slice(0, 12)}; it was left as it is`,
      )
    return { commit: existing, created: false }
  }
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
      {
        ...pass,
        env: {
          GIT_AUTHOR_NAME: spec.author.name,
          GIT_AUTHOR_EMAIL: spec.author.email,
          GIT_COMMITTER_NAME: spec.author.name,
          GIT_COMMITTER_EMAIL: spec.author.email,
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_DATE: date,
        },
      },
    )
  ).trim()
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
 */
export async function discardWorktree(
  repo: string,
  dir: string,
  branch: string,
): Promise<void> {
  await removeWorktree(repo, dir)
  for (const args of [
    ['worktree', 'prune'],
    ['branch', '-D', branch],
  ]) {
    try {
      await git(repo, args)
    } catch {
      // Nothing to remove; a fresh run takes this path every time.
    }
  }
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
 * Up to `limit` paths that `cleanUntracked` would remove, as `git clean`
 * itself reports them in a dry run. Using the same command keeps this check
 * and the clean in step: an empty directory counts, a directory holding only
 * ignored files does not, and a nested repository does. Empty when the clean
 * would remove nothing; only that and the first few names matter, so a long
 * listing is not read in full.
 */
export async function someUntracked(
  cwd: string,
  limit: number,
  signal?: AbortSignal,
): Promise<string[]> {
  const out = await git(cwd, ['clean', '-ffdn'], {
    // The dry run's "Would remove" wording is translated in other locales.
    env: { LC_ALL: 'C' },
    maxOutputChars: 100_000,
    ...(signal ? { signal } : {}),
  })
  const lines = out.split('\n')
  // A capped listing keeps its end, so its first line may be cut short.
  if (out.length >= 100_000) lines.shift()
  return lines
    .map((line) => /^Would remove (.+)$/.exec(line)?.[1])
    .filter((path): path is string => path !== undefined)
    .slice(0, limit)
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
