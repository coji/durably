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
 *   snapshot directory, never the live workdir.
 * - Requested effort is applied via the `effort` setting; unsupported values
 *   throw instead of being silently dropped.
 * - Bash containment is best-effort input inspection (documented limits, not
 *   a sandbox): statically unresolvable commands are denied; the Codex CLI
 *   sandbox remains the stronger isolation where that matters.
 */
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path'

import { generateText } from 'ai'
import {
  claudeCode,
  type ClaudeCodeSettings,
} from 'ai-sdk-provider-claude-code'

import { defaultModelFor, resolveEffort } from '../models.js'
import type {
  AgentCallOptions,
  AgentProvider,
  AgentResult,
  AgentRole,
} from './types.js'

const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

function resolveModel(options: { requestedModel: string | null }): string {
  return (
    options.requestedModel ??
    process.env.CLAUDE_MODEL ??
    process.env.MODEL ??
    defaultModelFor('claude')
  )
}

function resolveEffortFor(
  requestedModel: string | null,
  requestedEffort: string | null,
  modelId: string,
): string | null {
  const effort = resolveEffort(
    requestedEffort ?? undefined,
    process.env.CLAUDE_EFFORT,
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

const READ_ONLY_ROLES: ReadonlySet<AgentRole> = new Set([
  'review-a',
  'review-b',
])

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
): ToolDecision {
  if (readOnly) {
    if (toolName !== 'Read') {
      return {
        allow: false,
        reason: `review role is read-only (denied ${toolName})`,
      }
    }
    const p = input['file_path']
    if (typeof p === 'string' && !isInsideWorkdir(allowedRoot, p)) {
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
  // Dynamic shell forms whose target cannot be resolved statically.
  if (
    cmd.includes('$(') ||
    cmd.includes('`') ||
    /(^|[\s;"'=])~(\/|$)/.test(cmd)
  ) {
    return `command uses dynamic expansion that cannot be contained: ${cmd.slice(0, 200)}`
  }
  const tokens = cmd
    .split(/[\s;&|()<>$'"`]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
  for (const token of tokens) {
    if (token.includes('$')) {
      return `command references an unresolvable variable path: ${token.slice(0, 100)}`
    }
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

/**
 * Tool-permission guard for `canUseTool` (sees only non-pre-approved calls).
 * The `PreToolUse` hook below is the complete enforcement point.
 */
export function workdirGuard(allowedRoot: string, readOnly: boolean) {
  return async (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<
    | { behavior: 'allow'; updatedInput: Record<string, unknown> }
    | { behavior: 'deny'; message: string }
  > => {
    const decision = decideToolPermission(
      allowedRoot,
      readOnly,
      toolName,
      input,
    )
    if (!decision.allow) {
      return { behavior: 'deny', message: decision.reason }
    }
    return { behavior: 'allow', updatedInput: input }
  }
}

/**
 * `PreToolUse` hook: inspects EVERY tool call, including ones pre-approved
 * via `allowedTools` (which bypass `canUseTool` per the Claude Code docs).
 * Denials surface in `providerMetadata['claude-code'].permissionDenials`.
 */
export function preToolUseHook(allowedRoot: string, readOnly: boolean) {
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
    const decision = decideToolPermission(
      allowedRoot,
      readOnly,
      toolName,
      input,
    )
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

/** Build the model settings so tests can verify the wiring, not just hope. */
export function buildClaudeSettings(
  workdir: string,
  readOnly: boolean,
  effort: string | null,
  sessionId: string | null = null,
): ClaudeCodeSettings {
  return {
    cwd: workdir,
    settingSources: [],
    permissionMode: 'default',
    allowedTools: readOnly ? ['Read'] : ['Read', 'Edit', 'Write', 'Bash'],
    canUseTool: workdirGuard(workdir, readOnly),
    hooks: {
      PreToolUse: [{ hooks: [preToolUseHook(workdir, readOnly)] }],
    },
    ...(sessionId ? { resume: sessionId } : {}),
    ...(effort ? { effort: effort as 'low' } : {}),
  }
}

export class ClaudeProvider implements AgentProvider {
  readonly name = 'claude' as const
  readonly fake = false
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
    const model = claudeCode(
      modelIdResolved,
      buildClaudeSettings(options.workdir, readOnly, effort, options.sessionId),
    )
    const reported = await generateText({
      model,
      prompt: options.prompt,
      ...(options.signal ? { abortSignal: options.signal } : {}),
      timeout: options.timeoutMs,
      maxRetries: 0,
    })
    const input = reported.usage.inputTokens ?? null
    const output = reported.usage.outputTokens ?? null
    const cacheRead = reported.usage.inputTokenDetails?.cacheReadTokens ?? null
    const cacheWrite =
      reported.usage.inputTokenDetails?.cacheWriteTokens ?? null
    const cached =
      cacheRead !== null || cacheWrite !== null
        ? (cacheRead ?? 0) + (cacheWrite ?? 0)
        : null
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
    return {
      text: reported.text,
      session: sessionId ? { id: sessionId } : null,
      resolvedModel: modelIdResolved,
      resolvedEffort: effort,
      reportedModel: nativeModel,
      reportedEffort: null,
      usage:
        input === null && output === null
          ? null
          : {
              inputTokens: input,
              cachedInputTokens: cached,
              cacheReadTokens: cacheRead,
              cacheWriteTokens: cacheWrite,
              outputTokens: output,
              totalTokens: reported.usage.totalTokens ?? null,
              usageSource: 'provider-final',
            },
      elapsedMs: Date.now() - started,
    }
  }
}
