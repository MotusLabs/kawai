// The selected auto-compaction window of one Claude launch
// (mimo-million-token-context D1/D3). Capacity stays in the model
// declaration (`[1m]`); the window is a separate preference: the role's
// per-profile value, else the role default, else the flattened catalog
// scalar. A selected value sets CLAUDE_CODE_AUTO_COMPACT_WINDOW and clears
// DISABLE_AUTO_COMPACT and DISABLE_COMPACT — and, when the profile's model
// declaration explicitly carries `[1m]`, CLAUDE_CODE_DISABLE_1M_CONTEXT —
// in both env layers (the child env and the flag-layer settings.env). The
// composed names are checked against the spawn's own registered-name set
// first and never added to it: a collision refuses the launch before either
// layer is written. No selected value leaves the launch untouched, and a
// wrapper-backed launch never composes (the wrapper owns its configuration).
import { RegisteredNameRefusal } from './secretNameRegistry'

/** The supported window range, in tokens (D2). */
export const MIN_AUTO_COMPACT_WINDOW = 100_000
export const MAX_AUTO_COMPACT_WINDOW = 1_000_000

/** The refusal's branch label in its names-only message. */
export const COMPACTION_REFUSAL_BRANCH = 'auto-compaction'

export const AUTO_COMPACT_WINDOW_ENV = 'CLAUDE_CODE_AUTO_COMPACT_WINDOW'
export const AUTO_COMPACT_DISABLE_ENV = ['DISABLE_AUTO_COMPACT', 'DISABLE_COMPACT'] as const
export const DISABLE_1M_CONTEXT_ENV = 'CLAUDE_CODE_DISABLE_1M_CONTEXT'

/** The model-declaring catalog env names a `[1m]` tag can sit on. */
const MODEL_DECLARATION_ENV = [
  'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL',
] as const

/** Whether a value is a supported window: an integer in [100000, 1000000]. */
export function isAutoCompactWindow(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
    && value >= MIN_AUTO_COMPACT_WINDOW && value <= MAX_AUTO_COMPACT_WINDOW
}

/** A role file's window: a plain decimal token in range (D2), else null. */
export function parseWindowToken(raw: string): number | null {
  if (!/^[1-9]\d*$/.test(raw)) return null
  const value = Number(raw)
  return isAutoCompactWindow(value) ? value : null
}

/** The precedence of D2: role per-profile > role default > catalog scalar. */
export function selectAutoCompactWindow(role: number | undefined, catalog: number | undefined): number | undefined {
  return role ?? catalog
}

/** The catalog declaration of one profile, as the D1 condition reads it. */
export interface CompactionProfile {
  model?: string
  env: Readonly<Record<string, string>>
  autoCompactWindow?: number
}

/** Whether the profile's own model declaration explicitly carries `[1m]` (D1). */
export function declaresMillionContext(profile: CompactionProfile): boolean {
  if (profile.model?.endsWith('[1m]')) return true
  return MODEL_DECLARATION_ENV.some(name => profile.env[name]?.endsWith('[1m]'))
}

/** The names a selected window composes for this profile (the set C of D3). */
export function composedCompactionNames(profile: CompactionProfile): string[] {
  return [
    AUTO_COMPACT_WINDOW_ENV,
    ...AUTO_COMPACT_DISABLE_ENV,
    ...(declaresMillionContext(profile) ? [DISABLE_1M_CONTEXT_ENV] : []),
  ]
}

export interface CompactionLayers {
  childEnv: Record<string, string>
  settingsEnv?: Record<string, string>
}

/**
 * Compose the selected window into both layers, returning new objects; the
 * inputs are never mutated, so no other launch or the process env changes.
 * Throws RegisteredNameRefusal (names only) when a composed name is
 * registered, before anything is written. Undefined `window` returns the
 * layers as they were (the same objects).
 */
export function composeCompaction(
  layers: CompactionLayers,
  profile: CompactionProfile,
  window: number | undefined,
  registered: ReadonlySet<string>,
): CompactionLayers {
  if (window === undefined) return layers
  const names = composedCompactionNames(profile)
  const collisions = names.filter(name => registered.has(name)).sort()
  if (collisions.length > 0) throw new RegisteredNameRefusal(COMPACTION_REFUSAL_BRANCH, collisions)
  const composed: Record<string, string> = {}
  for (const name of names) composed[name] = name === AUTO_COMPACT_WINDOW_ENV ? String(window) : ''
  return {
    childEnv: { ...layers.childEnv, ...composed },
    settingsEnv: { ...layers.settingsEnv, ...composed },
  }
}
