// SessionRow.tsx - Session row rendering shared by the flat session list and
// the grouped workspace navigator: SortableSessionItem wraps SessionRow with
// dnd-kit drag behavior and framer-motion enter/exit animations; SessionRow
// renders the row content with rename editing and the long-press context menu.

import { useCallback, useEffect, useRef, useState, forwardRef } from 'react'
import { motion } from 'motion/react'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { HandIcon, XCloseIcon } from '@untitledui-icons/react/line'
import Copy01Icon from '@untitledui-icons/react/line/esm/Copy01Icon'
import File06Icon from '@untitledui-icons/react/line/esm/File06Icon'
import Edit05Icon from '@untitledui-icons/react/line/esm/Edit05Icon'
import Moon01Icon from '@untitledui-icons/react/line/esm/Moon01Icon'
import type { Session } from '@shared/types'
import { formatRelativeTime } from '../utils/time'
import { getPathLeaf } from '../utils/sessionLabel'
import { getSessionIdShort } from '../utils/sessionId'
import { copyText } from '../utils/copyText'
import { composeSortableTransform } from '../utils/sortableTransform'
import AgentIcon from './AgentIcon'
import ProjectBadge from './ProjectBadge'
import HostBadge from './HostBadge'

/** Status pill classes for the time/activity badge */
export const statusPillClass: Record<Session['status'], string> = {
  working: 'bg-green-500/20 text-green-600',
  waiting: 'bg-zinc-500/20 text-zinc-400',
  permission: 'bg-amber-500/20 text-amber-600',
  unknown: 'bg-zinc-500/20 text-zinc-400',
}

export interface SortableSessionItemProps {
  session: Session
  isNew: boolean
  exitDuration: number
  prefersReducedMotion: boolean | null
  useSafariLayoutFallback: boolean
  isSelected: boolean
  isEditing: boolean
  showSessionIdPrefix: boolean
  showProjectName: boolean
  showLastUserMessage: boolean
  showHostInfo: boolean
  dropIndicator: 'above' | 'below' | null
  onSelect: () => void
  onStartEdit?: () => void
  onCancelEdit: () => void
  onRename: (newName: string) => void
  onHibernate?: () => void
  onKill?: () => void
  onDuplicate?: () => void
}

export const SortableSessionItem = forwardRef<HTMLDivElement, SortableSessionItemProps>(function SortableSessionItem({
  session,
  isNew,
  exitDuration,
  prefersReducedMotion,
  useSafariLayoutFallback,
  isSelected,
  isEditing,
  showSessionIdPrefix,
  showProjectName,
  showLastUserMessage,
  showHostInfo,
  dropIndicator,
  onSelect,
  onStartEdit,
  onCancelEdit,
  onRename,
  onHibernate,
  onKill,
  onDuplicate,
}, ref) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: session.id,
    animateLayoutChanges: ({ isSorting, wasDragging }) => isSorting || wasDragging,
  })

  const dndTransform = CSS.Transform.toString(transform)
  const shouldApplyStyleTransform = Boolean(prefersReducedMotion && dndTransform)
  const style = {
    ...(shouldApplyStyleTransform ? { transform: dndTransform, transition } : {}),
    zIndex: isDragging ? 10 : undefined,
    opacity: isDragging ? 0.9 : undefined,
  }

  const setRefs = useCallback(
    (node: HTMLDivElement | null) => {
      setNodeRef(node)
      if (typeof ref === 'function') {
        ref(node)
      } else if (ref) {
        ref.current = node
      }
    },
    [setNodeRef, ref],
  )

  return (
    // Deliberately no framer `layout` prop: animated resorts slide rows through
    // each other, overlapping two sessions' text mid-flight (#159). Rows snap to
    // their new position; drag previews still animate via the dnd-kit transform.
    <motion.div
      ref={setRefs}
      style={{ ...style, overflow: 'hidden' }}
      className="relative"
      transformTemplate={(_, generatedTransform) =>
        composeSortableTransform({
          useSafariLayoutFallback,
          isDragging,
          dndTransform,
          generatedTransform,
        })
      }
      initial={
        prefersReducedMotion || !isNew
          ? false
          : useSafariLayoutFallback
            ? { opacity: 0 }
            : { opacity: 0, scale: 0.97 }
      }
      animate={
        prefersReducedMotion
          ? { opacity: 1 }
          : isNew
            ? useSafariLayoutFallback
              ? { opacity: 1 }
              : { opacity: 1, scale: [1.02, 0.99, 1] }
            : { opacity: 1, scale: 1 }
      }
      exit={prefersReducedMotion
        ? { opacity: 0 }
        : useSafariLayoutFallback
          ? { opacity: 0, height: 0 }
          : { opacity: 0, height: 0, scale: 0.97 }}
      transition={
        prefersReducedMotion
          ? { duration: 0 }
          : useSafariLayoutFallback
            ? {
              opacity: { duration: exitDuration / 1000 },
              height: { duration: exitDuration / 1000, ease: 'easeOut' },
            }
            : {
              opacity: { duration: exitDuration / 1000 },
              scale: { duration: exitDuration / 1000, ease: [0.34, 1.56, 0.64, 1] },
              height: { duration: exitDuration / 1000, ease: 'easeOut' },
            }
      }
      {...attributes}
      {...listeners}
    >
      {/* Drop indicator line */}
      {dropIndicator === 'above' && (
        <div className="absolute -top-px left-3 right-3 h-0.5 border-t-2 border-dashed border-accent" />
      )}
      <SessionRow
        session={session}
        isSelected={isSelected}
        isEditing={isEditing}
        showSessionIdPrefix={showSessionIdPrefix}
        showProjectName={showProjectName}
        showLastUserMessage={showLastUserMessage}
        showHostInfo={showHostInfo}
        isDragging={isDragging}
        onSelect={onSelect}
        onStartEdit={onStartEdit}
        onCancelEdit={onCancelEdit}
        onRename={onRename}
        onHibernate={onHibernate}
        onKill={onKill}
        onDuplicate={onDuplicate}
      />
      {dropIndicator === 'below' && (
        <div className="absolute -bottom-px left-3 right-3 h-0.5 border-t-2 border-dashed border-accent" />
      )}
    </motion.div>
  )
})

SortableSessionItem.displayName = 'SortableSessionItem'

interface SessionRowProps {
  session: Session
  isSelected: boolean
  isEditing: boolean
  showSessionIdPrefix: boolean
  showProjectName: boolean
  showLastUserMessage: boolean
  showHostInfo: boolean
  isDragging?: boolean
  onSelect: () => void
  onStartEdit?: () => void
  onCancelEdit: () => void
  onRename: (newName: string) => void
  onHibernate?: () => void
  onKill?: () => void
  onDuplicate?: () => void
}

export function SessionRow({
  session,
  isSelected,
  isEditing,
  showSessionIdPrefix,
  showProjectName,
  showLastUserMessage,
  showHostInfo,
  isDragging = false,
  onSelect,
  onStartEdit,
  onCancelEdit,
  onRename,
  onHibernate,
  onKill,
  onDuplicate,
}: SessionRowProps) {
  const lastActivity = formatRelativeTime(session.lastActivity)
  const inputRef = useRef<HTMLInputElement>(null)
  const contextMenuRef = useRef<HTMLDivElement>(null)
  const displayName =
    session.agentSessionName?.trim() ||
    session.name?.trim() ||
    session.id
  const [editValue, setEditValue] = useState(displayName)
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null)
  const directoryLeaf = getPathLeaf(session.projectPath)
  const hostLabel = session.host?.trim()
  const needsInput = session.status === 'permission'
  const agentSessionId = session.agentSessionId?.trim()
  const sessionIdPrefix =
    showSessionIdPrefix && agentSessionId
      ? getSessionIdShort(agentSessionId)
      : ''
  const showDirectory = showProjectName && Boolean(directoryLeaf)
  const showHostBadge = showHostInfo && Boolean(hostLabel)
  const showMessage = showLastUserMessage && Boolean(session.lastUserMessage)

  // Track previous status for transition animation
  const prevStatusRef = useRef<Session['status']>(session.status)
  const [isPulsingComplete, setIsPulsingComplete] = useState(false)

  useEffect(() => {
    const prevStatus = prevStatusRef.current
    const currentStatus = session.status

    // Detect transition from working → waiting (not permission, which needs immediate attention)
    if (prevStatus === 'working' && currentStatus === 'waiting') {
      setIsPulsingComplete(true)
      // Don't update ref yet - will update when animation ends
    } else {
      prevStatusRef.current = currentStatus
    }
  }, [session.status])

  const handlePulseAnimationEnd = () => {
    setIsPulsingComplete(false)
    prevStatusRef.current = session.status
  }

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  useEffect(() => {
    setEditValue(displayName)
  }, [displayName])

  const handleSubmit = () => {
    const trimmed = editValue.trim()
    if (trimmed && trimmed !== displayName) {
      onRename(trimmed)
    } else {
      onCancelEdit()
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSubmit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setEditValue(displayName)
      onCancelEdit()
    }
  }

  const touchStartPos = useRef<{ x: number; y: number } | null>(null)

  const handleTouchStart = (e: React.TouchEvent) => {
    if (isDragging) return
    const touch = e.touches[0]
    touchStartPos.current = { x: touch.clientX, y: touch.clientY }
    longPressTimer.current = setTimeout(() => {
      if (touchStartPos.current) {
        setContextMenu(touchStartPos.current)
      }
    }, 500)
  }

  const handleTouchEnd = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current)
      longPressTimer.current = null
    }
  }

  // Close context menu on click outside or escape
  useEffect(() => {
    if (!contextMenu) return

    const handleClickOutside = (e: MouseEvent | TouchEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null)
      }
    }

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setContextMenu(null)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('touchstart', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('touchstart', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [contextMenu])

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY })
  }

  return (
    <div
      className={`session-row group cursor-pointer select-none px-3 py-2 ${isSelected ? 'selected' : ''} ${isDragging ? 'cursor-grabbing shadow-lg ring-1 ring-accent/30 bg-elevated' : 'cursor-grab'}`}
      role="button"
      tabIndex={0}
      data-testid="session-card"
      data-session-id={session.id}
      onClick={isDragging ? undefined : onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') onSelect()
      }}
      onContextMenu={handleContextMenu}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
    >
      <div className="flex flex-col gap-0.5 pl-0.5">
        {/* Line 1: Icon + Name + Time/Hand */}
        <div className="flex items-center gap-2">
          <AgentIcon
            agentType={session.agentType}
            command={session.command}
            className="h-3.5 w-3.5 shrink-0 text-muted"
          />
          {isEditing ? (
            <input
              ref={inputRef}
              type="text"
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              onBlur={handleSubmit}
              onKeyDown={handleKeyDown}
              onClick={(e) => e.stopPropagation()}
              className="min-w-0 flex-1 rounded border border-border bg-surface px-1.5 py-0.5 text-sm font-medium text-primary outline-none focus:border-accent"
            />
          ) : (
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-primary">
              {displayName}
            </span>
          )}
          {sessionIdPrefix && (
            <span
              className="shrink-0 text-[11px] font-mono text-muted"
              title={agentSessionId}
            >
              {sessionIdPrefix}
            </span>
          )}
          {needsInput ? (
            <span
              className={`ml-1 flex shrink-0 items-center justify-center rounded-full px-1.5 py-0.5 ${statusPillClass[session.status]} pulse-approval`}
              onAnimationEnd={handlePulseAnimationEnd}
            >
              <HandIcon className="h-3 w-3" aria-label="Needs input" />
            </span>
          ) : (
            <span
              className={`ml-1 shrink-0 rounded-full px-1.5 py-0.5 text-right text-xs tabular-nums ${statusPillClass[session.status]}${isPulsingComplete ? ' pulse-complete' : ''}`}
              onAnimationEnd={handlePulseAnimationEnd}
            >
              {lastActivity}
            </span>
          )}
        </div>

        {/* Line 2: Project badge + last user message (up to 2 lines total) */}
        {(showDirectory || showHostBadge || showMessage) && (
          <div className="flex flex-wrap items-center gap-1 pl-[1.375rem]">
            {showHostBadge && <HostBadge name={hostLabel!} />}
            {showDirectory && (
              <ProjectBadge name={directoryLeaf!} fullPath={session.projectPath} />
            )}
            {showMessage && (
              <span className="line-clamp-2 text-xs italic text-muted">
                "{session.lastUserMessage!.length > 200
                  ? session.lastUserMessage!.slice(0, 200) + '…'
                  : session.lastUserMessage}"
              </span>
            )}
          </div>
        )}
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          ref={contextMenuRef}
          className="fixed z-50 min-w-[160px] rounded-md border border-border bg-elevated shadow-lg py-1"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          role="menu"
        >
          {onStartEdit && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                setContextMenu(null)
                onStartEdit()
              }}
              className="w-full px-3 py-2 text-left text-sm text-secondary hover:bg-hover hover:text-primary flex items-center gap-2"
              role="menuitem"
            >
              <Edit05Icon width={14} height={14} />
              Rename
            </button>
          )}
          {onDuplicate && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                setContextMenu(null)
                onDuplicate()
              }}
              className="w-full px-3 py-2 text-left text-sm text-secondary hover:bg-hover hover:text-primary flex items-center gap-2"
              role="menuitem"
              title="Create a copy in a new tmux window"
            >
              <Copy01Icon width={14} height={14} />
              Duplicate
            </button>
          )}
          {onHibernate && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                setContextMenu(null)
                onHibernate()
              }}
              className="w-full px-3 py-2 text-left text-sm text-secondary hover:bg-hover hover:text-primary flex items-center gap-2"
              role="menuitem"
              title="Close the live window and keep this session ready to wake"
            >
              <Moon01Icon width={14} height={14} />
              Hibernate
            </button>
          )}
          {session.logFilePath && (
            <button
              onClick={(e) => {
                e.stopPropagation()
                setContextMenu(null)
                if (session.logFilePath) {
                  copyText(session.logFilePath)
                }
              }}
              className="w-full px-3 py-2 text-left text-sm text-secondary hover:bg-hover hover:text-primary flex items-center gap-2"
              role="menuitem"
              title={session.logFilePath}
            >
              <File06Icon width={14} height={14} />
              Copy Log Path
            </button>
          )}
          {onKill && (
            <>
              <div className="my-1 border-t border-border" />
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setContextMenu(null)
                  onKill()
                }}
                className="w-full px-3 py-2 text-left text-sm text-danger hover:bg-danger/10 flex items-center gap-2"
                role="menuitem"
              >
                <XCloseIcon width={14} height={14} />
                Kill Session
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
