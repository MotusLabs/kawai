// The plan workspace's mount (plan-workspace 5.1, design D1/D8): one
// section inside the Plans detail that subscribes to the workspace
// projection, offers the displayed-version and execution pickers, and lays
// the map, the documents, and the conversation out as panes (7.2). The URL's
// plans query (7.1, design D8) names the workspace identity: this section
// syncs it one way into the store — validating each selector against the
// loaded data and falling back with a notice — and mirrors the store back
// into the URL only on user acts, so reload, Back, and Forward restore the
// same selections while a pick writes one history entry. A selector the
// loaded data does not name keeps its URL and explains the fallback; loading
// is never invalid. Every existing plan section and action gate stays where
// it was — this adds, it never replaces. Opening the workspace never starts
// or attaches a worker (design D5's read-only rule).
import { useEffect, useMemo, useRef } from 'react'
import type { PlanContent, PlanDetail } from '@shared/plans'
import type { SendClientMessage, ServerMessage, Session } from '@shared/types'
import type { WorkspaceSnapshot, WorkspaceVersionSelector } from '@shared/planWorkspace'
import { PLAN_REVISION_LABELS } from './planLabels'
import { shortHash } from '../chat/strategyLabels'
import { repositoryTeamKey } from '../../utils/teamKey'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { useTeamLocationStore } from '../../hooks/useTeamLocation'
import {
  useTeamPlanWorkspaceStore, type PlanWorkspaceView, type WorkspaceDocumentSelection,
} from '../../stores/teamPlanWorkspaceStore'
import { applyPlansQuery, plansQueryOfState } from './planWorkspaceLocation'
import PlanWorkspaceMap from './PlanWorkspaceMap'
import PlanWorkspacePanes from './PlanWorkspacePanes'
import PlanWorkspaceReader, { type ReaderRefAdd, type ReaderWorktree } from './PlanWorkspaceReader'
import PlanWorkspaceArtifacts from './PlanWorkspaceArtifacts'
import PlanWorkspaceHealth from './PlanWorkspaceHealth'
import PlanWorkspaceConversation, { type OpenNewSessionForRole } from './PlanWorkspaceConversation'

export default function PlanWorkspaceSection({ teamPath, detail, sessions, connected, connectionEpoch, sendMessage, subscribe, onOpenNewSession }: {
  teamPath: string
  detail: PlanDetail
  /** The session list, for naming bound chats and offering the bind picker. */
  sessions: Session[]
  connected: boolean
  connectionEpoch: number
  sendMessage: SendClientMessage
  /** The chat lifecycle subscription the conversation panel's reset and create-then-bind flows need. */
  subscribe?: (listener: (message: ServerMessage) => void) => () => void
  /** Opens the normal New Session dialog (App-owned) for an unbound role. */
  onOpenNewSession?: OpenNewSessionForRole
}) {
  const planId = detail.plan.id
  const view = useTeamPlanWorkspaceStore(state => state.views[teamPath])
  const version = useTeamPlanWorkspaceStore(state => state.views[teamPath]?.version ?? null)
  const executionId = useTeamPlanWorkspaceStore(state => state.views[teamPath]?.executionId ?? null)
  const viewPlanId = useTeamPlanWorkspaceStore(state => state.views[teamPath]?.planId)
  const snapshot = view?.snapshot ?? null
  // The team's discovered worktrees (the reader picker and document-link
  // validation); worktreePaths is null while discovery has not reported or
  // has not named this team's repository — pending, never invalid.
  const repositories = useWorkspaceStore(state => state.snapshot?.repositories)
  const worktrees = useMemo<ReaderWorktree[]>(() => {
    if (repositories === undefined) return []
    const repository = repositories.find(candidate => repositoryTeamKey(candidate) === teamPath)
    return (repository?.worktrees ?? []).map(worktree => ({
      path: worktree.path,
      label: `${worktree.path.split('/').filter(Boolean).at(-1) ?? worktree.path}${worktree.isMain ? ' (main)' : ''}`,
    }))
  }, [repositories, teamPath])
  const worktreePaths = useMemo(() => {
    if (repositories === undefined) return null
    const repository = repositories.find(candidate => repositoryTeamKey(candidate) === teamPath)
    return repository === undefined ? null : repository.worktrees.map(worktree => worktree.path)
  }, [repositories, teamPath])
  // The store view exists for this plan; selecting another plan resets it.
  useEffect(() => { useTeamPlanWorkspaceStore.getState().open(teamPath, planId) }, [teamPath, planId])
  // A result lost with the connection never leaves a command pending.
  const wasConnected = useRef(connected)
  const lastEpoch = useRef(connectionEpoch)
  useEffect(() => {
    const reconnected = (!wasConnected.current && connected) || (connected && lastEpoch.current !== connectionEpoch)
    if (reconnected) useTeamPlanWorkspaceStore.getState().reconnected(teamPath)
    wasConnected.current = connected
    lastEpoch.current = connectionEpoch
  }, [connected, connectionEpoch, teamPath])
  // URL → store (plan-workspace 7.1): validate the location's plans query
  // against the loaded data and apply what it names. Re-runs when the query,
  // the loaded data, or the view (a plan switch recreates it) changes; each
  // run is idempotent — it applies only differing fields and keeps the
  // notice in step, so a user's store-then-navigate write never loops back.
  const locationPlans = useTeamLocationStore(state => {
    const current = state.location
    return current !== null && current.teamKey === teamPath && current.tab === 'plans' ? current.plans : undefined
  })
  const locationPlansKey = JSON.stringify(locationPlans ?? null)
  const revisionsKey = detail.revisions.map(revision => revision.revision).join(',')
  const draftsKey = detail.drafts.map(draft => draft.draftId).join(',')
  const executionsKey = (detail.executions ?? []).map(execution => execution.id).join(',')
  const displayedContent = displayedContentOf(detail, snapshot)
  const changeNamesKey = displayedContent === null ? '' : displayedContent.changes.map(change => change.change).join('\0')
  const worktreesKey = worktreePaths === null ? '' : worktreePaths.join('\0')
  useEffect(() => {
    const store = useTeamPlanWorkspaceStore.getState()
    const currentView = store.views[teamPath]
    if (locationPlans === undefined) {
      if (currentView?.urlNotice !== null && currentView?.urlNotice !== undefined) store.setUrlNotice(teamPath, null)
      return
    }
    const { patch, notices } = applyPlansQuery(locationPlans, {
      revisions: detail.revisions.map(revision => revision.revision),
      draftIds: detail.drafts.map(draft => draft.draftId),
      executionIds: (detail.executions ?? []).map(execution => execution.id),
      changeNames: displayedContent === null ? null : displayedContent.changes.map(change => change.change),
      worktreePaths,
    }, {
      version: currentView?.version ?? null,
      executionId: currentView?.executionId ?? null,
      selectedChange: currentView?.selectedChange ?? null,
      selectedDocument: currentView?.selectedDocument ?? null,
      role: store.roles[teamPath] ?? 'architect',
    })
    if (patch.version !== undefined) store.setVersion(teamPath, patch.version)
    if (patch.executionId !== undefined) store.setExecution(teamPath, patch.executionId)
    if (patch.selectedChange !== undefined) store.selectChange(teamPath, patch.selectedChange)
    if (patch.selectedDocument !== undefined) store.openDocument(teamPath, patch.selectedDocument)
    if (patch.role !== undefined) store.setRole(teamPath, patch.role)
    store.setUrlNotice(teamPath, notices.length > 0 ? notices.join(' ') : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamPath, locationPlansKey, viewPlanId, revisionsKey, draftsKey, executionsKey, changeNamesKey, worktreesKey])
  // The subscription: re-sent on reconnect and on a version or execution
  // change; the close rides the same effect's cleanup, so a switch ends the
  // old one. The view appears one commit after mount (the open effect above
  // creates it), so the existence check rides the deps — a first mount
  // subscribes too, not only re-renders. The server's open answers an
  // authoritative snapshot.
  const versionKey = JSON.stringify(version)
  const hasView = view !== undefined
  useEffect(() => {
    if (!connected || !hasView) return
    sendMessage({
      type: 'team-plan-workspace-open', teamPath, planId,
      ...(version !== null ? { version } : {}),
      ...(executionId !== null ? { execution: { executionId } } : {}),
    })
    return () => sendMessage({ type: 'team-plan-workspace-close', teamPath, planId })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamPath, planId, connected, connectionEpoch, versionKey, executionId, hasView, sendMessage])
  // One document subscription at a time (design D4's bounded reads).
  const document = view?.selectedDocument ?? null
  const documentKey = document === null ? null : `${document.worktreeId}\0${document.relativePath}`
  useEffect(() => {
    if (!connected || document === null) return
    sendMessage({
      type: 'team-plan-workspace-document-open', teamPath, planId,
      worktreeId: document.worktreeId, relativePath: document.relativePath,
      ...(executionId !== null ? { executionId } : {}),
    })
    return () => sendMessage({
      type: 'team-plan-workspace-document-close', teamPath, planId,
      worktreeId: document.worktreeId, relativePath: document.relativePath,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamPath, planId, connected, connectionEpoch, documentKey, executionId, sendMessage])
  /* __WORKSPACE_BODY__ */
  if (view === undefined) return null
  // A user act mirrors the store into the URL (store → URL only here, never
  // from pushes), so Back and Forward walk the workspace's own selections.
  const navigateWorkspace = () => {
    const current = useTeamLocationStore.getState().location
    if (current === null || current.teamKey !== teamPath || current.tab !== 'plans') return
    const store = useTeamPlanWorkspaceStore.getState()
    const currentView = store.views[teamPath]
    const query = plansQueryOfState({
      version: currentView?.version ?? null,
      executionId: currentView?.executionId ?? null,
      selectedChange: currentView?.selectedChange ?? null,
      selectedDocument: currentView?.selectedDocument ?? null,
      role: store.roles[teamPath] ?? 'architect',
    })
    useTeamLocationStore.getState().navigate({ ...current, plans: query })
  }
  return <section data-testid="plan-workspace" aria-labelledby="plan-workspace-heading" className="mt-4 border-t border-border pt-2">
    <h3 id="plan-workspace-heading" className="font-medium">Workspace</h3>
    <VersionExecutionBar detail={detail} snapshot={snapshot} view={view} connected={connected}
      onVersion={selector => { useTeamPlanWorkspaceStore.getState().setVersion(teamPath, selector); navigateWorkspace() }}
      onExecution={id => { useTeamPlanWorkspaceStore.getState().setExecution(teamPath, id); navigateWorkspace() }} />
    {!connected && <p role="status" className="text-chat-meta text-secondary">Disconnected — workspace facts are stale and edits are disabled.</p>}
    {view.error !== null && <p role="alert" data-testid="plan-workspace-error" className="text-chat-meta text-chat-danger">{view.error}</p>}
    {view.urlNotice !== null && <p role="status" data-testid="plan-workspace-url-notice" className="text-chat-meta text-approval">{view.urlNotice}</p>}
    {snapshot !== null && <BindingsLine snapshot={snapshot} />}
    {snapshot !== null && snapshot.displayedVersion === null && (
      <p data-testid="plan-workspace-no-version" className="text-chat-meta text-secondary">
        No displayable version: the plan has no approved revision, no revision in review, and no draft.
      </p>
    )}
    {snapshot === null
      ? <p role="status" className="mt-2 text-chat-meta text-secondary" data-testid="plan-workspace-loading">Loading workspace…</p>
      : <PlanWorkspacePanes teamKey={teamPath}
        map={mapContent(displayedContent, view, teamPath, connected, navigateWorkspace, worktrees)}
        documents={documentsContent(view, teamPath, connected, connectionEpoch, sendMessage, worktrees, navigateWorkspace)}
        conversation={<PlanWorkspaceConversation teamPath={teamPath}
          sessions={sessions} connected={connected} connectionEpoch={connectionEpoch}
          sendMessage={sendMessage} subscribe={subscribe} onOpenNewSession={onOpenNewSession}
          onRoleSelected={navigateWorkspace}
          selection={{
            detail, snapshot, teamId: view.teamId,
            version: view.version, executionId: view.executionId,
            selectedChange: view.selectedChange, selectedDocument: view.selectedDocument,
          }} />} />}
    {view.expanded.map(change => (
      <ChecklistSubscription key={change} teamPath={teamPath} planId={planId} change={change}
        connected={connected} connectionEpoch={connectionEpoch} sendMessage={sendMessage} />
    ))}
  </section>
}

/** The map pane: breakdown, outside-version work, health (each a separate fact). */
function mapContent(content: PlanContent | null, view: PlanWorkspaceView, teamPath: string, connected: boolean,
  navigateWorkspace: () => void, worktrees: ReaderWorktree[]) {
  const store = useTeamPlanWorkspaceStore.getState()
  const snapshot = view.snapshot
  const runtime = snapshot?.runtime ?? null
  return <>
    {content !== null && runtime !== null
      ? <PlanWorkspaceMap content={content} runtime={runtime} view={view}
        onToggleExpanded={change => store.toggleExpanded(teamPath, change)}
        onSelectChange={change => { store.selectChange(teamPath, change); navigateWorkspace() }}
        onSetFilter={filter => store.setFilter(teamPath, filter)} />
      : content !== null && runtime === null && <p className="text-chat-meta text-secondary" data-testid="plan-workspace-runtime-unavailable">
        Execution state is unavailable for this workspace (no supervision module).
      </p>}
    {runtime !== null && (runtime.outside.changes.length > 0 || runtime.outside.tasks.length > 0) && (
      <div data-testid="plan-workspace-outside" className="mt-2 border border-border p-2 text-chat-meta">
        <h4 className="font-medium">Work outside this version</h4>
        {runtime.outside.changes.length > 0 && <p>
          In the execution&rsquo;s revision {runtime.outside.changes[0]!.executionRevision} but not displayed:
          {' '}{runtime.outside.changes.map(change => change.change).join(', ')}
        </p>}
        {runtime.outside.tasks.length > 0 && <ul className="mt-1 list-disc pl-5">
          {runtime.outside.tasks.map(task => <li key={task.taskId}>
            {task.title} — change {task.planChange}, {task.holders.length} holder{task.holders.length === 1 ? '' : 's'}
          </li>)}
        </ul>}
      </div>
    )}
    <PlanWorkspaceHealth readings={snapshot?.health ?? []} connected={connected} />
    {content !== null && <span className="sr-only">{worktrees.length} discovered worktrees offer documents for {view.planId}.</span>}
  </>
}

/** The documents pane (7.2): the selected change's artifacts above the reader. */
function documentsContent(view: PlanWorkspaceView, teamPath: string, connected: boolean, connectionEpoch: number,
  sendMessage: SendClientMessage, worktrees: ReaderWorktree[], navigateWorkspace: () => void) {
  const store = useTeamPlanWorkspaceStore.getState()
  const planId = view.planId
  return <>
    {view.selectedChange !== null && <PlanWorkspaceArtifacts teamPath={teamPath} planId={planId}
      change={view.selectedChange} view={view} connected={connected} connectionEpoch={connectionEpoch}
      sendMessage={sendMessage} />}
    <PlanWorkspaceReader teamPath={teamPath} refs={view.snapshot?.references ?? []}
      selectedChange={view.selectedChange} executionId={view.executionId} view={view}
      worktrees={worktrees} connected={connected}
      onOpenDocument={(selection: WorkspaceDocumentSelection | null) => {
        store.openDocument(teamPath, selection)
        navigateWorkspace()
      }}
      onAddRef={(payload: ReaderRefAdd) => {
        const requestId = crypto.randomUUID()
        store.begin(teamPath, requestId, 'ref-add')
        sendMessage({
          type: 'team-plan-workspace-ref-add', teamPath, requestId, commandId: crypto.randomUUID(),
          planId, label: payload.label, kind: payload.kind,
          ...(payload.changeName !== undefined ? { changeName: payload.changeName } : {}),
          ...(payload.worktreeId !== undefined ? { worktreeId: payload.worktreeId } : {}),
          ...(payload.relativePath !== undefined ? { relativePath: payload.relativePath } : {}),
          ...(payload.url !== undefined ? { url: payload.url } : {}),
        })
      }}
      onRemoveRef={refId => {
        const requestId = crypto.randomUUID()
        store.begin(teamPath, requestId, 'ref-remove')
        sendMessage({ type: 'team-plan-workspace-ref-remove', teamPath, requestId, commandId: crypto.randomUUID(), refId })
      }} />
  </>
}

/** The two explicit identities (design D2): what is displayed, and what an execution runs. */
function VersionExecutionBar({ detail, snapshot, view, connected, onVersion, onExecution }: {
  detail: PlanDetail
  snapshot: WorkspaceSnapshot | null
  view: { version: WorkspaceVersionSelector | null; executionId: string | null }
  connected: boolean
  onVersion: (selector: WorkspaceVersionSelector | null) => void
  onExecution: (executionId: string | null) => void
}) {
  const revisions = [...detail.revisions].reverse()
  const drafts = [...detail.drafts].reverse()
  const executions = detail.executions ?? []
  const value = view.version === null
    ? ''
    : view.version.kind === 'revision' ? `rev:${view.version.revision}` : `draft:${view.version.draftId}`
  const displayed = snapshot?.displayedVersion ?? null
  return <div className="mt-1 flex flex-wrap items-baseline gap-2" data-testid="plan-workspace-versions">
    <label className="text-chat-meta text-secondary" htmlFor="workspace-version-picker">Displayed version</label>
    <select id="workspace-version-picker" className="input max-w-72 text-xs" data-testid="workspace-version-picker"
      value={value} disabled={!connected}
      onChange={event => {
        const next = event.target.value
        onVersion(next === '' ? null : next.startsWith('rev:')
          ? { kind: 'revision', revision: Number(next.slice(4)) }
          : { kind: 'draft', draftId: next.slice(6) })
      }}>
      <option value="">Default (approved, else newest in review, else newest draft)</option>
      {revisions.map(revision => (
        <option key={`rev:${revision.revision}`} value={`rev:${revision.revision}`}>
          Revision {revision.revision} — {PLAN_REVISION_LABELS[revision.status]}
        </option>
      ))}
      {drafts.map(draft => (
        <option key={`draft:${draft.draftId}`} value={`draft:${draft.draftId}`}>Draft {draft.draftId}</option>
      ))}
    </select>
    {displayed !== null && <span className="text-chat-meta" data-testid="workspace-displayed-label">
      Showing {displayed.kind === 'revision'
        ? `revision ${displayed.revision} (${PLAN_REVISION_LABELS[displayed.status]})`
        : `draft ${displayed.draftId}`} · {shortHash(displayed.contentHash)}
    </span>}
    {executions.length > 0 && <>
      <label className="text-chat-meta text-secondary" htmlFor="workspace-execution-picker">Execution</label>
      <select id="workspace-execution-picker" className="input max-w-60 text-xs" data-testid="workspace-execution-picker"
        value={view.executionId ?? ''} disabled={!connected}
        onChange={event => onExecution(event.target.value === '' ? null : event.target.value)}>
        <option value="">Latest execution</option>
        {executions.map(execution => (
          <option key={execution.id} value={execution.id}>Execution {shortHash(execution.id)} — revision {execution.revision}</option>
        ))}
      </select>
    </>}
    {snapshot?.execution !== null && snapshot?.execution !== undefined && (
      <span className="text-chat-meta" data-testid="workspace-execution-label">
        Selected execution runs revision {snapshot.execution.revision}
      </span>
    )}
  </div>
}

/** The bound conversation roles (design D6), read-only here — binding is §6.2's control. */
function BindingsLine({ snapshot }: { snapshot: WorkspaceSnapshot }) {
  if (snapshot.bindings.length === 0) {
    return <p className="text-chat-meta text-secondary" data-testid="workspace-bindings">No repository chats bound yet.</p>
  }
  const words: Record<string, string> = { live: 'live', archived: 'archived (read-only until restore)', unavailable: 'unavailable' }
  return <p className="text-chat-meta text-secondary" data-testid="workspace-bindings">
    {snapshot.bindings.map(binding =>
      `${binding.role === 'architect' ? 'Architect' : 'Lead'}: ${binding.name ?? shortHash(binding.sessionId)} (${words[binding.availability] ?? binding.availability})`,
    ).join(' · ')}
  </p>
}

/** The displayed version's content, resolved against the plan detail's revisions and drafts. */
function displayedContentOf(detail: PlanDetail, snapshot: WorkspaceSnapshot | null): PlanContent | null {
  const displayed = snapshot?.displayedVersion ?? null
  if (displayed === null) return null
  if (displayed.kind === 'draft') {
    return detail.drafts.find(draft => draft.draftId === displayed.draftId)?.content ?? null
  }
  return detail.revisions.find(revision => revision.revision === displayed.revision)?.content ?? null
}

/** One expanded change's checklist subscription (open on expand, close on collapse). */
function ChecklistSubscription({ teamPath, planId, change, connected, connectionEpoch, sendMessage }: {
  teamPath: string
  planId: string
  change: string
  connected: boolean
  connectionEpoch: number
  sendMessage: SendClientMessage
}) {
  useEffect(() => {
    if (!connected) return
    sendMessage({ type: 'team-plan-workspace-checklist-open', teamPath, planId, changeName: change })
    return () => sendMessage({ type: 'team-plan-workspace-checklist-close', teamPath, planId, changeName: change })
  }, [teamPath, planId, connected, connectionEpoch, change, sendMessage])
  return null
}
