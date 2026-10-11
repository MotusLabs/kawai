// SessionsSettings.tsx - the Sessions tab of the Settings modal: default
// project directory, command presets (with the add-preset form), list
// ordering, and list detail switches. Drafts live in the modal shell and
// commit on Save (design D5); only the add-preset form's ephemeral state is
// local to this component.
import { useState } from 'react'
import {
  MAX_PRESETS,
  type CommandPreset,
  type SessionSortDirection,
  type SessionSortMode,
} from '../../stores/settingsStore'
import { Switch } from '../Switch'

export interface SessionsSettingsProps {
  /** Directory the server would use when the setting is empty; placeholder. */
  serverDefaultDir?: string | null
  draftDir: string
  onDraftDirChange: (dir: string) => void
  draftPresets: CommandPreset[]
  onDraftPresetsChange: (presets: CommandPreset[]) => void
  draftDefaultPresetId: string
  onDraftDefaultPresetIdChange: (id: string) => void
  draftSortMode: SessionSortMode
  onDraftSortModeChange: (mode: SessionSortMode) => void
  draftSortDirection: SessionSortDirection
  onDraftSortDirectionChange: (direction: SessionSortDirection) => void
  draftShowProjectName: boolean
  onDraftShowProjectNameChange: (enabled: boolean) => void
  draftShowLastUserMessage: boolean
  onDraftShowLastUserMessageChange: (enabled: boolean) => void
  draftShowSessionIdPrefix: boolean
  onDraftShowSessionIdPrefixChange: (enabled: boolean) => void
}

export default function SessionsSettings({
  serverDefaultDir,
  draftDir,
  onDraftDirChange,
  draftPresets,
  onDraftPresetsChange,
  draftDefaultPresetId,
  onDraftDefaultPresetIdChange,
  draftSortMode,
  onDraftSortModeChange,
  draftSortDirection,
  onDraftSortDirectionChange,
  draftShowProjectName,
  onDraftShowProjectNameChange,
  draftShowLastUserMessage,
  onDraftShowLastUserMessageChange,
  draftShowSessionIdPrefix,
  onDraftShowSessionIdPrefixChange,
}: SessionsSettingsProps) {
  // Add-preset form state (ephemeral; resets when the modal reopens because
  // the whole modal unmounts its panels on close).
  const [showAddForm, setShowAddForm] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const [newCommand, setNewCommand] = useState('')
  const [newAgentType, setNewAgentType] = useState<'claude' | 'codex' | ''>('')

  const handleUpdatePreset = (presetId: string, updates: Partial<CommandPreset>) => {
    onDraftPresetsChange(
      draftPresets.map(p => p.id === presetId ? { ...p, ...updates } : p)
    )
  }

  const handleDeletePreset = (presetId: string) => {
    const preset = draftPresets.find(p => p.id === presetId)
    if (!preset || preset.isBuiltIn) return

    const filtered = draftPresets.filter(p => p.id !== presetId)
    onDraftPresetsChange(filtered)

    // Update default if deleted preset was default
    if (presetId === draftDefaultPresetId) {
      onDraftDefaultPresetIdChange(filtered[0]?.id || 'claude')
    }
  }

  const handleAddPreset = () => {
    if (!newLabel.trim() || !newCommand.trim()) return
    if (draftPresets.length >= MAX_PRESETS) return

    const newPreset: CommandPreset = {
      id: `custom-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      label: newLabel.trim(),
      command: newCommand.trim(),
      isBuiltIn: false,
      agentType: newAgentType || undefined,
    }

    onDraftPresetsChange([...draftPresets, newPreset])
    setShowAddForm(false)
    setNewLabel('')
    setNewCommand('')
    setNewAgentType('')
  }

  const canAddPreset = draftPresets.length < MAX_PRESETS

  return (
    <>
      <div>
        <label className="mb-1.5 block text-xs text-secondary">
          Default Project Directory
        </label>
        <input
          value={draftDir}
          onChange={(event) => onDraftDirChange(event.target.value)}
          placeholder={serverDefaultDir || 'Server default directory'}
          className="input"
          autoFocus
        />
        <p className="mt-1.5 text-[10px] text-muted">
          Leave empty to default to the server's directory{serverDefaultDir ? ` (${serverDefaultDir})` : ''}.
        </p>
      </div>

      {/* Command Presets Section */}
      <div className="border-t border-border pt-4">
        <div className="flex items-center justify-between mb-2">
          <label className="text-xs text-secondary">
            Command Presets
          </label>
          <select
            value={draftDefaultPresetId}
            onChange={(e) => onDraftDefaultPresetIdChange(e.target.value)}
            className="input text-xs py-1 px-2 w-auto"
          >
            {draftPresets.map(p => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        </div>
        <p className="text-[10px] text-muted mb-3">
          Default preset is pre-selected when creating new sessions.
        </p>

        <div className="space-y-3">
          {draftPresets.map(preset => (
            <div
              key={preset.id}
              className="border border-border p-3 space-y-2"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <input
                    value={preset.label}
                    onChange={(e) => handleUpdatePreset(preset.id, { label: e.target.value })}
                    className="input text-sm py-1 px-2 w-32"
                    placeholder="Label"
                  />
                </div>
                {!preset.isBuiltIn && (
                  <button
                    type="button"
                    onClick={() => handleDeletePreset(preset.id)}
                    className="btn text-xs px-2 py-1 text-error hover:bg-error/10"
                  >
                    Delete
                  </button>
                )}
              </div>

              <div>
                <label className="text-[10px] text-muted block mb-1">Command</label>
                <input
                  value={preset.command}
                  onChange={(e) => handleUpdatePreset(preset.id, { command: e.target.value })}
                  className="input text-xs py-1 px-2 font-mono w-full"
                  placeholder="command --flags"
                />
              </div>

              {!preset.isBuiltIn && (
                <div>
                  <label className="text-[10px] text-muted block mb-1">Icon</label>
                  <select
                    value={preset.agentType || ''}
                    onChange={(e) => handleUpdatePreset(preset.id, {
                      agentType: e.target.value as 'claude' | 'codex' | undefined || undefined
                    })}
                    className="input text-xs py-1 px-2 w-auto"
                  >
                    <option value="">Terminal</option>
                    <option value="claude">Claude</option>
                    <option value="codex">Codex</option>
                  </select>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Add Preset Form */}
        {showAddForm ? (
          <div className="mt-3 border border-border p-3 space-y-2">
            <div className="text-xs text-secondary mb-2">New Preset</div>
            <input
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              className="input text-xs py-1 px-2 w-full"
              placeholder="Label"
            />
            <input
              value={newCommand}
              onChange={(e) => setNewCommand(e.target.value)}
              className="input text-xs py-1 px-2 w-full font-mono"
              placeholder="command --flags"
            />
            <div className="flex items-center gap-2">
              <select
                value={newAgentType}
                onChange={(e) => setNewAgentType(e.target.value as 'claude' | 'codex' | '')}
                className="input text-xs py-1 px-2 w-auto"
              >
                <option value="">Terminal Icon</option>
                <option value="claude">Claude Icon</option>
                <option value="codex">Codex Icon</option>
              </select>
              <div className="flex-1" />
              <button
                type="button"
                onClick={() => setShowAddForm(false)}
                className="btn text-xs px-2 py-1"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleAddPreset}
                disabled={!newLabel.trim() || !newCommand.trim()}
                className="btn btn-primary text-xs px-2 py-1"
              >
                Add
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setShowAddForm(true)}
            disabled={!canAddPreset}
            className="btn text-xs mt-3 w-full"
          >
            {canAddPreset ? '+ Add Preset' : `Max ${MAX_PRESETS} presets`}
          </button>
        )}
      </div>

      <div className="border-t border-border pt-4">
        <label className="mb-2 block text-xs text-secondary">
          Session List Order
        </label>
        <div className="flex gap-2">
          <button
            type="button"
            className={`btn flex-1 ${draftSortMode === 'created' ? 'btn-primary' : ''}`}
            onClick={() => onDraftSortModeChange('created')}
          >
            Created
          </button>
          <button
            type="button"
            className={`btn flex-1 ${draftSortMode === 'status' ? 'btn-primary' : ''}`}
            onClick={() => onDraftSortModeChange('status')}
          >
            Status
          </button>
          <button
            type="button"
            className={`btn flex-1 ${draftSortMode === 'manual' ? 'btn-primary' : ''}`}
            onClick={() => onDraftSortModeChange('manual')}
          >
            Manual
          </button>
        </div>
        <p className="mt-1.5 text-[10px] text-muted">
          {draftSortMode === 'status'
            ? 'Sessions auto-resort by status (waiting, working, unknown)'
            : draftSortMode === 'manual'
              ? 'Drag sessions to reorder manually'
              : 'Sessions stay in creation order'}
        </p>
      </div>

      {draftSortMode === 'created' && (
        <div>
          <label className="mb-2 block text-xs text-secondary">
            Sort Direction
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              className={`btn flex-1 ${draftSortDirection === 'desc' ? 'btn-primary' : ''}`}
              onClick={() => onDraftSortDirectionChange('desc')}
            >
              Newest First
            </button>
            <button
              type="button"
              className={`btn flex-1 ${draftSortDirection === 'asc' ? 'btn-primary' : ''}`}
              onClick={() => onDraftSortDirectionChange('asc')}
            >
              Oldest First
            </button>
          </div>
        </div>
      )}

      <div className="border-t border-border pt-4 space-y-3">
        <label className="mb-1 block text-xs text-secondary">
          Session List Details
        </label>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-primary">Project Name</div>
            <div className="text-[10px] text-muted">
              Show the project folder name under each session.
            </div>
          </div>
          <Switch
            checked={draftShowProjectName}
            onCheckedChange={onDraftShowProjectNameChange}
          />
        </div>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-primary">Last User Message</div>
            <div className="text-[10px] text-muted">
              Show the most recent user input next to the project name.
            </div>
          </div>
          <Switch
            checked={draftShowLastUserMessage}
            onCheckedChange={onDraftShowLastUserMessageChange}
          />
        </div>
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm text-primary">Session ID Prefix</div>
            <div className="text-[10px] text-muted">
              Show first 5 characters of agent session IDs in the list.
            </div>
          </div>
          <Switch
            checked={draftShowSessionIdPrefix}
            onCheckedChange={onDraftShowSessionIdPrefixChange}
          />
        </div>
      </div>
    </>
  )
}
