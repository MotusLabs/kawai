// The repository conversation panel (plan-workspace §6.2–6.4, design D6/D7):
// the two durable repository roles — Architect (planning conversation) and
// Lead (coordination conversation) — as tabs over the team's durable
// bindings. Binding is an explicit human act: pick an existing same-team
// chat (never the other role's session) or create one through the normal
// New Session dialog, and the bind commits only after the creation is
// observed. A role is a pointer, never an authority: the line shows the
// bound chat's configured group/profile/approval policy and warns when the
// plan's execution Lead role differs from the bound chat's group — execution
// routing and decisions keep following the plan, not this panel.
//
// Only the selected role's ChatSurface mounts, so exactly one conversation
// is attached (attachment holds follow the mount; the inactive role's agent
// is detached without interrupting its work and is never started by this
// panel — observation of the other role reads the snapshot only). The
// sendMessage reference passes through UNCHANGED: it is the attachment
// registry's key. The captured plan scope (§6.3) lives beside the per-session
// draft in planWorkspaceScopeStore: captured when a draft first becomes
// nonempty under this panel, never mutated by later navigation, replaced only
// by the explicit action on the chip. A local reset (§6.4) transfers the
// binding by the same CAS bind a human replace uses, exactly once, from this
// host or the full-screen view (planWorkspaceResetTransfer).
//
// Bindings come from the team-level slot in teamPlanWorkspaceStore (Q1,
// Lead-authorized): the panel owns the lazy team bindings subscription
// (open on mount, re-sent on reconnect, closed on unmount) and every read —
// here and in the per-plan snapshot — reconciles into that one slot per role
// by CAS version, so a no-plan empty state binds exactly like the plan
// detail and the two read paths never diverge.
import { useEffect, useMemo, useRef, useState } from 'react'
import type { SendClientMessage, ServerMessage, Session } from '@shared/types'
import type { PlanDetail } from '@shared/plans'
import type {
  PlanWorkspaceRole, WorkspaceBindingView, WorkspaceMessageEnvelope,
  WorkspaceSnapshot, WorkspaceVersionSelector,
} from '@shared/planWorkspace'
import { shortHash } from '../chat/strategyLabels'
import { teamKeyOf } from '../../utils/teamKey'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import { useChatStore } from '../../stores/chatStore'
import { useTeamPlanWorkspaceStore } from '../../stores/teamPlanWorkspaceStore'
import {
  sameEnvelope, usePlanWorkspaceScopeStore,
  type CapturedWorkspaceScope, type ResetTransferAttempt,
} from '../../stores/planWorkspaceScopeStore'
import ChatSurface from '../chat/ChatSurface'
import { transferBindingsOnReset } from '../../utils/planWorkspaceResetTransfer'

const ROLE_LABELS: Record<PlanWorkspaceRole, string> = { architect: 'Architect', lead: 'Lead' }
const AVAILABILITY_LABELS: Record<WorkspaceBindingView['availability'], string> = {
  live: 'live', archived: 'archived — read-only until restore', unavailable: 'unavailable — replace explicitly',
}
/** Stable empty list so an absent slot never re-renders (getSnapshot caching). */
const EMPTY_BINDINGS: WorkspaceBindingView[] = []

/**
 * Opens the normal New Session dialog (App-owned) for the panel's
 * create-then-bind flow. The optional callback reports how the dialog flow
 * ended: `created: false` — a cancel/close that abandons the arm (B5);
 * `created: true` — a creation was requested, whose `session-created` (or
 * error) reply settles the arm.
 */
export type OpenNewSessionForRole = (onDismissed?: (created: boolean) => void) => void

/** What the host needs to name and refine the captured scope (plan detail only). */
export interface ConversationSelection {
  detail: PlanDetail
  snapshot: WorkspaceSnapshot
  /** The server-assigned team id, from the wire snapshot message (V2). */
  teamId: string | null
  version: WorkspaceVersionSelector | null
  executionId: string | null
  selectedChange: string | null
  selectedDocument: { worktreeId: string; relativePath: string } | null
}

export default function PlanWorkspaceConversation({ teamPath, sessions, connected, connectionEpoch, sendMessage, subscribe, selection, onOpenNewSession, onRoleSelected }: {
  teamPath: string
  sessions: Session[]
  connected: boolean
  connectionEpoch: number
  /** The connection's stable sendMessage — passed to ChatSurface unchanged. */
  sendMessage: SendClientMessage
  /** Lifecycle subscription: required for local reset and create-then-bind. */
  subscribe?: (listener: (message: ServerMessage) => void) => () => void
  /** The selected plan's workspace facts when a plan is open; null in the list/empty state. */
  selection: ConversationSelection | null
  /** Opens the normal New Session dialog (App-owned) — see {@link OpenNewSessionForRole}. */
  onOpenNewSession?: OpenNewSessionForRole
  /** Mirrors a role pick into the plans URL (plan-workspace 7.1); the store write happens here. */
  onRoleSelected?: () => void
}) {
  // The lazy team bindings subscription (Q1): open while this panel is
  // mounted, re-sent on reconnect, closed on unmount. It starts no agent —
  // the server answers a bindings push only.
  useEffect(() => {
    if (!connected) return
    sendMessage({ type: 'team-plan-workspace-bindings-open', teamPath })
    return () => sendMessage({ type: 'team-plan-workspace-bindings-close', teamPath })
  }, [teamPath, connected, connectionEpoch, sendMessage])
  const bindings = useTeamPlanWorkspaceStore(state => state.teamBindings[teamPath]) ?? EMPTY_BINDINGS
  // The active role is per-team store state (plan-workspace 7.1): it
  // survives navigation and a linked `r=` query restores it. A pick writes
  // the store, then mirrors the workspace into the URL.
  const role = useTeamPlanWorkspaceStore(state => state.roles[teamPath] ?? 'architect')
  const selectRole = (next: PlanWorkspaceRole) => {
    setAwaitingCreate(null)
    setBindError(null)
    useTeamPlanWorkspaceStore.getState().setRole(teamPath, next)
    onRoleSelected?.()
  }
  const [bindError, setBindError] = useState<string | null>(null)
  // The create-then-bind arm (B5): the role plus the binding version the arm
  // observed when the dialog opened. Discharged by the dialog closing without
  // a creation, a picker pick, a role switch, any error reply, or the first
  // created chat — any creation, same-team or not, so the arm never dangles
  // for a later unrelated chat.
  const [awaitingCreate, setAwaitingCreate] = useState<{ role: PlanWorkspaceRole; expectedVersion: number | null } | null>(null)
  const repositories = useWorkspaceStore(state => state.snapshot?.repositories)
  const binding = bindings.find(entry => entry.role === role) ?? null
  const otherBinding = bindings.find(entry => entry.role !== role) ?? null
  const boundSession = binding ? sessions.find(entry => entry.id === binding.sessionId) ?? null : null
  const leadBinding = bindings.find(entry => entry.role === 'lead') ?? null
  const leadSession = leadBinding ? sessions.find(entry => entry.id === leadBinding.sessionId) ?? null : null
  const sameTeam = (session: Session): boolean => teamKeyOf(session.projectPath, repositories) === teamPath
  // Bindable chats: this team's ordinary chats minus the other role's bound
  // session (the server refuses a duplicate role session; the picker never
  // offers one). Killed sessions are absent from the list; archived ones are
  // offered labelled, since binding them read-only is allowed.
  const candidates = sessions.filter(entry =>
    entry.kind === 'chat' && sameTeam(entry) && entry.id !== otherBinding?.sessionId)
  // The bind results of this panel's own commands: errors surface here even
  // where no workspace view is open to carry them.
  const ownRequests = useRef(new Set<string>())
  const bindRole = (target: PlanWorkspaceRole, sessionId: string, expectedVersion: number | null) => {
    if (!connected) return
    const requestId = crypto.randomUUID()
    ownRequests.current.add(requestId)
    setBindError(null)
    sendMessage({
      type: 'team-plan-workspace-bind', teamPath, requestId, commandId: crypto.randomUUID(),
      role: target, sessionId, expectedVersion,
    })
  }
  useEffect(() => {
    if (!subscribe) return
    return subscribe(message => {
      // A reset transfer's keyed result settles its attempt (B2), including
      // transfers issued by the full-screen view while this panel was closed.
      if (message.type === 'team-plan-workspace-result') {
        usePlanWorkspaceScopeStore.getState().recordTransferOutcome(message.requestId,
          { ok: !message.error, error: message.error ?? null })
      }
      if (message.type === 'team-plan-workspace-result' && ownRequests.current.has(message.requestId)) {
        ownRequests.current.delete(message.requestId)
        if (message.error) setBindError(message.error)
      } else if (message.type === 'error' && awaitingCreate !== null) {
        setAwaitingCreate(null)
      } else if (message.type === 'session-created' && awaitingCreate !== null) {
        // One creation discharges the arm — same-team or not — so a creation
        // that is not this role's chat never leaves the arm dangling for a
        // later, unrelated chat. Bind only a same-team ordinary chat (D6),
        // and only while the role's binding is still exactly what the arm
        // observed when the dialog opened: a concurrent explicit bind or
        // replacement is never overwritten — the created chat stays unbound.
        const armed = awaitingCreate
        setAwaitingCreate(null)
        if (message.session.kind === 'chat' && sameTeam(message.session)) {
          const current = useTeamPlanWorkspaceStore.getState().teamBindings[teamPath]
            ?.find(entry => entry.role === armed.role)?.version ?? null
          if (current === armed.expectedVersion) {
            bindRole(armed.role, message.session.id, armed.expectedVersion)
          }
        }
      }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribe, awaitingCreate, connected, repositories, teamPath, sendMessage])
  // The plan's execution Lead role, to compare with the bound Lead chat's
  // group (D6): the displayed content's leadGroup, when one is set.
  const shownLeadGroup = selection ? shownRevisionLeadGroup(selection.detail, selection.snapshot) : null
  const leadGroupMismatch = shownLeadGroup !== null && leadSession !== null
    && (leadSession.groupId ?? null) !== shownLeadGroup
  // Reset-transfer conflicts (B2, D6 "explain the binding conflict"): an
  // attempt whose keyed result refused, or — for a transfer issued while this
  // panel was closed (the full-screen view), whose result was never observed
  // here — one the authoritative slot proves did not move the role onto the
  // created chat. Attempts that appear while mounted wait for their result.
  const transferAttempts = usePlanWorkspaceScopeStore(state => state.attempts[teamPath])
  const preexistingTransfers = useRef<Set<string> | null>(null)
  if (preexistingTransfers.current === null) {
    preexistingTransfers.current = new Set((transferAttempts ?? []).flatMap(attempt =>
      attempt.action.kind === 'sent' ? [attempt.action.requestId] : []))
  }
  const transferConflicts = useMemo(() => {
    const conflicts: Array<{ attempt: ResetTransferAttempt; role: PlanWorkspaceRole; error: string | null }> = []
    for (const attempt of transferAttempts ?? []) {
      const sent = attempt.action
      if (sent.kind !== 'sent') continue
      if (attempt.outcome) {
        if (!attempt.outcome.ok) conflicts.push({ attempt, role: sent.role, error: attempt.outcome.error })
        continue
      }
      if (!preexistingTransfers.current!.has(sent.requestId)) continue
      const current = bindings.find(entry => entry.role === sent.role) ?? null
      if (current?.sessionId !== attempt.newSessionId) {
        conflicts.push({ attempt, role: sent.role, error: null })
      }
    }
    return conflicts
  }, [transferAttempts, bindings])
  return <section data-testid="plan-workspace-conversation" aria-label="Repository conversation" className="mt-4 border border-border p-2">
    <div role="tablist" aria-label="Conversation role" className="flex gap-2">
      {(['architect', 'lead'] as const).map(entry => (
        <button key={entry} role="tab" aria-selected={entry === role} data-testid={`conversation-role-${entry}`}
          className={`btn text-chat-meta ${entry === role ? 'btn-primary' : ''}`}
          onClick={() => selectRole(entry)}>
          {ROLE_LABELS[entry]}{bindings.some(b => b.role === entry) ? '' : ' (unbound)'}
        </button>
      ))}
      <span className="ml-auto text-chat-meta text-secondary">
        {connected ? 'Bindings live' : 'Bindings unavailable offline'}
      </span>
    </div>
    {bindError !== null && <p role="alert" data-testid="conversation-bind-error" className="mt-1 text-chat-meta text-chat-danger">{bindError}</p>}
    {transferConflicts.map((conflict, index) => {
      const created = sessions.find(entry => entry.id === conflict.attempt.newSessionId)
      const holder = sessions.find(entry => entry.id === conflict.attempt.previousSessionId)
      return <p key={index} role="alert" data-testid="conversation-transfer-conflict"
        className="mt-1 text-chat-meta text-chat-danger">
        A reset created {created?.name ?? conflict.attempt.newSessionId}, but the {ROLE_LABELS[conflict.role]} role
        {' '}stays with {holder?.name ?? conflict.attempt.previousSessionId}
        {conflict.error ? `: ${conflict.error}` : ' — the binding moved on concurrently'}. Rebind explicitly if the new chat should take the role.
      </p>
    })}
    {binding === null && <div className="mt-2 text-chat-meta text-secondary" data-testid={`conversation-unbound-${role}`}>
      <p>No {ROLE_LABELS[role].toLowerCase()} chat is bound. Pick an existing same-team chat or create one; the role is a label, not an authority.</p>
      <RolePicker candidates={candidates} disabled={!connected} onPick={sessionId => {
        setAwaitingCreate(null) // an explicit pick abandons the create-then-bind arm
        bindRole(role, sessionId, null)
      }} />
      {onOpenNewSession && <button type="button" className="btn mt-1 text-chat-meta" disabled={!connected}
        data-testid={`conversation-new-chat-${role}`}
        onClick={() => {
          setAwaitingCreate({ role, expectedVersion: bindings.find(entry => entry.role === role)?.version ?? null })
          onOpenNewSession(created => { if (!created) setAwaitingCreate(null) })
        }}>
        New chat…{awaitingCreate?.role === role ? ' (binding after creation)' : ''}
      </button>}
      {!subscribe && <p className="mt-1">Create-then-bind and local reset are unavailable in this host: no chat lifecycle subscription.</p>}
    </div>}
    {binding !== null && <div className="mt-2" data-testid={`conversation-binding-${role}`}>
      <BindingLine binding={binding} session={boundSession} role={role} />
      {role === 'lead' && leadGroupMismatch && <p role="status" data-testid="conversation-lead-mismatch" className="text-chat-meta text-approval">
        The plan&rsquo;s Lead role is “{shownLeadGroup}”, but this chat&rsquo;s group is {leadSession!.groupLabel ?? leadSession!.groupId ?? 'none'}.
        The binding grants no authority; execution routing and decisions follow the plan.
      </p>}
      <RolePicker candidates={candidates.filter(entry => entry.id !== binding.sessionId)} disabled={!connected}
        label={`Replace ${ROLE_LABELS[role].toLowerCase()} with…`} onPick={sessionId => {
          setAwaitingCreate(null) // an explicit pick abandons the create-then-bind arm
          bindRole(role, sessionId, binding.version)
        }} />
    </div>}
    {boundSession && <ConversationHost key={`${role}:${boundSession.id}`} teamPath={teamPath}
      session={boundSession} role={role} connected={connected} connectionEpoch={connectionEpoch}
      sendMessage={sendMessage} subscribe={subscribe} selection={selection} />}
  </section>
}

/** The mounted conversation of the selected role — the only surface this panel attaches. */
function ConversationHost({ teamPath, session, role, connected, connectionEpoch, sendMessage, subscribe, selection }: {
  teamPath: string
  session: Session
  role: PlanWorkspaceRole
  connected: boolean
  connectionEpoch: number
  sendMessage: SendClientMessage
  subscribe?: (listener: (message: ServerMessage) => void) => () => void
  selection: ConversationSelection | null
}) {
  // The draft and its captured scope are per session, so switching roles
  // restores exactly what that session had; both hosts of a session share
  // them with the full-screen view (the full-screen composer shows the same
  // text and sends unscoped, per §6.3).
  const draftText = useChatStore(state => state.drafts[session.id] ?? '')
  const scope = usePlanWorkspaceScopeStore(state => state.scopes[session.id] ?? null)
  const previousText = useRef('')
  const selectionId = selection === null ? null : selectionKey(selection)
  // buildCapture freezes the selection; memoized so a re-render does not
  // mint a fresh capture object every time (the chip compares by value).
  const capture = useMemo(() => buildCapture(selection), [selectionId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const store = usePlanWorkspaceScopeStore.getState()
    const previous = previousText.current
    previousText.current = draftText
    if (draftText === '') {
      store.setScope(session.id, null)
      return
    }
    // Capture once, when the draft first becomes nonempty under this panel;
    // a draft that is already nonempty keeps whatever it captured. A draft
    // with nothing buildable to attach (no plan selected) stays unscoped.
    if (previous !== '' || store.scopes[session.id] || capture === null) return
    store.setScope(session.id, capture)
  }, [draftText, session.id, capture])
  return <ChatSurface session={session} sendMessage={sendMessage} subscribe={subscribe}
    connectionStatus={connected ? 'connected' : 'disconnected'} connectionEpoch={connectionEpoch}
    revealEnabled={false}
    onResetCreated={(newSessionId, previousSessionId) => transferBindingsOnReset(sendMessage, newSessionId, previousSessionId)}
    onSubmitContext={() => usePlanWorkspaceScopeStore.getState().scopes[session.id] ?? null}
    composerAttachment={<ScopeAttachment scope={scope} capture={capture} hasText={draftText.trim() !== ''}
      connected={connected} onReplace={next => usePlanWorkspaceScopeStore.getState().setScope(session.id, next)} />
    } />
}

/** The composer's attachment line: the captured scope, its mismatch with the current selection, and the explicit replace. */
function ScopeAttachment({ scope, capture, hasText, connected, onReplace }: {
  scope: CapturedWorkspaceScope | null
  capture: CapturedWorkspaceScope | null
  hasText: boolean
  connected: boolean
  onReplace: (next: CapturedWorkspaceScope) => void
}) {
  if (scope !== null) {
    const mismatch = capture === null || !sameEnvelope(scope.envelope, capture.envelope)
    return <div className="mb-2 flex flex-wrap items-baseline gap-2 border border-border px-2 py-1 text-chat-meta" data-testid="composer-scope">
      <span>Attached: {scope.planTitle} · {scopeLabel(scope)}</span>
      {mismatch && <>
        <span className="text-secondary">
          {capture === null ? 'Now showing no plan selection.' : `Now showing ${capture.planTitle} · ${scopeLabel(capture)} — sending keeps the attachment above.`}
        </span>
        <button type="button" className="btn text-chat-meta" disabled={!connected || capture === null || !hasText}
          data-testid="composer-scope-replace"
          onClick={() => capture !== null && onReplace(capture)}>Replace attachment</button>
      </>}
    </div>
  }
  if (capture !== null) {
    return <div className="mb-2 flex flex-wrap items-baseline gap-2 text-chat-meta text-secondary" data-testid="composer-scope-unattached">
      <span>{hasText ? 'Not attached (captured before a selection existed).' : 'Next message will attach:'} {capture.planTitle} · {scopeLabel(capture)}</span>
      <button type="button" className="btn text-chat-meta" disabled={!connected || !hasText} data-testid="composer-scope-attach"
        onClick={() => onReplace(capture)}>Attach selection</button>
    </div>
  }
  return <p className="mb-2 text-chat-meta text-secondary" data-testid="composer-scope-unscoped">
    Repository planning; no plan selected — messages send without a plan attachment.
  </p>
}

/** One bound role's durable pointer and its current availability (D6). */
function BindingLine({ binding, session, role }: {
  binding: WorkspaceBindingView
  session: Session | null
  role: PlanWorkspaceRole
}) {
  return <p className="text-chat-meta text-secondary" data-testid={`conversation-binding-line-${role}`}>
    {ROLE_LABELS[role]}: {session?.name ?? shortHash(binding.sessionId)}
    {' · '}{AVAILABILITY_LABELS[binding.availability]}
    {session && <> · group {session.groupLabel ?? session.groupId ?? 'none'}
      {' · profile '}{session.claudeProfileId ?? 'default'}
      {' · approval '}{session.approvalPolicy ?? 'manual'}</>}
  </p>
}

/** The same-team chat picker (existing sessions, other role's excluded). */
function RolePicker({ candidates, disabled, onPick, label = 'Bind existing chat…' }: {
  candidates: Session[]
  disabled: boolean
  onPick: (sessionId: string) => void
  label?: string
}) {
  return <label className="mt-1 block text-chat-meta text-secondary">
    {label}
    <select className="input ml-2 max-w-72 text-xs" data-testid="conversation-bind-picker" value=""
      disabled={disabled || candidates.length === 0}
      onChange={event => { if (event.target.value !== '') onPick(event.target.value) }}>
      <option value="">{candidates.length === 0 ? 'No same-team chats available' : 'Choose a chat…'}</option>
      {candidates.map(entry => (
        <option key={entry.id} value={entry.id}>
          {entry.name}{entry.archivedAt != null ? ' (archived)' : ''} — {entry.id.slice(0, 8)}
        </option>
      ))}
    </select>
  </label>
}

/** The captured identity's short label: version, execution, change, document. */
function scopeLabel(scope: CapturedWorkspaceScope): string {
  const envelope = scope.envelope
  const version = envelope.version.kind === 'revision'
    ? `revision ${envelope.version.revision} (${shortHash(envelope.version.contentHash)})`
    : `draft ${envelope.version.draftId} (${shortHash(envelope.version.contentHash)})`
  const parts = [version]
  if (envelope.executionId) parts.push(`execution ${shortHash(envelope.executionId)}`)
  if (envelope.changeName) parts.push(`change ${envelope.changeName}`)
  if (envelope.documentRefId) parts.push(`document ${shortHash(envelope.documentRefId)}`)
  return parts.join(' · ')
}

/**
 * Freezes the current selection into a captured scope; null when nothing
 * buildable exists (no plan open, or a plan with no displayable version —
 * those drafts send unscoped and say so).
 */
export function buildCapture(selection: ConversationSelection | null): CapturedWorkspaceScope | null {
  if (selection === null || selection.teamId === null) return null
  const displayed = selection.snapshot.displayedVersion
  if (displayed === null) return null
  const version = displayed.kind === 'revision'
    ? { kind: 'revision' as const, revision: displayed.revision, contentHash: displayed.contentHash }
    : { kind: 'draft' as const, draftId: displayed.draftId, contentHash: displayed.contentHash }
  const envelope: WorkspaceMessageEnvelope = {
    teamId: selection.teamId,
    planId: selection.snapshot.plan.id,
    version,
    ...(selection.executionId !== null && selection.snapshot.execution
      ? { executionId: selection.snapshot.execution.executionId, executionRevision: selection.snapshot.execution.revision }
      : {}),
    ...(selection.selectedChange !== null ? { changeName: selection.selectedChange } : {}),
    ...documentIdentity(selection),
  }
  return { envelope, planTitle: selection.snapshot.plan.title, capturedAt: new Date().toISOString() }
}

/** A selected document refines the envelope only when it maps to a labelled reference (the server validates the ref by id). */
function documentIdentity(selection: ConversationSelection): Partial<WorkspaceMessageEnvelope> {
  const document = selection.selectedDocument
  if (document === null) return {}
  const ref = selection.snapshot.references.find(candidate =>
    candidate.worktreeId === document.worktreeId && candidate.relativePath === document.relativePath)
  if (!ref) return {}
  return { documentRefId: ref.id }
}

function selectionKey(selection: ConversationSelection): string {
  return JSON.stringify([selection.snapshot.displayedVersion, selection.snapshot.execution,
    selection.selectedChange, selection.selectedDocument])
}

function shownRevisionLeadGroup(detail: PlanDetail, snapshot: WorkspaceSnapshot): string | null {
  const displayed = snapshot.displayedVersion
  const content = displayed === null ? null : displayed.kind === 'draft'
    ? detail.drafts.find(draft => draft.draftId === displayed.draftId)?.content ?? null
    : detail.revisions.find(revision => revision.revision === displayed.revision)?.content ?? null
  return content?.leadGroup ?? null
}
