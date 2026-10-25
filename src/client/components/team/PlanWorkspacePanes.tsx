// The workspace's pane layout (plan-workspace 7.2, design D8): on a wide
// host, the work breakdown beside a resizable documents pane and an optional
// right conversation; each pane can expand over the others and every size
// survives navigation through the per-team pane store. On a narrow host the
// same panes become an explicit Map/Documents/Conversation navigation with a
// Back control, one pane shown at a time, selection untouched by the
// switch. The divider is a real separator control: pointer drag and an
// equivalent keyboard step (labelled, bounded, with its value exposed), and
// focus moves to the shown pane when the narrow navigation switches, so the
// transition never strands a keyboard user. Pane scrolls are remembered
// per team (planWorkspacePaneScroll) and restored on remount. The two
// layouts are components; the default export only measures its own width and
// picks one, so each layout is mountable — and testable — on its own.
import { useLayoutEffect, useRef, useState, type MutableRefObject, type ReactNode, type RefObject } from 'react'
import {
  READER_FRACTION_MAX, READER_FRACTION_MIN, READER_FRACTION_STEP,
  useTeamPlanWorkspaceStore, type WorkspaceExpandedPane, type WorkspaceNarrowPane, type WorkspacePanesState,
} from '../../stores/teamPlanWorkspaceStore'
import { defaultPanes } from '../../stores/teamPlanWorkspaceStore'
import { paneScrollOf, setPaneScroll } from '../../utils/planWorkspacePaneScroll'

/** Below this section width the panes collapse to the narrow navigation. */
export const WORKSPACE_NARROW_MAX_PX = 900

export type WorkspacePaneLayout = 'desktop' | 'narrow'

/** The section's layout from its own width (the plan detail scrolls beside the navigator). */
export function workspaceLayoutForWidth(widthPx: number): WorkspacePaneLayout {
  return widthPx >= WORKSPACE_NARROW_MAX_PX ? 'desktop' : 'narrow'
}

function useWorkspaceLayout(ref: RefObject<HTMLElement | null>): WorkspacePaneLayout {
  const [width, setWidth] = useState<number | null>(null)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(entries => {
      const entry = entries[entries.length - 1]
      if (entry) setWidth(entry.contentRect.width)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return width === null ? 'desktop' : workspaceLayoutForWidth(width)
}

const NARROW_PANE_LABELS: Record<WorkspaceNarrowPane, string> = {
  map: 'Map', documents: 'Documents', conversation: 'Conversation',
}

const PANE_ARIA: Record<WorkspaceNarrowPane, string> = {
  map: 'work breakdown', documents: 'documents', conversation: 'conversation',
}

const NARROW_PANES: readonly WorkspaceNarrowPane[] = ['map', 'documents', 'conversation']

/** The three panes' content, keyed the way both layouts show them. */
export type WorkspacePaneContent = Record<WorkspaceNarrowPane, ReactNode>

/** One pane's scrollable body: restores its remembered scroll on mount, records it on scroll. */
function PaneBody({ teamKey, planId, pane, focusRef, children }: {
  teamKey: string
  planId: string
  pane: WorkspaceNarrowPane
  focusRef: MutableRefObject<HTMLDivElement | null>
  children: ReactNode
}) {
  const restoreRef = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    const element = restoreRef.current
    if (element) element.scrollTop = paneScrollOf(teamKey, planId, pane)
    // Restore once per mount; the scroll handler keeps the record current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return <div ref={node => { restoreRef.current = node; focusRef.current = node }} tabIndex={-1}
    data-testid={`workspace-pane-${pane}`}
    className="min-h-0 overflow-y-auto"
    onScroll={event => setPaneScroll(teamKey, planId, pane, event.currentTarget.scrollTop)}>
    {children}
  </div>
}

export default function PlanWorkspacePanes({ teamKey, planId, map, documents, conversation }: {
  teamKey: string
  /** The selected plan: pane scroll and expansion isolate by plan (7.1 r2). */
  planId: string
  /** The map pane's content: breakdown, outside-version work, health. */
  map: ReactNode
  /** The documents pane's content: artifacts and reader. */
  documents: ReactNode
  /** The conversation pane's content: the repository conversation panel. */
  conversation: ReactNode
}) {
  const rootRef = useRef<HTMLElement>(null)
  const layout = useWorkspaceLayout(rootRef)
  const panes: WorkspacePanesState = useTeamPlanWorkspaceStore(state => state.panes[teamKey]) ?? defaultPanes()
  const content: WorkspacePaneContent = { map, documents, conversation }
  return layout === 'narrow'
    ? <WorkspaceNarrowPanes teamKey={teamKey} planId={planId} panes={panes} rootRef={rootRef} content={content} />
    : <WorkspaceDesktopPanes teamKey={teamKey} planId={planId} panes={panes} rootRef={rootRef} content={content} />
}

/** The narrow layout (7.2): one pane behind an explicit navigation; a switch reveals it and moves focus with it. */
export function WorkspaceNarrowPanes({ teamKey, planId, panes, rootRef, content }: {
  teamKey: string
  planId: string
  panes: WorkspacePanesState
  rootRef: RefObject<HTMLElement>
  content: WorkspacePaneContent
}) {
  const paneRefs = {
    map: useRef<HTMLDivElement | null>(null),
    documents: useRef<HTMLDivElement | null>(null),
    conversation: useRef<HTMLDivElement | null>(null),
  }
  const store = useTeamPlanWorkspaceStore.getState()
  // A navigation switch moves focus to the pane it revealed, so the next Tab
  // starts inside the pane the user asked for. The first render does not
  // steal focus.
  const previousNarrow = useRef<WorkspaceNarrowPane | null>(null)
  useLayoutEffect(() => {
    const previous = previousNarrow.current
    previousNarrow.current = panes.narrowPane
    if (previous === null || previous === panes.narrowPane) return
    paneRefs[panes.narrowPane].current?.focus()
  }, [panes.narrowPane])
  return <section ref={rootRef} data-testid="plan-workspace-panes" data-layout="narrow"
    aria-label="Workspace panes" className="mt-3">
    <div role="tablist" aria-label="Workspace panes" className="flex gap-1" data-testid="workspace-narrow-nav">
      {NARROW_PANES.map(pane => (
        <button key={pane} type="button" role="tab" aria-selected={panes.narrowPane === pane}
          data-testid={`workspace-narrow-${pane}`}
          className={`btn text-xs ${panes.narrowPane === pane ? 'btn-primary' : ''}`}
          onClick={() => {
            if (pane === 'conversation') store.setConversationOpen(teamKey, true)
            store.setNarrowPane(teamKey, pane)
          }}>
          {NARROW_PANE_LABELS[pane]}
        </button>
      ))}
      {panes.narrowPane !== 'map' && <button type="button" className="btn text-xs" data-testid="workspace-narrow-back"
        aria-label={`Back to the map from the ${NARROW_PANE_LABELS[panes.narrowPane]} pane`}
        onClick={() => store.setNarrowPane(teamKey, 'map')}>← Map</button>}
    </div>
    <p className="sr-only" role="status" data-testid="workspace-narrow-status">
      Showing the {NARROW_PANE_LABELS[panes.narrowPane]} pane.
    </p>
    <div className="mt-2 flex min-h-0 flex-col" data-testid="workspace-narrow-body">
      {/* The key remounts the shown pane on a switch: the reused element
          would keep the previous pane's scrollTop and skip the mount-only
          restore, so each pane never inherits its neighbour's scroll. */}
      <PaneBody key={panes.narrowPane} teamKey={teamKey} planId={planId} pane={panes.narrowPane} focusRef={paneRefs[panes.narrowPane]}>
        {content[panes.narrowPane]}
      </PaneBody>
    </div>
  </section>
}

/** The desktop layout (7.2): the map beside a resizable documents pane and an optional right conversation. */
function WorkspaceDesktopPanes({ teamKey, planId, panes, rootRef, content }: {
  teamKey: string
  planId: string
  panes: WorkspacePanesState
  rootRef: RefObject<HTMLElement>
  content: WorkspacePaneContent
}) {
  const store = useTeamPlanWorkspaceStore.getState()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const dragging = useRef(false)
  const paneRefs = {
    map: useRef<HTMLDivElement | null>(null),
    documents: useRef<HTMLDivElement | null>(null),
    conversation: useRef<HTMLDivElement | null>(null),
  }

  const setFraction = (fraction: number) => store.setReaderFraction(teamKey, fraction)
  const onDividerKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft') { setFraction(panes.readerFraction - READER_FRACTION_STEP); event.preventDefault() }
    else if (event.key === 'ArrowRight') { setFraction(panes.readerFraction + READER_FRACTION_STEP); event.preventDefault() }
    else if (event.key === 'Home') { setFraction(READER_FRACTION_MIN); event.preventDefault() }
    else if (event.key === 'End') { setFraction(READER_FRACTION_MAX); event.preventDefault() }
  }
  const onDividerPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.currentTarget.setPointerCapture(event.pointerId)
    dragging.current = true
  }
  const onDividerPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return
    const area = containerRef.current
    if (!area) return
    const rect = area.getBoundingClientRect()
    if (rect.width <= 0) return
    // The documents pane's right edge tracks the pointer; its share is of the
    // resizable area, which the conversation column never counts (it is a
    // fixed sibling outside this container).
    setFraction((rect.right - event.clientX) / rect.width)
  }
  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return
    dragging.current = false
    event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const paneToolbar = (pane: WorkspaceNarrowPane) => {
    // The documents pane expands under its store key 'reader'.
    const expandedKey: WorkspaceExpandedPane = pane === 'documents' ? 'reader' : 'conversation'
    const isExpanded = panes.expandedPane === expandedKey
    return (
      <div className="flex items-center justify-end gap-1">
        {pane !== 'map' && (
          <button type="button" className="btn px-1.5 py-0.5 text-xs" data-testid={`workspace-expand-${pane}`}
            aria-pressed={isExpanded}
            aria-label={isExpanded
              ? `Restore panes from the expanded ${PANE_ARIA[pane]} pane`
              : `Expand the ${PANE_ARIA[pane]} pane`}
            onClick={() => store.setExpandedPane(teamKey, isExpanded ? null : expandedKey)}>
            {isExpanded ? '⤡ Restore' : '⤢ Expand'}
          </button>
        )}
      </div>
    )
  }

  const expanded = panes.expandedPane
  const mapFlex = (1 - panes.readerFraction) * 100
  const readerFlex = panes.readerFraction * 100
  return <section ref={rootRef} data-testid="plan-workspace-panes" data-layout="desktop"
    aria-label="Workspace panes" className="mt-3">
    <div className="flex items-baseline justify-end gap-2">
      <button type="button" className="btn px-1.5 py-0.5 text-xs" data-testid="workspace-conversation-toggle"
        aria-pressed={panes.conversationOpen}
        onClick={() => store.setConversationOpen(teamKey, !panes.conversationOpen)}>
        {panes.conversationOpen ? 'Hide conversation' : 'Show conversation'}
      </button>
    </div>
    <div className="flex min-h-0" data-testid="workspace-desktop-body">
      {expanded === null && <>
        <div className="flex min-w-0 flex-1" ref={containerRef} data-testid="workspace-resizable">
          <div className="flex min-w-0 flex-col" style={{ flexGrow: mapFlex, flexBasis: 0 }}>
            {paneToolbar('map')}
            <PaneBody teamKey={teamKey} planId={planId} pane="map" focusRef={paneRefs.map}>{content.map}</PaneBody>
          </div>
          <div role="separator" aria-orientation="vertical" tabIndex={0}
            data-testid="workspace-panes-divider"
            aria-label="Resize documents pane"
            aria-valuemin={Math.round(READER_FRACTION_MIN * 100)}
            aria-valuemax={Math.round(READER_FRACTION_MAX * 100)}
            aria-valuenow={Math.round(panes.readerFraction * 100)}
            className="mx-1 w-1.5 cursor-col-resize border-x border-border hover:bg-border"
            onKeyDown={onDividerKeyDown}
            onPointerDown={onDividerPointerDown}
            onPointerMove={onDividerPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag} />
          <div className="flex min-w-0 flex-col" style={{ flexGrow: readerFlex, flexBasis: 0 }}>
            {paneToolbar('documents')}
            <PaneBody teamKey={teamKey} planId={planId} pane="documents" focusRef={paneRefs.documents}>{content.documents}</PaneBody>
          </div>
        </div>
        {panes.conversationOpen && <div className="flex w-[26em] min-w-0 flex-col border-l border-border pl-2">
          {paneToolbar('conversation')}
          <PaneBody teamKey={teamKey} planId={planId} pane="conversation" focusRef={paneRefs.conversation}>{content.conversation}</PaneBody>
        </div>}
      </>}
      {expanded === 'reader' && <div className="flex min-w-0 flex-1 flex-col">
        {paneToolbar('documents')}
        <PaneBody teamKey={teamKey} planId={planId} pane="documents" focusRef={paneRefs.documents}>{content.documents}</PaneBody>
      </div>}
      {expanded === 'conversation' && <div className="flex min-w-0 flex-1 flex-col">
        {paneToolbar('conversation')}
        <PaneBody teamKey={teamKey} planId={planId} pane="conversation" focusRef={paneRefs.conversation}>{content.conversation}</PaneBody>
      </div>}
    </div>
  </section>
}
