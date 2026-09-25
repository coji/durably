/** Codex app-server provider with explicit persistent thread IDs. */
import { accessSync, constants } from 'node:fs'
import { createRequire } from 'node:module'
import { delimiter, dirname, join } from 'node:path'

import { generateText } from 'ai'
import {
  CODEX_REASONING_EFFORTS,
  createCodexAppServer,
  listModels,
  type ReasoningEffort,
} from 'ai-sdk-provider-codex-cli'

import { runChild } from '../child.js'
import { defaultModelFor, resolveEffort } from '../models.js'
import {
  READ_ONLY_ROLES,
  type AgentCallOptions,
  type AgentProvider,
  type AgentResult,
  type AvailabilityCheck,
  type AvailabilityRequest,
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

/** How the provider starts Codex, and the file that command runs. */
export interface CodexExecutable {
  command: string
  args: string[]
  /** The launched file; null when a PATH lookup finds nothing. */
  path: string | null
}

/** First executable `name` on PATH, as the shell would find it. */
function onPath(name: string): string | null {
  const exts =
    process.platform === 'win32'
      ? (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';')
      : ['']
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (!dir) continue
    for (const ext of exts) {
      const candidate = join(dir, `${name}${ext}`)
      try {
        accessSync(candidate, constants.X_OK)
        return candidate
      } catch {
        // Not here.
      }
    }
  }
  return null
}

/**
 * The Codex CLI the provider launches. A run that pinned `codexPath` launches
 * that file, a script through `node` the way the provider does. Otherwise
 * `ai-sdk-provider-codex-cli` prefers the `@openai/codex` package it can
 * resolve itself, run as `node <package>/bin/codex.js`, and falls back to
 * `codex` on PATH. This repeats that resolution from the provider's own
 * location, and the provider is then handed the result explicitly, so the
 * version on record and the CLI that runs are the same file.
 */
export function codexExecutable(pinned?: string | null): CodexExecutable {
  if (pinned)
    return /\.[cm]?js$/i.test(pinned)
      ? { command: 'node', args: [pinned], path: pinned }
      : { command: pinned, args: [], path: pinned }
  try {
    const provider = createRequire(import.meta.url).resolve(
      'ai-sdk-provider-codex-cli/package.json',
    )
    const pkg = createRequire(provider).resolve('@openai/codex/package.json')
    const bin = join(dirname(pkg), 'bin', 'codex.js')
    return { command: 'node', args: [bin], path: bin }
  } catch {
    return { command: 'codex', args: [], path: onPath('codex') }
  }
}

const authModes = new Map<string, Promise<CodexAuthMode>>()

/**
 * Probe the login once per process and CLI, through the owned-subprocess
 * path. A pinned CLI may keep its login elsewhere, so each file is asked.
 */
function codexAuthMode(pinned?: string | null): Promise<CodexAuthMode> {
  const key = pinned ?? ''
  const cached = authModes.get(key)
  if (cached) return cached
  const exe = codexExecutable(pinned)
  const probe = runChild(exe.command, [...exe.args, 'login', 'status'], {
    timeoutMs: 15000,
    maxOutputChars: 2000,
  })
    .then((res) => parseCodexAuthMode(`${res.stdout}\n${res.stderr}`))
    .catch(() => 'unknown' as const)
  authModes.set(key, probe)
  return probe
}

/** How the provider reports an app server that failed to initialize. */
const CODEX_START_FAILURE = 'Failed to initialize codex app-server'

/**
 * A 4xx answer from the Codex backend, such as a model the account cannot
 * use, or a CLI that never started, as its own message; null for anything
 * else. Codex reports it as the
 * JSON error body in the message. A timeout (408) or a rate limit (429) says
 * nothing about the settings, so neither counts.
 */
export function codexRejection(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error)
  // The CLI never came up, so no prompt can have reached it: a broken
  // `codexPath` or install is a refusal, not a doubt.
  if (message.startsWith(CODEX_START_FAILURE)) return message.slice(0, 500)
  try {
    const body = JSON.parse(message) as {
      status?: unknown
      error?: { message?: unknown }
    }
    const status = typeof body.status === 'number' ? body.status : null
    if (status === null || status < 400 || status >= 500) return null
    if (status === 408 || status === 429) return null
    const detail =
      typeof body.error?.message === 'string' ? body.error.message : message
    return `${status}: ${detail}`.slice(0, 500)
  } catch {
    return null
  }
}

/** A model entry of `model/list`, with only the fields the check reads. */
interface ListedModel {
  id?: unknown
  model?: unknown
  supportedReasoningEfforts?: unknown
}

/**
 * Judge one model and effort against the Codex model list. The list is the
 * account's own catalog, so a model absent from a complete list, or an effort
 * the model does not offer, is refused without sending a prompt. A list that
 * continues on another page cannot prove absence and says `unknown`.
 */
export function judgeCodexModelList(
  models: ListedModel[],
  complete: boolean,
  model: string,
  effort: string | null,
): AvailabilityCheck {
  const method = 'codex model/list'
  const entry = models.find((m) => m.id === model || m.model === model)
  if (!entry)
    return complete
      ? {
          verdict: 'unavailable',
          method,
          detail: `${model} is not in the model list of this Codex login`,
        }
      : { verdict: 'unknown', method, detail: 'the model list has more pages' }
  const efforts = Array.isArray(entry.supportedReasoningEfforts)
    ? entry.supportedReasoningEfforts.flatMap((e) => {
        const value = (e as { reasoningEffort?: unknown } | null)
          ?.reasoningEffort
        return typeof value === 'string' ? [value] : []
      })
    : null
  if (effort !== null && efforts !== null && !efforts.includes(effort))
    return {
      verdict: 'unavailable',
      method,
      detail: `${model} does not offer effort ${effort} (offers: ${efforts.join(', ')})`,
    }
  if (effort !== null && efforts === null)
    return {
      verdict: 'unknown',
      method,
      detail: `${model} is listed without its efforts`,
    }
  return {
    verdict: 'available',
    method,
    detail: `${model} is listed${effort ? ` with effort ${effort}` : ''}`,
  }
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

  constructor(readonly cliPath: string | null = null) {}

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
    const executable = codexExecutable(this.cliPath).path
    const provider = createCodexAppServer({
      defaultSettings: {
        ...(executable ? { codexPath: executable } : {}),
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
        await codexAuthMode(this.cliPath),
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

  /** `model/list` through the pinned CLI: free, and sends no prompt. */
  async checkAvailability(
    request: AvailabilityRequest,
  ): Promise<AvailabilityCheck> {
    const model = request.model ?? defaultModelFor('codex')
    const executable = codexExecutable(this.cliPath).path
    try {
      const listed = await listModels({
        ...(executable ? { codexPath: executable } : {}),
        connectionTimeoutMs: 30000,
        requestTimeoutMs: 30000,
      })
      return judgeCodexModelList(
        listed.models,
        !listed.nextCursor,
        model,
        request.effort,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        verdict: 'unknown',
        method: 'codex model/list',
        detail: `the model list could not be read: ${message.slice(0, 300)}`,
      }
    }
  }

  rejectionReason(error: unknown): string | null {
    return codexRejection(error)
  }
}
