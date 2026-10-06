// ArchiveRows.tsx - Rows of the Archive pane as one list in the view model's
// order (newest first by archive time or last activity): archived chats,
// hibernating terminals, and history interleave instead of grouping by kind.
// Hibernating and history rows follow the persisted visibility toggles from
// the Archive header; history keeps its shared "Show more" pagination.
// Archived chat rows reuse the sortable row for its menu and action gating,
// with dragging disabled — manual reorder has no meaning in Archive. No
// AnimatePresence here: it would keep hidden plain (non-motion) dormant rows
// mounted waiting for an exit animation that never completes.

import { DndContext } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import type { GroupedSessionEntry } from '../utils/workspaceView'
import type { GroupedRowContext } from './WorkspaceSectionList'
import HibernatingSessionItem from './HibernatingSessionItem'
import HistorySessionItem from './HistorySessionItem'
import { SortableSessionItem } from './SessionRow'

interface ArchiveRowsProps {
  entries: GroupedSessionEntry[]
  ctx: GroupedRowContext
  /** Remounts AnimatePresence children when filters change (entry animation). */
  remountKey: string
  showHibernating: boolean
  showHistory: boolean
  /** Shared history pagination: at most this many history rows render. */
  historyLimit: number
  onShowMoreHistory: () => void
}

export default function ArchiveRows({
  entries,
  ctx,
  remountKey,
  showHibernating,
  showHistory,
  historyLimit,
  onShowMoreHistory,
}: ArchiveRowsProps) {
  const liveIds = entries.flatMap((entry) =>
    entry.kind === 'live' && entry.liveSession ? [entry.liveSession.id] : []
  )
  let historyShown = 0
  let historyHidden = 0
  const visible = entries.filter((entry) => {
    if (entry.kind === 'hibernating') return showHibernating
    if (entry.kind === 'history') {
      if (!showHistory) return false
      if (historyShown >= historyLimit) {
        historyHidden += 1
        return false
      }
      historyShown += 1
    }
    return true
  })
  if (visible.length === 0 && historyHidden === 0) return null

  return (
    <DndContext>
      <SortableContext items={liveIds} strategy={verticalListSortingStrategy}>
        <div key={remountKey} className="py-1" data-testid="archive-rows">
          {visible.map((entry) => {
            if (entry.kind === 'live' && entry.liveSession) {
              const session = entry.liveSession
              return (
                <SortableSessionItem
                  key={entry.key}
                  session={session}
                  isNew={ctx.isNew(session.id)}
                  exitDuration={ctx.exitDuration}
                  prefersReducedMotion={ctx.prefersReducedMotion}
                  useSafariLayoutFallback={ctx.useSafariLayoutFallback}
                  isSelected={session.id === ctx.selectedSessionId}
                  isEditing={session.id === ctx.editingSessionId}
                  showSessionIdPrefix={ctx.showSessionIdPrefix}
                  showProjectName={ctx.showProjectName}
                  showLastUserMessage={ctx.showLastUserMessage}
                  showHostInfo={ctx.showHostInfo}
                  dropIndicator={null}
                  dragDisabled
                  nowTick={ctx.nowTick}
                  remoteAllowControl={ctx.remoteAllowControl}
                  onSelect={ctx.onSelect}
                  onStartEdit={ctx.onStartEdit}
                  onCancelEdit={ctx.onCancelEdit}
                  onRename={ctx.onRename}
                  onHibernate={ctx.onHibernate}
                  onArchiveChat={ctx.onArchiveChat}
                  onRestoreChat={ctx.onRestoreChat}
                  onKill={ctx.onKill}
                  onDuplicate={ctx.onDuplicate}
                />
              )
            }
            const agentSession = entry.agentSession
            if (!agentSession) return null
            return entry.kind === 'hibernating' ? (
              <HibernatingSessionItem
                key={entry.key}
                session={agentSession}
                isSelected={ctx.selectedHibernatingSessionId === agentSession.sessionId}
                showSessionIdPrefix={ctx.showSessionIdPrefix}
                showProjectName={ctx.showProjectName}
                showLastUserMessage={ctx.showLastUserMessage}
                onSelect={ctx.onSelectHibernating}
                onWake={ctx.onResume}
                onRename={ctx.onRename}
                onMoveToHistory={ctx.onMoveToHistory}
              />
            ) : (
              <HistorySessionItem
                key={entry.key}
                session={agentSession}
                showSessionIdPrefix={ctx.showSessionIdPrefix}
                showProjectName={ctx.showProjectName}
                showLastUserMessage={ctx.showLastUserMessage}
                onResume={ctx.onResume}
                onPreview={ctx.onPreview}
              />
            )
          })}
          {historyHidden > 0 && (
            <button
              type="button"
              onClick={onShowMoreHistory}
              className="w-full px-3 py-2 text-center text-xs text-muted hover:text-primary hover:bg-hover"
              data-testid="archive-show-more-history"
            >
              Show more ({historyHidden} remaining)
            </button>
          )}
        </div>
      </SortableContext>
    </DndContext>
  )
}
