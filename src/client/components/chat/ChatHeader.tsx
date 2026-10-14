// The chat view header (chat-header-layout D1): the session's identity and
// status, the side-panel switcher, the Auto-approve switch (amber while on,
// shown for live chats at every width), and the session menu (Rename, Debug,
// Archive, and Kill session, which asks for confirmation first). As the
// header narrows (measured in chat-font ems, D6) the switcher drops to icons,
// then folds into the session menu while the context meter shows only its
// percentage; the name, status, switch, and menu always stay visible. It renders from props only — the WebSocket subscription
// effects for each side panel stay in ChatView, which owns the attach
// lifecycle — and keeps the in-place rename state (chat-session-naming): a
// blank submit just exits editing, and the draft follows broadcast renames
// while not being edited, so another client's rename shows without a reload.
// The context meter sits beside the session status, hidden until the first
// model request; archived chats keep the stored reading and hide the
// approval and archive controls.
import { useEffect, useRef, useState } from 'react'
import type { ChatContextUsage } from '@shared/chat'
import type { Session } from '@shared/types'
import type { ConnectionStatus } from '../../stores/sessionStore'
import { parkedLabel } from '../../utils/parkedLabel'
import { chatStatusIndicator } from '../../utils/sessionStatus'
import { useHeaderLayout, type HeaderLayout } from '../../hooks/useHeaderLayout'
import { Switch } from '../Switch'
import ChatContextMeter from './ChatContextMeter'
import ChatKillDialog from './ChatKillDialog'
import ChatPanelSwitcher from './ChatPanelSwitcher'
import ChatSessionMenu, { sessionMenuEntries } from './ChatSessionMenu'
import type { SideSlot } from './sideSlot'

export interface ChatHeaderProps {
  session: Session
  profileLabel: string
  model: string | null
  contextUsage: ChatContextUsage | null
  connectionStatus: ConnectionStatus
  openSlot: SideSlot | null
  onToggleSlot: (slot: SideSlot) => void
  onOpenTask: (taskId: string) => void
  onRename: (name: string) => void
  onToggleApproval: () => void
  onArchive: () => void
  onKill: () => void
  onClose: () => void
  /** Chat font size in px; the width steps are measured in these ems. */
  fontSizePx?: number
  /** Forces a layout instead of measuring the header (tests). */
  layout?: HeaderLayout
}

/** The project's last path segment; the full path rides in the title. */
export function projectName(projectPath: string): string {
  return projectPath.split('/').filter(Boolean).at(-1) ?? projectPath
}

export default function ChatHeader({
  session, profileLabel, model, contextUsage, connectionStatus, openSlot,
  onToggleSlot, onOpenTask, onRename, onToggleApproval, onArchive, onKill, onClose, fontSizePx = 15, layout: forcedLayout,
}: ChatHeaderProps) {
  const archived = session.archivedAt != null
  const autoApprove = session.approvalPolicy === 'auto'
  const status = chatStatusIndicator(session.status, connectionStatus, archived)
  const [editingName, setEditingName] = useState(false)
  const [nameDraft, setNameDraft] = useState(session.name)
  useEffect(() => { setEditingName(false); setNameDraft(session.name) }, [session.id])
  useEffect(() => { if (!editingName) setNameDraft(session.name) }, [session.name, editingName])
  const submitName = () => {
    const trimmed = nameDraft.trim()
    setEditingName(false)
    if (trimmed && trimmed !== session.name) onRename(trimmed)
  }
  const handleNameKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      submitName()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setNameDraft(session.name)
      setEditingName(false)
    }
  }
  const headerRef = useRef<HTMLElement>(null)
  const measuredLayout = useHeaderLayout(headerRef, fontSizePx)
  const layout = forcedLayout ?? measuredLayout
  // The kill confirmation belongs to the session it was opened for: switching
  // chats (e.g. the next-session shortcut) closes it, and it never shows, or
  // confirms for, another session's name or kill callback.
  const [killFor, setKillFor] = useState<string | null>(null)
  useEffect(() => { setKillFor(null) }, [session.id])
  const killOpen = killFor === session.id
  const menuEntries = sessionMenuEntries({
    archived, openSlot, foldPanels: layout === 'menu', onRename: () => setEditingName(true), onToggleSlot,
    onArchive, onKill: () => setKillFor(session.id),
  })
  return (
    <header ref={headerRef} className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border p-3" data-layout={layout}>
      <button className="btn text-chat-meta md:hidden" onClick={onClose}>Sessions</button>
      <div className="min-w-[8em] flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex shrink-0 items-center gap-1.5 text-chat-meta text-secondary">
            <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${status.dot}`} data-testid="chat-status-dot" />
            <span data-testid="chat-status">{status.word}</span>
          </span>
          {editingName ? (
            <input data-testid="chat-name-input" autoFocus aria-label="Session name"
              className="min-w-0 flex-1 rounded border border-border bg-surface px-1.5 py-0.5 text-chat-body font-medium text-primary outline-none focus:border-accent"
              value={nameDraft} onChange={event => setNameDraft(event.target.value)}
              onBlur={submitName} onKeyDown={handleNameKeyDown} />
          ) : (
            <h2 className="min-w-[4ch] cursor-text truncate text-chat-body font-medium" title={`${session.name} — click to rename`}
              data-testid="chat-name" onClick={() => setEditingName(true)}>{session.name}</h2>
          )}
        </div>
        <p className="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-chat-meta text-secondary" data-testid="chat-identity">
          <span className="shrink-0" data-testid="chat-profile" title={`Profile: ${profileLabel}`}>{profileLabel}</span>
          {model && <>
            <span aria-hidden="true">·</span>
            <span className="min-w-0 truncate" data-testid="chat-model" title={`Model reported by the agent: ${model}`}>{model}</span>
          </>}
          <span aria-hidden="true">·</span>
          <span className="min-w-0 truncate" data-testid="chat-project" title={session.projectPath}>{projectName(session.projectPath)}</span>
          {session.taskId && <span className="min-w-0 truncate rounded border border-border px-1.5" data-testid="chat-task-chip">
            {session.spawned ? 'Spawned for task ' : 'Task '}
            <button className="hover:underline" data-testid="chat-task" onClick={() => onOpenTask(session.taskId!)}>{session.taskTitle ?? session.taskId}</button>
          </span>}
          {session.parked && <span className="min-w-0 truncate rounded border border-border px-1.5 text-amber-600" data-testid="chat-paused">{parkedLabel(session.parked)}</span>}
        </p>
      </div>
      <ChatContextMeter usage={contextUsage} compact={layout === 'menu'} />
      {layout !== 'menu' && <ChatPanelSwitcher openSlot={openSlot} onToggle={onToggleSlot} iconsOnly={layout === 'icons'} />}
      {!archived && (
        <label className={`flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap text-chat-meta ${autoApprove ? 'text-approval' : 'text-secondary'}`}>
          <Switch checked={autoApprove} onCheckedChange={onToggleApproval} ariaLabel="Auto-approve" testId="chat-approval-policy"
            className="data-[checked]:bg-approval" />
          <span aria-hidden="true">Auto-approve</span>
        </label>
      )}
      {/* Keyed by session so an open menu closes on a chat switch. */}
      <ChatSessionMenu key={session.id} entries={menuEntries} container={headerRef} />
      <ChatKillDialog open={killOpen} name={session.name} container={headerRef}
        onOpenChange={open => setKillFor(open ? session.id : null)} onConfirm={() => { if (killOpen) onKill() }} />
    </header>
  )
}
