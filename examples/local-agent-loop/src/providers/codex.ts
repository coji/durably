/** Codex app-server provider with explicit persistent thread IDs. */
import { generateText } from 'ai'
import {
  CODEX_REASONING_EFFORTS,
  createCodexAppServer,
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

function resolveModel(requestedModel: string | null): string {
  // No generic `MODEL` fallback — see the matching note in claude.ts.
  return requestedModel ?? process.env.CODEX_MODEL ?? defaultModelFor('codex')
}

function resolveEffortFor(
  requestedModel: string | null,
  requestedEffort: string | null,
  modelId: string,
): string | null {
  const effort = resolveEffort(
    requestedEffort ?? undefined,
    process.env.CODEX_EFFORT,
    requestedModel ?? modelId,
  )
  if (effort !== null && !VALID_EFFORTS.has(effort)) {
    throw new Error(
      `unsupported Codex effort "${effort}" (supported: ${[...VALID_EFFORTS].join(', ')})`,
    )
  }
  return effort
}

export function resolveCodexEffort(
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

export class CodexProvider implements AgentProvider {
  readonly name = 'codex' as const
  readonly fake = false
  readonly partialUsage = false

  resolveExecution(requested: {
    requestedModel: string | null
    requestedEffort: string | null
  }): { model: string | null; effort: string | null } {
    const model = resolveModel(requested.requestedModel)
    return {
      model,
      effort: resolveEffortFor(
        requested.requestedModel,
        requested.requestedEffort,
        model,
      ),
    }
  }

  async call(options: AgentCallOptions): Promise<AgentResult> {
    const started = Date.now()
    const { model, effort } = this.resolveExecution(options)
    const modelId = model ?? defaultModelFor('codex')
    const readOnly = READ_ONLY_ROLES.has(options.role)
    const provider = createCodexAppServer({
      defaultSettings: {
        cwd: options.workdir,
        approvalPolicy: 'never',
        sandboxPolicy: readOnly ? 'read-only' : 'workspace-write',
        autoApprove: true,
        ...(effort ? { effort: effort as ReasoningEffort } : {}),
      },
    })
    try {
      const result = await generateText({
        model: provider(modelId),
        prompt: options.prompt,
        providerOptions: {
          'codex-app-server': options.sessionId
            ? { threadId: options.sessionId }
            : { threadMode: 'persistent' },
        },
        ...(options.signal ? { abortSignal: options.signal } : {}),
        timeout: options.timeoutMs,
        maxRetries: 0,
      })
      const metadata = result.finalStep.providerMetadata?.[
        'codex-app-server'
      ] as Record<string, unknown> | undefined
      const threadId =
        typeof metadata?.['threadId'] === 'string'
          ? metadata['threadId']
          : options.sessionId
      const input = result.usage.inputTokens ?? null
      const output = result.usage.outputTokens ?? null
      const cacheRead = result.usage.inputTokenDetails?.cacheReadTokens ?? null
      const cacheWrite =
        result.usage.inputTokenDetails?.cacheWriteTokens ?? null
      const nativeModel =
        typeof result.response?.modelId === 'string' &&
        result.response.modelId.length > 0
          ? result.response.modelId
          : null
      return {
        text: result.text,
        session: threadId ? { id: threadId } : null,
        resolvedModel: modelId,
        resolvedEffort: effort,
        reportedModel: nativeModel,
        reportedEffort: null,
        usage:
          input === null && output === null
            ? null
            : {
                inputTokens: input,
                cachedInputTokens:
                  cacheRead !== null || cacheWrite !== null
                    ? (cacheRead ?? 0) + (cacheWrite ?? 0)
                    : null,
                cacheReadTokens: cacheRead,
                cacheWriteTokens: cacheWrite,
                outputTokens: output,
                totalTokens: result.usage.totalTokens ?? null,
                usageSource: 'provider-final',
              },
        elapsedMs: Date.now() - started,
      }
    } finally {
      await provider.close()
    }
  }
}
