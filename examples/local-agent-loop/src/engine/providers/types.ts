/**
 * Provider contract + attempt measurement stored in Durably metadata.
 *
 * Requested input, effective resolved settings, and provider-reported
 * model/effort are stored separately. A value the provider never reported
 * must never be presented as reported. Incremental usage snapshots merge via `mergeUsage`
 * (see usage.ts) so a failure preserves already-reported partial numbers.
 */
import type { TokenUsage } from '../usage.js'

export type ProviderName = 'codex' | 'claude' | 'fake'

/**
 * `triage` is a read-only, one-shot judgment made before any code is written.
 * `preflight` is the smallest call that proves a provider, model and effort
 * are usable, made only when no free check can tell.
 */
export type AgentRole =
  | 'implement'
  | 'repair'
  | 'review-a'
  | 'review-b'
  | 'triage'
  | 'preflight'
  | 'spec-author'
  | 'spec-fix'
  | 'spec-review'

/** Roles every real provider runs without write access. */
export const READ_ONLY_ROLES: ReadonlySet<AgentRole> = new Set([
  'review-a',
  'review-b',
  'triage',
  'preflight',
  'spec-review',
])

/** The roles that write the run's spec file and nothing else. */
export const SPEC_WRITER_ROLES: ReadonlySet<AgentRole> = new Set([
  'spec-author',
  'spec-fix',
])

/**
 * What a spec author or fixer may touch. Its working directory is the
 * run's own spec directory, outside the worktree: it reads that directory
 * and `readableDirs` (the worktree), and writes `writableFile` alone.
 */
export interface SpecWriteAccess {
  writableFile: string
  readableDirs: string[]
}

/**
 * How a review call was configured, for the provider that makes it. A review
 * without one is the factory's own prompt read as a verdict.
 */
export interface ReviewCallSettings {
  /** True when the input is the role's own command, expanded. */
  command: boolean
  /**
   * `local-instructions`: the review context is in `CLAUDE.local.md` at the
   * root of `workdir`, the review's own directory, never the candidate's.
   */
  context: 'prompt' | 'local-instructions'
  output: 'verdict' | 'findings-json'
  /**
   * Directories outside `workdir` the review may read whole: the candidate's
   * worktree, the directory of its diff and changed-file list, and the base
   * and head snapshots. Never writable, and never a source of settings.
   */
  readableDirs: string[]
}

/**
 * Whether a review call runs in command mode: its own command or local
 * instructions, read with the project's and the local settings.
 */
export function isCommandModeReview(
  review: ReviewCallSettings | null | undefined,
): review is ReviewCallSettings {
  return (
    review != null &&
    (review.command || review.context === 'local-instructions')
  )
}

export interface NativeSession {
  id: string
}

export interface AgentResult {
  text: string
  /** Provider-native conversation/thread created or resumed by this call. */
  session?: NativeSession | null
  /**
   * Execution settings actually applied to this call (explicit > env >
   * preset > provider default). Saved to the attempt BEFORE launch as the
   * effective model/effort — never presented as provider-reported.
   */
  resolvedModel: string | null
  resolvedEffort: string | null
  /**
   * Model the provider natively confirms for this call (read from the
   * response object, never assigned from config). Null when the response
   * confirms nothing.
   */
  reportedModel: string | null
  /**
   * Effort the provider natively confirms. CLI providers do not report this
   * back, so real providers leave it null — never back-filled from config.
   */
  reportedEffort: string | null
  /**
   * The concrete model the CLI says it ran, where it resolves an alias
   * itself (Claude Code: the `init` message's model, so `opus` reads
   * `claude-opus-5-5`). Absent or null when the provider reports none.
   * Only preflight reads it; it never replaces `resolvedModel`.
   */
  observedModel?: string | null
  usage: TokenUsage | null
  /**
   * `usage` split by the model that spent it, when the call ran more than
   * the main model's loop (a command-mode review's subagents). Each model's
   * tokens are priced at that model's rate. Absent: `usage` is one model's.
   */
  usageByModel?: Record<string, TokenUsage>
  elapsedMs: number | null
  /**
   * Tool calls the provider refused during this call, one line each. Absent
   * when the provider reports none or cannot tell.
   */
  permissionDenials?: string[]
}

export interface AgentCallOptions {
  prompt: string
  workdir: string
  /**
   * Upper bound per call (ms). The runner passes a value later than its own
   * limit, so its own timer stops the call first.
   */
  timeoutMs: number
  requestedModel: string | null
  requestedEffort: string | null
  role: AgentRole
  /**
   * A review call's round, from 1. Only the fake provider reads it, to pick
   * a scripted verdict that does not depend on call order.
   */
  reviewRound?: number
  /**
   * Files outside `workdir` a read-only role may read: the candidate's diff
   * and changed-file list, written by the factory. Never writable.
   */
  readableFiles?: string[]
  /** A configured review's settings; absent for every other call. */
  review?: ReviewCallSettings
  /** A spec author's or fixer's access; absent for every other call. */
  specWrite?: SpecWriteAccess
  /**
   * A spec reviewer's name. Only the fake provider reads it, to pick a
   * scripted reply by reviewer and round.
   */
  specReviewer?: string
  /** Explicit native session to resume. Null always creates a new conversation. */
  sessionId?: string | null
  /** Durably step signal: cancel / lease-loss aborts the call. */
  signal?: AbortSignal
  /**
   * Called (in order) with incremental usage snapshots when the provider
   * offers them. Providers without partial usage document that constraint
   * instead of fabricating numbers.
   */
  onPartialUsage?: (usage: TokenUsage) => void
  /**
   * Called when the provider sees the agent at work on this call: text,
   * reasoning, a tool call, a tool result or a running tool's progress, each
   * time, since the runner's idle limit restarts on it. Protocol set-up and
   * the error itself are not activity. After any activity, an error is never
   * read as a refusal, since the agent may already have acted.
   */
  onActivity?: () => void
  /**
   * Called, in order, with what the agent writes: assistant text as it
   * arrives, and one line per tool call with its name and a short summary
   * of its arguments. Never the prompt, a thinking or reasoning block, or
   * usage.
   */
  onOutput?: (chunk: string) => void
}

/** How long a tool call's argument summary may be in an agent log. */
const TOOL_SUMMARY_MAX = 160

/** Argument fields worth showing, in order; Codex's app-server items lead with `type`. */
const ARGUMENT_FIELDS = [
  'command',
  'query',
  'pattern',
  'path',
  'file_path',
  'tool',
]

/** Fields that describe the call, not what it does. */
const NOT_ARGUMENTS = new Set(['type', 'id', 'status', 'cwd', 'processId'])

/** The one string field of a tool's arguments that says what it does. */
function argumentOf(value: Record<string, unknown>): string | null {
  for (const key of ARGUMENT_FIELDS)
    if (typeof value[key] === 'string') return value[key]
  const first = Object.entries(value).find(
    ([k, v]) => !NOT_ARGUMENTS.has(k) && typeof v === 'string',
  )
  return first ? (first[1] as string) : null
}

/**
 * One agent-log line for a tool call: its name and its arguments in short.
 * A string argument is shown as is; an object shows its command, query or
 * path, else its first descriptive string field, else the object itself,
 * cut to one line.
 */
export function toolCallLine(name: string, input: unknown): string {
  let value = input
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown
    } catch {
      // A plain string argument.
    }
  }
  const first =
    value && typeof value === 'object' && !Array.isArray(value)
      ? argumentOf(value as Record<string, unknown>)
      : null
  const raw =
    typeof value === 'string'
      ? value
      : typeof first === 'string'
        ? first
        : value == null
          ? ''
          : JSON.stringify(value)
  const summary = raw.replace(/\s+/g, ' ').trim()
  const short =
    summary.length > TOOL_SUMMARY_MAX
      ? `${summary.slice(0, TOOL_SUMMARY_MAX - 1)}…`
      : summary
  return `> ${name}${short ? ` ${short}` : ''}\n`
}

/** A command's exit code from a tool result, in either spelling. */
function exitCodeOf(result: unknown): number | null {
  if (!result || typeof result !== 'object') return null
  const r = result as Record<string, unknown>
  const code = r.exitCode ?? r.exit_code
  return typeof code === 'number' ? code : null
}

/**
 * What a provider hands `onOutput`: text as is, each tool call on a line
 * of its own, and a command's exit code after it. Absent `onOutput`, it
 * writes nothing.
 */
export function agentOutput(onOutput: ((chunk: string) => void) | undefined) {
  let lineStart = true
  const emit = (chunk: string) => {
    if (!onOutput || chunk === '') return
    onOutput(chunk)
    lineStart = chunk.endsWith('\n')
  }
  return {
    text: emit,
    tool(name: string, input: unknown) {
      emit(`${lineStart ? '' : '\n'}${toolCallLine(name, input)}`)
    },
    /** How a command ended, when its result says: `< exec exit 1`. */
    result(name: string, result: unknown) {
      const code = exitCodeOf(result)
      if (code !== null)
        emit(`${lineStart ? '' : '\n'}< ${name} exit ${code}\n`)
    },
    /** End the line a message left open, so the next starts its own. */
    line() {
      if (!lineStart) emit('\n')
    },
  }
}

/**
 * Where one attempt's agent output is written, from before the call is
 * sent until it ends. `writeError` says the file may be incomplete.
 */
export interface AgentLog {
  path: string
  writeError?: string
}

export interface ResolvedExecution {
  model: string | null
  effort: string | null
}

/**
 * What a free availability check found for one provider, model and effort.
 * `unknown` means the check cannot tell, and only then is a minimal call
 * made. `method` names the check, so a report says how the verdict was made.
 */
export interface AvailabilityCheck {
  verdict: 'available' | 'unavailable' | 'unknown'
  method: string
  detail: string
}

export interface AvailabilityRequest {
  /** The role's requested model; the fake provider reads it, real ones do not. */
  requestedModel: string | null
  model: string | null
  effort: string | null
}

/** One provider invocation: run the selected local CLI in workdir. */
export interface AgentProvider {
  readonly name: ProviderName
  readonly fake: boolean
  /**
   * The CLI file the run pinned (`codexPath`), launched by every call and
   * check of this instance and probed for its version. Null: the provider's
   * own resolution.
   */
  readonly cliPath: string | null
  /** True when this provider streams partial usage via onPartialUsage. */
  readonly partialUsage: boolean
  /**
   * Resolve the execution settings (explicit > env > preset > default)
   * WITHOUT launching anything. The runner saves these before the call so
   * the resolved configuration is on record even if the call never reports.
   */
  resolveExecution(requested: {
    requestedModel: string | null
    requestedEffort: string | null
  }): ResolvedExecution
  call(options: AgentCallOptions): Promise<AgentResult>
  /**
   * A check that sends no prompt and costs nothing. It never throws: a check
   * that fails to run says `unknown`.
   */
  checkAvailability(request: AvailabilityRequest): Promise<AvailabilityCheck>
  /**
   * The provider's explicit refusal of a call, such as an unknown model or a
   * failed login, as one line; null for any other error. A refused call was
   * not acted on, so it is recorded as settled rather than uncertain.
   */
  rejectionReason(error: unknown): string | null
}

/**
 * Where one physical grading attempt left the check's full output. The exit
 * code is null when the check was killed before it exited (a timeout).
 */
export interface VerificationLog {
  stdoutPath: string
  stderrPath: string
  exitCode: number | null
  /** Why the log files may be incomplete; absent when they were written. */
  writeError?: string
  /** Cancelled or lease lost mid-check: a partial log, not part of a verdict. */
  interrupted?: true
  /** Killed at the check timeout after this many milliseconds. */
  timedOutAfterMs?: number
}

/**
 * How a repair call treated the implementation session, decided before the
 * call: `continued` resumes a session its own profile last ran,
 * `continued-effort-change` resumes one a profile that differs only in
 * effort last ran, and `fresh` starts a new one.
 */
export type SessionHandling = 'continued' | 'continued-effort-change' | 'fresh'

/**
 * The measurement result of a call superseded before it was sent
 * (ADR-0029): not an invocation, so no usage sum counts it.
 */
export const NOT_SENT = 'not-sent'

/**
 * The tool calls the provider refused during one call, as a review step, its
 * attempt and the report keep them: the total, and the first
 * `DENIAL_ENTRIES` entries, each `<tool>: <the guard's reason>` cut to
 * `DENIAL_ENTRY_CHARS` characters.
 */
export interface PermissionDenials {
  count: number
  entries: string[]
}

export const DENIAL_ENTRIES = 10
export const DENIAL_ENTRY_CHARS = 300

/** The bounded record of `denials`; undefined when there are none. */
export function boundedDenials(
  denials: readonly string[],
): PermissionDenials | undefined {
  if (denials.length === 0) return undefined
  return {
    count: denials.length,
    entries: denials
      .slice(0, DENIAL_ENTRIES)
      .map((d) => d.slice(0, DENIAL_ENTRY_CHARS)),
  }
}

/**
 * Which of the factory's limits stopped a call: `total`, counted from its
 * start, or `idle`, counted from the last sign of the agent at work.
 */
export interface AgentTimeout {
  kind: 'total' | 'idle'
  limitMs: number
}

/** Persisted per-attempt measurement. Missing values stay null (never 0-filled). */
export interface AttemptMeasurement {
  provider: ProviderName
  fake: boolean
  /** Stage/iteration snapshot — merged, never wholesale-replaced. */
  stage: string | null
  role?: AgentRole | null
  iteration: number | null
  operationKey?: string | null
  invocationId?: string | null
  sessionId?: string | null
  /**
   * A repair call's session handling, saved before the call is made; absent
   * on every other call and on a repair recorded before it existed.
   */
  sessionHandling?: SessionHandling | null
  /** Why, in one line, saved with `sessionHandling`. */
  sessionReason?: string | null
  /** True when a saved completed invocation was read without sending again. */
  recovered?: boolean
  /** Whether usage is for one provider invocation or a larger CLI session. */
  usageScope?: 'invocation' | 'session' | null
  requestedModel: string | null
  requestedEffort: string | null
  effectiveModel: string | null
  effectiveEffort: string | null
  reportedModel: string | null
  reportedEffort: string | null
  /** Original provider invocation interval, retained across recovery. */
  invocationStartedAt?: string | null
  invocationCompletedAt?: string | null
  /** Subprocess/CLI versions at call time (null when unresolvable). */
  versions: Record<string, string | null>
  elapsedMs: number | null
  usage: TokenUsage | null
  /**
   * `usage` split by model, when the provider reported one; the cost is
   * then each model's tokens at its own rate, summed. Absent otherwise.
   */
  usageByModel?: Record<string, TokenUsage> | null
  /** API-equivalent price estimate; null when usage or pricing unknown. */
  costUsdEstimate: number | null
  costBasis: 'api-equivalent-estimate' | null
  /** Per-meter USD split of `costUsdEstimate`; absent when unpriced. */
  costMeters?: Partial<Record<string, number>> | null
  /** True when cache legs were reported and priced at their own rates. */
  costCacheAware?: boolean | null
  /**
   * Hash of the run's fixed configuration (provider, models, efforts,
   * context mode, instructions version). Runs sharing it are comparable.
   */
  configVersion?: string | null
  result: string | null
  error: string | null
  /** Why the attempt stopped early (cancel / lease-loss / timeout). */
  interruptionReason: string | null
  /**
   * The factory's limit that stopped the call, when its own timer did;
   * absent on every other attempt.
   */
  timedOut?: AgentTimeout | null
  /** A verification attempt's full check output; absent on LLM calls. */
  verificationLog?: VerificationLog | null
  /** An LLM call's agent output; absent when nothing was sent. */
  agentLog?: AgentLog | null
  /** Tool calls the provider refused during the call; absent when none. */
  permissionDenials?: PermissionDenials
}
