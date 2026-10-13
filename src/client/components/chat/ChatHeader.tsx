// The chat view header (chat-header-layout D1): the session's identity and
// status, the side-panel toggles, the approval-policy control, and the
// session actions. It renders from props only — the WebSocket subscription
// effects for each side panel stay in ChatView, which owns the attach
// lifecycle — and keeps the in-place rename state (chat-session-naming): a
// blank submit just exits editing, and the draft follows broadcast renames
// while not being edited, so another client's rename shows without a reload.
// The context meter sits beside the session status, hidden until the first
// model request; archived chats keep the stored reading and hide the
// approval and archive controls.
import { useEffect, useState } from 'react'
import type { ChatContextUsage } from '@shared/chat'
import type { Session } from '@shared/types'
import type { ConnectionStatus } from '../../stores/sessionStore'
import { parkedLabel } from '../../utils/parkedLabel'
import ChatContextMeter from './ChatContextMeter'
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
}

export default function ChatHeader({
  session, profileLabel, model, contextUsage, connectionStatus, openSlot,
  onToggleSlot, onOpenTask, onRename, onToggleApproval, onArchive, onKill, onClose,
}: ChatHeaderProps) {
  const connected = connectionStatus === 'connected'
  const archived = session.archivedAt != null
  const autoApprove = session.approvalPolicy === 'auto'
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
  const slotButton = (slot: SideSlot, label: string) => (
    <button className={`btn text-chat-meta ${openSlot === slot ? 'btn-primary' : ''}`} aria-pressed={openSlot === slot}
      onClick={() => onToggleSlot(slot)}>{label}</button>
  )
  return (
    <header className="flex items-center gap-3 border-b border-border p-3">
      <button className="btn text-chat-meta md:hidden" onClick={onClose}>Sessions</button>
      <div className="min-w-0 flex-1">
        {editingName ? (
          <input data-testid="chat-name-input" autoFocus aria-label="Session name"
            className="w-full rounded border border-border bg-surface px-1.5 py-0.5 text-chat-body font-medium text-primary outline-none focus:border-accent"
            value={nameDraft} onChange={event => setNameDraft(event.target.value)}
            onBlur={submitName} onKeyDown={handleNameKeyDown} />
        ) : (
          <h2 className="cursor-text truncate text-chat-body font-medium" title="Rename"
            data-testid="chat-name" onClick={() => setEditingName(true)}>{session.name} · Chat</h2>
        )}
        <p className="text-chat-meta text-secondary" data-testid="chat-profile">Profile: {profileLabel}</p>
        {session.taskId && <p className="truncate text-chat-meta text-secondary">
          {session.spawned ? 'Spawned for task ' : 'Task '}
          <button className="hover:underline" data-testid="chat-task" onClick={() => onOpenTask(session.taskId!)}>{session.taskTitle ?? session.taskId}</button>
        </p>}
        {session.parked && <p className="truncate text-chat-meta text-amber-600" data-testid="chat-paused">{parkedLabel(session.parked)}</p>}
        <p className="truncate text-chat-meta text-secondary">{session.projectPath}</p></div>
      <span className="text-chat-meta text-secondary" data-testid="chat-status">{connected ? (archived ? 'archived' : session.status) : connectionStatus}</span>
      {model && (
        <span
          className="shrink-0 whitespace-nowrap text-chat-meta text-secondary"
          data-testid="chat-model"
          title={`Model reported by the agent: ${model}`}
        >
          {model}
        </span>
      )}
      <ChatContextMeter usage={contextUsage} />
      {slotButton('debug', 'Debug')}
      {slotButton('mailbox', 'Mailbox')}
      {slotButton('tasks', 'Tasks')}
      {slotButton('messages', 'Messages')}
      {slotButton('strategy', 'Strategy')}
      {!archived && <button className={`btn text-chat-meta ${autoApprove ? 'btn-approval-on' : ''}`} aria-pressed={autoApprove}
        onClick={onToggleApproval} data-testid="chat-approval-policy">Auto-approve</button>}
      {!archived && <button className="btn text-chat-meta" onClick={onArchive} data-testid="chat-archive-button">Archive</button>}
      <button className="btn text-chat-meta" onClick={onKill}>Kill session</button>
    </header>
  )
}
