// Canonical artifact enumeration subscriptions (plan-workspace 5.3, S1–S3,
// MiMo disposition B1–B5). One change's artifacts resolve through the
// existing ChangeArtifactsResolver (2.1, its pool and D4 containment); the
// wire names only the source worktree's exact listed root and
// worktree-relative descriptor paths — the resolver's absolute change or
// archive roots never leave the server (Lead b57a7360). Enumeration is
// lazy: descriptors only, no body reads, no hash fanout across the spec
// cap; hash, size, mtime and availability come from the selected
// document-open alone (B2), so unobserved metadata stays unknown.
import fs from 'node:fs'
import path from 'node:path'
import type { ChatSessionManager } from '../../chat/ChatSessionManager'
import type { ChatConnection } from '../../chat/ChatConnections'
import type {
  WorkspaceArtifactDescriptor, WorkspaceArtifactsSource, WorkspaceArtifactsView,
} from '../../../shared/planWorkspace'
import type { PlanWorkspaceClientMessage } from '../../../shared/planWorkspaceMessages'
import { unknownTeamError } from '../../../shared/team'
import { CHANGE_WORKTREES_DIR } from '../../../shared/workspace'
import type { ChangeArtifactsResolution } from './changeArtifacts'
import { ChangeArtifactsResolver } from './changeArtifacts'
import { SourceWatcher } from './documentWatcher'
import type { WorkspaceWatcherHost } from '../../workspace/workspaceWatcher'
import { WORKSPACE_RECONCILE_INTERVAL_MS, WORKSPACE_WATCH_DEBOUNCE_MS, createNodeWatcherHost } from '../../workspace/workspaceWatcher'
import { normalizeRelativeDocumentPath } from './documentReader'

type WorkspaceArtifactsMessage = Extract<PlanWorkspaceClientMessage, {
  type: 'team-plan-workspace-artifacts-open' | 'team-plan-workspace-artifacts-close'
}>

/** One subscribed change: the request's identity plus the last pushed view. */
interface ArtifactsSubscription {
  teamId: string
  planId: string
  changeName: string
  /** The team's main checkout, resolved at open (the 2.1 canonical root). */
  mainRoot: string
  /** The resolved change root (the watch target); null while unresolved. */
  changeRoot: string | null
  push: WorkspaceArtifactsView | null
}

interface TeamArtifacts {
  teamId: string
  artifacts: Map<string, ArtifactsSubscription>
}

const artifactsKey = (planId: string, changeName: string): string => `${planId}\0${changeName}`

/**
 * B5: the change name's shape, checked before any resolver or listing call
 * on open and close alike — one path segment, no separators, no traversal,
 * no absolute form. Errors name the shape, never a path.
 */
export const isChangeNameShape = (value: unknown): value is string => {
  if (typeof value !== 'string') return false
  if (value.trim() === '') return false
  if (value.includes('/') || value.includes('\\') || value.includes('\0')) return false
  if (value === '.' || value === '..') return false
  return !path.isAbsolute(value)
}

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
 * The plan workspace's canonical artifact subscriptions (5.3). Every request
 * names the team's directory (`teamPath`); the team, the plan and the change
 * name's shape are checked before any resolver call, mirroring
 * planWorkspaceDocuments. Refreshes serialize per source, push only when
 * the enumeration changed, and never start an agent.
 */
export class PlanWorkspaceArtifactsConnections {
  private readonly subscriptions = new Map<ChatConnection, Map<string, TeamArtifacts>>()
  /** Latest open/close per connection and target; a later one supersedes an in-flight open. */
  private readonly pending = new Map<ChatConnection, Map<string, object>>()
  /** Per-source refresh chains, so two racing invalidations push in order. */
  private readonly chains = new Map<string, Promise<void>>()
  private readonly resolver: ChangeArtifactsResolver
  private readonly watcher: SourceWatcher
  /** Set by stop(): a refresh that raced the shutdown is dropped, not answered. */
  private stopped = false

  constructor(
    private readonly manager: ChatSessionManager,
    options: {
      resolver?: ChangeArtifactsResolver
      host?: WorkspaceWatcherHost
      debounceMs?: number
      reconcileIntervalMs?: number
    } = {},
  ) {
    this.resolver = options.resolver ?? new ChangeArtifactsResolver()
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

  handle(connection: ChatConnection, message: WorkspaceArtifactsMessage): Promise<void> {
    return message.type === 'team-plan-workspace-artifacts-open'
      ? this.open(connection, message)
      : this.closeArtifact(connection, message)
  }

  /** Retire an open/close reservation, but only while it is still the latest one for its target. */
  private dropPending(connection: ChatConnection, target: string, token: object): void {
    const pending = this.pending.get(connection)
    if (pending?.get(target) === token) pending.delete(target)
  }

  private async open(connection: ChatConnection, message: Extract<WorkspaceArtifactsMessage, { type: 'team-plan-workspace-artifacts-open' }>): Promise<void> {
    const { teamPath, planId, changeName } = message
    const target = `${teamPath}\0${planId}`
    const token = {}
    const pending = this.pending.get(connection) ?? new Map<string, object>()
    pending.set(target, token)
    this.pending.set(connection, pending)
    // B5: the shape is refused before the team resolve and any listing.
    if (!isChangeNameShape(changeName)) {
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
    const views = this.subscriptions.get(connection) ?? new Map<string, TeamArtifacts>()
    this.subscriptions.set(connection, views)
    const current = views.get(teamPath)
    const subscription = current?.teamId === team.teamId ? current : { teamId: team.teamId, artifacts: new Map() }
    views.set(teamPath, subscription)
    const sub: ArtifactsSubscription = { teamId: team.teamId, planId, changeName, mainRoot: team.groupsRoot, changeRoot: null, push: null }
    subscription.artifacts.set(artifactsKey(planId, changeName), sub)
    this.updateWatchTargets()
    // The open's first push is authoritative: awaited, not fire-and-forget.
    await this.enqueue(`${team.teamId}\0${artifactsKey(planId, changeName)}`, () => this.refresh(connection, teamPath, sub))
  }

  private closeArtifact(connection: ChatConnection, message: Extract<WorkspaceArtifactsMessage, { type: 'team-plan-workspace-artifacts-close' }>): Promise<void> {
    const target = `${message.teamPath}\0${message.planId}`
    const token = {}
    const pending = this.pending.get(connection) ?? new Map<string, object>()
    pending.set(target, token)
    this.pending.set(connection, pending)
    if (!isChangeNameShape(message.changeName)) {
      this.dropPending(connection, target, token)
      connection.send({ type: 'error', message: 'Malformed change name.' })
      return Promise.resolve()
    }
    const views = this.subscriptions.get(connection)
    const subscription = views?.get(message.teamPath)
    subscription?.artifacts.delete(artifactsKey(message.planId, message.changeName))
    if (subscription && subscription.artifacts.size === 0) views!.delete(message.teamPath)
    this.dropPending(connection, target, token)
    this.updateWatchTargets()
    return Promise.resolve()
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

  private async refresh(connection: ChatConnection, teamPath: string, sub: ArtifactsSubscription): Promise<void> {
    if (this.stopped) return // A refresh that raced the shutdown is dropped, not answered.
    const view = await this.compose(sub)
    // B3: a close, a disconnect or a replacement that raced this refresh
    // tears the subscription down — the stale composition is dropped, never
    // pushed, and the chain's next run finds nothing subscribed.
    if (this.subscriptions.get(connection)?.get(teamPath)?.artifacts.get(artifactsKey(sub.planId, sub.changeName)) !== sub) return
    if (JSON.stringify(view) === JSON.stringify(sub.push)) return
    sub.push = view
    connection.send({ type: 'team-plan-workspace-artifacts', teamPath, planId: sub.planId, changeName: sub.changeName, view })
    this.updateWatchTargets()
  }

  /** Compose is total (O3): an open always answers, so a throw names its state. */
  private async compose(sub: ArtifactsSubscription): Promise<WorkspaceArtifactsView> {
    try {
      const worktreeRoots = await this.manager.tasks.worktrees.list(sub.teamId)
      const resolution = await this.resolver.resolve(sub.changeName, {
        mainRoot: sub.mainRoot,
        worktreeRoots,
      })
      if (!resolution.ok) {
        sub.changeRoot = null
        // The resolver's own messages name change names and exit codes,
        // never absolute paths — verified against every state it returns.
        return { ok: false, state: resolution.state, message: resolution.message }
      }
      return this.mapResolution(sub, resolution, worktreeRoots)
    } catch (error) {
      sub.changeRoot = null
      return {
        ok: false, state: 'cli-unavailable',
        message: `The artifacts of "${sub.changeName}" could not be enumerated (${errorText(error)}).`,
      }
    }
  }

  /**
   * B1, one rule for active and archive sources alike: the artifact's
   * absolute path (change root + its change-relative path) must lexically
   * stay inside the source worktree's root, whose exact listed entry becomes
   * the wire `worktreeId`. An escape refuses the whole view — nothing is
   * mapped, nothing exposed. The path spaces stay separate (B2): the
   * resolver reads change-relative, the wire carries worktree-relative.
   */
  private mapResolution(
    sub: ArtifactsSubscription,
    resolution: ChangeArtifactsResolution & { ok: true },
    worktreeRoots: readonly string[],
  ): WorkspaceArtifactsView {
    const sourceRoot = this.sourceRootFor(sub.mainRoot, sub.changeName, worktreeRoots)
    // The wire id is the exact listed entry matching the source root —
    // verbatim, never the resolved candidate (the team may list it with a
    // different spelling). The main checkout is always listed, so a miss
    // means the source is not a known worktree of this team.
    const listed = worktreeRoots.find(root => path.resolve(root) === path.resolve(sourceRoot))
    if (listed === undefined) return this.uncontained(sub)
    const descriptors: WorkspaceArtifactDescriptor[] = []
    for (const artifact of resolution.artifacts) {
      const absolute = path.join(resolution.changeRoot, artifact.relativePath)
      const relative = path.relative(sourceRoot, absolute)
      if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return this.uncontained(sub)
      const normalized = normalizeRelativeDocumentPath(relative.split(path.sep).join('/'))
      if (!normalized.ok) return this.uncontained(sub)
      descriptors.push({ kind: artifact.kind, relativePath: normalized.normalized })
    }
    sub.changeRoot = resolution.changeRoot
    const source: WorkspaceArtifactsSource = resolution.source.kind === 'archive'
      ? { kind: 'archive', worktreeId: listed, entry: resolution.source.entry }
      : { kind: resolution.source.kind, worktreeId: listed }
    return { ok: true, changeName: sub.changeName, source, artifacts: descriptors }
  }

  /** A view that exposes nothing: the named fail-closed state, no paths. */
  private uncontained(sub: ArtifactsSubscription): WorkspaceArtifactsView {
    sub.changeRoot = null
    return {
      ok: false, state: 'uncontained',
      message: `An artifact of "${sub.changeName}" does not stay inside the source worktree's listed root; nothing is exposed.`,
    }
  }

  /**
   * The resolver's own source decision, recomputed for the mapping: the
   * convention worktree once listed, else the main checkout — the same
   * comparison the resolver makes, so both spaces never disagree.
   */
  private sourceRootFor(mainRoot: string, changeName: string, worktreeRoots: readonly string[]): string {
    const convention = path.join(path.resolve(mainRoot), CHANGE_WORKTREES_DIR, changeName)
    return worktreeRoots.some(root => path.resolve(root) === convention) ? convention : path.resolve(mainRoot)
  }

  /** Watch events: re-enumerate every subscribed change the changed paths touch. */
  private refreshAffected(paths: readonly string[]): void {
    for (const [connection, views] of this.subscriptions) {
      for (const [teamPath, subscription] of views) {
        for (const sub of subscription.artifacts.values()) {
          if (sub.changeRoot === null) continue
          if (!paths.some(changed => touchesTree(changed, sub.changeRoot!))) continue
          void this.enqueue(`${sub.teamId}\0${artifactsKey(sub.planId, sub.changeName)}`, () => this.refresh(connection, teamPath, sub))
        }
      }
    }
  }

  /** The correctness mechanism: re-enumerate every subscribed change. */
  private refreshAll(): void {
    for (const [connection, views] of this.subscriptions) {
      for (const [teamPath, subscription] of views) {
        for (const sub of subscription.artifacts.values()) {
          void this.enqueue(`${sub.teamId}\0${artifactsKey(sub.planId, sub.changeName)}`, () => this.refresh(connection, teamPath, sub))
        }
      }
    }
  }

  private updateWatchTargets(): void {
    const dirs = new Set<string>()
    for (const views of this.subscriptions.values()) {
      for (const subscription of views.values()) {
        for (const sub of subscription.artifacts.values()) if (sub.changeRoot !== null) dirs.add(sub.changeRoot)
      }
    }
    this.watcher.setTargets(dirs)
  }
}

/** The error's own text, for a reason or message that names the failure. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** A watch event touches a change tree when either path contains the other. */
function touchesTree(changed: string, root: string): boolean {
  return changed === root || root.startsWith(changed + path.sep) || changed.startsWith(root + path.sep)
}
