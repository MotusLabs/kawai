import { useEffect, useRef, useState } from 'react'
import {
  useSettingsStore,
  type FontOption,
  type SessionSortDirection,
  type SessionSortMode,
  type ShortcutModifier,
  type CommandPreset,
} from '../stores/settingsStore'
import { useThemeStore, type Theme } from '../stores/themeStore'
import { getEffectiveModifier, getModifierDisplay } from '../utils/device'
import { Switch } from './Switch'
import SessionsSettings from './settings/SessionsSettings'
import ChatSettings from './settings/ChatSettings'
import TerminalSettings from './settings/TerminalSettings'
import { playPermissionSound, playIdleSound, primeAudio } from '../utils/sound'

interface SettingsChangeFlags {
  webglChanged: boolean
}

/** Settings tab (design D4): one concern per tab, opening on Sessions. */
type SettingsTab = 'sessions' | 'chat' | 'terminal' | 'general'

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: 'sessions', label: 'Sessions' },
  { id: 'chat', label: 'Chat' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'general', label: 'General' },
]

interface SettingsModalProps {
  isOpen: boolean
  onClose: (flags?: SettingsChangeFlags) => void
  /**
   * Directory the server would use when this setting is empty
   * (AGENTBOARD_PROJECT_DIR, else the server's working directory), from
   * /api/server-info. Shown as the placeholder default.
   */
  serverDefaultDir?: string | null
  /** Server build version from /api/server-info, shown beside the title. */
  version?: string | null
}

export default function SettingsModal({
  isOpen,
  onClose,
  serverDefaultDir = null,
  version = null,
}: SettingsModalProps) {
  const defaultProjectDir = useSettingsStore((state) => state.defaultProjectDir)
  const setDefaultProjectDir = useSettingsStore(
    (state) => state.setDefaultProjectDir
  )
  const commandPresets = useSettingsStore((state) => state.commandPresets)
  const setCommandPresets = useSettingsStore((state) => state.setCommandPresets)
  const defaultPresetId = useSettingsStore((state) => state.defaultPresetId)
  const setDefaultPresetId = useSettingsStore((state) => state.setDefaultPresetId)
  const sessionSortMode = useSettingsStore((state) => state.sessionSortMode)
  const setSessionSortMode = useSettingsStore(
    (state) => state.setSessionSortMode
  )
  const sessionSortDirection = useSettingsStore(
    (state) => state.sessionSortDirection
  )
  const setSessionSortDirection = useSettingsStore(
    (state) => state.setSessionSortDirection
  )
  const useWebGL = useSettingsStore((state) => state.useWebGL)
  const setUseWebGL = useSettingsStore((state) => state.setUseWebGL)
  const fontSize = useSettingsStore((state) => state.fontSize)
  const setFontSize = useSettingsStore((state) => state.setFontSize)
  const chatFontSize = useSettingsStore((state) => state.chatFontSize)
  const setChatFontSize = useSettingsStore((state) => state.setChatFontSize)
  const lineHeight = useSettingsStore((state) => state.lineHeight)
  const setLineHeight = useSettingsStore((state) => state.setLineHeight)
  const letterSpacing = useSettingsStore((state) => state.letterSpacing)
  const setLetterSpacing = useSettingsStore((state) => state.setLetterSpacing)
  const fontOption = useSettingsStore((state) => state.fontOption)
  const setFontOption = useSettingsStore((state) => state.setFontOption)
  const customFontFamily = useSettingsStore((state) => state.customFontFamily)
  const setCustomFontFamily = useSettingsStore((state) => state.setCustomFontFamily)
  const shortcutModifier = useSettingsStore((state) => state.shortcutModifier)
  const setShortcutModifier = useSettingsStore(
    (state) => state.setShortcutModifier
  )
  const showProjectName = useSettingsStore((state) => state.showProjectName)
  const setShowProjectName = useSettingsStore(
    (state) => state.setShowProjectName
  )
  const showLastUserMessage = useSettingsStore(
    (state) => state.showLastUserMessage
  )
  const setShowLastUserMessage = useSettingsStore(
    (state) => state.setShowLastUserMessage
  )
  const showSessionIdPrefix = useSettingsStore(
    (state) => state.showSessionIdPrefix
  )
  const setShowSessionIdPrefix = useSettingsStore(
    (state) => state.setShowSessionIdPrefix
  )
  const theme = useThemeStore((state) => state.theme)
  const setTheme = useThemeStore((state) => state.setTheme)
  const soundOnPermission = useSettingsStore((state) => state.soundOnPermission)
  const setSoundOnPermission = useSettingsStore((state) => state.setSoundOnPermission)
  const soundOnIdle = useSettingsStore((state) => state.soundOnIdle)
  const setSoundOnIdle = useSettingsStore((state) => state.setSoundOnIdle)

  const [draftDir, setDraftDir] = useState(defaultProjectDir)
  const [draftPresets, setDraftPresets] = useState<CommandPreset[]>(commandPresets)
  const [draftDefaultPresetId, setDraftDefaultPresetId] = useState(defaultPresetId)
  const [draftSortMode, setDraftSortMode] =
    useState<SessionSortMode>(sessionSortMode)
  const [draftSortDirection, setDraftSortDirection] =
    useState<SessionSortDirection>(sessionSortDirection)
  const [draftUseWebGL, setDraftUseWebGL] = useState(useWebGL)
  const [draftFontSize, setDraftFontSize] = useState(fontSize)
  const [draftChatFontSize, setDraftChatFontSize] = useState(chatFontSize)
  const [draftLineHeight, setDraftLineHeight] = useState(lineHeight)
  const [draftLetterSpacing, setDraftLetterSpacing] = useState(letterSpacing)
  const [draftFontOption, setDraftFontOption] = useState<FontOption>(fontOption)
  const [draftCustomFontFamily, setDraftCustomFontFamily] = useState(customFontFamily)
  const [draftShortcutModifier, setDraftShortcutModifier] = useState<
    ShortcutModifier | 'auto'
  >(shortcutModifier)
  const [draftShowProjectName, setDraftShowProjectName] =
    useState(showProjectName)
  const [draftShowLastUserMessage, setDraftShowLastUserMessage] = useState(
    showLastUserMessage
  )
  const [draftShowSessionIdPrefix, setDraftShowSessionIdSuffix] = useState(
    showSessionIdPrefix
  )
  const [draftTheme, setDraftTheme] = useState<Theme>(theme)
  const [draftSoundOnPermission, setDraftSoundOnPermission] = useState(soundOnPermission)
  const [draftSoundOnIdle, setDraftSoundOnIdle] = useState(soundOnIdle)
  // The modal always opens on Sessions (design D4); the selection is never
  // persisted across opens.
  const [activeTab, setActiveTab] = useState<SettingsTab>('sessions')

  const reenableTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (reenableTimeoutRef.current) {
      clearTimeout(reenableTimeoutRef.current)
      reenableTimeoutRef.current = null
    }

    if (isOpen) {
      setDraftDir(defaultProjectDir)
      setDraftPresets(commandPresets)
      setDraftDefaultPresetId(defaultPresetId)
      setDraftSortMode(sessionSortMode)
      setDraftSortDirection(sessionSortDirection)
      setDraftUseWebGL(useWebGL)
      setDraftFontSize(fontSize)
      setDraftChatFontSize(chatFontSize)
      setDraftLineHeight(lineHeight)
      setDraftLetterSpacing(letterSpacing)
      setDraftFontOption(fontOption)
      setDraftCustomFontFamily(customFontFamily)
      setDraftShortcutModifier(shortcutModifier)
      setDraftShowProjectName(showProjectName)
      setDraftShowLastUserMessage(showLastUserMessage)
      setDraftShowSessionIdSuffix(showSessionIdPrefix)
      setDraftTheme(theme)
      setDraftSoundOnPermission(soundOnPermission)
      setDraftSoundOnIdle(soundOnIdle)
      setActiveTab('sessions')
      // Disable terminal textarea when modal opens to prevent keyboard capture
      if (typeof document !== 'undefined') {
        const textarea = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
        if (textarea && typeof textarea.setAttribute === 'function') {
          if (typeof textarea.blur === 'function') textarea.blur()
          textarea.setAttribute('disabled', 'true')
        }
      }
    } else {
      // Re-enable terminal textarea when modal closes
      if (typeof document !== 'undefined') {
        reenableTimeoutRef.current = setTimeout(() => {
          if (typeof document === 'undefined') {
            return
          }
          const textarea = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
          if (textarea) {
            textarea.removeAttribute('disabled')
            textarea.focus()
          }
        }, 300)
      }
    }
    return () => {
      if (reenableTimeoutRef.current) {
        clearTimeout(reenableTimeoutRef.current)
        reenableTimeoutRef.current = null
      }
    }
  }, [
    commandPresets,
    defaultPresetId,
    defaultProjectDir,
    sessionSortMode,
    sessionSortDirection,
    useWebGL,
    fontSize,
    chatFontSize,
    lineHeight,
    letterSpacing,
    fontOption,
    customFontFamily,
    shortcutModifier,
    showProjectName,
    showLastUserMessage,
    showSessionIdPrefix,
    theme,
    soundOnPermission,
    soundOnIdle,
    isOpen,
  ])

  // Handle Escape key to close modal
  useEffect(() => {
    if (!isOpen) return
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (typeof e.stopPropagation === 'function') e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  if (!isOpen) {
    return null
  }

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    const trimmedDir = draftDir.trim()
    const webglChanged = draftUseWebGL !== useWebGL
    // Empty means "not set" — the New Session dialog then defaults to the
    // server's directory (AGENTBOARD_PROJECT_DIR, else its working directory).
    setDefaultProjectDir(trimmedDir)
    setCommandPresets(draftPresets)
    setDefaultPresetId(draftDefaultPresetId)
    setSessionSortMode(draftSortMode)
    setSessionSortDirection(draftSortDirection)
    setUseWebGL(draftUseWebGL)
    setFontSize(draftFontSize)
    setChatFontSize(draftChatFontSize)
    setLineHeight(draftLineHeight)
    setLetterSpacing(draftLetterSpacing)
    setFontOption(draftFontOption)
    setCustomFontFamily(draftCustomFontFamily)
    setShortcutModifier(draftShortcutModifier)
    setShowProjectName(draftShowProjectName)
    setShowLastUserMessage(draftShowLastUserMessage)
    setShowSessionIdPrefix(draftShowSessionIdPrefix)
    setTheme(draftTheme)
    setSoundOnPermission(draftSoundOnPermission)
    setSoundOnIdle(draftSoundOnIdle)
    onClose({ webglChanged })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <form
        onSubmit={handleSubmit}
        className="w-full max-w-lg max-h-[90vh] flex flex-col border border-border bg-elevated"
      >
        <div className="p-6 pb-0">
          <div className="flex items-baseline justify-between gap-4">
            <h2 className="text-sm font-semibold uppercase tracking-wider text-primary text-balance">
              Settings
            </h2>
            {version && (
              <span className="text-xs text-muted tabular-nums select-text">
                v{version}
              </span>
            )}
          </div>
          <p className="mt-2 text-xs text-muted text-pretty">
            Configure default directory, command presets, and display options.
          </p>
        </div>

        {/* Tab strip (design D6): inactive panels stay mounted with `hidden`
            so every control keeps its place in the tree — they leave the
            accessibility tree and tab order instead of unmounting. */}
        <div role="tablist" aria-label="Settings sections" className="flex gap-1 px-6 pt-4">
          {SETTINGS_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={activeTab === tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`btn text-xs px-3 py-1 ${activeTab === tab.id ? 'btn-primary' : ''}`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-y-auto px-6 pb-4">

        <div role="tabpanel" aria-label="Sessions" hidden={activeTab !== 'sessions'} className="mt-5 space-y-4">
          <SessionsSettings
            serverDefaultDir={serverDefaultDir}
            draftDir={draftDir}
            onDraftDirChange={setDraftDir}
            draftPresets={draftPresets}
            onDraftPresetsChange={setDraftPresets}
            draftDefaultPresetId={draftDefaultPresetId}
            onDraftDefaultPresetIdChange={setDraftDefaultPresetId}
            draftSortMode={draftSortMode}
            onDraftSortModeChange={setDraftSortMode}
            draftSortDirection={draftSortDirection}
            onDraftSortDirectionChange={setDraftSortDirection}
            draftShowProjectName={draftShowProjectName}
            onDraftShowProjectNameChange={setDraftShowProjectName}
            draftShowLastUserMessage={draftShowLastUserMessage}
            onDraftShowLastUserMessageChange={setDraftShowLastUserMessage}
            draftShowSessionIdPrefix={draftShowSessionIdPrefix}
            onDraftShowSessionIdPrefixChange={setDraftShowSessionIdSuffix}
          />
        </div>

        <div role="tabpanel" aria-label="General" hidden={activeTab !== 'general'} className="mt-5 space-y-4">
          <div className="border-t border-border pt-4">
            <label className="mb-2 block text-xs text-secondary">
              Appearance
            </label>
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm text-primary">Dark Mode</div>
                <div className="text-[10px] text-muted">
                  Switch between dark and light themes.
                </div>
              </div>
              <Switch
                checked={draftTheme === 'dark'}
                onCheckedChange={(checked) => setDraftTheme(checked ? 'dark' : 'light')}
              />
            </div>
          </div>

          <div className="border-t border-border pt-4 space-y-3">
            <label className="mb-1 block text-xs text-secondary">
              Notifications
            </label>
            <div className="flex items-center justify-between">
              <div className="flex-1">
                <div className="text-sm text-primary">Permission Sound</div>
                <div className="text-[10px] text-muted">
                  Play a ping when any session needs permission.
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void playPermissionSound()}
                  className="btn text-xs px-2 py-1"
                >
                  Test
                </button>
                <Switch
                  checked={draftSoundOnPermission}
                  onCheckedChange={(checked) => {
                    setDraftSoundOnPermission(checked)
                    if (checked) void primeAudio() // Unlock audio on user gesture
                  }}
                />
              </div>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex-1">
                <div className="text-sm text-primary">Idle Sound</div>
                <div className="text-[10px] text-muted">
                  Play a chime when a session finishes working.
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void playIdleSound()}
                  className="btn text-xs px-2 py-1"
                >
                  Test
                </button>
                <Switch
                  checked={draftSoundOnIdle}
                  onCheckedChange={(checked) => {
                    setDraftSoundOnIdle(checked)
                    if (checked) void primeAudio() // Unlock audio on user gesture
                  }}
                />
              </div>
            </div>
          </div>

          <div className="border-t border-border pt-4">
            <label className="mb-2 block text-xs text-secondary">
              Keyboard Shortcut Modifier
            </label>
            <div className="grid grid-cols-5 gap-1">
              {(
                ['auto', 'ctrl-option', 'ctrl-shift', 'cmd-option', 'cmd-shift'] as const
              ).map((mod) => (
                <button
                  key={mod}
                  type="button"
                  className={`btn text-xs px-2 ${draftShortcutModifier === mod ? 'btn-primary' : ''}`}
                  onClick={() => setDraftShortcutModifier(mod)}
                >
                  {mod === 'auto'
                    ? 'Auto'
                    : getModifierDisplay(mod)}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[10px] text-muted">
              {draftShortcutModifier === 'auto'
                ? `Shortcuts: ${getModifierDisplay(getEffectiveModifier('auto'))}+[1-9/N/X/[/]]`
                : `Shortcuts: ${getModifierDisplay(draftShortcutModifier)}+[1-9/N/X/[/]]`}
            </p>
          </div>
        </div>

        <div role="tabpanel" aria-label="Chat" hidden={activeTab !== 'chat'} className="mt-5 space-y-4">
          <ChatSettings
            draftChatFontSize={draftChatFontSize}
            onDraftChatFontSizeChange={setDraftChatFontSize}
          />
        </div>

        <div role="tabpanel" aria-label="Terminal" hidden={activeTab !== 'terminal'} className="mt-5 space-y-4">
          <TerminalSettings
            draftUseWebGL={draftUseWebGL}
            onDraftUseWebGLChange={setDraftUseWebGL}
            committedUseWebGL={useWebGL}
            draftFontSize={draftFontSize}
            onDraftFontSizeChange={setDraftFontSize}
            draftLineHeight={draftLineHeight}
            onDraftLineHeightChange={setDraftLineHeight}
            draftLetterSpacing={draftLetterSpacing}
            onDraftLetterSpacingChange={setDraftLetterSpacing}
            draftFontOption={draftFontOption}
            onDraftFontOptionChange={setDraftFontOption}
            draftCustomFontFamily={draftCustomFontFamily}
            onDraftCustomFontFamilyChange={setDraftCustomFontFamily}
          />
        </div>

        </div>

        <div className="flex justify-end gap-2 p-6 pt-4 border-t border-border bg-elevated">
          <button type="button" onClick={() => onClose()} className="btn">
            Cancel
          </button>
          <button type="submit" className="btn btn-primary">
            Save
          </button>
        </div>
      </form>
    </div>
  )
}
