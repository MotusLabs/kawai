// The chat view header (chat-header-layout D1, team-workspace-pages 4.1,
// chat-transcript-layout D4), in up to three rows: identity and actions (status,
// the click-to-rename name, one **Team** button that opens the Team page for
// the chat's team on the tab last used — Tasks the first time — the
// Auto-approve switch, amber while on and shown for live chats at every width,
// and the session menu: Rename, Debug, Archive, and Kill session, which asks
// first); supporting metadata (profile, reported model, project basename with
// the full path on hover and to assistive technology, and the context meter at
// the trailing edge); and, only when present, the task and paused context. Every
// row wraps instead of clipping: long values break inside themselves and a very
// narrow header moves the action group below the name. The side slot hosts only
// the debug panel; the task chip opens its task on the Team page. As the header
// narrows (measured in chat-font ems, useHeaderLayout) the Team button drops to
// an icon, then folds into the session menu while the context meter shows only
// its percentage. It renders from props only — the WebSocket subscription
// effects stay in ChatView, which owns the attach lifecycle — and keeps the
// in-place rename state (chat-session-naming): a blank submit just exits
// editing, and the draft follows broadcast renames while not being edited, so
// another client's rename shows without a reload. The context meter is hidden
// until the first model request; archived chats keep the stored reading and
// hide the approval and archive controls.
import { useEffect, useRef, useState } from 'react'
import type { ChatContextUsage } from '@shared/chat'
import type { Session } from '@shared/types'
import type { ConnectionStatus } from '../../stores/sessionStore'
import { parkedLabel } from '../../utils/parkedLabel'
import { contextExhaustedLabel } from '../../utils/contextExhaustedLabel'
import { chatStatusIndicator } from '../../utils/sessionStatus'
import { useHeaderLayout, type HeaderLayout } from '../../hooks/useHeaderLayout'
import Users01Icon from '@untitledui-icons/react/line/esm/Users01Icon'
import { Switch } from '../Switch'
import ChatContextMeter from './ChatContextMeter'
import ChatKillDialog from './ChatKillDialog'
import ChatSessionMenu, { sessionMenuEntries } from './ChatSessionMenu'

export interface ChatHeaderProps {
  session: Session
  profileLabel: string
  /** The model's provider's label (design D13); shown before the model label. */
  providerLabel: string
  model: string | null
  contextUsage: ChatContextUsage | null
  connectionStatus: ConnectionStatus
  /** Whether the debug panel occupies the side slot (the session menu shows it). */
  debugOpen: boolean
  onToggleDebug: () => void
  /** Opens the Team page for the chat's team (the Team button). */
  onOpenTeam: () => void
  /** Opens the Team page's Tasks tab with one task (the task chip). */
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
  session, profileLabel, providerLabel, model, contextUsage, connectionStatus, debugOpen,
  onToggleDebug, onOpenTeam, onOpenTask, onRename, onToggleApproval, onArchive, onKill, onClose, fontSizePx = 15, layout: forcedLayout,
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
    archived, debugOpen, foldTeam: layout === 'menu', onOpenTeam, onRename: () => setEditingName(true), onToggleDebug,
    onArchive, onKill: () => setKillFor(session.id),
  })
  return (
    <header ref={headerRef} className="flex flex-col gap-y-1.5 border-b border-border p-3" data-layout={layout}>
      {/* Row 1, identity and actions (chat-transcript-layout D4): the name takes
          the flexible space; on a very narrow header the action group wraps
          below it rather than squeezing it. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2" data-testid="chat-identity-row">
        <button className="btn text-chat-meta md:hidden" onClick={onClose}>Sessions</button>
        <div className="flex min-w-[12em] flex-1 items-center gap-2">
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
        <div className="ml-auto flex shrink-0 items-center gap-x-3" data-testid="chat-actions">
          {layout !== 'menu' && (
            <button type="button" className={`btn text-chat-meta ${iconsOnly(layout) ? 'px-2' : ''}`}
              data-testid="chat-team-button" onClick={onOpenTeam}
              {...(iconsOnly(layout) ? { 'aria-label': 'Team', title: 'Team' } : {})}>
              {iconsOnly(layout)
                ? <Users01Icon aria-hidden="true" className="h-4 w-4" />
                : <span className="flex items-center gap-1.5"><Users01Icon aria-hidden="true" className="h-4 w-4" />Team</span>}
            </button>
          )}
          {!archived && (
            <label className={`flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap text-chat-meta ${autoApprove ? 'text-approval' : 'text-secondary'}`}>
              <Switch checked={autoApprove} onCheckedChange={onToggleApproval} ariaLabel="Auto-approve" testId="chat-approval-policy"
                className="data-[checked]:bg-approval" />
              <span aria-hidden="true">Auto-approve</span>
            </label>
          )}
          {/* Keyed by session so an open menu closes on a chat switch. */}
          <ChatSessionMenu key={session.id} entries={menuEntries} container={headerRef} />
        </div>
      </div>
      {/* Row 2, supporting metadata: each field wraps and long tokens break
          inside themselves; the context meter takes the trailing edge when it
          fits, else its own line. */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-chat-meta text-secondary">
        <p className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5" data-testid="chat-identity">
          {/* Provider and model labels (D13): one label when they are equal. */}
          <span className="min-w-0 [overflow-wrap:anywhere]" data-testid="chat-profile"
            title={profileLabel === providerLabel ? `Profile: ${profileLabel}` : `Provider: ${providerLabel} · Profile: ${profileLabel}`}>
            {profileLabel === providerLabel ? profileLabel : `${providerLabel} · ${profileLabel}`}
          </span>
          {model && <>
            <span aria-hidden="true">·</span>
            <span className="min-w-0 [overflow-wrap:anywhere]" data-testid="chat-model" title={`Model reported by the agent: ${model}`}>{model}</span>
          </>}
          <span aria-hidden="true">·</span>
          <span className="min-w-0 [overflow-wrap:anywhere]" data-testid="chat-project" title={session.projectPath}>
            {projectName(session.projectPath)}<span className="sr-only"> ({session.projectPath})</span>
          </span>
        </p>
        <span className="ml-auto"><ChatContextMeter usage={contextUsage} compact={layout === 'menu'} /></span>
      </div>
      {/* Row 3, task, paused, and exhausted context: only when present, wrapping in full. */}
      {(session.taskId || session.parked || session.contextExhausted) && (
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-chat-meta" data-testid="chat-context-row">
          {session.taskId && <span className="min-w-0 rounded border border-border px-1.5 [overflow-wrap:anywhere]" data-testid="chat-task-chip">
            {session.spawned ? 'Spawned for task ' : 'Task '}
            <button className="text-left hover:underline" data-testid="chat-task" onClick={() => onOpenTask(session.taskId!)}>{session.taskTitle ?? session.taskId}</button>
          </span>}
          {session.parked && <span className="min-w-0 rounded border border-border px-1.5 text-amber-600 [overflow-wrap:anywhere]" data-testid="chat-paused">{parkedLabel(session.parked)}</span>}
          {session.contextExhausted && <span className="min-w-0 rounded border border-border px-1.5 text-red-600 [overflow-wrap:anywhere]" data-testid="chat-exhausted">{contextExhaustedLabel(session.contextExhausted)}</span>}
        </div>
      )}
      <ChatKillDialog open={killOpen} name={session.name} container={headerRef}
        onOpenChange={open => setKillFor(open ? session.id : null)} onConfirm={() => { if (killOpen) onKill() }} />
    </header>
  )
}

const iconsOnly = (layout: HeaderLayout) => layout === 'icons'
