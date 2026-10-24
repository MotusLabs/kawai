// The command-preset model of the settings store, and the localStorage
// migration that upgrades older persisted shapes: extracted from
// settingsStore.ts (which re-exports the public names) to keep both files
// small. Nothing here touches the store itself.
export interface CommandPreset {
  id: string
  label: string
  command: string
  isBuiltIn: boolean
  agentType?: 'claude' | 'codex' | 'pi'
}

export const MAX_PRESETS = 50

export const DEFAULT_PRESETS: CommandPreset[] = [
  { id: 'claude', label: 'Claude', command: 'claude', isBuiltIn: true, agentType: 'claude' },
  { id: 'codex', label: 'Codex', command: 'codex', isBuiltIn: true, agentType: 'codex' },
  { id: 'pi', label: 'Pi', command: 'pi', isBuiltIn: true, agentType: 'pi' },
]

// Validation and helper functions
export function isValidPreset(p: unknown): p is CommandPreset {
  if (typeof p !== 'object' || p === null) return false
  const obj = p as Record<string, unknown>
  return (
    typeof obj.id === 'string' && obj.id.length >= 1 && obj.id.length <= 128 &&
    typeof obj.label === 'string' && obj.label.trim().length >= 1 && obj.label.length <= 64 &&
    typeof obj.command === 'string' && obj.command.trim().length >= 1 && obj.command.length <= 1024 &&
    typeof obj.isBuiltIn === 'boolean' &&
    (obj.agentType === undefined || obj.agentType === 'claude' || obj.agentType === 'codex' || obj.agentType === 'pi')
  )
}

export function normalizePreset(p: CommandPreset): CommandPreset {
  return {
    ...p,
    label: p.label.trim().slice(0, 64),
    command: p.command.trim().slice(0, 1024),
  }
}

export function getFullCommand(preset: CommandPreset): string {
  return preset.command.trim()
}

export function generatePresetId(existing: Set<string>): string {
  const maxAttempts = 100
  for (let i = 0; i < maxAttempts; i++) {
    const id = `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    if (!existing.has(id)) return id
  }
  return `custom-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function resolveDefaultPresetId(
  presets: CommandPreset[],
  currentId: string
): string {
  return presets.some(p => p.id === currentId) ? currentId : presets[0]?.id || 'claude'
}

// Empty means "not set" — fall back to the server's default directory
// (AGENTBOARD_PROJECT_DIR, else its working directory; both exposed via
// /api/server-info) when pre-filling new sessions. Lives here so the
// migration below can read them without importing the store.
export const DEFAULT_PROJECT_DIR = ''
// Pre-v7 hardcoded default; cleared during migration so the server
// working directory takes over for anyone who never customized it.
export const LEGACY_DEFAULT_PROJECT_DIR = '~/Documents/GitHub'

/** Migrate old preset format (baseCommand+modifiers) to new (command). */
const migrateOldPreset = (p: Record<string, unknown>): CommandPreset => {
  // Check if already new format
  if (typeof p.command === 'string') {
    return p as unknown as CommandPreset
  }
  // Migrate from baseCommand+modifiers
  const base = typeof p.baseCommand === 'string' ? p.baseCommand.trim() : ''
  const mods = typeof p.modifiers === 'string' ? p.modifiers.trim() : ''
  const command = mods ? `${base} ${mods}` : base
  return {
    id: p.id as string,
    label: p.label as string,
    command: command || 'claude',
    isBuiltIn: p.isBuiltIn as boolean,
    agentType: p.agentType as 'claude' | 'codex' | 'pi' | undefined,
  }
}

/**
 * The settings store's localStorage migration (zustand `migrate`): upgrades
 * pre-v2 preset shapes, restores built-ins, and clears the stale v6 project
 * directory default.
 */
export function migratePersistedSettings(persistedState: unknown, version: number): unknown {
  const state = persistedState as Record<string, unknown>
  // v7: drop the stale '~/Documents/GitHub' hardcoded default so the
  // server's directory becomes the default again for users who never
  // explicitly customized the setting.
  if (version < 7 && state.defaultProjectDir === LEGACY_DEFAULT_PROJECT_DIR) {
    state.defaultProjectDir = DEFAULT_PROJECT_DIR
  }
  if (
    typeof state.historySessionsExpanded !== 'boolean' &&
    typeof state.inactiveSessionsExpanded === 'boolean'
  ) {
    state.historySessionsExpanded = state.inactiveSessionsExpanded
  }
  if (
    typeof state.hibernatingSessionsExpanded !== 'boolean' &&
    typeof state.snoozedSessionsExpanded === 'boolean'
  ) {
    state.hibernatingSessionsExpanded = state.snoozedSessionsExpanded
  }

  if (version === 0 || !Array.isArray(state.commandPresets)) {
    // Migrate from old defaultCommand to new preset system
    const oldCmd = typeof state.defaultCommand === 'string'
      ? state.defaultCommand
      : 'claude'
    const presets: CommandPreset[] = [...DEFAULT_PRESETS]
    let defaultPresetId = 'claude'

    if (oldCmd === 'codex') {
      defaultPresetId = 'codex'
    } else if (oldCmd !== 'claude') {
      const existingIds = new Set(presets.map(p => p.id))
      const customPreset: CommandPreset = {
        id: generatePresetId(existingIds),
        label: 'Migrated',
        command: oldCmd,
        isBuiltIn: false,
      }
      presets.push(customPreset)
      defaultPresetId = customPreset.id
    }

    console.info('[agentboard:settings] Migrated from v0 to v2')
    return {
      ...state,
      commandPresets: presets,
      defaultPresetId,
      defaultCommand: oldCmd,
      recentPaths: [],
    }
  }

  // Migrate v1 presets (baseCommand+modifiers) to v2 (single command)
  const rawPresets = state.commandPresets as Record<string, unknown>[]
  const migratedPresets = rawPresets.map(migrateOldPreset)

  // Validate migrated presets
  const validPresets = migratedPresets.filter(isValidPreset)
  const hasBuiltIns = validPresets.some(p => p.id === 'claude') &&
                     validPresets.some(p => p.id === 'codex')

  if (!hasBuiltIns || validPresets.length === 0) {
    console.warn('[agentboard:settings] Invalid presets, resetting to defaults')
    return {
      ...state,
      commandPresets: DEFAULT_PRESETS,
      defaultPresetId: 'claude',
    }
  }

  // Trim to max if needed
  const trimmedPresets = validPresets.length > MAX_PRESETS
    ? [...validPresets.filter(p => p.isBuiltIn),
       ...validPresets.filter(p => !p.isBuiltIn).slice(0, MAX_PRESETS - 2)]
    : validPresets

  // Ensure all built-in presets from DEFAULT_PRESETS are present
  const existingIds = new Set(trimmedPresets.map(p => p.id))
  const missingBuiltIns = DEFAULT_PRESETS.filter(p => p.isBuiltIn && !existingIds.has(p.id))
  const finalPresets = [...trimmedPresets, ...missingBuiltIns]

  if (version < 7) {
    console.info(`[agentboard:settings] Migrated from v${version} to v7`)
  }

  return {
    ...state,
    commandPresets: finalPresets.map(normalizePreset),
    defaultPresetId: resolveDefaultPresetId(
      trimmedPresets,
      state.defaultPresetId as string
    ),
  }
}
