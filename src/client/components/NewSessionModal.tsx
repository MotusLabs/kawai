import { useClaudeProfiles } from './chat/useClaudeProfiles'
import { useEffect, useRef, useState } from 'react'
import { type CommandPreset, getFullCommand, useSettingsStore } from '../stores/settingsStore'
import { DirectoryBrowser } from './DirectoryBrowser'
import AgentIcon from './AgentIcon'
import { shortRevision } from '@shared/workspace'
import { autoStartAgentFromToken, resolveAgentToken } from '@shared/agentToken'
import { getPathLeaf } from '../utils/sessionLabel'
import type { AutoStartAgent, ChatApprovalPolicy, HostStatus } from '@shared/types'

/** A discovered local worktree offered by the picker. */
export interface NewSessionWorktreeOption {
  worktreeId: string
  repositoryName: string
  path: string
  branch?: string
  detached: boolean
  headRevision: string
}

function worktreeOptionLabel(worktree: NewSessionWorktreeOption): string {
  const revision = worktree.detached || !worktree.branch
    ? `@${shortRevision(worktree.headRevision)}`
    : worktree.branch
  const leaf = getPathLeaf(worktree.path)
  return `${worktree.repositoryName} · ${revision}${leaf ? ` (${leaf})` : ''}`
}

/** Values of the first-prompt ("Start with") selector. */
type StartWithValue = AutoStartAgent | 'none'

/**
 * The session kind a fresh open preselects. A change-section launch exists to
 * offer the terminal-only first-prompt ("Start with") selector, so that entry
 * point keeps Terminal; every other open defaults to Claude chat. Recalculated
 * on every open rather than remembered, so the previous open's choice never
 * leaks into the next one.
 */
function defaultKind(initialAutoStartChange?: string): 'terminal' | 'chat' {
  return initialAutoStartChange ? 'terminal' : 'chat'
}

/**
 * The first-prompt selector's default: the selected preset's declared agent
 * type (an explicit user declaration; `pi` has no apply equivalent), else the
 * claude/codex prefix rule on the command's resolved agent token, else
 * Nothing.
 */
function defaultStartWith(
  command: string,
  presetId: string | null,
  presets: CommandPreset[]
): StartWithValue {
  const declared = presets.find((preset) => preset.id === presetId)?.agentType
  if (declared === 'claude') return 'claude'
  if (declared === 'codex') return 'codex'
  if (declared === 'pi') return 'none'
  return autoStartAgentFromToken(resolveAgentToken(command)) ?? 'none'
}

interface NewSessionModalProps {
  isOpen: boolean
  onClose: () => void
  onCreate: (
    projectPath: string,
    name?: string,
    command?: string,
    host?: string,
    autoStartChange?: string,
    autoStartAgent?: AutoStartAgent,
    kind?: 'terminal' | 'chat',
    claudeProfileId?: string,
    approvalPolicy?: ChatApprovalPolicy
  ) => void
  defaultProjectDir: string
  commandPresets: CommandPreset[]
  defaultPresetId: string
  lastProjectPath?: string | null
  activeProjectPath?: string
  remoteHosts?: HostStatus[]
  remoteAllowControl?: boolean
  /** Discovered local worktrees for the compact picker. */
  worktrees?: NewSessionWorktreeOption[]
  /** Pre-fill host for duplicate of remote session */
  initialHost?: string
  /** Pre-fill path (e.g. when duplicating an existing session) */
  initialPath?: string
  /** Pre-fill command (e.g. when duplicating an existing session) */
  initialCommand?: string
  /**
   * OpenSpec change name when opened from a change section: offers the
   * first-prompt ("Start with") selector for the change's apply command.
   */
  initialAutoStartChange?: string
}

export default function NewSessionModal({
  isOpen,
  onClose,
  onCreate,
  defaultProjectDir,
  commandPresets,
  defaultPresetId,
  lastProjectPath,
  activeProjectPath,
  remoteHosts = [],
  remoteAllowControl = false,
  worktrees = [],
  initialHost,
  initialPath,
  initialCommand,
  initialAutoStartChange,
}: NewSessionModalProps) {
  const [projectPath, setProjectPath] = useState('')
  /** Inline refusal for an empty Project Path — Create must never no-op silently. */
  const [projectPathError, setProjectPathError] = useState<string | null>(null)
  /** Seeded with the generic default; every open re-derives it (see `defaultKind`). */
  const [kind, setKind] = useState<'terminal' | 'chat'>(defaultKind())
  const [claudeProfileId, setClaudeProfileId] = useState('default')
  // Auto-approve is seeded from the Settings default on every open (design
  // D2): the checkbox is the deliberate per-session act.
  const defaultApprovalPolicy = useSettingsStore((state) => state.defaultApprovalPolicy)
  const [autoApprove, setAutoApprove] = useState(false)
  // The catalog is resolved for the entered project path: a `.kawai`
  // directory in the project (or above it) extends the picker live.
  const catalog = useClaudeProfiles(isOpen && kind === 'chat', projectPath)
  const [name, setName] = useState('')
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null)
  const [command, setCommand] = useState('')
  const [showBrowser, setShowBrowser] = useState(false)
  const [selectedHost, setSelectedHost] = useState('')
  // First-prompt selector: offered with a change context (a change section's
  // action). Follows command/preset changes until the user picks explicitly.
  const [startWith, setStartWith] = useState<StartWithValue>('none')
  const [startWithTouched, setStartWithTouched] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)
  const projectPathRef = useRef<HTMLInputElement>(null)
  const defaultButtonRef = useRef<HTMLButtonElement>(null)
  const kindSelectRef = useRef<HTMLSelectElement>(null)
  /**
   * The element the dialog focused provisionally at open. The catalog catch-up
   * below may replace it with Create, but only while it is still what has focus
   * — a focus the user moved themselves is never stolen.
   */
  const provisionalFocusRef = useRef<HTMLElement | null>(null)
  /**
   * Whether Create can currently take focus, read by the deferred focus attempt
   * that outlives the render which scheduled it. Create is disabled while the
   * chat profile catalog loads or errors, and a disabled button cannot be
   * focused, so the attempt needs a live answer to pick its fallback.
   */
  const focusStateRef = useRef<{ kind: 'terminal' | 'chat'; createDisabled: boolean }>({
    kind: defaultKind(),
    createDisabled: true,
  })
  /**
   * Whether the dialog is currently in its open state. State initialization
   * must run only on the closed→open transition (and cleanup only on
   * open→closed): this effect's dependencies include values that change while
   * the dialog is open (server-info arriving, presets, active path), and
   * re-initializing on those would silently wipe whatever the user typed.
   */
  const wasOpenRef = useRef(false)

  const showHostPicker = kind === 'terminal' && remoteAllowControl && remoteHosts.length > 0

  useEffect(() => {
    // No open/closed transition: leave the form's live state alone.
    if (isOpen === wasOpenRef.current) return
    wasOpenRef.current = isOpen

    if (!isOpen) {
      // `kind` is deliberately left alone: the next open re-derives it from its
      // own entry point (see `defaultKind`), so a reset here would only record
      // the open that just ended.
      setClaudeProfileId('default')
      setProjectPath('')
      setProjectPathError(null)
      setName('')
      setSelectedPresetId(null)
      setCommand('')
      setShowBrowser(false)
      setSelectedHost(initialHost ?? '')
      setStartWith('none')
      setStartWithTouched(false)
      provisionalFocusRef.current = null
      // Focus terminal after modal closes
      setTimeout(() => {
        if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return
        const textarea = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
        if (textarea) {
          textarea.removeAttribute('disabled')
          textarea.focus()
        }
      }, 300)
      return
    }
    // Disable terminal textarea when modal opens to prevent keyboard capture
    if (typeof document !== 'undefined' && typeof document.querySelector === 'function') {
      const textarea = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
      if (textarea && typeof textarea.setAttribute === 'function') {
        if (typeof textarea.blur === 'function') textarea.blur()
        textarea.setAttribute('disabled', 'true')
      }
    }
    // Initialize state when opening
    setKind(defaultKind(initialAutoStartChange))
    setAutoApprove(defaultApprovalPolicy === 'auto')
    provisionalFocusRef.current = null
    const basePath =
      initialPath?.trim() ||
      activeProjectPath?.trim() ||
      lastProjectPath ||
      defaultProjectDir ||
      ''
    setProjectPath(basePath)
    setProjectPathError(null)
    setName('')
    setSelectedHost(initialHost ?? '')
    setStartWith('none')
    setStartWithTouched(false)
    const trimmedInitialCommand = initialCommand?.trim()
    if (trimmedInitialCommand) {
      const matchingPreset = commandPresets.find((p) => getFullCommand(p) === trimmedInitialCommand)
      if (matchingPreset) {
        setSelectedPresetId(matchingPreset.id)
        setCommand(getFullCommand(matchingPreset))
      } else {
        setSelectedPresetId(null)
        setCommand(trimmedInitialCommand)
      }
    } else {
      // Select default preset and set full command
      const defaultPreset = commandPresets.find(p => p.id === defaultPresetId)
      if (defaultPreset) {
        setSelectedPresetId(defaultPresetId)
        setCommand(getFullCommand(defaultPreset))
      } else if (commandPresets.length > 0) {
        setSelectedPresetId(commandPresets[0].id)
        setCommand(getFullCommand(commandPresets[0]))
      } else {
        setSelectedPresetId(null)
        setCommand('')
      }
    }
    // Provisional focus after DOM update: the dialog's primary action (the
    // active command-preset chip for Terminal, Create for chat) when it can
    // take focus, otherwise the always-enabled session-kind select. Whichever
    // lands is recorded as provisional so the catalog catch-up can promote it.
    const focusBeforeAttempt = typeof document === 'undefined' ? null : document.activeElement
    setTimeout(() => {
      // This attempt is deferred, so it can arrive after the user has already
      // picked a control of their own — inside the form or out of it, such as
      // the directory browser that sits outside the form. Take focus only while
      // nothing meaningful holds it (or the opener still does); anything else is
      // theirs. Leaving `provisionalFocusRef` unset then also keeps the catalog
      // catch-up from promoting onto them later.
      const activeElement = typeof document === 'undefined' ? null : document.activeElement
      const userHasFocus =
        !!activeElement && activeElement !== document.body && activeElement !== focusBeforeAttempt
      if (!userHasFocus) {
        const { kind: currentKind, createDisabled } = focusStateRef.current
        const target =
          currentKind === 'chat' && createDisabled
            ? kindSelectRef.current
            : (defaultButtonRef.current ?? kindSelectRef.current)
        target?.focus()
        provisionalFocusRef.current = target ?? null
      }
      if (projectPathRef.current) {
        const input = projectPathRef.current
        input.scrollLeft = input.scrollWidth
      }
    }, 50)
  }, [activeProjectPath, commandPresets, defaultPresetId, defaultProjectDir, defaultApprovalPolicy, isOpen, lastProjectPath, initialHost, initialPath, initialCommand, initialAutoStartChange])

  // Keep the deferred focus attempt's view of Create current; that attempt is
  // scheduled once per open and reads this after the catalog has moved on.
  useEffect(() => {
    focusStateRef.current = {
      kind,
      createDisabled: kind === 'chat' && (catalog.loading || !!catalog.error),
    }
  })

  // Provisional-focus catch-up. Create cannot take focus while the chat
  // profile catalog loads, so the open attempt settles for the kind select;
  // once the catalog settles, promote that provisional focus to Create — but
  // only while it is still what has focus. A focus the user moved themselves
  // never matches the provisional ref, so it is never stolen.
  useEffect(() => {
    if (!isOpen || kind !== 'chat') return
    if (catalog.loading || !!catalog.error) return
    const provisional = provisionalFocusRef.current
    if (!provisional) return
    if (typeof document !== 'undefined' && document.activeElement !== provisional) return
    const create = defaultButtonRef.current
    if (!create) return
    create.focus()
    provisionalFocusRef.current = create
  }, [isOpen, kind, catalog.loading, catalog.error])

  // The first-prompt default follows command and preset changes until the
  // user selects a value explicitly, after which their choice sticks.
  useEffect(() => {
    if (!isOpen || !initialAutoStartChange || startWithTouched) return
    setStartWith(defaultStartWith(command, selectedPresetId, commandPresets))
  }, [isOpen, initialAutoStartChange, startWithTouched, command, selectedPresetId, commandPresets])

  useEffect(() => {
    if (!isOpen) return
    if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return

    const getFocusableElements = () => {
      if (!formRef.current) return []
      const selector =
        'input:not([disabled]), select:not([disabled]), button:not([disabled]):not([tabindex="-1"]), [tabindex="0"]'
      return Array.from(formRef.current.querySelectorAll<HTMLElement>(selector))
    }

      const handleKeyDown = (e: KeyboardEvent) => {
      if (showBrowser) return

      if (e.key === 'Escape') {
        if (typeof e.stopPropagation === 'function') e.stopPropagation()
        onClose()
        return
      }

      if (e.key === 'Enter') {
        const activeEl = document.activeElement as HTMLElement | null
        if (!activeEl) return
        if (activeEl.tagName === 'INPUT') return
        // Don't auto-submit from the host picker; Enter should only select the host chip.
        if (activeEl.closest('[data-testid="host-select"]')) return
        // Preserve the "Enter submits" behavior when focus is on command preset chips.
        if (!activeEl.closest('[data-testid="command-select"]')) return

        e.preventDefault()
        if (typeof e.stopPropagation === 'function') e.stopPropagation()
        formRef.current?.requestSubmit()
        return
      }

      if (e.key === 'Tab') {
        e.preventDefault()
        if (typeof e.stopPropagation === 'function') e.stopPropagation()
        const focusableElements = getFocusableElements()
        if (focusableElements.length === 0) return

        const activeEl = document.activeElement as HTMLElement
        const currentIndex = focusableElements.indexOf(activeEl)

        let nextIndex: number
        if (currentIndex === -1) {
          // If current element not in list, start from beginning or end
          nextIndex = e.shiftKey ? focusableElements.length - 1 : 0
        } else if (e.shiftKey) {
          nextIndex = currentIndex <= 0 ? focusableElements.length - 1 : currentIndex - 1
        } else {
          nextIndex = currentIndex >= focusableElements.length - 1 ? 0 : currentIndex + 1
        }

        focusableElements[nextIndex]?.focus()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose, showBrowser])

  if (!isOpen) {
    return null
  }

  const handlePresetSelect = (presetId: string) => {
    const preset = commandPresets.find(p => p.id === presetId)
    if (preset) {
      setSelectedPresetId(presetId)
      setCommand(getFullCommand(preset))
    }
  }

  const handleCustomSelect = () => {
    setSelectedPresetId(null)
    setCommand('')
  }

  const isCustomMode = selectedPresetId === null
  const isRemoteHost = kind === 'terminal' && selectedHost !== ''

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault()
    const trimmedPath = projectPath.trim()
    if (!trimmedPath) {
      // Refuse in place with a visible reason: a silent return leaves the user
      // staring at a Create button that appears to do nothing (§ chat create).
      setProjectPathError('Enter a project path to create the session.')
      projectPathRef.current?.focus()
      return
    }
    setProjectPathError(null)
    if (kind === 'chat') {
      if (catalog.loading || catalog.error || !catalog.profiles.some(profile => profile.id === claudeProfileId)) return
      onCreate(trimmedPath, name.trim() || undefined, undefined, undefined, undefined, undefined, 'chat', claudeProfileId, autoApprove ? 'auto' : 'manual')
      onClose()
      return
    }

    const finalCommand = command.trim()
    // First-prompt selection applies to every host: the server composes the
    // mapped apply command into the start command as a launch argument, so
    // remote creation needs no local terminal-input path.
    const startWithAgent = startWith !== 'none' ? startWith : undefined
    onCreate(
      trimmedPath,
      name.trim() || undefined,
      finalCommand || undefined,
      isRemoteHost ? selectedHost : undefined,
      initialAutoStartChange && startWithAgent ? initialAutoStartChange : undefined,
      startWithAgent
    )
    onClose()
  }

  // Build button list: presets + Custom
  const allOptions = [
    ...commandPresets.map(p => ({ id: p.id, label: p.label, isCustom: false, agentType: p.agentType, command: p.command })),
    { id: 'custom', label: 'Custom', isCustom: true, agentType: undefined, command: undefined },
  ]

  const hostOptions = [
    { id: '', label: 'Local', ok: true, error: undefined },
    ...remoteHosts.map((hostStatus) => ({
      id: hostStatus.host,
      label: hostStatus.host,
      ok: hostStatus.ok,
      error: hostStatus.error,
    })),
  ]

  const browserInitialPath = projectPath.trim() || '~'

  // The picker mirrors the path input: it shows the worktree whose path the
  // input currently holds (e.g. preselected from a worktree header action)
  // and falls back to the placeholder for manual or edited paths.
  const showWorktreePicker = worktrees.length > 0 && !isRemoteHost
  const selectedWorktreeId =
    worktrees.find((worktree) => worktree.path === projectPath.trim())?.worktreeId ?? ''

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-session-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <form
        ref={formRef}
        onSubmit={handleSubmit}
        className="w-full max-w-md border border-border bg-elevated p-6"
      >
        <h2 id="new-session-title" className="text-sm font-semibold uppercase tracking-wider text-primary text-balance">
          New Session
        </h2>

        <div className="mt-4 space-y-4">
          <label className="block text-xs text-secondary">
            Session kind
            <select ref={kindSelectRef} aria-label="Session kind" className="input mt-1.5" value={kind}
              onChange={event => setKind(event.target.value as 'terminal' | 'chat')}>
              <option value="terminal">Terminal</option>
              <option value="chat">Claude chat</option>
            </select>
          </label>
          {kind === 'chat' && <div>
            <label className="block text-xs text-secondary">Profile
              <select aria-label="Profile" className="input mt-1.5" value={claudeProfileId}
                disabled={catalog.loading || !!catalog.error}
                onChange={event => setClaudeProfileId(event.target.value)}>
                {catalog.profiles.map(profile => <option key={profile.id} value={profile.id}>{profile.label}</option>)}
              </select>
            </label>
            {catalog.loading && <p className="mt-1 text-xs text-secondary">Loading profiles…</p>}
            {catalog.error && <div className="mt-1 text-xs text-red-400">
              <p role="alert">{catalog.error}</p>
              <button type="button" className="btn mt-1" onClick={catalog.retry}>Retry profiles</button>
            </div>}
            {catalog.warnings.map(warning => <p key={warning} role="status" className="mt-1 text-xs text-amber-400">{warning}</p>)}
            <label className="mt-3 flex items-center gap-2 text-xs text-secondary">
              <input
                type="checkbox"
                aria-label="Auto-approve tools"
                data-testid="chat-auto-approve"
                checked={autoApprove}
                onChange={(event) => setAutoApprove(event.target.checked)}
              />
              Auto-approve tools
            </label>
            <p className="mt-1 text-[10px] text-muted">
              Tools run without asking for this session. Change it anytime from the chat header.
            </p>
          </div>}
          {showHostPicker && (
            <div>
              <label className="mb-1.5 block text-xs text-secondary">
                Host
              </label>
              <div
                className="flex flex-wrap gap-2"
                role="radiogroup"
                aria-label="Host"
                data-testid="host-select"
              >
                {hostOptions.map((option, index) => {
                  const isActive = selectedHost === option.id
                  const isMuted = !option.ok && !isActive
                  return (
                    <button
                      key={option.id || 'local'}
                      type="button"
                      role="radio"
                      aria-checked={isActive}
                      aria-label={option.label}
                      title={!option.ok ? (option.error || 'Unreachable') : undefined}
                      tabIndex={isActive ? 0 : -1}
                      onClick={() => setSelectedHost(option.id)}
                      onKeyDown={(e) => {
                        let newIndex = index
                        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                          e.preventDefault()
                          newIndex = (index + 1) % hostOptions.length
                        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                          e.preventDefault()
                          newIndex = (index - 1 + hostOptions.length) % hostOptions.length
                        } else {
                          return
                        }
                        const next = hostOptions[newIndex]
                        setSelectedHost(next.id)
                        const container = e.currentTarget.parentElement
                        const buttons = container?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
                        buttons?.[newIndex]?.focus()
                      }}
                      className={`btn text-xs focus:outline-none focus:ring-2 focus:ring-primary ${isActive ? 'btn-primary' : ''} ${isMuted ? 'opacity-60' : ''}`}
                    >
                      {option.label}
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {kind === 'terminal' && <div>
            <label className="mb-1.5 block text-xs text-secondary">
              Command
            </label>
            <div
              className="flex flex-wrap gap-2"
              role="radiogroup"
              aria-label="Command preset"
              data-testid="command-select"
            >
              {allOptions.map((option, index) => {
                const isActive = option.isCustom ? isCustomMode : selectedPresetId === option.id
                return (
                  <button
                    key={option.id}
                    ref={isActive ? defaultButtonRef : undefined}
                    type="button"
                    role="radio"
                    aria-checked={isActive}
                    tabIndex={isActive ? 0 : -1}
                    onClick={() => {
                      if (option.isCustom) {
                        handleCustomSelect()
                      } else {
                        handlePresetSelect(option.id)
                      }
                    }}
                    onKeyDown={(e) => {
                      let newIndex = index
                      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
                        e.preventDefault()
                        newIndex = (index + 1) % allOptions.length
                      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
                        e.preventDefault()
                        newIndex = (index - 1 + allOptions.length) % allOptions.length
                      } else {
                        return
                      }
                      const newOption = allOptions[newIndex]
                      if (newOption.isCustom) {
                        handleCustomSelect()
                      } else {
                        handlePresetSelect(newOption.id)
                      }
                      const container = e.currentTarget.parentElement
                      const buttons = container?.querySelectorAll<HTMLButtonElement>('[role="radio"]')
                      buttons?.[newIndex]?.focus()
                    }}
                    className={`btn text-xs focus:outline-none focus:ring-2 focus:ring-primary ${isActive ? 'btn-primary' : ''}`}
                  >
                    <AgentIcon agentType={option.agentType} command={option.command} className="inline-block h-3.5 w-3.5 shrink-0" />
                    {option.label}
                  </button>
                )
              })}
            </div>

            {/* Full command input */}
            <input
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              placeholder="Enter command..."
              className="input mt-2 font-mono text-xs"
            />
          </div>}
          <div>
            <label className="mb-1.5 block text-xs text-secondary">
              Project Path
            </label>
            <div className="flex gap-2">
              <input
                ref={projectPathRef}
                value={projectPath}
                onChange={(event) => {
                  setProjectPath(event.target.value)
                  setProjectPathError(null)
                }}
                aria-invalid={projectPathError !== null ? 'true' : undefined}
                placeholder={
                  isRemoteHost
                    ? '/home/user/project'
                    : activeProjectPath ||
                      lastProjectPath ||
                      defaultProjectDir ||
                      '/Users/you/code/my-project'
                }
                className="input flex-1 text-sm"
              />
              {!isRemoteHost && (
                <button
                  type="button"
                  className="btn"
                  onClick={() => setShowBrowser(true)}
                >
                  Browse
                </button>
              )}
            </div>
            {projectPathError !== null ? (
              <p
                role="alert"
                className="mt-1 text-xs text-red-500"
                data-testid="project-path-error"
              >
                {projectPathError}
              </p>
            ) : null}
            {showWorktreePicker && (
              <select
                data-testid="worktree-picker"
                aria-label="Discovered worktrees"
                className="input mt-2 text-xs"
                value={selectedWorktreeId}
                onChange={(event) => {
                  const worktree = worktrees.find(
                    (option) => option.worktreeId === event.target.value
                  )
                  if (worktree) {
                    setProjectPath(worktree.path)
                    setProjectPathError(null)
                  }
                }}
              >
                <option value="">Discovered worktrees…</option>
                {worktrees.map((worktree) => (
                  <option key={worktree.worktreeId} value={worktree.worktreeId}>
                    {worktreeOptionLabel(worktree)}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div>
            <label className="mb-1.5 block text-xs text-secondary">
              Display Name
            </label>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="auto-generated"
              className="input text-sm placeholder:italic"
            />
          </div>
          {kind === 'terminal' && initialAutoStartChange && (
            <div>
              <label className="mb-1.5 block text-xs text-secondary">
                Start with
              </label>
              <select
                data-testid="start-with-select"
                aria-label="First prompt for the change's apply command"
                className="input text-xs"
                value={startWith}
                title={`The selected prompt is composed into the session's start command as a launch argument — the agent holds its first prompt until it is ready, so it survives trust and sign-in gates. Nothing is sent as terminal input.`}
                onChange={(event) => {
                  setStartWith(event.target.value as StartWithValue)
                  setStartWithTouched(true)
                }}
              >
                <option value="claude">Claude - /opsx:apply {initialAutoStartChange}</option>
                <option value="codex">Codex - $openspec-apply-change {initialAutoStartChange}</option>
                <option value="none">Nothing</option>
              </select>
            </div>
          )}
        </div>

        <div className="mt-6 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn">
            Cancel
          </button>
          <button
            ref={kind === 'chat' ? defaultButtonRef : undefined}
            type="submit"
            className="btn btn-primary"
            disabled={kind === 'chat' && (catalog.loading || !!catalog.error)}
          >
            Create
          </button>
        </div>
      </form>
      {showBrowser && !isRemoteHost && (
        <DirectoryBrowser
          initialPath={browserInitialPath}
          onSelect={(path) => {
            setProjectPath(path)
            setProjectPathError(null)
            setShowBrowser(false)
          }}
          onCancel={() => setShowBrowser(false)}
        />
      )}
    </div>
  )
}
