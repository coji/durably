/** Version recording: AI SDK + provider packages + local CLIs. */
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

import { runChild } from './child.js'

const require = createRequire(import.meta.url)
const versionCache = new Map<string, Promise<Record<string, string | null>>>()

function packageVersion(name: string): string | null {
  try {
    const pkg = require(`${name}/package.json`) as { version?: unknown }
    return typeof pkg.version === 'string' ? pkg.version : null
  } catch {
    return null
  }
}

/**
 * Probe a CLI's version through `runChild`, like every other subprocess here,
 * so it joins the owned-children registry and its own process group. A bare
 * `execFile` would survive the worker's shutdown path and ignore the step
 * signal.
 */
async function cliVersion(
  command: string,
  args: string[],
): Promise<string | null> {
  try {
    const res = await runChild(command, args, {
      timeoutMs: 15000,
      maxOutputChars: 2000,
    })
    if (res.code !== 0) return null
    const out =
      `${res.stdout} ${res.stderr}`.trim().split('\n')[0]?.trim() ?? ''
    return out.length > 0 ? out.slice(0, 120) : null
  } catch {
    return null
  }
}

/**
 * Resolve the versions used for one provider call. Only the selected
 * provider's CLI is probed — the unselected CLI is never required to be
 * installed or authenticated.
 */
export async function resolveVersions(
  provider: 'codex' | 'claude' | 'fake',
): Promise<Record<string, string | null>> {
  const cached = versionCache.get(provider)
  if (cached) return cached
  // Drop a rejected probe from the cache: caching it would make one transient
  // failure permanent for the life of the worker.
  const pending = resolveVersionsUncached(provider).catch((error) => {
    versionCache.delete(provider)
    throw error
  })
  versionCache.set(provider, pending)
  return pending
}

async function resolveVersionsUncached(
  provider: 'codex' | 'claude' | 'fake',
): Promise<Record<string, string | null>> {
  const base = {
    ai: packageVersion('ai'),
    'ai-sdk-provider-codex-cli': packageVersion('ai-sdk-provider-codex-cli'),
    'ai-sdk-provider-claude-code': packageVersion(
      'ai-sdk-provider-claude-code',
    ),
  }
  if (provider === 'codex') {
    return { ...base, codexCli: await cliVersion('codex', ['--version']) }
  }
  if (provider === 'claude') {
    return { ...base, claudeCli: await cliVersion('claude', ['--version']) }
  }
  return base
}

/** One role's fixed settings, as they enter the config version. */
export interface ConfigVersionProfile {
  provider: string
  requestedModel: string | null
  requestedEffort: string | null
  effectiveModel: string | null
  effectiveEffort: string | null
}

export interface ConfigVersionInput {
  contextMode: string
  instructionsVersion: string
  maxIterations: number
  /** What the run was pointed at; runs against different work are not comparable. */
  target: string
  /**
   * Timeouts decide whether a candidate passes, so two runs with different
   * ones are not one population even when everything else matches.
   */
  agentTimeoutMs: number
  checkTimeoutMs: number
  /** Implementation and repair share one profile. */
  code: ConfigVersionProfile
  correctness: ConfigVersionProfile
  edgeCases: ConfigVersionProfile
}

function canonicalProfile(p: ConfigVersionProfile): ConfigVersionProfile {
  return {
    provider: p.provider,
    requestedModel: p.requestedModel,
    requestedEffort: p.requestedEffort,
    effectiveModel: p.effectiveModel,
    effectiveEffort: p.effectiveEffort,
  }
}

/**
 * Stable hash of the fixed run configuration. Two runs share a config
 * version exactly when every role's provider, models and efforts, the context
 * mode, iteration budget, and instruction set are identical — the unit of a
 * fair comparison. Stored on every LLM attempt as `configVersion`.
 */
export function configVersionOf(input: ConfigVersionInput): string {
  const canonical = JSON.stringify({
    contextMode: input.contextMode,
    instructionsVersion: input.instructionsVersion,
    maxIterations: input.maxIterations,
    target: input.target,
    agentTimeoutMs: input.agentTimeoutMs,
    checkTimeoutMs: input.checkTimeoutMs,
    code: canonicalProfile(input.code),
    correctness: canonicalProfile(input.correctness),
    edgeCases: canonicalProfile(input.edgeCases),
  })
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}
