/**
 * The test probe (ADR-0039): run the test files a sealed candidate added or
 * changed on the base commit and on the candidate, and write down what each
 * did, for the reviewers' trusted context.
 *
 * Reviewers cannot run anything, so whether a new test exercises the change
 * was something they guessed from the code. The probe runs each matching
 * test file twice, once in the base worktree with only that file taken from
 * the candidate and once in the candidate's own worktree, and records exit
 * codes, times and output tails. It never judges the result: a test can fail
 * on the base only because a module it imports is missing there, and the
 * output tail is what lets a reviewer tell.
 */
import { existsSync } from 'node:fs'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, posix, relative, resolve, sep } from 'node:path'

import { runChild } from '../engine/child.js'
import { formatters } from '../engine/format.js'
import {
  checkoutPathsFrom,
  describeCommitChanges,
  resetHard,
} from '../engine/git.js'
import { fencedText } from '../engine/markdown.js'
import type { CandidateRef } from '../engine/types.js'
import { prepareTestProbeBase } from '../targets/index.js'
import { testProbeResultOf } from './layout.js'
import { MAX_CONTEXT_BYTES, type RepoTargetConfig } from './target.js'
import type {
  TestProbeFile,
  TestProbeRecord,
  TestProbeRule,
  TestProbeSide,
} from './types.js'

/** The result text is English, like the prompts it goes into. */
const { formatDuration } = formatters('en')

/** The element of a probe command each file's path replaces. */
export const TEST_PROBE_FILES = '{files}'

/** Each side's stdout and stderr are kept up to this many characters. */
const OUTPUT_CHARS = 8000

/** The longest reason a side that could not run records. */
const REASON_CHARS = 1000

/** One test file to probe, with the entry whose glob it matched first. */
interface ProbeTarget {
  path: string
  rule: TestProbeRule
}

/**
 * The files to probe: each `added:` or `modified:` line of the candidate's
 * changed-file list whose path matches an entry's glob, once, with the
 * first entry it matches. Deleted, renamed and copied files are never run.
 */
export function probeTargets(
  rules: TestProbeRule[],
  changedFiles: string[],
): ProbeTarget[] {
  const seen = new Set<string>()
  const targets: ProbeTarget[] = []
  for (const line of changedFiles) {
    const found = /^(added|modified): (.+)$/.exec(line)
    const path = found?.[2]
    if (!path || seen.has(path)) continue
    const rule = rules.find((r) => posix.matchesGlob(path, r.glob))
    if (!rule) continue
    seen.add(path)
    targets.push({ path, rule })
  }
  return targets
}

/** Why `path`, repository-relative, would leave `root`, or null. */
async function escapes(root: string, path: string): Promise<string | null> {
  const outside = (from: string) =>
    from === '..' || from.startsWith(`..${sep}`) || isAbsolute(from)
  if (isAbsolute(path) || outside(relative(root, resolve(root, path))))
    return `${path} is not inside the worktree`
  // Through links too: a file that is a link out of the worktree is not run.
  const [real, top] = await Promise.all([
    realpath(resolve(root, path)).catch(() => null),
    realpath(root),
  ])
  if (real === null) return `${path} is not in the worktree`
  return outside(relative(top, real))
    ? `${path} resolves outside the worktree`
    : null
}

/** A side that never started, for `reason`. */
function notRun(reason: string): TestProbeSide {
  return { ran: false, reason: reason.slice(0, REASON_CHARS), elapsedMs: 0 }
}

/** One side's result and what it printed. */
interface SideRun {
  side: TestProbeSide
  output: string
}

/**
 * Run one test file in `cwd`, as argv: the path replaces each `{files}`
 * element and is never seen by a shell. A command that cannot start or
 * times out is a side that could not run; a cancel or a lost lease throws.
 */
async function runSide(
  target: ProbeTarget,
  cwd: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<SideRun> {
  const outside = await escapes(cwd, target.path)
  if (outside) return { side: notRun(outside), output: '' }
  const [command, ...args] = target.rule.command.map((arg) =>
    arg === TEST_PROBE_FILES ? target.path : arg,
  )
  if (!command) return { side: notRun('empty command'), output: '' }
  const started = Date.now()
  try {
    const res = await runChild(command, args, {
      cwd,
      timeoutMs,
      maxOutputChars: OUTPUT_CHARS,
      signal,
    })
    return {
      side: { ran: true, exitCode: res.code, elapsedMs: res.elapsedMs },
      output: `${res.stdout}${res.stderr}`,
    }
  } catch (error) {
    if (signal.aborted || (error as Error).name === 'SpawnCancelledError')
      throw error
    return {
      side: {
        ...notRun((error as Error).message),
        elapsedMs: Date.now() - started,
      },
      output: '',
    }
  }
}

/** A git failure in one line, with what git printed. */
function describeFailure(error: unknown): string {
  const stderr = (error as { stderr?: string }).stderr?.trim()
  return [(error as Error).message, stderr].filter(Boolean).join(': ')
}

/**
 * Make the base worktree ready for this candidate's files: made again when
 * it is gone, reset to the base commit, and given only those files from the
 * candidate. Returns why it could not be, or null.
 */
async function prepareBase(
  config: RepoTargetConfig,
  candidate: CandidateRef,
  paths: string[],
  signal: AbortSignal,
): Promise<string | null> {
  const base = config.testProbeBase
  if (!base) return 'no base worktree was set up'
  if (base.setupFailure)
    return `the base worktree could not be set up: ${base.setupFailure}`
  // The run removes it whenever it stops running, a wait for a person's
  // decision on the spec included; the next probe makes it again.
  if (!existsSync(base.workdir)) {
    const made = await prepareTestProbeBase({
      repo: config.repoPath,
      root: dirname(base.workdir),
      baseCommit: config.baseCommit,
      setupCommand: config.setupCommand,
      signal,
    })
    if (made.setupFailure)
      return `the base worktree could not be set up again: ${made.setupFailure}`
  }
  if (!candidate.commit) return `${candidate.id} has no commit`
  try {
    await resetHard(base.workdir, config.baseCommit, signal)
    await checkoutPathsFrom(base.workdir, candidate.commit, paths, signal)
    return null
  } catch (error) {
    if (signal.aborted) throw error
    return `the candidate's test files could not be put on the base: ${describeFailure(error)}`
  }
}

/** What one file came to, as the result and the report name it. */
export type TestProbeOutcome =
  | 'failed-on-base'
  | 'passed-on-both'
  | 'failed-on-candidate'
  | 'could-not-run'

export function testProbeOutcomeOf(file: TestProbeFile): TestProbeOutcome {
  const { base, candidate } = file
  if (!base.ran || !candidate.ran) return 'could-not-run'
  if (candidate.exitCode !== 0) return 'failed-on-candidate'
  return base.exitCode === 0 ? 'passed-on-both' : 'failed-on-base'
}

const OUTCOME_TEXT: Record<TestProbeOutcome, string> = {
  'failed-on-base': 'failed on the base, passed on the candidate',
  'passed-on-both': 'passed on the base and on the candidate',
  'failed-on-candidate': 'failed on the candidate',
  'could-not-run': 'could not run',
}

function sideLine(name: string, side: TestProbeSide): string {
  return side.ran
    ? `${name}: exit code ${side.exitCode ?? 'none (killed by a signal)'} after ${formatDuration(side.elapsedMs)}`
    : `${name}: could not run: ${side.reason}`
}

/** The last `chars` characters of `output`, or nothing. */
function tailLines(name: string, output: string, chars: number): string[] {
  const text = output.trimEnd()
  if (chars === 0 || text.length === 0) return []
  const tail = text.slice(-chars)
  return [
    tail.length < text.length
      ? `${name} output, last ${chars} characters:`
      : `${name} output:`,
    ...fencedText(tail),
  ]
}

interface ProbedFile extends TestProbeFile {
  baseOutput: string
  candidateOutput: string
}

/**
 * The result text: what was run, the outcome of each file and its output
 * tails. Kept within `MAX_CONTEXT_BYTES`: the tails shrink first, then the
 * files past the first few are listed only in the count. Never blank, so a
 * candidate with nothing to probe says so too.
 */
export function testProbeText(args: {
  candidateId: string
  baseCommit: string
  rules: TestProbeRule[]
  files: ProbedFile[]
  elapsedMs: number
}): string {
  const { files } = args
  const counts = new Map<TestProbeOutcome, number>()
  for (const file of files) {
    const outcome = testProbeOutcomeOf(file)
    counts.set(outcome, (counts.get(outcome) ?? 0) + 1)
  }
  const head = [
    `Test probe of ${args.candidateId} against the base commit ${args.baseCommit}.`,
    'The factory ran each test file the candidate added or modified that matches a testProbe glob, one file at a time: in a worktree at the base commit with only that file taken from the candidate, and in the candidate itself. Exit code 0 means it passed. The implementer wrote none of this.',
    `Globs: ${args.rules.map((r) => `\`${r.glob}\``).join(', ')}`,
    '',
  ]
  if (files.length === 0)
    return [
      ...head,
      'No added or modified file of this candidate matches a testProbe glob, so no test ran.',
      '',
    ].join('\n')
  const summary = [
    `${files.length} test file(s), ${formatDuration(args.elapsedMs)} in all: ${(
      Object.keys(OUTCOME_TEXT) as TestProbeOutcome[]
    )
      .map((outcome) => `${counts.get(outcome) ?? 0} ${OUTCOME_TEXT[outcome]}`)
      .join('; ')}.`,
  ]
  const render = (chars: number, listed: number) =>
    [
      ...head,
      ...summary,
      ...files
        .slice(0, listed)
        .flatMap((file) => [
          '',
          `## ${file.path}: ${OUTCOME_TEXT[testProbeOutcomeOf(file)]}`,
          `command: ${file.command.join(' ')}`,
          sideLine('base', file.base),
          sideLine('candidate', file.candidate),
          ...tailLines('base', file.baseOutput, chars),
          ...tailLines('candidate', file.candidateOutput, chars),
        ]),
      ...(listed < files.length
        ? [
            '',
            `${files.length - listed} more file(s) ran but are not listed, to keep this result within its size limit; the summary above counts them.`,
          ]
        : []),
      '',
    ].join('\n')
  const fits = (text: string) =>
    Buffer.byteLength(text, 'utf8') <= MAX_CONTEXT_BYTES
  for (const chars of [2000, 1000, 400, 0]) {
    const text = render(chars, files.length)
    if (fits(text)) return text
  }
  let listed = files.length
  while (listed > 0) {
    listed = Math.floor(listed / 2)
    const text = render(0, listed)
    if (fits(text)) return text
  }
  return render(0, 0)
}

/** The candidate's changed-file list, as its seal wrote it. */
async function changedFilesOf(
  config: RepoTargetConfig,
  candidate: CandidateRef,
): Promise<string[]> {
  const file = candidate.changes?.changedFilesPath
  if (file) return (await readFile(file, 'utf8')).split('\n')
  if (!candidate.commit) return []
  return describeCommitChanges(
    config.repoPath,
    config.baseCommit,
    candidate.commit,
  )
}

/**
 * Probe one sealed candidate and write its result file, outside both
 * worktrees. Call it inside the candidate's probe step, which reads the
 * file back as the `test-probe` stage context: the step's output is the
 * record, so a replay reads it back and runs nothing. Every file runs on the base
 * first, then on the candidate in its own worktree, whose tracked files are
 * then put back as sealed and checked with `assertIntact`. A base that
 * cannot be prepared, a command that cannot start and one that times out
 * are recorded as not run; only a cancel, a lost lease or a candidate that
 * no longer matches its seal throws.
 */
export async function runTestProbe(args: {
  config: RepoTargetConfig
  candidate: CandidateRef
  /** The run's directory, where the result file is written. */
  runRoot: string
  assertIntact: () => Promise<void>
  signal: AbortSignal
}): Promise<Omit<TestProbeRecord, 'context'> & { resultFile: string }> {
  const { config, candidate, signal } = args
  const started = Date.now()
  const targets = probeTargets(
    config.testProbe ?? [],
    await changedFilesOf(config, candidate),
  )
  const files: ProbedFile[] = []
  if (targets.length > 0) {
    // The candidate's other changes stay out of the base: each file runs
    // against the code it was written to test, as the base has it.
    const baseFailure = await prepareBase(
      config,
      candidate,
      targets.map((t) => t.path),
      signal,
    )
    const baseDir =
      baseFailure === null ? config.testProbeBase?.workdir : undefined
    const baseRuns: SideRun[] = []
    for (const target of targets)
      baseRuns.push(
        baseDir
          ? await runSide(target, baseDir, config.checkTimeoutMs, signal)
          : { side: notRun(baseFailure ?? 'no base worktree'), output: '' },
      )
    try {
      for (const [i, target] of targets.entries()) {
        const run = await runSide(
          target,
          config.workdir,
          config.checkTimeoutMs,
          signal,
        )
        const base = baseRuns[i] as SideRun
        files.push({
          path: target.path,
          command: target.rule.command.map((arg) =>
            arg === TEST_PROBE_FILES ? target.path : arg,
          ),
          base: base.side,
          candidate: run.side,
          baseOutput: base.output,
          candidateOutput: run.output,
        })
      }
    } finally {
      // A test that rewrote a tracked file would otherwise leave it changed
      // for the check and the reviews.
      if (candidate.commit) await resetHard(config.workdir, candidate.commit)
    }
    await args.assertIntact()
  }
  const elapsedMs = Date.now() - started
  const file = testProbeResultOf(args.runRoot, candidate.id)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(
    file,
    testProbeText({
      candidateId: candidate.id,
      baseCommit: config.baseCommit,
      rules: config.testProbe ?? [],
      files,
      elapsedMs,
    }),
  )
  return {
    candidateId: candidate.id,
    files: files.map(({ path, command, base, candidate: side }) => ({
      path,
      command,
      base,
      candidate: side,
    })),
    elapsedMs,
    resultFile: file,
  }
}
