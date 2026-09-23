import type { CandidateRef } from '../engine/types.js'
/**
 * What a factory is pointed at.
 *
 * The stage graph (code, verify, review, approve, finish) is the same whatever
 * you are building. Everything that differs between "fix the bundled sample"
 * and "work a GitHub issue in a real repository" lives behind this interface:
 * where the agent edits, how work is sealed into an immutable candidate, what
 * counts as verified, what a reviewer is told, and what the human finally
 * receives.
 *
 * A `TargetConfig` is persisted in the run's setup step, so it must be plain
 * JSON. The live `Target` is rebuilt from it on every replay, exactly as the
 * provider is, because a worker that picks the run back up has only the
 * database to work from.
 */
import type { GradeResult } from '../engine/verification.js'
import type { ProfileRole } from './types.js'

export type TargetKind = 'subject' | 'repo'

/** Bundled sample: a fixed buggy subject graded by a pinned suite. */
export interface SubjectTargetConfig {
  kind: 'subject'
  workdir: string
  baselineDir: string
  baselineHash: string
  acceptanceDir: string
  acceptanceHash: string
  candidatesDir: string
  testTimeoutMs: number
}

/** A real repository: a git worktree graded by the repository's own check. */
export interface RepoTargetConfig {
  kind: 'repo'
  /** Absolute path of the repository the worktrees are cut from. */
  repoPath: string
  /** Commit every candidate is diffed against. */
  baseCommit: string
  /** Branch the agent's worktree is on. */
  branch: string
  /** The agent's editable worktree. */
  workdir: string
  /** Optional one-time preparation (dependency install) for a fresh worktree. */
  setupCommand: string[] | null
  /** Pinned check argv. Recorded at setup so the agent cannot redefine it. */
  checkCommand: string[]
  checkTimeoutMs: number
  /** Task text handed to the implementer (an issue body, or free text). */
  task: string
  /** Specification text handed to the implementer and both reviewers. */
  spec: string | null
  /** Prior review dispositions, handed to the reviewers only. */
  dispositions: string | null
  /** Source issue, when the task came from one. */
  issue: { number: number; title: string; url: string } | null
  /** Where the delivered patch is written. */
  deliveryDir: string
  /** Push the branch and open a draft pull request on delivery. */
  publish: boolean
}

export type TargetConfig = SubjectTargetConfig | RepoTargetConfig

/** Where an input file was read from at trigger time. */
export interface InputFileRef {
  path: string
}

/**
 * Text that came from whoever started the run rather than from the factory.
 * Prompts fence it off as data, so nothing inside it reads as an instruction.
 */
export interface UntrustedInput {
  label: 'TASK' | 'SPEC' | 'DISPOSITIONS'
  content: string
}

/** What the human receives when a run finishes. */
export interface Delivery {
  kind: 'snapshot' | 'patch' | 'pull-request'
  /** Directory, patch file, or pull request URL. */
  location: string
  summary: string
  /** Branch holding the delivered commit; null when there is no branch. */
  branch: string | null
  /** Commit sha of the delivered candidate; null when it is not a commit. */
  commit: string | null
}

export interface SealArgs {
  iteration: number
  attemptId: string
  signal: AbortSignal
}

export interface GradeArgs {
  candidate: CandidateRef
  /** Scratch space outside the agent's workdir, rebuilt per attempt. */
  scratchDir: string
  signal: AbortSignal
}

export interface DeliverArgs {
  candidate: CandidateRef
  runId: string
  /** Review notes, for the pull request body. */
  reviews: { lens: string; decision: string; notes: string }[]
  signal: AbortSignal
}

export interface Target {
  readonly kind: TargetKind
  /** Where the agent edits. */
  readonly workdir: string
  /** One line naming the check that decides pass or fail. */
  checkDescription(): string
  /** What the implementer is asked to accomplish. */
  taskBrief(): string
  /** Constraints appended to the implementation prompt. */
  implementationRules(): string[]
  /**
   * Caller-supplied text a role is shown, fenced off as data. The implementer
   * gets the task and the spec; each reviewer gets the task, the spec and the
   * dispositions.
   */
  untrustedInputs(role: ProfileRole): UntrustedInput[]
  /**
   * What each reviewer is asked to check. Reviewers see only the candidate
   * and the trusted context, so the questions have to come from whoever knows
   * what is being built.
   */
  reviewRules(lens: 'correctness' | 'edge-cases'): string[]
  /** Seal the current workdir as an immutable candidate. */
  seal(args: SealArgs): Promise<CandidateRef>
  /** Throw when a sealed candidate no longer matches what was sealed. */
  assertIntact(candidate: CandidateRef): Promise<void>
  /** Run the pinned check against a sealed candidate. */
  grade(args: GradeArgs): Promise<GradeResult>
  /** Directory a read-only reviewer is pointed at. */
  reviewCwd(candidate: CandidateRef): string
  /** Trusted change summary and originals, for reviewers who see only the candidate. */
  reviewContext(candidate: CandidateRef): Promise<string>
  /** Turn an approved candidate into something the human can act on. */
  deliver(args: DeliverArgs): Promise<Delivery>
  /** Best-effort cleanup of scratch worktrees. Never throws. */
  cleanup(): Promise<void>
}
