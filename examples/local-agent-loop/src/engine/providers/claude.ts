/**
 * Claude provider via AI SDK v7 (`ai` + `ai-sdk-provider-claude-code`).
 *
 * - Subscription auth (`claude auth login`); never requires the unselected
 *   CLI and never switches to API billing on its own.
 * - No unconditional `--dangerously-skip-permissions`: permissionMode stays
 *   `default` and the workdir guard is enforced TWICE — via `canUseTool` AND
 *   a `PreToolUse` hook. Both are needed: `allowedTools` pre-approves calls
 *   (so the agent can work non-interactively), and pre-approved calls bypass
 *   `canUseTool`; only the hook inspects every call.
 * - Review roles run read-only (`allowedTools: ['Read']`) against a frozen
 *   snapshot directory, never the live workdir. Triage runs read-only too,
 *   before any code exists.
 * - A review with its own command or local instructions runs in command
 *   mode: only `Read`, `Grep`, `Glob` and `Agent` exist, `dontAsk` refuses
 *   anything else, the project's and local settings are loaded so the
 *   command and `CLAUDE.local.md` are found, and the same guard checks every
 *   tool call, a subagent's included, against the readable directories.
 * - Usage comes from the final result's `modelUsage`, which covers the call
 *   and every subagent it started, counted once.
 * - Requested effort is applied via the `effort` setting; unsupported values
 *   throw instead of being silently dropped.
 * - Bash containment is best-effort input inspection (documented limits, not
 *   a sandbox): statically unresolvable commands are denied; the Codex CLI
 *   sandbox remains the stronger isolation where that matters.
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path'

import { generateText } from 'ai'
import {
  claudeCode,
  isAuthenticationError,
  type ClaudeCodeSettings,
  type SDKMessage,
} from 'ai-sdk-provider-claude-code'

import { defaultModelFor, resolveEffort } from '../models.js'
import type { TokenUsage } from '../usage.js'
import {
  isCommandModeReview,
  READ_ONLY_ROLES,
  type AgentCallOptions,
  type AgentProvider,
  type AgentResult,
  type AvailabilityCheck,
  type ReviewCallSettings,
} from './types.js'

const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

/**
 * Model and effort come from the command line or the preset table, never from
 * the environment. `CLAUDE_EFFORT` is a particularly sharp case: Claude Code
 * exports it into the shell it runs commands in, so honouring it would make a
 * run's effort depend on the effort of whichever agent session launched it.
 */
function resolveModel(options: { requestedModel: string | null }): string {
  return options.requestedModel ?? defaultModelFor('claude')
}

function resolveEffortFor(
  requestedModel: string | null,
  requestedEffort: string | null,
  modelId: string,
): string | null {
  const effort = resolveEffort(
    requestedEffort ?? undefined,
    requestedModel ?? modelId,
  )
  if (effort !== null && !VALID_EFFORTS.has(effort)) {
    throw new Error(
      `unsupported Claude effort "${effort}" (supported: ${[...VALID_EFFORTS].join(', ')})`,
    )
  }
  return effort
}

export function resolveClaudeEffort(
  options: AgentCallOptions,
  modelId: string,
): string | null {
  return resolveEffortFor(
    options.requestedModel,
    options.requestedEffort,
    modelId,
  )
}

const AGENT_SDK = '@anthropic-ai/claude-agent-sdk'

/** The Agent SDK's own libc test: a Linux without glibc takes musl first. */
function prefersMusl(): boolean {
  if (process.platform !== 'linux') return false
  const report = process.report?.getReport?.() as {
    header?: { glibcVersionRuntime?: string }
  } | null
  return report != null && report.header?.glibcVersionRuntime === undefined
}

let cachedClaudeExecutable: string | null | undefined

/**
 * The Claude Code binary the Agent SDK launches: the native build shipped in
 * its platform package, never a `claude` on PATH. Resolved the way the SDK
 * resolves it, from the SDK that `ai-sdk-provider-claude-code` loads, so the
 * recorded version is of the binary that actually runs. Null when it cannot
 * be found.
 */
export function claudeExecutable(): string | null {
  // The installed binary cannot change within a process, and on Linux the
  // libc test builds a full diagnostic report, so resolve it once.
  if (cachedClaudeExecutable === undefined)
    cachedClaudeExecutable = resolveClaudeExecutable()
  return cachedClaudeExecutable
}

function resolveClaudeExecutable(): string | null {
  try {
    const provider = createRequire(import.meta.url).resolve(
      'ai-sdk-provider-claude-code',
    )
    const sdk = createRequire(provider).resolve(AGENT_SDK)
    const load = createRequire(sdk)
    const { platform, arch } = process
    const ext = platform === 'win32' ? '.exe' : ''
    const packages =
      platform === 'linux'
        ? prefersMusl()
          ? [`${AGENT_SDK}-linux-${arch}-musl`, `${AGENT_SDK}-linux-${arch}`]
          : [`${AGENT_SDK}-linux-${arch}`, `${AGENT_SDK}-linux-${arch}-musl`]
        : [`${AGENT_SDK}-${platform}-${arch}`]
    for (const name of packages) {
      try {
        const path = load.resolve(`${name}/claude${ext}`)
        if (existsSync(path)) return path
      } catch {
        // Not installed for this platform; try the next.
      }
    }
  } catch {
    // The provider or the SDK is not installed.
  }
  return null
}

/** Normalize and resolve a candidate path against the allowed root. */
function resolveInside(root: string, candidate: string): string {
  const base = resolve(root)
  return isAbsolute(candidate) ? normalize(candidate) : resolve(base, candidate)
}

/** True when the resolved path is the root itself or below it. */
export function isInsideWorkdir(workdir: string, target: string): boolean {
  const base = resolve(workdir)
  const abs = resolveInside(workdir, target)
  if (abs === base) return true
  const rel = relative(base, abs)
  return rel !== '' && !rel.startsWith(`..${sep}`) && rel !== '..'
}

export type ToolDecision = { allow: true } | { allow: false; reason: string }

/**
 * Decide whether one tool call may run. Pure (no SDK types) so the exact
 * execution-path logic is unit-testable; both `canUseTool` and the
 * `PreToolUse` hook delegate here.
 *
 * - File tools: every path input must normalize inside the allowed root
 *   (`/root/../outside` and absolute escapes are denied).
 * - Bash: statically analyzable escapes are denied (absolute paths outside
 *   the root, `..` that escapes the root, `~`, `$VAR`/command substitution
 *   whose target cannot be resolved statically). Anything else — including
 *   `node -e` with fully dynamic paths — is BEYOND what input inspection can
 *   guarantee (see README); unresolvable-dynamic forms are denied, the rest
 *   is allowed and documented as best-effort.
 */
export function decideToolPermission(
  allowedRoot: string,
  readOnly: boolean,
  toolName: string,
  input: Record<string, unknown>,
  /**
   * Exact files outside the root a read-only role may also read: the
   * candidate's diff and changed-file list. Only whole paths match, so a
   * directory or a sibling file is not opened up with them.
   */
  readableFiles: readonly string[] = [],
): ToolDecision {
  if (readOnly) {
    if (toolName !== 'Read') {
      return {
        allow: false,
        reason: `review role is read-only (denied ${toolName})`,
      }
    }
    const p = input['file_path']
    const trusted =
      typeof p === 'string' &&
      readableFiles.some(
        (file) => resolve(file) === resolveInside(allowedRoot, p),
      )
    if (typeof p === 'string' && !trusted && !isInsideWorkdir(allowedRoot, p)) {
      return {
        allow: false,
        reason: `read outside review snapshot denied: ${p}`,
      }
    }
    return { allow: true }
  }
  const fileKeys = ['file_path', 'path', 'notebook_path'] as const
  for (const key of fileKeys) {
    const p = input[key]
    if (typeof p === 'string' && !isInsideWorkdir(allowedRoot, p)) {
      return {
        allow: false,
        reason: `write outside execution workdir denied: ${p}`,
      }
    }
  }
  if (toolName === 'Bash') {
    const cmd = input['command']
    if (typeof cmd === 'string') {
      const reason = bashEscapeReason(allowedRoot, cmd)
      if (reason) return { allow: false, reason }
    }
  }
  return { allow: true }
}

/** Lexically resolve `..`/`.` in a token; null when it escapes the root. */
function bashEscapeReason(root: string, cmd: string): string | null {
  // Dynamic shell forms whose target cannot be resolved statically. Any `$`
  // is rejected here rather than per token: the tokenizer below splits on `$`,
  // so `$HOME/.ssh/id_rsa` would otherwise reach the containment check as the
  // relative-looking `HOME/.ssh/id_rsa` and resolve inside the workdir.
  if (
    cmd.includes('$') ||
    cmd.includes('`') ||
    /(^|[\s;"'=])~(\/|$)/.test(cmd)
  ) {
    return `command uses dynamic expansion that cannot be contained: ${cmd.slice(0, 200)}`
  }
  // `=` separates a flag from its value, so `--out=/etc/passwd` must be graded
  // as the path `/etc/passwd` and not as one opaque relative-looking token.
  const tokens = cmd
    .split(/[\s;&|()<>$'"`=]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
  for (const token of tokens) {
    const looksLikePath =
      token.includes('/') ||
      token.startsWith('.') ||
      isAbsolute(token) ||
      token === '..'
    if (!looksLikePath) continue
    if (!isInsideWorkdir(root, token)) {
      return `command escapes execution workdir: ${token.slice(0, 100)}`
    }
  }
  return null
}

/** The tools a command-mode review has; every other tool does not exist. */
export const COMMAND_MODE_REVIEW_TOOLS = ['Read', 'Grep', 'Glob', 'Agent']

/**
 * Decide one tool call of a command-mode review or any subagent it starts.
 * Only `Read`, `Grep`, `Glob` and `Agent` pass, and every path they name must
 * normalize inside one of `roots`: the candidate worktree and the directories
 * holding its diff, changed-file list and snapshots. A relative path is taken
 * from the first root, the review's cwd. A `Glob` pattern may not climb out
 * with `..` or name an absolute path outside the roots. Bash and every write
 * tool are refused.
 */
export function decideReviewToolPermission(
  roots: readonly string[],
  toolName: string,
  input: Record<string, unknown>,
): ToolDecision {
  if (!COMMAND_MODE_REVIEW_TOOLS.includes(toolName))
    return {
      allow: false,
      reason: `review is read-only (denied ${toolName})`,
    }
  const cwd = roots[0] ?? '.'
  const inside = (p: string) => {
    const abs = resolveInside(cwd, p)
    return roots.some((root) => isInsideWorkdir(root, abs))
  }
  for (const key of ['file_path', 'path', 'notebook_path'] as const) {
    const p = input[key]
    if (typeof p === 'string' && !inside(p))
      return {
        allow: false,
        reason: `read outside the review's directories denied: ${p}`,
      }
  }
  const pattern = input['pattern']
  if (toolName === 'Glob' && typeof pattern === 'string') {
    const climbs = pattern.split(/[\\/]/).includes('..')
    if (climbs || (isAbsolute(pattern) && !inside(pattern)))
      return {
        allow: false,
        reason: `glob outside the review's directories denied: ${pattern}`,
      }
  }
  return { allow: true }
}

type Decide = (toolName: string, input: Record<string, unknown>) => ToolDecision

function canUseToolWith(decide: Decide) {
  return async (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<
    | { behavior: 'allow'; updatedInput: Record<string, unknown> }
    | { behavior: 'deny'; message: string }
  > => {
    const decision = decide(toolName, input)
    if (!decision.allow) {
      return { behavior: 'deny', message: decision.reason }
    }
    return { behavior: 'allow', updatedInput: input }
  }
}

function preToolUseWith(decide: Decide) {
  return async (hookInput: unknown) => {
    const record =
      typeof hookInput === 'object' && hookInput !== null
        ? (hookInput as Record<string, unknown>)
        : {}
    const toolName =
      typeof record['tool_name'] === 'string' ? record['tool_name'] : ''
    const rawInput = record['tool_input']
    const input =
      rawInput !== null &&
      typeof rawInput === 'object' &&
      !Array.isArray(rawInput)
        ? (rawInput as Record<string, unknown>)
        : {}
    const decision = decide(toolName, input)
    if (!decision.allow) {
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: decision.reason,
        },
      }
    }
    return {
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
      },
    }
  }
}

/**
 * Tool-permission guard for `canUseTool` (sees only non-pre-approved calls).
 * The `PreToolUse` hook below is the complete enforcement point.
 */
export function workdirGuard(
  allowedRoot: string,
  readOnly: boolean,
  readableFiles: readonly string[] = [],
) {
  return canUseToolWith((toolName, input) =>
    decideToolPermission(allowedRoot, readOnly, toolName, input, readableFiles),
  )
}

/**
 * `PreToolUse` hook: inspects EVERY tool call, including ones pre-approved
 * via `allowedTools` (which bypass `canUseTool` per the Claude Code docs).
 * Denials surface in `providerMetadata['claude-code'].permissionDenials`.
 */
export function preToolUseHook(
  allowedRoot: string,
  readOnly: boolean,
  readableFiles: readonly string[] = [],
) {
  return preToolUseWith((toolName, input) =>
    decideToolPermission(allowedRoot, readOnly, toolName, input, readableFiles),
  )
}

/**
 * The same guard for a command-mode review. Hooks run for a subagent's tool
 * calls too, so what a subagent may do is decided here as well.
 */
export function reviewPreToolUseHook(roots: readonly string[]) {
  return preToolUseWith((toolName, input) =>
    decideReviewToolPermission(roots, toolName, input),
  )
}

/** Build the model settings so tests can verify the wiring, not just hope. */
export function buildClaudeSettings(
  workdir: string,
  readOnly: boolean,
  effort: string | null,
  sessionId: string | null = null,
  readableFiles: readonly string[] = [],
  review: ReviewCallSettings | null = null,
): ClaudeCodeSettings {
  const executable = claudeExecutable()
  const pinned = {
    // Pinned to the binary whose version is recorded, so the two cannot
    // name different CLIs. Unresolved, the SDK reports its own error.
    ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
    ...(effort ? { effort: effort as 'low' } : {}),
  }
  if (isCommandModeReview(review)) {
    // The command and CLAUDE.local.md are found through the project's and
    // the local settings. Only the listed tools exist, `dontAsk` refuses
    // anything not pre-approved, and the guard sees every call, a
    // subagent's included. A review never resumes a session.
    const roots = [workdir, ...review.readableDirs]
    return {
      cwd: workdir,
      settingSources: ['project', 'local'],
      permissionMode: 'dontAsk',
      tools: [...COMMAND_MODE_REVIEW_TOOLS],
      allowedTools: [...COMMAND_MODE_REVIEW_TOOLS],
      additionalDirectories: roots,
      canUseTool: canUseToolWith((toolName, input) =>
        decideReviewToolPermission(roots, toolName, input),
      ),
      hooks: { PreToolUse: [{ hooks: [reviewPreToolUseHook(roots)] }] },
      ...pinned,
    }
  }
  return {
    cwd: workdir,
    settingSources: [],
    permissionMode: 'default',
    allowedTools: readOnly ? ['Read'] : ['Read', 'Edit', 'Write', 'Bash'],
    canUseTool: workdirGuard(workdir, readOnly, readableFiles),
    hooks: {
      PreToolUse: [
        { hooks: [preToolUseHook(workdir, readOnly, readableFiles)] },
      ],
    },
    ...pinned,
    ...(sessionId ? { resume: sessionId } : {}),
  }
}

/** The usage the AI SDK reports for the main loop alone. */
export interface MainLoopUsage {
  inputTokens: number | null
  outputTokens: number | null
  cacheReadTokens: number | null
  cacheWriteTokens: number | null
  totalTokens: number | null
}

/**
 * One call's usage. The result message's `modelUsage` holds per-model
 * totals for the whole call: the main loop, every subagent and internal
 * calls. When it is there it is the call's usage, summed across models once
 * and never added to the main loop's numbers, which it already contains. A
 * leg some model does not report stays unknown. Without it, the main loop's
 * numbers are all there is.
 */
export function claudeUsageOf(
  reported: MainLoopUsage,
  modelUsage: unknown,
): TokenUsage | null {
  const models =
    modelUsage !== null &&
    typeof modelUsage === 'object' &&
    !Array.isArray(modelUsage)
      ? Object.values(modelUsage as Record<string, unknown>).filter(
          (m): m is Record<string, unknown> =>
            m !== null && typeof m === 'object',
        )
      : []
  if (models.length === 0) {
    const {
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
    } = reported
    if (input === null && output === null) return null
    return {
      inputTokens: input,
      cachedInputTokens:
        cacheRead !== null || cacheWrite !== null
          ? (cacheRead ?? 0) + (cacheWrite ?? 0)
          : null,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      outputTokens: output,
      totalTokens: reported.totalTokens,
      usageSource: 'provider-final',
    }
  }
  const sum = (key: string): number | null => {
    let total = 0
    for (const model of models) {
      const value = model[key]
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
        return null
      total += value
    }
    return total
  }
  const uncached = sum('inputTokens')
  const cacheRead = sum('cacheReadInputTokens')
  const cacheWrite = sum('cacheCreationInputTokens')
  const output = sum('outputTokens')
  // AI SDK usage counts the cache legs inside input; modelUsage does not.
  const input =
    uncached !== null && cacheRead !== null && cacheWrite !== null
      ? uncached + cacheRead + cacheWrite
      : null
  return {
    inputTokens: input,
    cachedInputTokens:
      cacheRead !== null && cacheWrite !== null ? cacheRead + cacheWrite : null,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    outputTokens: output,
    totalTokens: input !== null && output !== null ? input + output : null,
    usageSource: 'provider-final',
  }
}

/** The provider's recorded permission denials, one line each. */
export function permissionDenialsOf(denials: unknown): string[] {
  if (!Array.isArray(denials)) return []
  return denials.map((denial) => {
    const d = (denial ?? {}) as Record<string, unknown>
    const tool = typeof d['toolName'] === 'string' ? d['toolName'] : 'tool'
    const agent =
      typeof d['agentId'] === 'string' ? ` (subagent ${d['agentId']})` : ''
    const reason = typeof d['reason'] === 'string' ? `: ${d['reason']}` : ''
    return `${tool}${agent}${reason}`.slice(0, 400)
  })
}

/**
 * Error kinds the provider reports when the Claude Code CLI refused a call
 * outright: the settings or the login are wrong, and nothing was acted on.
 */
const REFUSAL_KINDS = new Set([
  'model_not_found',
  'authentication_failed',
  'oauth_org_not_allowed',
  'account_on_hold',
  'billing_error',
])

/**
 * The sentence the provider appends when it recognised a missing model from
 * the CLI's text rather than from a structured error kind.
 */
const MODEL_NOT_FOUND_TEXT = 'The requested model was not found.'

/**
 * The provider's explicit refusal as one line; null for any other error.
 * The provider does not always attach a structured kind: a login problem
 * seen in the CLI's text or its 401 exit comes back as the provider's
 * authentication error, and a missing model seen in its text carries the
 * provider's model-not-found sentence. Both are refusals all the same.
 */
export function claudeRejection(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error)
  const line = message.split(' | stderr')[0]?.slice(0, 400) ?? ''
  const kind = (error as { data?: { errorKind?: unknown } } | null)?.data
    ?.errorKind
  if (typeof kind === 'string' && REFUSAL_KINDS.has(kind))
    return `${kind}: ${line}`
  if (isAuthenticationError(error)) return `authentication_failed: ${line}`
  if (message.includes(MODEL_NOT_FOUND_TEXT)) return `model_not_found: ${line}`
  return null
}

/**
 * Whether one Agent SDK message shows the agent at work: an assistant
 * message (text, thinking or a tool call, with its usage). Every tool call
 * arrives in one, so a tool result never comes first. When the CLI reports
 * an API refusal it sends a synthetic assistant message: model
 * `<synthetic>`, the error text as content and zero usage. That frame is not
 * activity. An errored message from a real model, or one that reports any
 * usage (cache tokens included), is: work may already have begun, so the
 * call stays uncertain. Session set-up and status messages come before any
 * model request, so they are not activity.
 */
export function isAgentActivity(message: SDKMessage): boolean {
  if (message.type !== 'assistant') return false
  if (message.error === undefined) return true
  const body = message.message as unknown as {
    model?: string
    usage?: Record<string, unknown> | null
  }
  const usage = body?.usage ?? {}
  const anyUsage = [
    'input_tokens',
    'output_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
  ].some((key) => {
    const value = usage[key]
    return typeof value === 'number' && value > 0
  })
  return body?.model !== SYNTHETIC_MODEL || anyUsage
}

/** The model name the Claude CLI puts on the frames it makes up itself. */
const SYNTHETIC_MODEL = '<synthetic>'

export class ClaudeProvider implements AgentProvider {
  readonly name = 'claude' as const
  readonly fake = false
  /** The Agent SDK's own binary; see `claudeExecutable`. */
  readonly cliPath = null
  /** Claude Agent SDK reports usage once at completion — no partial snapshots. */
  readonly partialUsage = false

  resolveExecution(requested: {
    requestedModel: string | null
    requestedEffort: string | null
  }): { model: string | null; effort: string | null } {
    const modelId = resolveModel(requested)
    return {
      model: modelId,
      effort: resolveEffortFor(
        requested.requestedModel,
        requested.requestedEffort,
        modelId,
      ),
    }
  }

  async call(options: AgentCallOptions): Promise<AgentResult> {
    const started = Date.now()
    const { model: modelId, effort } = this.resolveExecution(options)
    const modelIdResolved = modelId ?? defaultModelFor('claude')
    const readOnly = READ_ONLY_ROLES.has(options.role)
    const onActivity = options.onActivity
    const model = claudeCode(modelIdResolved, {
      ...buildClaudeSettings(
        options.workdir,
        readOnly,
        effort,
        options.sessionId,
        options.readableFiles,
        options.review ?? null,
      ),
      ...(onActivity
        ? {
            onSdkMessage: (message: SDKMessage) => {
              if (isAgentActivity(message)) onActivity()
            },
          }
        : {}),
    })
    const reported = await generateText({
      model,
      prompt: options.prompt,
      ...(options.signal ? { abortSignal: options.signal } : {}),
      timeout: options.timeoutMs,
      maxRetries: 0,
    })
    // Reported values come ONLY from the native response object. The Agent
    // SDK echoes the resolved id in response.modelId and never reports
    // effort, so reportedEffort stays null — never back-filled from config.
    const nativeModel =
      typeof reported.response?.modelId === 'string' &&
      reported.response.modelId.length > 0
        ? reported.response.modelId
        : null
    const providerMetadata = reported.finalStep.providerMetadata?.[
      'claude-code'
    ] as Record<string, unknown> | undefined
    const sessionId =
      typeof providerMetadata?.['sessionId'] === 'string'
        ? providerMetadata['sessionId']
        : options.sessionId
    const denials = permissionDenialsOf(providerMetadata?.['permissionDenials'])
    return {
      text: reported.text,
      session: sessionId ? { id: sessionId } : null,
      resolvedModel: modelIdResolved,
      resolvedEffort: effort,
      reportedModel: nativeModel,
      reportedEffort: null,
      usage: claudeUsageOf(
        {
          inputTokens: reported.usage.inputTokens ?? null,
          outputTokens: reported.usage.outputTokens ?? null,
          cacheReadTokens:
            reported.usage.inputTokenDetails?.cacheReadTokens ?? null,
          cacheWriteTokens:
            reported.usage.inputTokenDetails?.cacheWriteTokens ?? null,
          totalTokens: reported.usage.totalTokens ?? null,
        },
        providerMetadata?.['modelUsage'],
      ),
      elapsedMs: Date.now() - started,
      ...(denials.length > 0 ? { permissionDenials: denials } : {}),
    }
  }

  /**
   * Claude Code has no way to ask whether a model and effort are usable
   * without sending a prompt, so the answer is always a minimal call.
   */
  async checkAvailability(): Promise<AvailabilityCheck> {
    return {
      verdict: 'unknown',
      method: 'none',
      detail: 'Claude Code offers no check that sends no prompt',
    }
  }

  rejectionReason(error: unknown): string | null {
    return claudeRejection(error)
  }
}
