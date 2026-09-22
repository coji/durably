/** Version recording: AI SDK + provider packages + local CLIs. */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'

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

function cliVersion(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) {
        resolve(null)
        return
      }
      const out = `${stdout} ${stderr}`.trim().split('\n')[0]?.trim() ?? ''
      resolve(out.length > 0 ? out.slice(0, 120) : null)
    })
  })
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
  const pending = resolveVersionsUncached(provider)
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

export interface ConfigVersionInput {
  provider: string
  contextMode: string
  instructionsVersion: string
  maxIterations: number
  /** What the run was pointed at; runs against different work are not comparable. */
  target: string
  code: { model: string | null; effort: string | null }
  review: { model: string | null; effort: string | null }
}

/**
 * Stable hash of the fixed run configuration. Two runs share a config
 * version exactly when their provider, models, efforts, context mode,
 * iteration budget, and instruction set are identical — the unit of a fair
 * comparison. Stored on every LLM attempt as `configVersion`.
 */
export function configVersionOf(input: ConfigVersionInput): string {
  const canonical = JSON.stringify({
    provider: input.provider,
    contextMode: input.contextMode,
    instructionsVersion: input.instructionsVersion,
    maxIterations: input.maxIterations,
    target: input.target,
    code: { model: input.code.model, effort: input.code.effort },
    review: { model: input.review.model, effort: input.review.effort },
  })
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16)
}
