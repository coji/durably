/** Provider factory via lookup table (no switch). */
import { ClaudeProvider } from './claude.js'
import { CodexProvider } from './codex.js'
import { FakeProvider } from './fake.js'
import type { AgentProvider, ProviderName } from './types.js'

const factories: Record<ProviderName, () => AgentProvider> = {
  codex: () => new CodexProvider(),
  claude: () => new ClaudeProvider(),
  fake: () => new FakeProvider(),
}

export function createProvider(name: ProviderName): AgentProvider {
  const factory = factories[name]
  if (!factory) throw new Error(`Unknown provider: ${name}`)
  return factory()
}

export function parseProviderName(value: string): ProviderName {
  if (value === 'codex' || value === 'claude' || value === 'fake') return value
  throw new Error(`--provider must be codex|claude|fake (got ${value})`)
}
