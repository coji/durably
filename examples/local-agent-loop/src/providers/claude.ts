/**
 * Claude provider via AI SDK v7 (`ai` + `ai-sdk-provider-claude-code`).
 *
 * - Subscription auth (`claude auth login`); never requires the unselected
 *   CLI and never switches to API billing on its own.
 * - No unconditional `--dangerously-skip-permissions`: permissionMode stays
 *   `default` and a `canUseTool` guard denies file operations outside the
 *   execution workdir (enforced by the tool-permission layer, not the prompt).
 * - Review roles run read-only (`allowedTools: ['Read']`) against a frozen
 *   snapshot directory, never the live workdir.
 * - Requested effort is applied via the `effort` setting; unsupported values
 *   throw instead of being silently dropped.
 */
import { generateText } from 'ai'
import { claudeCode } from 'ai-sdk-provider-claude-code'

import { resolveEffort } from '../models.js'
import type {
  AgentCallOptions,
  AgentProvider,
  AgentResult,
  AgentRole,
} from './types.js'

const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])

function resolveModel(options: AgentCallOptions): string {
  return (
    options.requestedModel ??
    process.env.CLAUDE_MODEL ??
    process.env.MODEL ??
    'sonnet'
  )
}

export function resolveClaudeEffort(
  options: AgentCallOptions,
  modelId: string,
): string | null {
  const effort = resolveEffort(
    options.requestedEffort ?? undefined,
    process.env.CLAUDE_EFFORT,
    options.requestedModel ?? modelId,
  )
  if (effort !== null && !VALID_EFFORTS.has(effort)) {
    throw new Error(
      `unsupported Claude effort "${effort}" (supported: ${[...VALID_EFFORTS].join(', ')})`,
    )
  }
  return effort
}

const READ_ONLY_ROLES: ReadonlySet<AgentRole> = new Set([
  'review-a',
  'review-b',
])

function isInsideWorkdir(workdir: string, target: string): boolean {
  const norm = (p: string) => (p.endsWith('/') ? p.slice(0, -1) : p)
  const base = norm(workdir)
  return target === base || target.startsWith(`${base}/`)
}

/**
 * Tool-permission guard: file tools may only touch the allowed root;
 * Bash may not reference parent-dir segments or absolute paths outside it.
 * Everything else (review roles) is denied except Read.
 */
export function workdirGuard(allowedRoot: string, readOnly: boolean) {
  return async (
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<
    | { behavior: 'allow'; updatedInput: Record<string, unknown> }
    | { behavior: 'deny'; message: string }
  > => {
    if (readOnly) {
      if (toolName !== 'Read') {
        return {
          behavior: 'deny',
          message: `review role is read-only (denied ${toolName})`,
        }
      }
      const p = input['file_path']
      if (typeof p === 'string' && !isInsideWorkdir(allowedRoot, p)) {
        return {
          behavior: 'deny',
          message: `read outside review snapshot denied: ${p}`,
        }
      }
      return { behavior: 'allow', updatedInput: input }
    }
    const fileKeys = ['file_path', 'path', 'notebook_path'] as const
    for (const key of fileKeys) {
      const p = input[key]
      if (typeof p === 'string' && !isInsideWorkdir(allowedRoot, p)) {
        return {
          behavior: 'deny',
          message: `write outside execution workdir denied: ${p}`,
        }
      }
    }
    if (toolName === 'Bash') {
      const cmd = input['command']
      if (typeof cmd === 'string') {
        const escapes =
          /(^|[\s;"'])\.\.(\/|\\|$)|(^|[\s;"'])\/(Users|etc|tmp|var|home|root|private)\//.test(
            cmd,
          )
        if (escapes) {
          return {
            behavior: 'deny',
            message: `command escapes execution workdir: ${cmd.slice(0, 200)}`,
          }
        }
      }
    }
    return { behavior: 'allow', updatedInput: input }
  }
}

export class ClaudeProvider implements AgentProvider {
  readonly name = 'claude' as const
  readonly fake = false
  /** Claude Agent SDK reports usage once at completion — no partial snapshots. */
  readonly partialUsage = false

  async call(options: AgentCallOptions): Promise<AgentResult> {
    const started = Date.now()
    const modelId = resolveModel(options)
    const effort = resolveClaudeEffort(options, modelId)
    const readOnly = READ_ONLY_ROLES.has(options.role)
    const model = claudeCode(modelId, {
      cwd: options.workdir,
      settingSources: [],
      permissionMode: 'default',
      allowedTools: readOnly ? ['Read'] : ['Read', 'Edit', 'Write', 'Bash'],
      canUseTool: workdirGuard(options.workdir, readOnly),
      ...(effort ? { effort: effort as 'low' } : {}),
    })
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
    return {
      text: reported.text,
      reportedModel: modelId,
      reportedEffort: effort,
      usage:
        input === null && output === null
          ? null
          : {
              inputTokens: input,
              cachedInputTokens: cached,
              outputTokens: output,
              totalTokens: reported.usage.totalTokens ?? null,
              usageSource: 'provider-final',
            },
      elapsedMs: Date.now() - started,
    }
  }
}
