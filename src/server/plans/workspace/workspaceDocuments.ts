// Document and checklist subscriptions with hash, provenance and
// invalidation (plan-workspace 2.4, design D4; CP1 §5 as amended by B7/B8).
//
// Supported formats and source rules (module docs, B7):
// - Sources resolve through ChangeArtifactsResolver (2.1): the canonical
//   source only — the convention worktree once listed, else the main
//   checkout; a listed worktree lacking the change reads
//   `missing-in-worktree`; an archive resolves to its unique entry; a change
//   absent from both listings reads `missing`; two archive entries are
//   `ambiguous`; any CLI failure is `cli-unavailable`. A missing source is
//   never substituted from another worktree.
// - Markdown: `.md`/`.markdown`, valid UTF-8, at most 1 MiB; its text rides
//   the WS snapshot. Images: PNG/JPEG/WebP/GIF at most 10 MiB; image bytes
//   never ride WS — the asset route (`/api/plan-workspace/asset`) serves
//   them under the same INVARIANT S checks. HTML and SVG are never served.
// - Every read goes through readWorkspaceDocument (2.3): bytes come only
//   from a regular file inside the permitted root, opened race-safely,
//   within the type's bound — everything else returns no content and names
//   its reason, carried on the view as `reason`.
// - Provenance: worktree id, relative path, sha256 content hash, size,
//   mtime, availability and staleness, and the execution pin's match. The
//   pin is worktree-scoped (O1): the newest attempt of the execution change
//   provisioned in the document's own worktree — never another change's
//   attempt, and nothing for a worktree no change of the execution occupies
//   (the main checkout included). The comparison is convention-comparable
//   (B1): only markdown within the git output bound, fatally valid UTF-8 and
//   BOM-free compares; everything else — no execution, no attempt, no
//   occupied worktree, a path absent from the map, an image, a BOM, invalid
//   UTF-8, or a view without current content — reads `unknown` (D4: never
//   inferred, never a false mismatch). executionPin.ts owns the rule.
// - Invalidation: dedicated non-recursive watches on each selected
//   document's parent directory and each expanded change's artifact
//   directory, debounced (WORKSPACE_WATCH_DEBOUNCE_MS), plus a
//   WORKSPACE_RECONCILE_INTERVAL_MS pass re-reading every subscribed source.
//   The watcher is the latency optimization; the period is the correctness
//   mechanism (inotify misses new directories and events). The cache is
//   server memory only — rebuilt at restart, never persisted, no exclusive
//   slot — so the recovery matrix names only the missed-watch fault the
//   reconciliation pass recovers.
import fs from 'node:fs'
import path from 'node:path'
import type { WorkspaceWatcherHost } from '../../workspace/workspaceWatcher'
import {
  WORKSPACE_RECONCILE_INTERVAL_MS, WORKSPACE_WATCH_DEBOUNCE_MS, createNodeWatcherHost,
} from '../../workspace/workspaceWatcher'
import { SourceWatcher } from './documentWatcher'
import type {
  WorkspaceChecklist, WorkspaceChecklistUnavailable, WorkspaceDocumentView,
} from '../../../shared/planWorkspace'
import { unknownTeamError } from '../../../shared/team'
import type { PlanWorkspaceClientMessage } from '../../../shared/planWorkspaceMessages'
import type { ChatSessionManager } from '../../chat/ChatSessionManager'
import type { ChatConnection } from '../../chat/ChatConnections'
import { ChangeArtifactsResolver } from './changeArtifacts'
import { PlanChecklistTotals } from './checklistTotals'
import { projectChecklist } from './checklistProjection'
import { normalizeRelativeDocumentPath, readWorkspaceDocument } from './documentReader'
import { executionMatchFor, type ExecutionPin, type ExecutionPinStore } from './executionPin'

/** One subscribed document: the request's identity plus the composed view. */
interface DocumentSubscription {
  teamId: string
  planId: string
  worktreeId: string
  relativePath: string
  executionId: string | null
  /** The parent directory to watch; null when the path is lexically invalid. */
  watchDir: string | null
  view: WorkspaceDocumentView | null
}

/** One subscribed change checklist: the request's identity plus the last push. */
interface ChecklistSubscription {
  teamId: string
  planId: string
  changeName: string
  /** The team's main checkout, resolved at open (the 2.1 canonical root). */
  mainRoot: string
  /** The resolved change root (the watch target); null while unresolved. */
  changeRoot: string | null
  push: { checklist: WorkspaceChecklist | null; unavailable: WorkspaceChecklistUnavailable | null } | null
}

type WorkspaceDocumentMessage = Extract<PlanWorkspaceClientMessage, {
  type: 'team-plan-workspace-checklist-open' | 'team-plan-workspace-checklist-close'
    | 'team-plan-workspace-document-open' | 'team-plan-workspace-document-close'
}>

interface TeamSubscriptions {
  teamId: string
  checklists: Map<string, ChecklistSubscription>
  documents: Map<string, DocumentSubscription>
}

const checklistKey = (planId: string, changeName: string): string => `${planId}\0${changeName}`
const documentKey = (worktreeId: string, relativePath: string): string => `${worktreeId}\0${relativePath}`

/** The node host with the reconciliation interval unref'd (never holds shutdown). */
function unrefReconciliation(host: WorkspaceWatcherHost): WorkspaceWatcherHost {
  return {
    ...host,
    setReconciliationInterval: (callback, ms) => {
      const handle = host.setReconciliationInterval(callback, ms)
      ;(handle as { unref?: () => void })?.unref?.()
      return handle
    },
  }
}

/**
 * The plan workspace's document and checklist subscriptions (2.4). Every
 * request names the team's directory (`teamPath`); the team, the plan and —
 * for documents — the worktree membership are checked before any read, and
 * another team's ids are refused with no data, mirroring
 * planWorkspaceConnections. Refreshes are serialized per source, pushed only
 * when the composed view changed, and never start an agent.
 */
export class PlanWorkspaceDocumentConnections {
  private readonly subscriptions = new Map<ChatConnection, Map<string, TeamSubscriptions>>()
  /** Latest open/close per connection and target; a later one supersedes an in-flight open. */
  private readonly pending = new Map<ChatConnection, Map<string, object>>()
  /** Per-source refresh chains, so two racing invalidations push in order. */
  private readonly chains = new Map<string, Promise<void>>()
  private readonly resolver: ChangeArtifactsResolver
  private readonly read: typeof readWorkspaceDocument
  private readonly watcher: SourceWatcher
  /** The composed checklists' totals, read by the workspace snapshot (N3). */
  private readonly totals: PlanChecklistTotals
  /** Set by stop(): a refresh that raced the shutdown is dropped, not answered. */
  private stopped = false

  constructor(
    private readonly manager: ChatSessionManager,
    options: {
      resolver?: ChangeArtifactsResolver
      read?: typeof readWorkspaceDocument
      host?: WorkspaceWatcherHost
      debounceMs?: number
      reconcileIntervalMs?: number
      /** Receives every composed checklist's totals for the workspace rows (N3). */
      totals?: PlanChecklistTotals
    } = {},
  ) {
    this.totals = options.totals ?? new PlanChecklistTotals()
    this.resolver = options.resolver ?? new ChangeArtifactsResolver()
    this.read = options.read ?? readWorkspaceDocument
    // Production host: the navigator watcher's node adapter, with the
    // reconciliation interval unref'd — it must never hold the process at
    // shutdown (the executor timer's rule).
    const host = options.host ?? unrefReconciliation(createNodeWatcherHost(fs))
    this.watcher = new SourceWatcher({
      host,
      onPathsChanged: paths => this.refreshAffected(paths),
      onReconcile: () => this.refreshAll(),
      debounceMs: options.debounceMs ?? WORKSPACE_WATCH_DEBOUNCE_MS,
      reconcileIntervalMs: options.reconcileIntervalMs ?? WORKSPACE_RECONCILE_INTERVAL_MS,
    })
    this.watcher.start()
  }

  disconnect(connection: ChatConnection): void {
    this.subscriptions.delete(connection)
    this.pending.delete(connection)
    this.updateWatchTargets()
  }

  /** Close every watch and timer; the subscriptions die with it (shutdown, tests). */
  stop(): void {
    this.stopped = true
    this.subscriptions.clear()
    this.pending.clear()
    this.watcher.stop()
  }

  handle(connection: ChatConnection, message: WorkspaceDocumentMessage): Promise<void> {
    if (message.type === 'team-plan-workspace-checklist-open') return this.checklistOpen(connection, message)
    if (message.type === 'team-plan-workspace-document-open') return this.documentOpen(connection, message)
    const target = `${message.teamPath}\0${message.planId}`
    const token = {}
    const pending = this.pending.get(connection) ?? new Map<string, object>()
    pending.set(target, token)
    this.pending.set(connection, pending)
    const views = this.subscriptions.get(connection)
    const subscription = views?.get(message.teamPath)
    if (message.type === 'team-plan-workspace-checklist-close') {
      subscription?.checklists.delete(checklistKey(message.planId, message.changeName))
    } else {
      subscription?.documents.delete(documentKey(path.resolve(message.worktreeId), message.relativePath))
    }
    if (subscription && subscription.checklists.size === 0 && subscription.documents.size === 0) views!.delete(message.teamPath)
    this.dropPending(connection, target, token)
    this.updateWatchTargets()
    return Promise.resolve()
  }

  /** Retire an open/close reservation, but only while it is still the latest one for its target. */
  private dropPending(connection: ChatConnection, target: string, token: object): void {
    const pending = this.pending.get(connection)
    if (pending?.get(target) === token) pending.delete(target)
  }

  private async checklistOpen(connection: ChatConnection, message: Extract<WorkspaceDocumentMessage, { type: 'team-plan-workspace-checklist-open' }>): Promise<void> {
    const { teamPath, planId, changeName } = message
    const target = `${teamPath}\0${planId}`
    const token = {}
    const pending = this.pending.get(connection) ?? new Map<string, object>()
    pending.set(target, token)
    this.pending.set(connection, pending)
    if (typeof changeName !== 'string' || changeName.trim() === '') {
      // A refused open leaves nothing behind (F3's rule): drop the token.
      this.dropPending(connection, target, token)
      connection.send({ type: 'error', message: 'Malformed change name.' })
      return
    }
    const team = await this.manager.teamScopes.resolve(teamPath)
    if (this.pending.get(connection)?.get(target) !== token) return
    this.pending.get(connection)?.delete(target)
    if (!team) {
      connection.send({ type: 'error', message: unknownTeamError(teamPath) })
      return
    }
    if (!this.manager.plans.store.forTeam(team.teamId, planId)) {
      connection.send({ type: 'error', message: `Plan not found in this team: ${planId}` })
      return
    }
    const views = this.subscriptions.get(connection) ?? new Map<string, TeamSubscriptions>()
    this.subscriptions.set(connection, views)
    const current = views.get(teamPath)
    const subscription = current?.teamId === team.teamId ? current : { teamId: team.teamId, checklists: new Map(), documents: new Map() }
    views.set(teamPath, subscription)
    const sub: ChecklistSubscription = { teamId: team.teamId, planId, changeName, mainRoot: team.groupsRoot, changeRoot: null, push: null }
    subscription.checklists.set(checklistKey(planId, changeName), sub)
    this.updateWatchTargets()
    // The open's first snapshot is authoritative: awaited, not pushed.
    await this.enqueue(`${team.teamId}\0${checklistKey(planId, changeName)}`, () => this.refreshChecklist(connection, teamPath, sub))
  }

  private async documentOpen(connection: ChatConnection, message: Extract<WorkspaceDocumentMessage, { type: 'team-plan-workspace-document-open' }>): Promise<void> {
    const { teamPath, planId } = message
    const target = `${teamPath}\0${planId}`
    const token = {}
    const pending = this.pending.get(connection) ?? new Map<string, object>()
    pending.set(target, token)
    this.pending.set(connection, pending)
    const worktreeId = path.resolve(typeof message.worktreeId === 'string' ? message.worktreeId : '')
    if (worktreeId === '' || message.worktreeId === '' || typeof message.worktreeId !== 'string') {
      this.dropPending(connection, target, token)
      connection.send({ type: 'error', message: 'Malformed worktree id.' })
      return
    }
    const team = await this.manager.teamScopes.resolve(teamPath)
    if (this.pending.get(connection)?.get(target) !== token) return
    this.pending.get(connection)?.delete(target)
    if (!team) {
      connection.send({ type: 'error', message: unknownTeamError(teamPath) })
      return
    }
    if (!this.manager.plans.store.forTeam(team.teamId, planId)) {
      connection.send({ type: 'error', message: `Plan not found in this team: ${planId}` })
      return
    }
    // Membership before any read, lexically (B8.3): the request's worktree is
    // resolved, then compared against the team's listed roots — never resolved
    // through the filesystem here.
    const listed = await this.manager.tasks.worktrees.list(team.teamId)
    if (!listed.some(root => path.resolve(root) === worktreeId)) {
      connection.send({ type: 'error', message: 'Worktree not listed in this team.' })
      return
    }
    if (message.executionId !== undefined && !this.executionFor(team.teamId, planId, message.executionId)) {
      connection.send({ type: 'error', message: `Execution not found in this plan: ${message.executionId}` })
      return
    }
    const views = this.subscriptions.get(connection) ?? new Map<string, TeamSubscriptions>()
    this.subscriptions.set(connection, views)
    const current = views.get(teamPath)
    const subscription = current?.teamId === team.teamId ? current : { teamId: team.teamId, checklists: new Map(), documents: new Map() }
    views.set(teamPath, subscription)
    const normalized = normalizeRelativeDocumentPath(message.relativePath)
    const sub: DocumentSubscription = {
      teamId: team.teamId, planId, worktreeId,
      relativePath: typeof message.relativePath === 'string' ? message.relativePath : '',
      executionId: message.executionId ?? null,
      watchDir: normalized.ok ? path.dirname(path.join(worktreeId, normalized.normalized)) : null,
      view: null,
    }
    subscription.documents.set(documentKey(worktreeId, sub.relativePath), sub)
    this.updateWatchTargets()
    await this.enqueue(documentChainKey(worktreeId, sub.relativePath), () => this.refreshDocument(connection, teamPath, sub))
  }

  /** Serialize refreshes per source, so two racing invalidations push in order. */
  private enqueue(key: string, body: () => Promise<void>): Promise<void> {
    const previous = this.chains.get(key) ?? Promise.resolve()
    const next = previous.then(body, body)
    this.chains.set(key, next)
    const settled = () => {
      if (this.chains.get(key) === next) this.chains.delete(key)
    }
    next.then(settled, settled)
    return next
  }

  private async refreshChecklist(connection: ChatConnection, teamPath: string, sub: ChecklistSubscription): Promise<void> {
    if (this.stopped) return // A refresh that raced the shutdown is dropped, not answered.
    const payload = await this.composeChecklist(sub)
    // The totals ride every compose, push or not: the workspace's runtime
    // rows read the last composed value (N3). A checklist or document
    // refresh itself never pushes the workspace projection (CP1).
    this.totals.record(sub.teamId, sub.planId, sub.changeName, payload.checklist)
    if (JSON.stringify(payload) === JSON.stringify(sub.push)) return
    sub.push = payload
    connection.send({ type: 'team-plan-workspace-checklist', teamPath, planId: sub.planId, changeName: sub.changeName, ...payload })
    this.updateWatchTargets()
  }

  private async refreshDocument(connection: ChatConnection, teamPath: string, sub: DocumentSubscription): Promise<void> {
    if (this.stopped) return // A refresh that raced the shutdown is dropped, not answered.
    const view = await this.composeDocument(sub)
    if (JSON.stringify(view) === JSON.stringify(sub.view)) return
    sub.view = view
    connection.send({ type: 'team-plan-workspace-document', teamPath, planId: sub.planId, worktreeId: sub.worktreeId, relativePath: sub.relativePath, view })
  }

  private async composeChecklist(sub: ChecklistSubscription): Promise<{ checklist: WorkspaceChecklist | null; unavailable: WorkspaceChecklistUnavailable | null }> {
    try {
      const resolution = await this.resolver.resolve(sub.changeName, {
        mainRoot: sub.mainRoot,
        worktreeRoots: await this.manager.tasks.worktrees.list(sub.teamId),
      })
      if (!resolution.ok) {
        sub.changeRoot = null
        return { checklist: null, unavailable: { state: resolution.state, message: resolution.message } }
      }
      sub.changeRoot = resolution.changeRoot
      const tasks = resolution.artifacts.filter(artifact => artifact.kind === 'tasks')
      if (tasks.length === 0) {
        return { checklist: null, unavailable: { state: 'unreadable', message: `Change "${sub.changeName}" has no tasks artifact.` } }
      }
      const read = await this.read(resolution.changeRoot, tasks[0]!.relativePath)
      if (!read.ok || read.kind !== 'markdown') {
        const why = read.ok ? 'not markdown' : read.reason
        return { checklist: null, unavailable: { state: 'unreadable', message: `The tasks artifact of "${sub.changeName}" is unreadable (${why}).` } }
      }
      return { checklist: projectChecklist(read.text, read.hash), unavailable: null }
    } catch (error) {
      // Compose is total (O3): an open always answers, so a throwing
      // resolver, listing or read names the existing `unreadable` state.
      return { checklist: null, unavailable: { state: 'unreadable', message: `The checklist of "${sub.changeName}" could not be composed (${errorText(error)}).` } }
    }
  }

  private async composeDocument(sub: DocumentSubscription): Promise<WorkspaceDocumentView> {
    try {
      const result = await this.read(sub.worktreeId, sub.relativePath)
      if (result.ok) {
        const { match, executionId } = executionMatchFor(
          this.pinFor(sub.teamId, sub.planId, sub.executionId, sub.worktreeId), sub.relativePath,
          { kind: result.kind, hash: result.hash, size: result.size, bytes: result.bytes },
        )
        return {
          worktreeId: sub.worktreeId, relativePath: sub.relativePath,
          kind: result.kind, availability: 'current', stale: false, reason: null,
          executionMatch: match, executionId,
          contentHash: result.hash, size: result.size, mtimeMs: result.mtimeMs,
          text: result.kind === 'markdown' ? result.text : null,
        }
      }
      // Refused: hold last-valid content, labelled stale; with nothing held the
      // view names the refusal and serves nothing. Either way the execution
      // match stays unknown — last-valid content is never a pin comparison.
      return this.unavailableDocument(sub, result.reason)
    } catch (error) {
      // Compose is total (O3): an open always answers, so a throwing reader
      // names the failure on the view's `missing` state instead of dropping
      // the snapshot. Like a refused read, last-valid content is held stale
      // and the execution match stays unknown.
      return this.unavailableDocument(sub, `The document could not be read (${errorText(error)}).`)
    }
  }

  /** A view without content: the reason named, last-valid held stale when there is one. */
  private unavailableDocument(sub: DocumentSubscription, reason: string): WorkspaceDocumentView {
    const previous = sub.view
    if (previous && previous.contentHash !== null) {
      return { ...previous, availability: 'missing', stale: true, reason, executionMatch: 'unknown' }
    }
    return {
      worktreeId: sub.worktreeId, relativePath: sub.relativePath,
      kind: null, availability: 'missing', stale: false, reason,
      executionMatch: 'unknown', executionId: null,
      contentHash: null, size: null, mtimeMs: null, text: null,
    }
  }

  /** Watch events: re-read every subscribed source the changed paths touch. */
  private refreshAffected(paths: readonly string[]): void {
    for (const [connection, views] of this.subscriptions) {
      for (const [teamPath, subscription] of views) {
        for (const sub of subscription.documents.values()) {
          if (sub.watchDir === null) continue
          const normalized = normalizeRelativeDocumentPath(sub.relativePath)
          const absPath = normalized.ok ? path.join(sub.worktreeId, normalized.normalized) : null
          if (absPath === null || !paths.some(changed => touchesDocument(changed, absPath))) continue
          void this.enqueue(documentChainKey(sub.worktreeId, sub.relativePath), () => this.refreshDocument(connection, teamPath, sub))
        }
        for (const sub of subscription.checklists.values()) {
          if (sub.changeRoot === null) continue
          if (!paths.some(changed => touchesTree(changed, sub.changeRoot!))) continue
          void this.enqueue(`${sub.teamId}\0${checklistKey(sub.planId, sub.changeName)}`, () => this.refreshChecklist(connection, teamPath, sub))
        }
      }
    }
  }

  /** The correctness mechanism: re-read every subscribed source, resolved or not. */
  private refreshAll(): void {
    for (const [connection, views] of this.subscriptions) {
      for (const [teamPath, subscription] of views) {
        for (const sub of subscription.documents.values()) {
          void this.enqueue(documentChainKey(sub.worktreeId, sub.relativePath), () => this.refreshDocument(connection, teamPath, sub))
        }
        for (const sub of subscription.checklists.values()) {
          void this.enqueue(`${sub.teamId}\0${checklistKey(sub.planId, sub.changeName)}`, () => this.refreshChecklist(connection, teamPath, sub))
        }
      }
    }
  }

  /**
   * The selected execution: the named id, or the plan's latest (D2). It must
   * belong to this team and plan — a foreign id names no execution.
   */
  private executionFor(teamId: string, planId: string, requested: string | null) {
    const store = this.manager.planExecutionStore
    const execution = requested !== null ? store.execution(requested) : store.latestForPlan(planId)
    if (!execution || execution.teamId !== teamId || execution.planId !== planId) return null
    return execution
  }

  /**
   * The execution pin, worktree-scoped (O1): the newest attempt of the one
   * execution change provisioned in the document's worktree. No change of
   * the execution occupies that worktree (the main checkout, another plan's
   * worktree), or the change has no attempt yet — no pin. Another change's
   * attempt never speaks for this worktree.
   */
  private pinFor(teamId: string, planId: string, requested: string | null, worktreeId: string): ExecutionPin | null {
    const store: ExecutionPinStore = this.manager.planExecutionStore
    const execution = this.executionFor(teamId, planId, requested)
    if (!execution) return null
    const change = store.changes(execution.id).find(candidate =>
      candidate.worktree !== null && path.resolve(candidate.worktree) === worktreeId)
    if (!change) return null
    const attempt = store.latestAttemptForChange(execution.id, change.change)
    return attempt ? { executionId: execution.id, artifacts: attempt.manifest.artifacts } : null
  }

  /** The team's main checkout — the subscription carries it, resolved at open. */

  private updateWatchTargets(): void {
    const dirs = new Set<string>()
    for (const views of this.subscriptions.values()) {
      for (const subscription of views.values()) {
        for (const sub of subscription.documents.values()) if (sub.watchDir !== null) dirs.add(sub.watchDir)
        for (const sub of subscription.checklists.values()) if (sub.changeRoot !== null) dirs.add(sub.changeRoot)
      }
    }
    this.watcher.setTargets(dirs)
  }
}

const documentChainKey = (worktreeId: string, relativePath: string): string => `document\0${worktreeId}\0${relativePath}`

/** The error's own text, for a reason or message that names the failure. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A watch event touches a document when it is the file, inside its directory, or an ancestor of it. */
function touchesDocument(changed: string, absPath: string): boolean {
  return changed === absPath || changed === path.dirname(absPath)
    || absPath.startsWith(changed + path.sep) || changed.startsWith(absPath + path.sep)
}

/** A watch event touches a change tree when either path contains the other. */
function touchesTree(changed: string, root: string): boolean {
  return changed === root || root.startsWith(changed + path.sep) || changed.startsWith(root + path.sep)
}
