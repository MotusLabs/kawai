// GeneralSettings.tsx - the General tab of the Settings modal: appearance,
// notification sounds, and the keyboard shortcut modifier. All values are
// drafts owned by the modal shell and committed on Save (design D5).
import { Switch } from '../Switch'
import { getEffectiveModifier, getModifierDisplay } from '../../utils/device'
import { playPermissionSound, playIdleSound, primeAudio } from '../../utils/sound'
import type { Theme } from '../../stores/themeStore'
import type { ShortcutModifier } from '../../stores/settingsStore'

export interface GeneralSettingsProps {
  draftTheme: Theme
  onDraftThemeChange: (theme: Theme) => void
  draftSoundOnPermission: boolean
  onDraftSoundOnPermissionChange: (enabled: boolean) => void
  draftSoundOnIdle: boolean
  onDraftSoundOnIdleChange: (enabled: boolean) => void
  draftShortcutModifier: ShortcutModifier | 'auto'
  onDraftShortcutModifierChange: (modifier: ShortcutModifier | 'auto') => void
}

export default function GeneralSettings({
  draftTheme,
  onDraftThemeChange,
  draftSoundOnPermission,
  onDraftSoundOnPermissionChange,
  draftSoundOnIdle,
  onDraftSoundOnIdleChange,
  draftShortcutModifier,
  onDraftShortcutModifierChange,
}: GeneralSettingsProps) {
  return (
    <>
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
            onCheckedChange={(checked) => onDraftThemeChange(checked ? 'dark' : 'light')}
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
                onDraftSoundOnPermissionChange(checked)
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
                onDraftSoundOnIdleChange(checked)
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
              onClick={() => onDraftShortcutModifierChange(mod)}
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
    </>
  )
}
