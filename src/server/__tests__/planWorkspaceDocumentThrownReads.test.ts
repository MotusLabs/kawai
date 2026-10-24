// Thrown dependency failures keep the client-visible reason fixed and
// path-free (plan-workspace D4, first-path advisory F1): a document or
// checklist read that throws with a representative absolute path in its
// error still answers the open with shape-only text — the raw error never
// crosses the wire, and the server log carries the detail. The openspec
// listing the checklist resolver sees is a runner double; no CLI runs, no
// agent starts (I6).
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import { TeamScopes } from '../team/teamScope'
import type { SessionTeams } from '../team/sessionTeams'
import type { TeamIdentity } from '../team/teamIdentity'
import type { ServerMessage } from '../../shared/types'
import type { OpenspecRunner } from '../plans/validation/openspecAdapter'
import { ExecutionStore } from '../plans/execution/executionStore'
import { ChangeArtifactsResolver } from '../plans/workspace/changeArtifacts'
import { readWorkspaceDocument } from '../plans/workspace/documentReader'
import { PlanWorkspaceDocumentConnections } from '../plans/workspace/workspaceDocuments'
import type { WorkspaceWatcherHost } from '../workspace/workspaceWatcher'
import { createPlanBench, createPlanWorld, sessionRow, type PlanWorld } from './planHarness'

/** The watcher host double: watch callbacks and timers are recorded. */
function fixtureHost() {
  const watchers = new Map<string, (changedPath: string) => void>()
  const debounce: Array<{ callback: () => void; ms: number }> = []
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
    setReconciliationInterval: () => undefined,
    clearReconciliationInterval: () => undefined,
  }
  return {
    host,
    fireWatch: (directory: string, name: string) => watchers.get(directory)?.(path.join(directory, name)),
    flushDebounce: () => {
      for (const { callback } of debounce.splice(0)) callback()
    },
  }
}

/**
 * The openspec listing double: `alpha` is active in the main checkout and
 * its status names its tasks artifact — the checklist's read then throws.
 */
const runner: OpenspecRunner = async (args, { cwd }) => {
  const call = (stdout: string) => ({ ok: true, exitCode: 0, stdout, stderr: '', timedOut: false })
  if (args[0] === 'list' && cwd === world.repo) {
    const names = args.includes('--archived') ? [] : ['alpha']
    return call(JSON.stringify({ changes: names.map(name => ({ name })), root: { path: world.repo } }))
  }
  if (args[0] === 'status' && cwd === world.repo && args[2] === 'alpha') {
    const changeRoot = path.join(world.repo, 'openspec', 'changes', 'alpha')
    return call(JSON.stringify({
      changeRoot,
      artifactPaths: { tasks: { existingOutputPaths: [path.join(changeRoot, 'tasks.md')] } },
    }))
  }
  return { ok: false, exitCode: 1, stdout: '', stderr: 'not found', timedOut: false }
}

const writeChecklistFixture = (): void => {
  const changeRoot = path.join(world.repo, 'openspec', 'changes', 'alpha')
  fs.mkdirSync(changeRoot, { recursive: true })
  fs.writeFileSync(path.join(changeRoot, 'tasks.md'), '# Tasks\n')
}

const sha = (text: string): string => crypto.createHash('sha256').update(text).digest('hex')

let world: PlanWorld
let bench: ReturnType<typeof createPlanBench>
let messages: ServerMessage[]
let managerDouble: ChatSessionManager
let agentStarts = 0
const records = new Map<string, ReturnType<typeof sessionRow>>()
const teamOfMap = new Map<string, TeamIdentity>()
const connection = { send: (message: ServerMessage) => messages.push(message) }
const last = <T extends ServerMessage['type']>(type: T) =>
  messages.filter((message): message is Extract<ServerMessage, { type: T }> => message.type === type).at(-1)

beforeAll(async () => {
  world = await createPlanWorld('kawai-plan-workspace-thrown-reads-')
})
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))
beforeEach(() => {
  fs.rmSync(path.join(world.repo, 'openspec'), { recursive: true, force: true })
  fs.rmSync(path.join(world.feature, 'notes'), { recursive: true, force: true })
  bench = createPlanBench(world)
  messages = []
  agentStarts = 0
  records.clear()
  for (const id of ['lead-chat']) records.set(id, sessionRow(id, 'leads', world.repo))
  teamOfMap.clear()
  for (const id of records.keys()) teamOfMap.set(id, world.team)
  const forbidden = (what: string) => () => { agentStarts += 1; throw new Error(`I6: ${what} must not be called`) }
  managerDouble = {
    whenRestored: () => Promise.resolve(),
    teamScopes: new TeamScopes({ teams: { hasTeam: async () => false } as unknown as SessionTeams, repositories: () => [world.team.teamId] }),
    plans: bench.service,
    planExecutionStore: new ExecutionStore(bench.db.db),
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
  fixture = fixtureHost()
})

let fixture: ReturnType<typeof fixtureHost>

describe('thrown reads name no path (D4)', () => {
  // A dependency throw whose own message carries a representative absolute
  // path: the client-visible reason must stay fixed shape-only text, the
  // raw error never crossing the wire (first-path advisory F1).
  const pathError = () => new Error(`EACCES: permission denied, open '${world.repo}/openspec/changes/alpha/tasks.md'`)
  const throwingModule = (read?: typeof readWorkspaceDocument): PlanWorkspaceDocumentConnections =>
    new PlanWorkspaceDocumentConnections(managerDouble, {
      host: fixture.host, resolver: new ChangeArtifactsResolver(runner),
      read: read ?? (async () => { throw pathError() }),
    })

  test('a thrown document read answers the fixed missing reason, never the raw error', async () => {
    const { planId } = await bench.draftInReview()
    const throwing = throwingModule()
    messages = []
    await throwing.handle(connection, { type: 'team-plan-workspace-document-open', teamPath: world.repo, planId,
      worktreeId: world.feature, relativePath: 'notes/design.md' })
    const view = last('team-plan-workspace-document')!.view
    expect(view.availability).toBe('missing')
    expect(view.reason).toBe('The document could not be read.')
    expect(view.reason).not.toContain(world.repo)
    expect(view.reason).not.toContain(world.feature)
    expect(agentStarts).toBe(0)
    throwing.stop()
  })

  test('a thrown checklist read answers the fixed unreadable message, never the raw error', async () => {
    const { planId } = await bench.draftInReview()
    writeChecklistFixture()
    const throwing = throwingModule()
    messages = []
    await throwing.handle(connection, { type: 'team-plan-workspace-checklist-open', teamPath: world.repo, planId, changeName: 'alpha' })
    const push = last('team-plan-workspace-checklist')!
    expect(push.checklist).toBeNull()
    expect(push.unavailable).toMatchObject({ state: 'unreadable' })
    expect(push.unavailable!.message).toBe('The checklist of "alpha" could not be composed.')
    expect(push.unavailable!.message).not.toContain(world.repo)
    expect(agentStarts).toBe(0)
    throwing.stop()
  })

  test('a throw after a successful read holds last-valid content stale (fixed reason)', async () => {
    const { planId } = await bench.draftInReview()
    const docDir = path.join(world.feature, 'notes')
    fs.mkdirSync(docDir, { recursive: true })
    fs.writeFileSync(path.join(docDir, 'design.md'), 'first\n')
    // The read succeeds once, then throws: the same subscription refreshes
    // on a watch event and must hold the last-valid content stale, naming
    // the fixed reason — never the raw error (D4, correction semantics).
    let calls = 0
    const read: typeof readWorkspaceDocument = (...args) => {
      calls += 1
      if (calls > 1) throw pathError()
      return readWorkspaceDocument(...args)
    }
    const throwing = throwingModule(read)
    messages = []
    await throwing.handle(connection, { type: 'team-plan-workspace-document-open', teamPath: world.repo, planId,
      worktreeId: world.feature, relativePath: 'notes/design.md' })
    const currentMessage = last('team-plan-workspace-document')!
    expect(currentMessage.view.availability).toBe('current')
    expect(currentMessage.view.contentHash).toBe(sha('first\n'))
    fixture.fireWatch(docDir, 'design.md')
    fixture.flushDebounce()
    for (let attempt = 0; attempt < 400 && last('team-plan-workspace-document') === currentMessage; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    const stale = last('team-plan-workspace-document')!.view
    expect(stale.availability).toBe('missing')
    expect(stale.stale).toBe(true)
    expect(stale.reason).toBe('The document could not be read.')
    expect(stale.reason).not.toContain(world.repo)
    // Last-valid content is held: the hash and text survive the failure.
    expect(stale.contentHash).toBe(sha('first\n'))
    expect(stale.text).toBe('first\n')
    expect(stale.executionMatch).toBe('unknown')
    expect(agentStarts).toBe(0)
    throwing.stop()
  })
})
