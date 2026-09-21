/** Model presets: default effort per model. Lookup table, no switch. */
import type { ProviderName } from './providers/types.js'

export interface ModelPreset {
  model: string
  provider: Exclude<ProviderName, 'fake'>
  effort: string
}

export const MODEL_PRESETS: readonly ModelPreset[] = [
  { model: 'gpt-6-astra', provider: 'codex', effort: 'low' },
  { model: 'gpt-5.6-sol', provider: 'codex', effort: 'low' },
  { model: 'gpt-5.6-luna', provider: 'codex', effort: 'max' },
  { model: 'claude-fable-5-1', provider: 'claude', effort: 'low' },
  { model: 'claude-opus-5', provider: 'claude', effort: 'high' },
  { model: 'claude-sonnet-5', provider: 'claude', effort: 'high' },
]

const byModel: Record<string, ModelPreset> = Object.fromEntries(
  MODEL_PRESETS.map((p) => [p.model.toLowerCase(), p]),
)

/** Provider default when no model is requested: always a preset model, so
 * effort and pricing resolve without unknowns. Single source of truth —
 * providers must use this instead of hardcoding their own default. */
const DEFAULT_MODEL: Record<Exclude<ProviderName, 'fake'>, string> = {
  codex: 'gpt-5.6-sol',
  claude: 'claude-sonnet-5',
}

export function defaultModelFor(
  provider: Exclude<ProviderName, 'fake'>,
): string {
  return DEFAULT_MODEL[provider]
}

export function presetForModel(
  model: string | null | undefined,
): ModelPreset | null {
  if (!model) return null
  return byModel[model.toLowerCase()] ?? null
}

/** Precedence: explicit option > env var > model preset > null (unknown). */
export function resolveEffort(
  explicit: string | undefined,
  envValue: string | undefined,
  model: string | null,
): string | null {
  if (explicit) return explicit
  if (envValue) return envValue
  return presetForModel(model)?.effort ?? null
}
