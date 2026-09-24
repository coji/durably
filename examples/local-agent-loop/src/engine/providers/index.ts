/** Provider factory via lookup table (no switch). */
import { ClaudeProvider } from './claude.js'
import { CodexProvider } from './codex.js'
import { FakeProvider, type FakeProviderOptions } from './fake.js'
import type { AgentProvider, ProviderName } from './types.js'

const factories: Record<
  ProviderName,
  (fake?: FakeProviderOptions) => AgentProvider
> = {
  codex: () => new CodexProvider(),
  claude: () => new ClaudeProvider(),
  fake: (fake) => new FakeProvider(fake),
}

/** `fake` options reach only the fake provider; real providers ignore them. */
export function createProvider(
  name: ProviderName,
  fake?: FakeProviderOptions,
): AgentProvider {
  const factory = factories[name]
  if (!factory) throw new Error(`Unknown provider: ${name}`)
  return factory(fake)
}

export function parseProviderName(value: string): ProviderName {
  if (value === 'codex' || value === 'claude' || value === 'fake') return value
  throw new Error(`--provider must be codex|claude|fake (got ${value})`)
}
