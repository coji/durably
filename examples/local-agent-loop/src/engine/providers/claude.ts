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
import { tokenCount, type TokenUsage } from '../usage.js'
import {
  agentOutput,
  isCommandModeReview,
  READ_ONLY_ROLES,
  SPEC_WRITER_ROLES,
  type AgentCallOptions,
  type AgentProvider,
  type AgentResult,
  type AvailabilityCheck,
  type ReviewCallSettings,
  type SpecWriteAccess,
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
        reason:
          toolName === 'Glob' && typeof input['pattern'] === 'string'
            ? `glob outside the review's directories denied: ${input['pattern']} (path ${p})`
            : `read outside the review's directories denied: ${p}`,
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
        reason: `glob outside the review's directories denied: ${pattern} (path ${typeof searchPath === 'string' ? searchPath : 'not given'})`,
      }
  }
  return { allow: true }
}

/** The tools a spec author or fixer has; every other tool does not exist. */
export const SPEC_WRITER_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write']

/**
 * Decide one tool call of a spec author or fixer. Reading, searching and
 * globbing are held to `roots`, as a command-mode review's are: the spec's
 * own directory first, relative paths taken from it, then the worktree.
 * `Edit` and `Write` may name the spec file alone, compared after resolving
 * symbolic links. Bash, subagents and every other tool are refused.
 */
export function decideSpecToolPermission(
  roots: readonly string[],
  writableFile: string,
  toolName: string,
  input: Record<string, unknown>,
): ToolDecision {
  if (!SPEC_WRITER_TOOLS.includes(toolName))
    return {
      allow: false,
      reason: `a spec writer reads the repository and writes the spec file only (denied ${toolName})`,
    }
  if (toolName === 'Edit' || toolName === 'Write') {
    const p = input['file_path']
    const cwd = resolve(roots[0] ?? '.')
    const real =
      typeof p === 'string' && !namesHome(p)
        ? realPathOf(resolveInside(cwd, p))
        : null
    return real !== null && real === realPathOf(resolve(writableFile))
      ? { allow: true }
      : {
          allow: false,
          reason: `a spec writer writes the spec file only (denied ${String(p)})`,
        }
  }
  return decideReviewToolPermission(roots, toolName, input)
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
  specWrite: SpecWriteAccess | null = null,
): ClaudeCodeSettings {
  const executable = claudeExecutable()
  const pinned = {
    // Pinned to the binary whose version is recorded, so the two cannot
    // name different CLIs. Unresolved, the SDK reports its own error.
    ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
    ...(effort ? { effort: effort as 'low' } : {}),
  }
  if (specWrite) {
    // A spec author or fixer works in the run's spec directory, outside the
    // worktree. It reads that directory and the worktree, and writes the
    // spec file alone: only the listed tools exist, `dontAsk` refuses what
    // is not pre-approved, no project settings are loaded, and the same
    // guard sees every call through the hook.
    const roots = [workdir, ...specWrite.readableDirs]
    const decide: Decide = (toolName, input) =>
      decideSpecToolPermission(roots, specWrite.writableFile, toolName, input)
    return {
      cwd: workdir,
      persistSession: false,
      settingSources: [],
      permissionMode: 'dontAsk',
      tools: [...SPEC_WRITER_TOOLS],
      allowedTools: [...SPEC_WRITER_TOOLS],
      canUseTool: canUseToolWith(decide),
      hooks: { PreToolUse: [{ hooks: [preToolUseWith(decide)] }] },
      ...pinned,
    }
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
    // one) is not shown any tool the guard would refuse.
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
  const leg = (key: string): number | null => tokenCount(model[key])
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

/** A running total of a call's usage, by model too; see `claudePartialUsage`. */
export interface PartialUsageSnapshot {
  usage: TokenUsage
  usageByModel: Record<string, TokenUsage>
}

const asPartial = (usage: TokenUsage): TokenUsage => ({
  ...usage,
  usageSource: 'provider-partial',
})

/**
 * Legs summed across messages, kept as running sums so a changed message
 * adjusts them by its difference. A leg some message does not know stays
 * unknown while that message is counted, as `sumUsage` has it.
 */
class RunningLegs {
  private readonly sums: Record<keyof UsageLegs, number> = {
    uncached: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
  }
  private readonly unknown: Record<keyof UsageLegs, number> = {
    uncached: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
  }

  add(legs: UsageLegs, sign: 1 | -1): void {
    for (const key of Object.keys(this.sums) as (keyof UsageLegs)[]) {
      const value = legs[key]
      if (value === null) this.unknown[key] += sign
      else this.sums[key] += sign * value
    }
  }

  usage(): TokenUsage {
    const leg = (key: keyof UsageLegs) =>
      this.unknown[key] > 0 ? null : this.sums[key]
    return asPartial(
      sumUsage([
        {
          uncached: leg('uncached'),
          cacheRead: leg('cacheRead'),
          cacheWrite: leg('cacheWrite'),
          output: leg('output'),
        },
      ]),
    )
  }
}

/**
 * A reader of Agent SDK messages that keeps the call's running usage total
 * before its result message arrives, so a call stopped early keeps what it
 * had spent (ADR-0034). Each API response counts once, by its message id.
 * Its assistant messages, one per content block, carry the usage the
 * response started with, whose output is only the first few tokens; the
 * output grows only in the response's streamed `message_delta` events,
 * which the call asks for with `includePartialMessages`. A delta names no
 * message, so it belongs to the latest `message_start` on the same stream
 * (the main loop, or one subagent's tool call). Within a response each leg
 * only grows, so the response keeps the largest value seen on each leg.
 * The frames the CLI makes up itself and frames without tokens count
 * nothing. The scope is the final usage's: subagents count only in a
 * command-mode review, whose final usage includes them; every other call
 * counts its main loop alone. Returns the new total when a message changed
 * it, and null otherwise.
 */
export function claudePartialUsage(
  review: ReviewCallSettings | null | undefined,
): (message: SDKMessage) => PartialUsageSnapshot | null {
  const subagents = isCommandModeReview(review)
  const byMessage = new Map<string, { model: string; legs: UsageLegs }>()
  // The response each stream is in, by `parent_tool_use_id`.
  const streaming = new Map<string, { id: string; model: string }>()
  const total = new RunningLegs()
  const models = new Map<string, RunningLegs>()
  const modelSums = (model: string): RunningLegs => {
    let sums = models.get(model)
    if (!sums) models.set(model, (sums = new RunningLegs()))
    return sums
  }
  const snapshot = (): PartialUsageSnapshot => ({
    usage: total.usage(),
    usageByModel: Object.fromEntries(
      [...models].map(([name, sums]) => [name, sums.usage()]),
    ),
  })
  const count = (
    id: string,
    model: string,
    legs: UsageLegs,
  ): PartialUsageSnapshot | null => {
    const previous = byMessage.get(id)
    if (!previous) {
      if (!Object.values(legs).some((v) => v !== null && v > 0)) return null
      byMessage.set(id, { model, legs })
      total.add(legs, 1)
      modelSums(model).add(legs, 1)
      return snapshot()
    }
    const keys = Object.keys(legs) as (keyof UsageLegs)[]
    const grown = Object.fromEntries(
      keys.map((k) => {
        const [was, now] = [previous.legs[k], legs[k]]
        return [k, was === null ? now : now === null ? was : Math.max(was, now)]
      }),
    ) as unknown as UsageLegs
    if (keys.every((k) => grown[k] === previous.legs[k])) return null
    byMessage.set(id, { model: previous.model, legs: grown })
    total.add(previous.legs, -1)
    total.add(grown, 1)
    modelSums(previous.model).add(previous.legs, -1)
    modelSums(previous.model).add(grown, 1)
    return snapshot()
  }
  return (message) => {
    const parent = (message as { parent_tool_use_id?: unknown })
      .parent_tool_use_id
    if (!subagents && parent != null) return null
    const stream = typeof parent === 'string' ? parent : ''
    if (message.type === 'stream_event') {
      const event = message.event as unknown as {
        type?: unknown
        message?: { id?: unknown; model?: unknown; usage?: unknown }
        usage?: unknown
      }
      if (event?.type === 'message_start') {
        const id = event.message?.id
        const model = event.message?.model
        if (typeof id !== 'string' || !isCountedModel(model)) {
          streaming.delete(stream)
          return null
        }
        streaming.set(stream, { id, model })
        return count(id, model, responseLegs(event.message?.usage))
      }
      if (event?.type === 'message_delta') {
        const current = streaming.get(stream)
        const usage = event.usage
        if (!current || !usage || typeof usage !== 'object') return null
        const leg = (key: string) =>
          tokenCount((usage as Record<string, unknown>)[key])
        return count(current.id, current.model, {
          uncached: leg('input_tokens'),
          cacheRead: leg('cache_read_input_tokens'),
          cacheWrite: leg('cache_creation_input_tokens'),
          output: leg('output_tokens'),
        })
      }
      return null
    }
    if (message.type !== 'assistant') return null
    const body = message.message as unknown as {
      id?: unknown
      model?: unknown
      usage?: unknown
    }
    if (!isCountedModel(body?.model)) return null
    return count(
      typeof body.id === 'string' ? body.id : message.uuid,
      body.model,
      responseLegs(body.usage),
    )
  }
}

/** A real model's name; the CLI's own frames name `<synthetic>`. */
const isCountedModel = (model: unknown): model is string =>
  typeof model === 'string' && model.length > 0 && model !== SYNTHETIC_MODEL

/** The legs of one API response's usage; every leg unknown when it has none. */
function responseLegs(usage: unknown): UsageLegs {
  const read = (usage && typeof usage === 'object' ? usage : {}) as Record<
    string,
    unknown
  >
  const uncached = tokenCount(read['input_tokens'])
  // The API reports an absent cache leg as null: no tokens on it.
  const cacheLeg = (key: string) =>
    tokenCount(read[key]) ?? (uncached !== null ? 0 : null)
  return {
    uncached,
    cacheRead: cacheLeg('cache_read_input_tokens'),
    cacheWrite: cacheLeg('cache_creation_input_tokens'),
    output: tokenCount(read['output_tokens']),
  }
}

/** The native session ID an Agent SDK message carries; null when none. */
export function claudeSessionId(message: SDKMessage): string | null {
  const id = (message as { session_id?: unknown }).session_id
  return typeof id === 'string' && id.length > 0 ? id : null
}

/**
 * The provider's recorded permission denials, one line each. A denial by
 * the `PreToolUse` hook reaches the result's list without a reason, so its
 * reason is the one the guard gave for that tool call, from `guardReasons`.
 */
export function permissionDenialsOf(
  denials: unknown,
  guardReasons: ReadonlyMap<string, string> = new Map(),
): string[] {
  if (!Array.isArray(denials)) return []
  return denials.map((denial) => {
    const d = (denial ?? {}) as Record<string, unknown>
    const tool = typeof d['toolName'] === 'string' ? d['toolName'] : 'tool'
    const agent =
      typeof d['agentId'] === 'string' ? ` (subagent ${d['agentId']})` : ''
    const given =
      typeof d['reason'] === 'string'
        ? d['reason']
        : typeof d['toolUseId'] === 'string'
          ? guardReasons.get(d['toolUseId'])
          : undefined
    const reason = given !== undefined ? `: ${given}` : ''
    return `${tool}${agent}${reason}`.slice(0, 400)
  })
}

/**
 * The same settings, with each `PreToolUse` hook also keeping, by tool call,
 * the reason the guard gave for a call it denied. The decisions are the
 * hooks' own, unchanged.
 */
export function keepingGuardReasons(
  settings: ClaudeCodeSettings,
  reasons: Map<string, string>,
): ClaudeCodeSettings {
  const matchers = settings.hooks?.PreToolUse
  if (!matchers) return settings
  return {
    ...settings,
    hooks: {
      ...settings.hooks,
      PreToolUse: matchers.map((matcher) => ({
        ...matcher,
        hooks: matcher.hooks.map(
          (hook) => async (input, toolUseId, options) => {
            const output = await hook(input, toolUseId, options)
            const decided = (
              output as {
                hookSpecificOutput?: {
                  permissionDecision?: unknown
                  permissionDecisionReason?: unknown
                }
              }
            ).hookSpecificOutput
            const id =
              toolUseId ?? (input as { tool_use_id?: unknown }).tool_use_id
            if (
              decided?.permissionDecision === 'deny' &&
              typeof decided.permissionDecisionReason === 'string' &&
              typeof id === 'string'
            )
              reasons.set(id, decided.permissionDecisionReason)
            return output
          },
        ),
      })),
    },
  }
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
 * message (text, thinking or a tool call, with its usage), a tool's result,
 * or a running tool's progress. The last two keep the runner's idle limit
 * from firing while a long command runs. Every tool call arrives in an
 * assistant message, so a tool result or progress never comes first. When the CLI reports
 * an API refusal it sends a synthetic assistant message: model
 * `<synthetic>`, the error text as content and zero usage. That frame is not
 * activity. An errored message from a real model, or one that reports any
 * usage (cache tokens included), is: work may already have begun, so the
 * call stays uncertain. Session set-up and status messages come before any
 * model request, so they are not activity.
 */
export function isAgentActivity(message: SDKMessage): boolean {
  if (message.type === 'tool_progress') return true
  if (message.type === 'user') return hasToolResult(message.message)
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

/** Whether a user message carries a tool's result, not a prompt. */
function hasToolResult(message: unknown): boolean {
  const content = (message as { content?: unknown } | null)?.content
  return (
    Array.isArray(content) &&
    content.some(
      (block) => (block as { type?: unknown } | null)?.type === 'tool_result',
    )
  )
}

/**
 * A reader of Agent SDK messages that hands `onOutput` the assistant's text
 * and one line per tool call. A message can arrive more than once with the
 * blocks it had already sent, so each text block is written once per
 * message ID and position, and each tool call once per its own ID. Thinking
 * blocks, tool results, errored frames and everything else are skipped.
 */
export function claudeOutput(onOutput: ((chunk: string) => void) | undefined) {
  const output = agentOutput(onOutput)
  const written = new Set<string>()
  return (message: SDKMessage) => {
    if (!onOutput || message.type !== 'assistant' || message.error) return
    const body = message.message as unknown as {
      id?: unknown
      content?: unknown
    }
    if (!Array.isArray(body?.content)) return
    for (const [index, block] of body.content.entries()) {
      const b = block as {
        type?: unknown
        text?: unknown
        id?: unknown
        name?: unknown
        input?: unknown
      }
      const key =
        b.type === 'tool_use'
          ? `tool:${String(b.id)}`
          : `${String(body.id)}:${index}`
      if (written.has(key)) continue
      if (b.type === 'text' && typeof b.text === 'string') {
        written.add(key)
        output.text(b.text.endsWith('\n') ? b.text : `${b.text}\n`)
      } else if (b.type === 'tool_use' && typeof b.name === 'string') {
        written.add(key)
        output.tool(b.name, b.input)
      }
    }
  }
}

/** The model name the Claude CLI puts on the frames it makes up itself. */
const SYNTHETIC_MODEL = '<synthetic>'

/**
 * The concrete model Claude Code says it runs, from one Agent SDK message:
 * the `init` message's `model`, or an assistant message's own model when no
 * `init` came first. The CLI resolves an alias such as `opus` here, to the
 * id it sends to the API (`claude-opus-5-5` on 2.1.280). Null for any other
 * message, and for the frames the CLI makes up itself.
 */
export function observedClaudeModel(message: SDKMessage): string | null {
  const model =
    message.type === 'system' && message.subtype === 'init'
      ? (message as { model?: unknown }).model
      : message.type === 'assistant'
        ? (message.message as unknown as { model?: unknown })?.model
        : null
  return typeof model === 'string' &&
    model.length > 0 &&
    model !== SYNTHETIC_MODEL
    ? model
    : null
}

/**
 * The first Claude Code build the prompt caching documentation names as
 * keeping the cache when a session resumes at another effort.
 */
export const EFFORT_RESUME_MIN_CLAUDE_CLI = [2, 1, 260] as const

/**
 * Models whose cache Claude Code keeps across an effort change. Adding one
 * here is the whole change: the pattern and the wording below follow.
 */
const EFFORT_RESUME_MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
] as const

/**
 * A listed model id, with an optional `-YYYYMMDD` date suffix and an
 * optional `[1m]` context suffix that Claude Code reports. Anchored to the
 * whole model string so no other name matches. Matched against the model
 * Claude Code reports running, never an alias such as `opus`.
 */
const EFFORT_RESUME_MODEL_PATTERN = new RegExp(
  `^(${EFFORT_RESUME_MODELS.map((m) => m.id).join('|')})(-\\d{8})?(\\[1m\\])?$`,
  'i',
)

/** The listed models in words, such as `Opus 5.5 or Fable 5.1`. */
export const EFFORT_RESUME_MODELS_LABEL = EFFORT_RESUME_MODELS.map(
  (m) => m.label,
).join(' or ')

/**
 * Environment variables that route Claude Code through Bedrock or Vertex,
 * or turn off its experimental betas. With any of them set, resuming at
 * another effort is not known to keep the cache.
 */
export const EFFORT_RESUME_BLOCKING_ENV = [
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS',
] as const

/** `major.minor.patch` from a version line such as `2.1.280 (Claude Code)`. */
export function parseCliVersion(
  line: string | null,
): [number, number, number] | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(line ?? '')
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

function atLeast(
  version: readonly number[],
  minimum: readonly number[],
): boolean {
  for (const [i, min] of minimum.entries()) {
    const v = version[i] ?? 0
    if (v !== min) return v > min
  }
  return true
}

/** Whether Claude Code keeps the cache across an effort change on `model`. */
export function claudeKeepsCacheAcrossEffort(model: string): boolean {
  return EFFORT_RESUME_MODEL_PATTERN.test(model)
}

/**
 * Whether a model name is a full Claude model id, which Claude Code runs as
 * written. Anything else, such as `opus` or `sonnet`, is an alias whose
 * model only the CLI knows, so it is learned from what the CLI reports.
 */
export function isFullClaudeModelId(model: string): boolean {
  return /^claude-/i.test(model)
}

/**
 * Whether this Claude Code build and environment keep the cache across an
 * effort change, the model aside: `keeps` with the version, or why not.
 */
export function claudeEffortResumeEnvironment(
  cliVersion: string | null,
  env: Readonly<Record<string, string | undefined>>,
): { keeps: true; version: string } | { keeps: false; reason: string } {
  const version = parseCliVersion(cliVersion)
  const minimum = EFFORT_RESUME_MIN_CLAUDE_CLI.join('.')
  if (!version)
    return {
      keeps: false,
      reason: `Claude Code version unknown; ${minimum} or later is needed`,
    }
  if (!atLeast(version, EFFORT_RESUME_MIN_CLAUDE_CLI))
    return {
      keeps: false,
      reason: `Claude Code ${version.join('.')} is older than ${minimum}`,
    }
  const blocking = EFFORT_RESUME_BLOCKING_ENV.find((name) => Boolean(env[name]))
  if (blocking) return { keeps: false, reason: `${blocking} is set` }
  return { keeps: true, version: version.join('.') }
}

export class ClaudeProvider implements AgentProvider {
  readonly name = 'claude' as const
  readonly fake = false
  /** The Agent SDK's own binary; see `claudeExecutable`. */
  readonly cliPath = null
  /**
   * The Agent SDK's result message has the call's usage; until it arrives,
   * each API response's usage is summed into a running total.
   */
  readonly partialUsage = true

  /**
   * `sdk` is what a call reaches Claude Code through: the provider's model
   * factory and the AI SDK's `generateText`. Only a test hands in others,
   * to see what a call passes without starting the CLI.
   */
  constructor(
    private readonly sdk: {
      claudeCode: typeof claudeCode
      generateText: typeof generateText
    } = { claudeCode, generateText },
  ) {}

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
    if (SPEC_WRITER_ROLES.has(options.role) && !options.specWrite)
      throw new Error(`a ${options.role} call needs the spec file it may write`)
    const onActivity = options.onActivity
    const writeOutput = claudeOutput(options.onOutput)
    const partialUsage = claudePartialUsage(options.review)
    // The concrete model the CLI reports, first seen wins: an alias such as
    // `opus` is resolved by the CLI, never here.
    let observedModel: string | null = null
    const guardReasons = new Map<string, string>()
    const model = this.sdk.claudeCode(modelIdResolved, {
      ...keepingGuardReasons(
        buildClaudeSettings(
          options.workdir,
          readOnly,
          effort,
          options.sessionId,
          options.readableFiles,
          options.review ?? null,
          options.specWrite ?? null,
        ),
        guardReasons,
      ),
      // The streamed events carry each response's output as it grows; the
      // provider builds its result from the other messages alone.
      ...(options.onPartialUsage ? { includePartialMessages: true } : {}),
      onSdkMessage: (message: SDKMessage) => {
        observedModel ??= observedClaudeModel(message)
        if (onActivity && isAgentActivity(message)) onActivity()
        writeOutput(message)
        const session = claudeSessionId(message)
        if (session) options.onSession?.(session)
        const snapshot = options.onPartialUsage ? partialUsage(message) : null
        if (snapshot)
          options.onPartialUsage?.(snapshot.usage, snapshot.usageByModel)
      },
    })
    const reported = await this.sdk.generateText({
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
    const denials = permissionDenialsOf(
      providerMetadata?.['permissionDenials'],
      guardReasons,
    )
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
      observedModel,
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
