// Persisted client settings store: typed fields with setters, localStorage
// sync, and migration of previously stored shapes.
import { useState, useEffect } from 'react'
import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import type { ChatApprovalPolicy } from '@shared/types'
import { parseApprovalPolicy } from '@shared/chat'
import { parseQuestionAutoAnswerMinutes } from '@shared/chatQuestionAutoAnswer'
import { QUESTION_AUTO_ANSWER_DEFAULT_MINUTES } from '@shared/types'
import { safeStorage } from '../utils/storage'
// The command-preset model and the localStorage migration live beside the
// store in `settingsPresets.ts`; their public names are re-exported below so
// existing importers keep their import paths.
import {
  DEFAULT_PRESETS,
  DEFAULT_PROJECT_DIR,
  MAX_PRESETS,
  generatePresetId,
  migratePersistedSettings,
  normalizePreset,
  resolveDefaultPresetId,
  type CommandPreset,
} from './settingsPresets'

const DEFAULT_COMMAND = 'claude'

// WebGL renderer produces blurry text on Safari Retina (texture atlas DPR bug)
const isSafariDesktop = typeof navigator !== 'undefined'
  && /^((?!chrome|android).)*safari/i.test(navigator.userAgent)
  && !/iPhone|iPad|iPod/.test(navigator.userAgent)
const DEFAULT_WEBGL = !(isSafariDesktop && (typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1) > 1)

// Terminal font configuration
export type FontOption = 'jetbrains-mono' | 'system' | 'custom'

export const FONT_OPTIONS: { id: FontOption; label: string; family: string }[] = [
  {
    id: 'jetbrains-mono',
    label: 'JetBrains Mono',
    family: '"JetBrains Mono Variable", "JetBrains Mono", "SF Mono", "Fira Code", ui-monospace, monospace',
  },
  {
    id: 'system',
    label: 'System Default',
    family: 'ui-monospace, "SF Mono", Menlo, Monaco, "Cascadia Code", "Consolas", monospace',
  },
  {
    id: 'custom',
    label: 'Custom',
    family: '', // Uses customFontFamily setting
  },
]

export function getFontFamily(fontOption: FontOption, customFontFamily: string): string {
  if (fontOption === 'custom' && customFontFamily.trim()) {
    return customFontFamily.trim()
  }
  const option = FONT_OPTIONS.find((o) => o.id === fontOption)
  return option?.family || FONT_OPTIONS[0].family
}

export type SessionSortMode = 'status' | 'created' | 'manual'
export type SessionSortDirection = 'asc' | 'desc'
export type ShortcutModifier = 'ctrl-option' | 'ctrl-shift' | 'cmd-option' | 'cmd-shift'

// Sidebar width constraints
const SIDEBAR_MIN_WIDTH = 180
const SIDEBAR_MAX_WIDTH = 400
const SIDEBAR_DEFAULT_WIDTH = 240

// Workspace/Remote/Archive pane height constraints, as fractions of the
// navigator height (the flex column below the filter bar). The joint
// constraint — every pane plus the flow region's minimum — is enforced by
// CSS flex shrink, not by these per-pane bounds.
const PANE_MIN_FRACTION = 0.1
const PANE_MAX_FRACTION = 0.6
const PANE_DEFAULT_FRACTION = 0.25

function clampPaneFraction(fraction: number): number {
  return Math.max(PANE_MIN_FRACTION, Math.min(PANE_MAX_FRACTION, fraction))
}

function sanitizePaneFraction(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? clampPaneFraction(value)
    : PANE_DEFAULT_FRACTION
}

// Chat view base text size in px, separate from the terminal font size.
const CHAT_FONT_SIZE_MIN = 12
const CHAT_FONT_SIZE_MAX = 20
const CHAT_FONT_SIZE_DEFAULT = 15

function sanitizeChatFontSize(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.round(Math.max(CHAT_FONT_SIZE_MIN, Math.min(CHAT_FONT_SIZE_MAX, value)))
    : CHAT_FONT_SIZE_DEFAULT
}

// Anything that is not exactly 'auto' reads as 'manual', so a hand-edited or
// corrupt persisted value can never silently auto-approve tools (design D1).
interface SettingsState {
  defaultProjectDir: string
  setDefaultProjectDir: (dir: string) => void
  defaultCommand: string
  setDefaultCommand: (cmd: string) => void
  lastProjectPath: string | null
  setLastProjectPath: (path: string) => void
  recentPaths: string[]
  addRecentPath: (path: string) => void
  sessionSortMode: SessionSortMode
  setSessionSortMode: (mode: SessionSortMode) => void
  sessionSortDirection: SessionSortDirection
  setSessionSortDirection: (direction: SessionSortDirection) => void
  manualSessionOrder: string[]
  setManualSessionOrder: (order: string[]) => void
  useWebGL: boolean
  setUseWebGL: (enabled: boolean) => void
  fontSize: number
  setFontSize: (size: number) => void
  chatFontSize: number
  setChatFontSize: (size: number) => void
  /** Starting approval policy for new chat sessions; 'manual' unless saved as 'auto'. */
  defaultApprovalPolicy: ChatApprovalPolicy
  setDefaultApprovalPolicy: (policy: ChatApprovalPolicy) => void
  /**
   * The server's question auto-answer wait in minutes (question-auto-answer
   * D5): a memory cache of `app_settings`, loaded from
   * /api/settings/question-auto-answer and updated by its change broadcast.
   * Never persisted here — the server's copy is the only truth.
   */
  questionAutoAnswerMinutes: number
  setQuestionAutoAnswerMinutes: (minutes: unknown) => void
  lineHeight: number
  setLineHeight: (height: number) => void
  letterSpacing: number
  setLetterSpacing: (spacing: number) => void
  fontOption: FontOption
  setFontOption: (option: FontOption) => void
  customFontFamily: string
  setCustomFontFamily: (family: string) => void
  shortcutModifier: ShortcutModifier | 'auto'
  setShortcutModifier: (modifier: ShortcutModifier | 'auto') => void
  showProjectName: boolean
  setShowProjectName: (enabled: boolean) => void
  showLastUserMessage: boolean
  setShowLastUserMessage: (enabled: boolean) => void
  showSessionIdPrefix: boolean
  setShowSessionIdPrefix: (enabled: boolean) => void
  historySessionsExpanded: boolean
  setHistorySessionsExpanded: (expanded: boolean) => void
  hibernatingSessionsExpanded: boolean
  setHibernatingSessionsExpanded: (expanded: boolean) => void
  sidebarWidth: number
  setSidebarWidth: (width: number) => void
  /** Workspace pane height as a fraction of the navigator height. */
  workspacePaneFraction: number
  setWorkspacePaneFraction: (fraction: number) => void
  /** Remote pane height as a fraction of the navigator height. */
  remotePaneFraction: number
  setRemotePaneFraction: (fraction: number) => void
  /** Archive pane height as a fraction of the navigator height. */
  archivePaneFraction: number
  setArchivePaneFraction: (fraction: number) => void
  projectFilters: string[]
  setProjectFilters: (filters: string[]) => void
  hostFilters: string[]
  setHostFilters: (filters: string[]) => void
  // Sound notifications
  soundOnPermission: boolean
  setSoundOnPermission: (enabled: boolean) => void
  soundOnIdle: boolean
  setSoundOnIdle: (enabled: boolean) => void

  // Command presets
  commandPresets: CommandPreset[]
  setCommandPresets: (presets: CommandPreset[]) => void
  defaultPresetId: string
  setDefaultPresetId: (id: string) => void
  updatePresetCommand: (presetId: string, command: string) => void
  addPreset: (preset: Omit<CommandPreset, 'id' | 'isBuiltIn'>) => void
  removePreset: (presetId: string) => void
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      defaultProjectDir: DEFAULT_PROJECT_DIR,
      setDefaultProjectDir: (dir) => set({ defaultProjectDir: dir }),
      defaultCommand: DEFAULT_COMMAND,
      setDefaultCommand: (cmd) => set({ defaultCommand: cmd }),
      lastProjectPath: null,
      setLastProjectPath: (path) => set({ lastProjectPath: path }),
      recentPaths: [],
      addRecentPath: (path) => set((state) => ({
        recentPaths: [path, ...state.recentPaths.filter(p => p !== path)].slice(0, 5),
      })),
      sessionSortMode: 'created',
      setSessionSortMode: (mode) => set({ sessionSortMode: mode }),
      sessionSortDirection: 'desc',
      setSessionSortDirection: (direction) =>
        set({ sessionSortDirection: direction }),
      manualSessionOrder: [],
      setManualSessionOrder: (order) => set({ manualSessionOrder: order }),
      useWebGL: DEFAULT_WEBGL,
      setUseWebGL: (enabled) => set({ useWebGL: enabled }),
      fontSize: 13,
      setFontSize: (size) => set({ fontSize: Math.max(6, Math.min(24, size)) }),
      chatFontSize: CHAT_FONT_SIZE_DEFAULT,
      setChatFontSize: (size) => set({ chatFontSize: sanitizeChatFontSize(size) }),
      defaultApprovalPolicy: 'manual',
      setDefaultApprovalPolicy: (policy) =>
        set({ defaultApprovalPolicy: parseApprovalPolicy(policy) }),
      questionAutoAnswerMinutes: QUESTION_AUTO_ANSWER_DEFAULT_MINUTES,
      setQuestionAutoAnswerMinutes: (minutes) => {
        // A bad wire value never enters the store (QA-S4): the validated
        // whole number of minutes is the only thing cached.
        const parsed = parseQuestionAutoAnswerMinutes(minutes)
        if (parsed.valid) set({ questionAutoAnswerMinutes: parsed.minutes })
      },
      lineHeight: 1.0,
      setLineHeight: (height) => set({ lineHeight: Math.max(1.0, Math.min(2.0, height)) }),
      letterSpacing: 0,
      setLetterSpacing: (spacing) => set({ letterSpacing: Math.max(-3, Math.min(3, spacing)) }),
      fontOption: 'jetbrains-mono',
      setFontOption: (option) => set({ fontOption: option }),
      customFontFamily: '',
      setCustomFontFamily: (family) => set({ customFontFamily: family.slice(0, 256) }),
      shortcutModifier: 'auto',
      setShortcutModifier: (modifier) => set({ shortcutModifier: modifier }),
      showProjectName: true,
      setShowProjectName: (enabled) => set({ showProjectName: enabled }),
      showLastUserMessage: true,
      setShowLastUserMessage: (enabled) => set({ showLastUserMessage: enabled }),
      showSessionIdPrefix: false,
      setShowSessionIdPrefix: (enabled) => set({ showSessionIdPrefix: enabled }),
      historySessionsExpanded: false,
      setHistorySessionsExpanded: (expanded) => set({ historySessionsExpanded: expanded }),
      hibernatingSessionsExpanded: true,
      setHibernatingSessionsExpanded: (expanded) => set({ hibernatingSessionsExpanded: expanded }),
      sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
      setSidebarWidth: (width) =>
        set({
          sidebarWidth: Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, width)),
        }),
      workspacePaneFraction: PANE_DEFAULT_FRACTION,
      setWorkspacePaneFraction: (fraction) =>
        set({ workspacePaneFraction: sanitizePaneFraction(fraction) }),
      remotePaneFraction: PANE_DEFAULT_FRACTION,
      setRemotePaneFraction: (fraction) =>
        set({ remotePaneFraction: sanitizePaneFraction(fraction) }),
      archivePaneFraction: PANE_DEFAULT_FRACTION,
      setArchivePaneFraction: (fraction) =>
        set({ archivePaneFraction: sanitizePaneFraction(fraction) }),
      projectFilters: [],
      setProjectFilters: (filters) => set({ projectFilters: filters }),
      hostFilters: [],
      setHostFilters: (filters) => set({ hostFilters: filters }),
      // Sound notifications
      soundOnPermission: false,
      setSoundOnPermission: (enabled) => set({ soundOnPermission: enabled }),
      soundOnIdle: false,
      setSoundOnIdle: (enabled) => set({ soundOnIdle: enabled }),

      // Command presets
      commandPresets: DEFAULT_PRESETS,
      setCommandPresets: (presets) => set({ commandPresets: presets }),
      defaultPresetId: 'claude',
      setDefaultPresetId: (id) => set({ defaultPresetId: id }),
      updatePresetCommand: (presetId, command) => {
        const { commandPresets } = get()
        const updated = commandPresets.map(p =>
          p.id === presetId ? { ...p, command: command.trim().slice(0, 1024) } : p
        )
        set({ commandPresets: updated })
      },
      addPreset: (preset) => {
        const { commandPresets } = get()
        if (commandPresets.length >= MAX_PRESETS) {
          console.warn('[agentboard:settings] Max presets reached')
          return
        }
        const existingIds = new Set(commandPresets.map(p => p.id))
        const newPreset: CommandPreset = {
          ...normalizePreset({ ...preset, id: '', isBuiltIn: false }),
          id: generatePresetId(existingIds),
          isBuiltIn: false,
        }
        set({ commandPresets: [...commandPresets, newPreset] })
      },
      removePreset: (presetId) => {
        const { commandPresets, defaultPresetId } = get()
        const preset = commandPresets.find(p => p.id === presetId)
        if (!preset || preset.isBuiltIn) return
        const filtered = commandPresets.filter(p => p.id !== presetId)
        const newDefault = presetId === defaultPresetId
          ? resolveDefaultPresetId(filtered, defaultPresetId)
          : defaultPresetId
        set({ commandPresets: filtered, defaultPresetId: newDefault })
      },
    }),
    {
      name: 'agentboard-settings',
      storage: createJSONStorage(() => safeStorage),
      version: 7,
      // The question auto-answer wait mirrors server state (question-auto-
      // answer D5): only the running server's value is true, so it is never
      // written to localStorage — a stale cached wait could disagree with
      // what the server will actually do.
      partialize: (state) => {
        const { questionAutoAnswerMinutes: _value, setQuestionAutoAnswerMinutes: _set, ...persisted } = state
        return persisted as SettingsState
      },
      // Same shallow merge as the default, plus re-clamping of the pane
      // fractions and chat font size and re-sanitizing of the default
      // approval policy: a hand-edited or corrupt persisted value must not
      // produce an unusable layout or silently auto-approve tools, and state
      // persisted before the keys existed keeps the defaults supplied by the
      // spread below.
      merge: (persistedState, currentState) => {
        const merged = {
          ...currentState,
          ...(persistedState as object),
        } as SettingsState
        return {
          ...merged,
          workspacePaneFraction: sanitizePaneFraction(merged.workspacePaneFraction),
          remotePaneFraction: sanitizePaneFraction(merged.remotePaneFraction),
          archivePaneFraction: sanitizePaneFraction(merged.archivePaneFraction),
          chatFontSize: sanitizeChatFontSize(merged.chatFontSize),
          defaultApprovalPolicy: parseApprovalPolicy(merged.defaultApprovalPolicy),
        }
      },
      migrate: migratePersistedSettings,
    }
  )
)

export { DEFAULT_COMMAND }

export {
  DEFAULT_PROJECT_DIR,
  LEGACY_DEFAULT_PROJECT_DIR,
  MAX_PRESETS,
  DEFAULT_PRESETS,
  isValidPreset,
  normalizePreset,
  getFullCommand,
  generatePresetId,
  resolveDefaultPresetId,
} from './settingsPresets'
export type { CommandPreset } from './settingsPresets'

export {
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  PANE_MIN_FRACTION,
  PANE_MAX_FRACTION,
  CHAT_FONT_SIZE_MIN,
  CHAT_FONT_SIZE_MAX,
  CHAT_FONT_SIZE_DEFAULT,
}

/**
 * Returns true once the settings store has finished hydrating from
 * localStorage. Prevents components from reading default (pre-hydration)
 * values like DEFAULT_PRESETS instead of the user's saved settings.
 */
export function useSettingsHasHydrated(): boolean {
  const [hydrated, setHydrated] = useState(useSettingsStore.persist.hasHydrated())

  useEffect(() => {
    const unsub = useSettingsStore.persist.onFinishHydration(() => setHydrated(true))
    // Re-check after subscribing to close the race window where hydration
    // completes between the initial useState and the effect subscription.
    if (useSettingsStore.persist.hasHydrated()) setHydrated(true)
    return unsub
  }, [])

  return hydrated
}
