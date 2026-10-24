// The canonical artifact enumeration subscription (plan-workspace 5.3, the
// r5 first path): an archived change's open answers the descriptor push in
// the source worktree's address space, every enumerated pair opens through
// the existing document subscription to the same file and metadata, close
// and disconnect leave no watch target and suppress the stale push, and a
// crafted change root as worktreeId is refused before any read. The
// openspec listings are runner doubles; no CLI runs, no agent starts (I6).
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import { CHAT_CONNECTION_TYPES } from '../chat/chatConnectionTypes'
import { ChatConnections } from '../chat/ChatConnections'
import { TeamScopes } from '../team/teamScope'
import type { SessionTeams } from '../team/sessionTeams'
import type { TeamIdentity } from '../team/teamIdentity'
import type { ClientMessage, ServerMessage } from '../../shared/types'
import type { WorkspaceArtifactsView } from '../../shared/planWorkspace'
import type { OpenspecRunner } from '../plans/validation/openspecAdapter'
import { ExecutionStore } from '../plans/execution/executionStore'
import { ChangeArtifactsResolver } from '../plans/workspace/changeArtifacts'
import { PlanWorkspaceArtifactsConnections } from '../plans/workspace/workspaceArtifacts'
import { PlanWorkspaceDocumentConnections } from '../plans/workspace/workspaceDocuments'
import type { WorkspaceWatcherHost } from '../workspace/workspaceWatcher'
import { createPlanBench, createPlanWorld, sessionRow, type PlanWorld } from './planHarness'

/** The watcher host double: watch targets and timers are recorded. */
function fixtureHost() {
  const watchers = new Map<string, (changedPath: string) => void>()
  const debounce: Array<{ callback: () => void; ms: number }> = []
  const intervals: Array<{ callback: () => void; ms: number }> = []
  const host: WorkspaceWatcherHost = {
    watchDirectory: (directory, onEvent) => {
      watchers.set(directory, onEvent)
      return { close: () => watchers.delete(directory) }
    },
    isWatchable: candidate => fs.existsSync(candidate),
    setDebounceTimer: (callback, ms) => {
      const entry = { callback, ms }
      debounce.push(entry)
      return entry
    },
    clearDebounceTimer: handle => {
      const at = debounce.indexOf(handle as { callback: () => void; ms: number })
      if (at >= 0) debounce.splice(at, 1)
    },
    setReconciliationInterval: (callback, ms) => {
      const entry = { callback, ms }
      intervals.push(entry)
      return entry
    },
    clearReconciliationInterval: handle => {
      const at = intervals.indexOf(handle as { callback: () => void; ms: number })
      if (at >= 0) intervals.splice(at, 1)
    },
  }
  return {
    host,
    watchers,
    fireWatch: (directory: string, name: string) => watchers.get(directory)?.(path.join(directory, name)),
    flushDebounce: () => {
      for (const { callback } of debounce.splice(0)) callback()
    },
    reconcile: () => {
      for (const { callback } of intervals) callback()
    },
  }
}

let fixture: ReturnType<typeof fixtureHost>

/** The archive entry under the main checkout's openspec root (the fixture layout). */
const archiveRoot = () => path.join(world.repo, 'openspec', 'changes', 'archive', ENTRY)
const ENTRY = '2026-01-15-archived'

/** The fixture files of one archived change: proposal, tasks, and a nested spec. */
const writeArchiveFixture = (): void => {
  const root = archiveRoot()
  fs.mkdirSync(path.join(root, 'specs', 'nested'), { recursive: true })
  fs.writeFileSync(path.join(root, 'proposal.md'), '# Archived proposal\n')
  fs.writeFileSync(path.join(root, 'tasks.md'), '# Tasks\n\n- [x] done\n')
  fs.writeFileSync(path.join(root, 'specs', 'nested', 'spec.md'), '# Nested spec\n')
}

/** Derived expectation (B1): the worktree-relative address of a fixture file. */
const wtRel = (absolute: string): string => path.relative(world.repo, absolute).split(path.sep).join('/')

let world: PlanWorld
let bench: ReturnType<typeof createPlanBench>
let connections: ChatConnections
let artifacts: PlanWorkspaceArtifactsConnections
let documents: PlanWorkspaceDocumentConnections
let messages: ServerMessage[]
let agentStarts = 0
let runnerCalls = 0
/** Gate for the archive listing: armed, a refresh stays in flight until released. */
let holdListing = false
let releaseListing: (() => void) | null = null
const records = new Map<string, ReturnType<typeof sessionRow>>()
const teamOfMap = new Map<string, TeamIdentity>()
const connection = { send: (message: ServerMessage) => messages.push(message) }

/**
 * The listing double: `archived` is absent from the active listing and
 * resolves through the archive listing of the main checkout; status is
 * never a valid call for an archived name and counts as a guard. When
 * `gate` is held, the archive listing waits, keeping a refresh in flight.
 */
const runner: OpenspecRunner = async (args, { cwd }) => {
  runnerCalls += 1
  const call = (stdout: string) => ({ ok: true, exitCode: 0, stdout, stderr: '', timedOut: false })
  if (args[0] === 'list' && cwd === world.repo) {
    if (args.includes('--archived')) {
      if (holdListing) await new Promise<void>(resolve => { releaseListing = resolve })
      return call(JSON.stringify({ changes: [{ name: ENTRY }], root: { path: world.repo } }))
    }
    return call(JSON.stringify({ changes: [{ name: 'alpha' }], root: { path: world.repo } }))
  }
  return { ok: false, exitCode: 1, stdout: '', stderr: 'not found', timedOut: false }
}

let managerDouble: ChatSessionManager

beforeAll(async () => {
  world = await createPlanWorld('kawai-plan-workspace-artifacts-')
})
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))
beforeEach(() => {
  fs.rmSync(path.join(world.repo, 'openspec'), { recursive: true, force: true })
  bench = createPlanBench(world)
  fixture = fixtureHost()
  messages = []
  agentStarts = 0
  runnerCalls = 0
  holdListing = false
  releaseListing = null
  records.clear()
  for (const id of ['lead-chat']) records.set(id, sessionRow(id, 'leads', world.repo))
  teamOfMap.clear()
  for (const id of records.keys()) teamOfMap.set(id, world.team)
  const forbidden = (what: string) => () => { agentStarts += 1; throw new Error(`I6: ${what} must not be called`) }
  const executions = new ExecutionStore(bench.db.db)
  const manager = {
    whenRestored: () => Promise.resolve(),
    teamScopes: new TeamScopes({ teams: { hasTeam: async () => false } as unknown as SessionTeams, repositories: () => [world.team.teamId] }),
    plans: bench.service,
    planExecutionStore: executions,
    tasks: { worktrees: { list: async () => [world.repo, world.feature] } },
    has: (id: string) => records.has(id),
    isArchived: (id: string) => records.get(id)?.archivedAt != null,
    teams: { teamOf: (id: string) => teamOfMap.get(id) },
    directory: { get: (teamId: string, id: string) => (records.has(id) ? { sessionId: id, name: `name-${id}`, group: null } : null) },
    ensureDriver: forbidden('ensureDriver'),
    start: forbidden('start'),
    restore: forbidden('restore'),
    loadHistory: forbidden('loadHistory'),
  } as unknown as ChatSessionManager
  managerDouble = manager
  connections = new ChatConnections(manager)
  artifacts = new PlanWorkspaceArtifactsConnections(managerDouble, { host: fixture.host, resolver: new ChangeArtifactsResolver(runner) })
  documents = new PlanWorkspaceDocumentConnections(managerDouble, { host: fixture.host, resolver: new ChangeArtifactsResolver(runner) })
})

const send = (message: ClientMessage) => artifacts.handle(connection, message as Parameters<typeof artifacts.handle>[1])
const docSend = (message: ClientMessage) => documents.handle(connection, message as Parameters<typeof documents.handle>[1])
const route = (message: ClientMessage) => connections.handle(connection, message)
const all = <T extends ServerMessage['type']>(type: T) =>
  messages.filter((message): message is Extract<ServerMessage, { type: T }> => message.type === type)
const last = <T extends ServerMessage['type']>(type: T) => all(type).at(-1)

const openArchived = (planId: string, changeName = 'archived'): Promise<void> =>
  send({ type: 'team-plan-workspace-artifacts-open', teamPath: world.repo, planId, changeName })
const closeArtifacts = (planId: string, changeName = 'archived'): Promise<void> =>
  send({ type: 'team-plan-workspace-artifacts-close', teamPath: world.repo, planId, changeName })

async function untilArtifacts(check: (view: WorkspaceArtifactsView) => boolean, tries = 400): Promise<Extract<ServerMessage, { type: 'team-plan-workspace-artifacts' }>> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const arrived = all('team-plan-workspace-artifacts').filter(message => check(message.view))
    if (arrived.length > 0) return arrived[arrived.length - 1]!
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('no artifacts push arrived')
}

describe('the archived first path (r5 checkpoint 2)', () => {
  test('open answers the descriptor push; every pair opens through document-open to the same file', async () => {
    const { planId } = await bench.draftInReview()
    writeArchiveFixture()
    await openArchived(planId)
    const push = await untilArtifacts(view => view.ok)
    expect(push.view.ok).toBe(true)
    if (!push.view.ok) return
    // The source is the exact listed main checkout, with the archive entry —
    // never an absolute resolver root.
    expect(push.view.source).toEqual({ kind: 'archive', worktreeId: world.repo, entry: ENTRY })
    const root = archiveRoot()
    const expected = [
      { kind: 'proposal', relativePath: wtRel(path.join(root, 'proposal.md')) },
      { kind: 'tasks', relativePath: wtRel(path.join(root, 'tasks.md')) },
      { kind: 'specs', relativePath: wtRel(path.join(root, 'specs', 'nested', 'spec.md')) },
    ]
    expect(push.view.artifacts).toEqual(expected)
    // B2 round-trip: each pushed pair opens the SAME file through the
    // existing document subscription, with the same observed metadata.
    const sha = (text: string) => crypto.createHash('sha256').update(text).digest('hex')
    for (const descriptor of push.view.artifacts) {
      messages = []
      await docSend({ type: 'team-plan-workspace-document-open', teamPath: world.repo, planId,
        worktreeId: push.view.source.worktreeId, relativePath: descriptor.relativePath })
      for (let attempt = 0; attempt < 400; attempt += 1) {
        if (last('team-plan-workspace-document')) break
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      const document = last('team-plan-workspace-document')!
      expect(document.view.availability, `reason: ${document.view.reason}`).toBe('current')
      expect(document.view.worktreeId).toBe(push.view.source.worktreeId)
      expect(document.view.relativePath).toBe(descriptor.relativePath)
      const absolute = path.join(world.repo, descriptor.relativePath)
      const stat = fs.statSync(absolute)
      expect(document.view.contentHash).toBe(sha(fs.readFileSync(absolute, 'utf8')))
      expect(document.view.size).toBe(stat.size)
      expect(document.view.mtimeMs).toBe(stat.mtimeMs)
    }
    expect(agentStarts).toBe(0)
  })
})

describe('refusals and cleanup', () => {
  test('a crafted change root as worktreeId is refused before any read', async () => {
    const { planId } = await bench.draftInReview()
    writeArchiveFixture()
    messages = []
    await docSend({ type: 'team-plan-workspace-document-open', teamPath: world.repo, planId,
      worktreeId: archiveRoot(), relativePath: 'proposal.md' })
    expect(last('team-plan-workspace-document')).toBeUndefined()
    expect(last('error')!.message).toBe('Worktree not listed in this team.')
    expect(agentStarts).toBe(0)
  })

  test('close ends the subscription: no watch target, no push on later edits or reconciliation', async () => {
    const { planId } = await bench.draftInReview()
    writeArchiveFixture()
    await openArchived(planId)
    await untilArtifacts(view => view.ok)
    expect(fixture.watchers.has(archiveRoot())).toBe(true)
    await closeArtifacts(planId)
    expect(fixture.watchers.has(archiveRoot())).toBe(false)
    fs.writeFileSync(path.join(archiveRoot(), 'late.md'), 'late\n')
    fixture.fireWatch(archiveRoot(), 'late.md')
    fixture.flushDebounce()
    fixture.reconcile()
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(all('team-plan-workspace-artifacts')).toHaveLength(1)
    expect(agentStarts).toBe(0)
  })

  test('a close racing the in-flight open suppresses the stale push (B3)', async () => {
    const { planId } = await bench.draftInReview()
    writeArchiveFixture()
    holdListing = true
    const opening = openArchived(planId)
    await new Promise(resolve => setTimeout(resolve, 20))
    await closeArtifacts(planId)
    holdListing = false
    releaseListing!()
    await opening
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(all('team-plan-workspace-artifacts')).toHaveLength(0)
    expect(fixture.watchers.size).toBe(0)
  })

  test('disconnect drops the subscription and suppresses the pending refresh', async () => {
    const { planId } = await bench.draftInReview()
    writeArchiveFixture()
    holdListing = true
    const opening = openArchived(planId)
    await new Promise(resolve => setTimeout(resolve, 20))
    artifacts.disconnect(connection)
    holdListing = false
    releaseListing!()
    await opening
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(all('team-plan-workspace-artifacts')).toHaveLength(0)
    expect(fixture.watchers.size).toBe(0)
    expect(agentStarts).toBe(0)
  })

  test('a throwing enumeration answers a fixed path-free reason, never the raw error', async () => {
    const { planId } = await bench.draftInReview()
    writeArchiveFixture()
    // The resolver's runner throws with a representative absolute path in
    // its message; the push's reason must stay shape-only text (D4).
    const throwing: OpenspecRunner = async () => {
      throw new Error(`ENOENT: no such file or directory, open '${archiveRoot()}/proposal.md'`)
    }
    const throwingModule = new PlanWorkspaceArtifactsConnections(managerDouble, { host: fixture.host, resolver: new ChangeArtifactsResolver(throwing) })
    messages = []
    await throwingModule.handle(connection, { type: 'team-plan-workspace-artifacts-open', teamPath: world.repo, planId, changeName: 'archived' })
    const push = await untilArtifacts(view => !view.ok)
    expect(push.view).toMatchObject({ ok: false, state: 'cli-unavailable' })
    if (push.view.ok) return
    expect(push.view.message).toBe('The artifacts of "archived" could not be enumerated.')
    expect(push.view.message).not.toContain(world.repo)
    expect(push.view.message).not.toContain(archiveRoot())
    expect(agentStarts).toBe(0)
    throwingModule.stop()
  })
})

describe('the change name shape gate (B5)', () => {
  test('malformed names are refused on open before any resolver call', async () => {
    const { planId } = await bench.draftInReview()
    for (const changeName of ['', '  ', 'a/b', 'a\\b', '..', '.', '/abs', 'na\u0000me']) {
      messages = []
      await openArchived(planId, changeName)
      expect(last('error')!.message).toBe('Malformed change name.')
      expect(all('team-plan-workspace-artifacts')).toHaveLength(0)
    }
    expect(runnerCalls).toBe(0)
  })

  test('malformed names are refused on close, touching no subscription', async () => {
    const { planId } = await bench.draftInReview()
    writeArchiveFixture()
    await openArchived(planId)
    await untilArtifacts(view => view.ok)
    messages = []
    await closeArtifacts(planId, 'a/b')
    expect(last('error')!.message).toBe('Malformed change name.')
    // The valid subscription survives the refused close.
    expect(fixture.watchers.has(archiveRoot())).toBe(true)
  })

  test('an artifact outside the source worktree reads uncontained, naming no path', async () => {
    const { planId } = await bench.draftInReview()
    // An active change whose status names a change root in another tree: the
    // mapping must refuse the whole view, and the refusal names no path.
    const foreignRoot = path.join(world.other, 'openspec', 'changes', 'alpha')
    const hostile: OpenspecRunner = async (args, { cwd }) => {
      const call = (stdout: string) => ({ ok: true, exitCode: 0, stdout, stderr: '', timedOut: false })
      if (args[0] === 'list' && cwd === world.repo && !args.includes('--archived')) {
        return call(JSON.stringify({ changes: [{ name: 'alpha' }], root: { path: world.repo } }))
      }
      if (args[0] === 'status' && cwd === world.repo && args[2] === 'alpha') {
        return call(JSON.stringify({
          changeRoot: foreignRoot,
          artifactPaths: { proposal: { existingOutputPaths: [path.join(foreignRoot, 'proposal.md')] } },
        }))
      }
      return { ok: false, exitCode: 1, stdout: '', stderr: 'not found', timedOut: false }
    }
    const hostileModule = new PlanWorkspaceArtifactsConnections(managerDouble, { host: fixture.host, resolver: new ChangeArtifactsResolver(hostile) })
    messages = []
    await hostileModule.handle(connection, { type: 'team-plan-workspace-artifacts-open', teamPath: world.repo, planId, changeName: 'alpha' })
    const push = await untilArtifacts(view => !view.ok)
    expect(push.view).toMatchObject({ ok: false, state: 'uncontained' })
    if (push.view.ok) return
    expect(push.view.message).not.toContain(world.other)
    expect(push.view.message).not.toContain(world.repo)
    hostileModule.stop()
    expect(agentStarts).toBe(0)
  })
})

test('the ChatConnections dispatch routes the artifacts prefix to the module, B5 before any spawn', async () => {
  // A malformed name is refused by the artifacts module itself — the
  // dispatch branch is proven with no resolver construction or CLI spawn.
  messages = []
  await route({ type: 'team-plan-workspace-artifacts-open', teamPath: world.repo, planId: 'p', changeName: 'a/b' })
  expect(last('error')!.message).toBe('Malformed change name.')
  expect(runnerCalls).toBe(0)
  expect(agentStarts).toBe(0)
})

test('the artifacts client types are listed for the WS router', () => {
  // Registered beside the other workspace subscriptions (CHAT_CONNECTION_TYPES).
  // The full list assertion lives in planWorkspaceConnections.test.ts.
  for (const type of ['team-plan-workspace-artifacts-open', 'team-plan-workspace-artifacts-close']) {
    expect(CHAT_CONNECTION_TYPES as readonly string[]).toContain(type)
  }
})
