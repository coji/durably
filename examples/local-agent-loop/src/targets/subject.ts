/**
 * The bundled sample target.
 *
 * A fixed buggy subject, a pinned test suite the agent may not edit, and a
 * candidate sealed by copying the directory. Because the task never varies,
 * this is the target to use when the question is "which model placement is
 * cheaper", not "build me this feature".
 */
import { cp, mkdir } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { assertCandidateIntact, createCandidate } from '../engine/candidate.js'
import { describeTreeChanges, hashDir } from '../engine/tree.js'
import type { CandidateRef } from '../engine/types.js'
import type { GradeResult } from '../engine/verification.js'
import type {
  Delivery,
  DeliverArgs,
  GradeArgs,
  SealArgs,
  SubjectTargetConfig,
  Target,
  UntrustedInput,
} from '../factory/target.js'
import { runAcceptanceSuite, snapshotAcceptance } from './subject-acceptance.js'

export interface PrepareSubjectArgs {
  /** Directory holding the pristine sample sources. */
  subjectDir: string
  /** Run-scoped root under which the workspace is built. */
  root: string
  testTimeoutMs: number
}

export async function prepareSubjectTarget(
  args: PrepareSubjectArgs,
): Promise<SubjectTargetConfig> {
  const workdir = join(args.root, 'work')
  const baselineDir = join(args.root, 'baseline')
  const acceptanceDir = join(args.root, 'acceptance')
  await mkdir(args.root, { recursive: true })
  await cp(args.subjectDir, workdir, { recursive: true })
  await cp(args.subjectDir, baselineDir, { recursive: true })
  const acceptance = await snapshotAcceptance(
    join(args.subjectDir, 'test'),
    acceptanceDir,
  )
  return {
    kind: 'subject',
    workdir,
    baselineDir,
    baselineHash: await hashDir(baselineDir),
    acceptanceDir,
    acceptanceHash: acceptance.hash,
    candidatesDir: join(args.root, 'candidates'),
    testTimeoutMs: args.testTimeoutMs,
  }
}

export class SubjectTarget implements Target {
  readonly kind = 'subject' as const

  constructor(private readonly config: SubjectTargetConfig) {}

  get workdir(): string {
    return this.config.workdir
  }

  checkDescription(): string {
    return 'the pinned acceptance suite, run from an immutable snapshot'
  }

  taskBrief(): string {
    return 'Fix src/calc.js add() so decimal inputs are not truncated.'
  }

  untrustedInputs(): UntrustedInput[] {
    // The sample's task is written by the factory; nothing comes from outside.
    return []
  }

  implementationRules(): string[] {
    return [
      'Keep the change minimal; only edit files under src/.',
      'Do not modify files under test/ — acceptance tests are immutable and tampering fails the run.',
      'Do not run network commands. You may run `npm test` to check locally, but grading runs the pristine snapshot with a fixed command, so rewriting the test script cannot fake a pass.',
    ]
  }

  reviewRules(lens: 'correctness' | 'edge-cases'): string[] {
    return lens === 'correctness'
      ? [
          'Read src/calc.js and test/calc.test.js in the workdir.',
          'Check: does add() handle decimals, negatives, zero? Use the trusted baseline context to confirm whether mul() was touched.',
        ]
      : [
          'Check: minimal change, no extra deps, no unrelated edits, tests cover the fix.',
        ]
  }

  async seal(args: SealArgs): Promise<CandidateRef> {
    return createCandidate({
      workdir: this.config.workdir,
      candidatesDir: this.config.candidatesDir,
      iteration: args.iteration,
      acceptanceHash: this.config.acceptanceHash,
      attemptId: args.attemptId,
    })
  }

  async assertIntact(candidate: CandidateRef): Promise<void> {
    await assertCandidateIntact(candidate)
  }

  async grade(args: GradeArgs): Promise<GradeResult> {
    return runAcceptanceSuite(
      {
        workdir: args.candidate.snapshotDir,
        acceptanceDir: this.config.acceptanceDir,
        scratchDir: args.scratchDir,
        timeoutMs: this.config.testTimeoutMs,
        signal: args.signal,
        logDir: args.logDir,
      },
      args.candidate.acceptanceHash,
    )
  }

  reviewCwd(candidate: CandidateRef): string {
    return candidate.snapshotDir
  }

  async reviewContext(candidate: CandidateRef): Promise<string> {
    // The reviewer reads only the candidate, so the untouched original has to
    // be handed over explicitly. Verify the baseline first: a mutated
    // baseline would make "minimal change" unprovable.
    if ((await hashDir(this.config.baselineDir)) !== this.config.baselineHash)
      throw new Error('trusted baseline mutated')
    const changes = await describeTreeChanges(
      this.config.baselineDir,
      candidate.snapshotDir,
    )
    const original = await readFile(
      join(this.config.baselineDir, 'src', 'calc.js'),
      'utf8',
    )
    return [
      'TRUSTED BASELINE CONTEXT:',
      `Changed paths: ${changes.length > 0 ? changes.join(', ') : '(none)'}`,
      'Original src/calc.js:',
      '```js',
      original,
      '```',
    ].join('\n')
  }

  async deliver(args: DeliverArgs): Promise<Delivery> {
    return {
      kind: 'snapshot',
      location: args.candidate.snapshotDir,
      summary: `approved candidate ${args.candidate.id}`,
      branch: null,
      commit: null,
    }
  }

  async cleanup(): Promise<void> {
    // Directory snapshots live under the run root and are kept for inspection.
  }
}
