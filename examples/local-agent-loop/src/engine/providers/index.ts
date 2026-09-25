/** Provider factory via lookup table (no switch). */
import { ClaudeProvider } from './claude.js'
import { CodexProvider } from './codex.js'
import { FakeProvider, type FakeProviderOptions } from './fake.js'
import type { AgentProvider, ProviderName } from './types.js'

export interface ProviderOptions extends FakeProviderOptions {
  /** The run's pinned `codexPath`; only the Codex provider reads it. */
  codexPath?: string | null
}

const factories: Record<
  ProviderName,
  (options?: ProviderOptions) => AgentProvider
> = {
  codex: (options) => new CodexProvider(options?.codexPath ?? null),
  claude: () => new ClaudeProvider(),
  fake: (fake) => new FakeProvider(fake),
}

/**
 * Fake options reach only the fake provider, and `codexPath` only the Codex
 * one; the others ignore what they do not use.
 */
export function createProvider(
  name: ProviderName,
  options?: ProviderOptions,
): AgentProvider {
  const factory = factories[name]
  if (!factory) throw new Error(`Unknown provider: ${name}`)
  return factory(options)
}

export function parseProviderName(value: string): ProviderName {
  if (value === 'codex' || value === 'claude' || value === 'fake') return value
  throw new Error(`--provider must be codex|claude|fake (got ${value})`)
}
