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
 *   mode, in a working directory of its own holding the base commit's
 *   `CLAUDE.md` and `.claude/` and the factory's `CLAUDE.local.md`: only
 *   `Read`, `Grep`, `Glob` and `Agent` exist, `dontAsk` refuses anything
 *   else, the project's and local settings are loaded from that directory,
 *   and the same guard checks every tool call, a subagent's included,
 *   against it and the candidate's readable directories.
 * - Usage comes from the final result's `modelUsage`, which covers the call
 *   and every subagent it started, counted once.
 * - Requested effort is applied via the `effort` setting; unsupported values
 *   throw instead of being silently dropped.
 * - Bash containment is best-effort input inspection (documented limits, not
 *   a sandbox): statically unresolvable commands are denied; the Codex CLI
 *   sandbox remains the stronger isolation where that matters.
 */
import { existsSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from 'node:path'

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
 * An absolute path with every symbolic link on it resolved. A path that
 * does not exist yet (a Glob pattern, a file a tool would create) keeps its
 * missing tail, joined onto the resolved longest prefix that does exist.
 * Null when the path cannot be resolved for any other reason, which the
 * caller treats as outside.
 */
export function realPathOf(abs: string): string | null {
  const missing: string[] = []
  let current = abs
  for (;;) {
    try {
      return join(realpathSync.native(current), ...missing.reverse())
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null
      const parent = dirname(current)
      if (parent === current) return null
      missing.push(basename(current))
      current = parent
    }
  }
}

/** Whether a path names a home directory: `~`, `~/…` or `~user/…`. */
function namesHome(p: string): boolean {
  return p.startsWith('~')
}

/**
 * The `Agent` modes a review refuses. This is defence in depth, not the
 * boundary: a plain subagent keeps the review's permission mode, the review
 * has no tool that starts teammates (for which `mode` is used), and the
 * guard still sees every call a subagent makes. Refusing these costs
 * nothing and keeps a future SDK that honours `mode` from widening a review.
 */
const ESCAPING_AGENT_MODES = new Set([
  'acceptEdits',
  'auto',
  'bypassPermissions',
])

/**
 * Decide one tool call of a command-mode review or any subagent it starts.
 * Only `Read`, `Grep`, `Glob` and `Agent` pass, and every path they name must
 * resolve inside one of `roots`. The first root is the review's own working
 * directory, and a relative path is taken from it; the others are the
 * candidate worktree and the directories holding its diff, changed-file
 * list and snapshots. Paths are compared after resolving symbolic links on
 * both sides, so a link inside a root that points out of it is refused, and
 * a `~` path is refused outright. A `Glob` pattern may not climb out with
 * `..`, and its fixed prefix is resolved from its `path` like any other
 * path. An `Agent` call may not ask for isolation, nor for a permission mode
 * in `ESCAPING_AGENT_MODES`; subagent definitions come only from the base
 * commit's `.claude/`. Bash and every write tool are refused.
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
  if (toolName === 'Agent') {
    if (input['isolation'] !== undefined)
      return {
        allow: false,
        reason: `review subagents run in place (denied isolation ${String(input['isolation'])})`,
      }
    const mode = input['mode']
    if (typeof mode === 'string' && ESCAPING_AGENT_MODES.has(mode))
      return {
        allow: false,
        reason: `review subagents keep the review's permissions (denied mode ${mode})`,
      }
    return { allow: true }
  }
  const cwd = resolve(roots[0] ?? '.')
  const realRoots = roots
    .map((root) => realPathOf(resolve(root)))
    .filter((root): root is string => root !== null)
  const inside = (p: string, from = cwd) => {
    if (namesHome(p)) return false
    const real = realPathOf(resolveInside(from, p))
    return (
      real !== null && realRoots.some((root) => isInsideWorkdir(root, real))
    )
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
    const searchPath = input['path']
    const from =
      typeof searchPath === 'string' ? resolveInside(cwd, searchPath) : cwd
    // Only the part before the first wildcard names a place; it must stay
    // inside, links and all.
    const fixed = pattern.split(/[*?[{]/)[0] ?? ''
    const climbs = pattern.split(/[\\/]/).includes('..')
    if (
      climbs ||
      namesHome(pattern) ||
      !inside(fixed === '' ? '.' : fixed, from)
    )
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

/**
 * What a command-mode review turns off in the settings it loads. Those
 * settings are the base commit's, copied into the review's own working
 * directory; the candidate's are never loaded. The base is code the user
 * already merged, but a review still runs nothing it did not ask for:
 * - `disableAllHooks` in the flag settings layer, which outranks the
 *   project's and local settings, turns off every hook and status line they
 *   define. The guard is not one of them: it is passed to the SDK as a
 *   callback, not read from a settings file.
 * - `disableSkillShellExecution` replaces inline shell commands in the
 *   project's commands and skills with a placeholder instead of running them.
 * - `strictMcpConfig` with no `mcpServers` starts no MCP server: `.mcp.json`,
 *   the settings' servers, plugins' and agent frontmatter's are all ignored.
 */
export const COMMAND_MODE_LOCKDOWN = {
  settings: { disableAllHooks: true, disableSkillShellExecution: true },
  strictMcpConfig: true,
  mcpServers: {},
} satisfies Partial<ClaudeCodeSettings>

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
    // `workdir` is the review's own directory: the base commit's CLAUDE.md
    // and .claude/, and the factory's CLAUDE.local.md, found through the
    // project's and the local settings. The candidate is only data: it is
    // read through the guard, and is not an additional directory, since
    // Claude Code loads the skills, commands and agents of every additional
    // directory. Only the listed tools exist, `dontAsk` refuses anything not
    // pre-approved, and the guard sees every call, a subagent's included. A
    // review never resumes a session, so none is saved: each call has a
    // working directory of its own, and a saved session would leave one
    // more project under ~/.claude/projects/ per call.
    const roots = [workdir, ...review.readableDirs]
    return {
      cwd: workdir,
      persistSession: false,
      settingSources: ['project', 'local'],
      ...COMMAND_MODE_LOCKDOWN,
      permissionMode: 'dontAsk',
      tools: [...COMMAND_MODE_REVIEW_TOOLS],
      allowedTools: [...COMMAND_MODE_REVIEW_TOOLS],
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
    // A configured review that is not in command mode (a findings-only
    // one) reads a refused tool call as an incomplete review, so it is not
    // shown any tool it could not use.
    ...(review ? { tools: ['Read'] } : {}),
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

/** The per-model entries of a result message's `modelUsage`, by model. */
function modelUsageEntries(
  modelUsage: unknown,
): [string, Record<string, unknown>][] {
  if (
    modelUsage === null ||
    typeof modelUsage !== 'object' ||
    Array.isArray(modelUsage)
  )
    return []
  return Object.entries(modelUsage as Record<string, unknown>).filter(
    (entry): entry is [string, Record<string, unknown>] =>
      entry[1] !== null && typeof entry[1] === 'object',
  )
}

interface UsageLegs {
  uncached: number | null
  cacheRead: number | null
  cacheWrite: number | null
  output: number | null
}

/** One model's `modelUsage` legs; a leg it does not report stays unknown. */
function legsOf(model: Record<string, unknown>): UsageLegs {
  const leg = (key: string): number | null => {
    const value = model[key]
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
      ? value
      : null
  }
  return {
    uncached: leg('inputTokens'),
    cacheRead: leg('cacheReadInputTokens'),
    cacheWrite: leg('cacheCreationInputTokens'),
    output: leg('outputTokens'),
  }
}

/** Legs summed across models; one unknown leg makes the sum unknown. */
function sumUsage(legs: UsageLegs[]): TokenUsage {
  const sum = (key: keyof UsageLegs): number | null => {
    let total = 0
    for (const leg of legs) {
      const value = leg[key]
      if (value === null) return null
      total += value
    }
    return total
  }
  const uncached = sum('uncached')
  const cacheRead = sum('cacheRead')
  const cacheWrite = sum('cacheWrite')
  const output = sum('output')
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

/**
 * The usage of one model per entry of `modelUsage`, keyed by model, so each
 * model's tokens can be priced at that model's rate. Null when there is no
 * `modelUsage`.
 */
export function claudeUsageByModel(
  modelUsage: unknown,
): Record<string, TokenUsage> | null {
  const models = modelUsageEntries(modelUsage)
  if (models.length === 0) return null
  return Object.fromEntries(
    models.map(([name, model]) => [name, sumUsage([legsOf(model)])]),
  )
}

/**
 * One call's usage. A command-mode review passes the result message's
 * `modelUsage`: per-model totals for the whole call, the main loop, every
 * subagent and internal calls. When it is there it is the call's usage,
 * summed across models once and never added to the main loop's numbers,
 * which it already contains. A leg some model does not report stays
 * unknown. Every other call passes none and keeps the main loop's numbers,
 * as it always has, so runs with the default settings are measured as
 * before.
 */
export function claudeUsageOf(
  reported: MainLoopUsage,
  modelUsage: unknown,
): TokenUsage | null {
  const models = modelUsageEntries(modelUsage)
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
  return sumUsage(models.map(([, model]) => legsOf(model)))
}

/**
 * The usage one call records. Only a command-mode review counts its
 * subagents, through `modelUsage`, split by model so each is priced at its
 * own rate. Every other call keeps the main loop's usage exactly as before,
 * whatever the result message carries, so runs that configure no reviewer
 * are measured as they always were.
 */
export function claudeCallUsage(
  review: ReviewCallSettings | null | undefined,
  reported: MainLoopUsage,
  modelUsage: unknown,
): {
  usage: TokenUsage | null
  usageByModel: Record<string, TokenUsage> | null
} {
  if (!isCommandModeReview(review))
    return { usage: claudeUsageOf(reported, undefined), usageByModel: null }
  return {
    usage: claudeUsageOf(reported, modelUsage),
    usageByModel: claudeUsageByModel(modelUsage),
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
    const { usage, usageByModel } = claudeCallUsage(
      options.review,
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
    )
    return {
      text: reported.text,
      session: sessionId ? { id: sessionId } : null,
      resolvedModel: modelIdResolved,
      resolvedEffort: effort,
      reportedModel: nativeModel,
      reportedEffort: null,
      usage,
      ...(usageByModel ? { usageByModel } : {}),
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
