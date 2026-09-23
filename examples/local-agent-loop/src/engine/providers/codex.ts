/** Codex app-server provider with explicit persistent thread IDs. */
import { generateText } from 'ai'
import {
  CODEX_REASONING_EFFORTS,
  createCodexAppServer,
  type ReasoningEffort,
} from 'ai-sdk-provider-codex-cli'

import { runChild } from '../child.js'
import { defaultModelFor, resolveEffort } from '../models.js'
import {
  READ_ONLY_ROLES,
  type AgentCallOptions,
  type AgentProvider,
  type AgentResult,
} from './types.js'

const VALID_EFFORTS = new Set<string>(
  CODEX_REASONING_EFFORTS as readonly string[],
)

export type CodexAuthMode = 'chatgpt' | 'api-key' | 'unknown'

/**
 * Whether a reported cache-write count can be believed.
 *
 * On a ChatGPT login the server returns `cache_write_tokens: 0` for every
 * request, including ones that demonstrably wrote the cache: across 330,957
 * responses on this machine, 2,334 went from nothing cached to a cache hit on
 * the next call and every one reported 0 writes. Codex maps the field since
 * 0.145.0; the zero is server-side and out of Codex's scope
 * (openai/codex#32479). With an API key the value is real.
 *
 * So a positive count is always taken, a zero is taken only with an API key,
 * and otherwise the leg is unknown rather than a zero that prices the 1.25x
 * write premium out of the estimate.
 */
export function codexCacheWriteTokens(
  reported: number | null | undefined,
  auth: CodexAuthMode,
): number | null {
  if (typeof reported !== 'number') return null
  if (reported > 0) return reported
  return auth === 'api-key' ? reported : null
}

/**
 * Classify `codex login status` output (codex-rs/cli/src/login.rs).
 *
 * Only the two modes whose cache-write behaviour is known are named. Bedrock
 * keys, access tokens and workload identity fall to `unknown`, which keeps a
 * zero from being believed without evidence while still taking any positive
 * count.
 */
export function parseCodexAuthMode(statusOutput: string): CodexAuthMode {
  if (/^Logged in using ChatGPT\b/m.test(statusOutput)) return 'chatgpt'
  if (/^Logged in using an API key\b/m.test(statusOutput)) return 'api-key'
  return 'unknown'
}

let authModePromise: Promise<CodexAuthMode> | null = null

/** Probe the login once per process, through the owned-subprocess path. */
function codexAuthMode(): Promise<CodexAuthMode> {
  authModePromise ??= runChild('codex', ['login', 'status'], {
    timeoutMs: 15000,
    maxOutputChars: 2000,
  })
    .then((res) => parseCodexAuthMode(`${res.stdout}\n${res.stderr}`))
    .catch(() => 'unknown' as const)
  return authModePromise
}

/** Command line or preset table only — see the matching note in claude.ts. */
function resolveModel(requestedModel: string | null): string {
  return requestedModel ?? defaultModelFor('codex')
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
      const cacheWrite = codexCacheWriteTokens(
        result.usage.inputTokenDetails?.cacheWriteTokens,
        await codexAuthMode(),
      )
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
