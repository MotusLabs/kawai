// TerminalSettings.tsx - the Terminal tab of the Settings modal: rendering
// drafts (WebGL, font, spacing — committed on Save by the shell, design D5)
// plus the four self-saving settings (mouse mode, terminal colors, window
// names, history lookback) that PUT immediately and live entirely here. The
// component mounts when the modal opens (the shell renders null when closed),
// so it fetches the server-side values on mount.
import { useEffect, useRef, useState } from 'react'
import {
  FONT_OPTIONS,
  type FontOption,
} from '../../stores/settingsStore'
import { HISTORY_MAX_AGE_MIN_HOURS, HISTORY_MAX_AGE_MAX_HOURS } from '@shared/types'
import { Switch } from '../Switch'
import FontSizeStepper from '../FontSizeStepper'

export interface TerminalSettingsProps {
  draftUseWebGL: boolean
  onDraftUseWebGLChange: (enabled: boolean) => void
  /** Committed value; drives the "will reload when saved" note. */
  committedUseWebGL: boolean
  draftFontSize: number
  onDraftFontSizeChange: (size: number) => void
  draftLineHeight: number
  onDraftLineHeightChange: (height: number) => void
  draftLetterSpacing: number
  onDraftLetterSpacingChange: (spacing: number) => void
  draftFontOption: FontOption
  onDraftFontOptionChange: (option: FontOption) => void
  draftCustomFontFamily: string
  onDraftCustomFontFamilyChange: (family: string) => void
}

export default function TerminalSettings({
  draftUseWebGL,
  onDraftUseWebGLChange,
  committedUseWebGL,
  draftFontSize,
  onDraftFontSizeChange,
  draftLineHeight,
  onDraftLineHeightChange,
  draftLetterSpacing,
  onDraftLetterSpacingChange,
  draftFontOption,
  onDraftFontOptionChange,
  draftCustomFontFamily,
  onDraftCustomFontFamilyChange,
}: TerminalSettingsProps) {
  // Self-saving server-side settings (design D5): they load on mount and PUT
  // immediately on change — no Save button involvement.
  const [tmuxMouseMode, setTmuxMouseMode] = useState(true)
  const [tmuxMouseModeLoading, setTmuxMouseModeLoading] = useState(false)
  const [terminalColors, setTerminalColors] = useState(true)
  const [terminalColorsLoading, setTerminalColorsLoading] = useState(true)
  const [preferWindowName, setPreferWindowName] = useState(false)
  const [preferWindowNameLoading, setPreferWindowNameLoading] = useState(false)
  const [historyMaxAgeHours, setHistoryMaxAgeHours] = useState(24)
  const [historyMaxAgeHoursLoading, setHistoryMaxAgeHoursLoading] = useState(false)

  // Guards a stale terminal-colors fetch (e.g. StrictMode double-mount) from
  // clobbering a newer load's value or clearing its loading flag early.
  const terminalColorsLoadIdRef = useRef(0)

  useEffect(() => {
    const terminalColorsLoadId = ++terminalColorsLoadIdRef.current

    fetch('/api/settings/tmux-mouse-mode')
      .then((res) => res.json())
      .then((data: { enabled: boolean }) => setTmuxMouseMode(data.enabled))
      .catch(() => {})
    setTerminalColorsLoading(true)
    fetch('/api/settings/terminal-colors')
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.json()
      })
      .then((data: { enabled: boolean }) => {
        if (terminalColorsLoadIdRef.current === terminalColorsLoadId) {
          setTerminalColors(data.enabled)
        }
      })
      .catch(() => {})
      .finally(() => {
        if (terminalColorsLoadIdRef.current === terminalColorsLoadId) {
          setTerminalColorsLoading(false)
        }
      })
    fetch('/api/settings/history-max-age-hours')
      .then((res) => res.json())
      .then((data: { hours: number }) => setHistoryMaxAgeHours(data.hours))
      .catch(() => {})
    fetch('/api/settings/prefer-window-name')
      .then((res) => res.json())
      .then((data: { enabled: boolean }) => setPreferWindowName(data.enabled))
      .catch(() => {})
  }, [])

  const handleTmuxMouseModeChange = (enabled: boolean) => {
    setTmuxMouseModeLoading(true)
    setTmuxMouseMode(enabled)
    fetch('/api/settings/tmux-mouse-mode', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    })
      // The server rolls the setting back when persistence fails (500), so a
      // non-ok response must revert the optimistic UI value too.
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
      })
      .catch(() => setTmuxMouseMode(!enabled)) // Revert on error
      .finally(() => setTmuxMouseModeLoading(false))
  }

  const handlePreferWindowNameChange = (enabled: boolean) => {
    setPreferWindowNameLoading(true)
    setPreferWindowName(enabled)
    fetch('/api/settings/prefer-window-name', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
      })
      .catch(() => setPreferWindowName(!enabled)) // Revert on error
      .finally(() => setPreferWindowNameLoading(false))
  }

  const handleTerminalColorsChange = (enabled: boolean) => {
    setTerminalColorsLoading(true)
    setTerminalColors(enabled)
    fetch('/api/settings/terminal-colors', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
      })
      .catch(() => setTerminalColors(!enabled))
      .finally(() => setTerminalColorsLoading(false))
  }

  const handleHistoryMaxAgeHoursChange = (hours: number) => {
    const prevHours = historyMaxAgeHours
    setHistoryMaxAgeHoursLoading(true)
    setHistoryMaxAgeHours(hours)
    fetch('/api/settings/history-max-age-hours', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hours }),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
      })
      .catch(() => setHistoryMaxAgeHours(prevHours)) // Revert on error
      .finally(() => setHistoryMaxAgeHoursLoading(false))
  }

  return (
    <>
      <div className="border-t border-border pt-4">
        <label className="mb-2 block text-xs text-secondary">
          Terminal Rendering
        </label>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-primary">WebGL Acceleration</div>
            <div className="text-[10px] text-muted">
              GPU rendering for better performance. Turn off if text looks fuzzy or flickering.
            </div>
          </div>
          <Switch
            checked={draftUseWebGL}
            onCheckedChange={onDraftUseWebGLChange}
          />
        </div>
        {draftUseWebGL !== committedUseWebGL && (
          <p className="mt-2 text-[10px] text-approval">
            Terminal will reload when saved
          </p>
        )}

        <div className="mt-4 flex items-center justify-between">
          <div>
            <div className="text-sm text-primary">Mouse Mode</div>
            <div className="text-[10px] text-muted">
              Enable tmux mouse mode for trackpad/scroll wheel support.
            </div>
          </div>
          <Switch
            checked={tmuxMouseMode}
            onCheckedChange={handleTmuxMouseModeChange}
            disabled={tmuxMouseModeLoading}
          />
        </div>

        <div className="mt-4 flex items-center justify-between gap-4">
          <div>
            <div className="text-sm text-primary">Terminal Colors</div>
            <div className="text-[10px] text-muted">
              Preserve ANSI colors for terminal output. Hibernate then Wake running agents
              after changing this setting.
            </div>
          </div>
          <Switch
            checked={terminalColors}
            onCheckedChange={handleTerminalColorsChange}
            disabled={terminalColorsLoading}
            ariaLabel="Enable terminal colors"
          />
        </div>

        <div className="mt-4 flex items-center justify-between">
          <div>
            <div className="text-sm text-primary">Prefer Window Names</div>
            <div className="text-[10px] text-muted">
              Label discovered sessions with their tmux window name instead
              of the session name. Applies immediately.
            </div>
          </div>
          <Switch
            checked={preferWindowName}
            onCheckedChange={handlePreferWindowNameChange}
            disabled={preferWindowNameLoading}
          />
        </div>

        <FontSizeStepper
          label="Font Size"
          hint="Terminal text size in pixels (6-24)"
          value={draftFontSize}
          min={6}
          max={24}
          onChange={onDraftFontSizeChange}
        />

        <div className="mt-4 flex items-center justify-between">
          <div>
            <div className="text-sm text-primary">Line Height</div>
            <div className="text-[10px] text-muted">
              Vertical spacing (1.0 = compact, 2.0 = spacious)
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min="1.0"
              max="2.0"
              step="0.1"
              value={draftLineHeight}
              onChange={(e) => onDraftLineHeightChange(parseFloat(e.target.value))}
              className="w-20 h-1 bg-border rounded-lg appearance-none cursor-pointer accent-accent"
            />
            <span className="text-xs text-secondary w-8 text-right">{draftLineHeight.toFixed(1)}</span>
          </div>
        </div>

        <div className="mt-4 flex items-center justify-between">
          <div>
            <div className="text-sm text-primary">Letter Spacing</div>
            <div className="text-[10px] text-muted">
              Horizontal spacing between characters in pixels
            </div>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min="-3"
              max="3"
              step="1"
              value={draftLetterSpacing}
              onChange={(e) => onDraftLetterSpacingChange(parseInt(e.target.value, 10))}
              className="w-20 h-1 bg-border rounded-lg appearance-none cursor-pointer accent-accent"
            />
            <span className="text-xs text-secondary w-8 text-right">{draftLetterSpacing}px</span>
          </div>
        </div>

        <div className="mt-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm text-primary">Font Family</div>
              <div className="text-[10px] text-muted">
                Terminal typeface
              </div>
            </div>
            <select
              value={draftFontOption}
              onChange={(e) => onDraftFontOptionChange(e.target.value as FontOption)}
              className="input text-xs py-1 px-2 w-auto"
            >
              {FONT_OPTIONS.map((opt) => (
                <option key={opt.id} value={opt.id}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
          {draftFontOption === 'custom' && (
            <input
              value={draftCustomFontFamily}
              onChange={(e) => onDraftCustomFontFamilyChange(e.target.value)}
              placeholder='"Fira Code", monospace'
              className="input text-xs mt-2 font-mono"
            />
          )}
        </div>
      </div>

      {/* History lookback is one of the four self-saving (immediate-PUT)
          settings; they live together on the Terminal tab (design D5). */}
      <div className="border-t border-border pt-4 flex items-center justify-between">
        <div>
          <div className="text-sm text-primary">History Sessions Lookback</div>
          <div className="text-[10px] text-muted">
            Show history sessions from the last N hours ({HISTORY_MAX_AGE_MIN_HOURS}-{HISTORY_MAX_AGE_MAX_HOURS}).
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={HISTORY_MAX_AGE_MIN_HOURS}
            max={HISTORY_MAX_AGE_MAX_HOURS}
            value={historyMaxAgeHours}
            onChange={(e) => {
              const val = parseInt(e.target.value, 10)
              if (val >= HISTORY_MAX_AGE_MIN_HOURS && val <= HISTORY_MAX_AGE_MAX_HOURS) {
                handleHistoryMaxAgeHoursChange(val)
              }
            }}
            disabled={historyMaxAgeHoursLoading}
            className="input text-xs py-1 px-2 w-16 text-center"
          />
          <span className="text-xs text-muted">hrs</span>
        </div>
      </div>
    </>
  )
}
