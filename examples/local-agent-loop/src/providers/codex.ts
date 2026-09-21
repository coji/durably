/**
 * Codex provider via AI SDK v7 (`ai` + `ai-sdk-provider-codex-cli`).
 *
 * - Subscription auth (`codex login`) or OPENAI_API_KEY — never switches to
 *   API billing on its own; the unselected CLI is never touched.
 * - Requested effort is actually applied via `reasoningEffort` (previously
 *   record-only metadata). Unsupported effort values throw instead of being
 *   silently dropped.
 * - Read-only roles use `sandboxMode: 'read-only'` + `approvalMode: 'never'`
 *   (enforced by the CLI sandbox, not just the prompt text).
 * - `codex exec` reports usage only at the end; that constraint is recorded
 *   in `usageSource: 'provider-final'` and `partialUsage: false`.
 */
import { generateText } from 'ai'
import {
  CODEX_REASONING_EFFORTS,
  codexExec,
  type ReasoningEffort,
} from 'ai-sdk-provider-codex-cli'

import { defaultModelFor, resolveEffort } from '../models.js'
import type {
  AgentCallOptions,
  AgentProvider,
  AgentResult,
  AgentRole,
} from './types.js'

const VALID_EFFORTS = new Set<string>(
  CODEX_REASONING_EFFORTS as readonly string[],
)

function resolveModel(options: AgentCallOptions): string {
  return (
    options.requestedModel ??
    process.env.CODEX_MODEL ??
    process.env.MODEL ??
    defaultModelFor('codex')
  )
}

export function resolveCodexEffort(
  options: AgentCallOptions,
  modelId: string,
): string | null {
  // Preset lookup runs against the effective model so the provider default
  // gets its preset too; explicit > env > preset precedence is unchanged.
  const effort = resolveEffort(
    options.requestedEffort ?? undefined,
    process.env.CODEX_EFFORT,
    options.requestedModel ?? modelId,
  )
  if (effort !== null && !VALID_EFFORTS.has(effort)) {
    throw new Error(
      `unsupported Codex effort "${effort}" (supported: ${[...VALID_EFFORTS].join(', ')})`,
    )
  }
  return effort
}

const READ_ONLY_ROLES: ReadonlySet<AgentRole> = new Set([
  'review-a',
  'review-b',
])

export class CodexProvider implements AgentProvider {
  readonly name = 'codex' as const
  readonly fake = false
  /** `codex exec` reports usage once at completion — no partial snapshots. */
  readonly partialUsage = false

  async call(options: AgentCallOptions): Promise<AgentResult> {
    const started = Date.now()
    const modelId = resolveModel(options)
    const effort = resolveCodexEffort(options, modelId)
    const readOnly = READ_ONLY_ROLES.has(options.role)
    const model = codexExec(modelId, {
      allowNpx: true,
      skipGitRepoCheck: true,
      cwd: options.workdir,
      // Implementer may edit only the execution workdir; reviewers are
      // sandboxed read-only by the CLI itself.
      sandboxMode: readOnly ? 'read-only' : 'workspace-write',
      approvalMode: readOnly ? 'never' : 'on-request',
      ...(effort ? { reasoningEffort: effort as ReasoningEffort } : {}),
    })
    const result = await generateText({
      model,
      prompt: options.prompt,
      ...(options.signal ? { abortSignal: options.signal } : {}),
      timeout: options.timeoutMs,
      maxRetries: 0,
    })
    const input = result.usage.inputTokens ?? null
    const output = result.usage.outputTokens ?? null
    const cacheRead = result.usage.inputTokenDetails?.cacheReadTokens ?? null
    const cacheWrite = result.usage.inputTokenDetails?.cacheWriteTokens ?? null
    const cached =
      cacheRead !== null || cacheWrite !== null
        ? (cacheRead ?? 0) + (cacheWrite ?? 0)
        : null
    return {
      text: result.text,
      reportedModel: modelId,
      reportedEffort: effort,
      usage:
        input === null && output === null
          ? null
          : {
              inputTokens: input,
              cachedInputTokens: cached,
              outputTokens: output,
              totalTokens: result.usage.totalTokens ?? null,
              usageSource: 'provider-final',
            },
      elapsedMs: Date.now() - started,
    }
  }
}
