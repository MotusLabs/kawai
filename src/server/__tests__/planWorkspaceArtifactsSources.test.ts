// The canonical enumeration's source decisions (plan-workspace 5.3
// expansion): active main and convention-worktree sources, the archive
// mapping through a nested monorepo projectRoot, missing-in-worktree with
// no fallback to main, the ambiguous archive, the refusal when the producer
// omits the source root, and the watch target moving on an equal view (F4).
// The openspec listings are runner doubles; no CLI runs, no agent starts.
// Fixture paths name repository shapes as data, never runtime reads —
// declared for the reads guard.
// @reads: openspec/**
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { ChatSessionManager } from '../chat/ChatSessionManager'
import { ChatConnections } from '../chat/ChatConnections'
import { TeamScopes } from '../team/teamScope'
import type { SessionTeams } from '../team/sessionTeams'
import type { TeamIdentity } from '../team/teamIdentity'
import type { ClientMessage, ServerMessage } from '../../shared/types'
import type { OpenspecRunner } from '../plans/validation/openspecAdapter'
import { ExecutionStore } from '../plans/execution/executionStore'
import { CHANGE_WORKTREES_DIR } from '../../shared/workspace'
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
    flushDebounce: () => {
      for (const { callback } of debounce.splice(0)) callback()
    },
    reconcile: () => {
      for (const { callback } of intervals) callback()
    },
  }
}

const ENTRY = '2026-04-01-nested'
const sha = (text: string): string => crypto.createHash('sha256').update(text).digest('hex')
const call = (stdout: string) => ({ ok: true, exitCode: 0, stdout, stderr: '', timedOut: false })
const listing = (root: string, names: string[]) =>
  call(JSON.stringify({ changes: names.map(name => ({ name })), root: { path: root } }))
const notFound = () => ({ ok: false as const, exitCode: 1, stdout: '', stderr: 'not found', timedOut: false })

let world: PlanWorld
let bench: ReturnType<typeof createPlanBench>
let fixture: ReturnType<typeof fixtureHost>
let messages: ServerMessage[]
let managerDouble: ChatSessionManager
let agentStarts = 0
/** The roots the manager double's worktrees.list serves; tests narrow it. */
let listedRoots: string[]
const records = new Map<string, ReturnType<typeof sessionRow>>()
const teamOfMap = new Map<string, TeamIdentity>()
const connection = { send: (message: ServerMessage) => messages.push(message) }
const tick = () => new Promise(resolve => setTimeout(resolve, 25))

const conventionOf = (changeName: string): string => path.join(world.repo, CHANGE_WORKTREES_DIR, changeName)
const wtRel = (absolute: string): string => path.relative(world.repo, absolute).split(path.sep).join('/')
const all = <T extends ServerMessage['type']>(type: T) =>
  messages.filter((message): message is Extract<ServerMessage, { type: T }> => message.type === type)
const last = <T extends ServerMessage['type']>(type: T) => all(type).at(-1)

beforeAll(async () => {
  world = await createPlanWorld('kawai-plan-workspace-sources-')
})
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))
beforeEach(() => {
  fs.rmSync(path.join(world.repo, 'openspec'), { recursive: true, force: true })
  fs.rmSync(path.join(world.repo, 'packages'), { recursive: true, force: true })
  fs.rmSync(path.join(world.repo, CHANGE_WORKTREES_DIR), { recursive: true, force: true })
  bench = createPlanBench(world)
  fixture = fixtureHost()
  messages = []
  agentStarts = 0
  listedRoots = [world.repo, world.feature]
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
    tasks: { worktrees: { list: async () => listedRoots } },
    has: (id: string) => records.has(id),
    isArchived: (id: string) => records.get(id)?.archivedAt != null,
    teams: { teamOf: (id: string) => teamOfMap.get(id) },
    directory: { get: (teamId: string, id: string) => (records.has(id) ? { sessionId: id, name: `name-${id}`, group: null } : null) },
    ensureDriver: forbidden('ensureDriver'),
    start: forbidden('start'),
    restore: forbidden('restore'),
    loadHistory: forbidden('loadHistory'),
  } as unknown as ChatSessionManager
})

/** One artifacts module over the given runner; the open awaits its first push. */
const moduleFor = (runner: OpenspecRunner): PlanWorkspaceArtifactsConnections =>
  new PlanWorkspaceArtifactsConnections(managerDouble, { host: fixture.host, resolver: new ChangeArtifactsResolver(runner) })

/** One documents module over the given runner (B2 round-trips). */
const documentsFor = (runner: OpenspecRunner): PlanWorkspaceDocumentConnections =>
  new PlanWorkspaceDocumentConnections(managerDouble, { host: fixture.host, resolver: new ChangeArtifactsResolver(runner) })

/** Writes the monorepo archive fixture of one nested projectRoot. */
const writeNestedFixture = (projectRoot: string): void => {
  const archiveRoot = path.join(projectRoot, 'openspec', 'changes', 'archive', ENTRY)
  fs.mkdirSync(path.join(archiveRoot, 'specs', 'nested'), { recursive: true })
  fs.writeFileSync(path.join(archiveRoot, 'proposal.md'), '# Nested proposal\n')
  fs.writeFileSync(path.join(archiveRoot, 'tasks.md'), '# Tasks\n\n- [x] done\n')
  fs.writeFileSync(path.join(archiveRoot, 'specs', 'nested', 'spec.md'), '# Nested spec\n')
}

/** Only the archive directory: an entry the listing names with no artifacts yet. */
const writeNestedArchiveDir = (projectRoot: string): void => {
  fs.mkdirSync(path.join(projectRoot, 'openspec', 'changes', 'archive', ENTRY), { recursive: true })
}

describe('active sources', () => {
  test('an active change in the main checkout enumerates with the main source', async () => {
    const { planId } = await bench.draftInReview()
    const changeRoot = path.join(world.repo, 'openspec', 'changes', 'alpha')
    fs.mkdirSync(changeRoot, { recursive: true })
    fs.writeFileSync(path.join(changeRoot, 'proposal.md'), '# A\n')
    const runner: OpenspecRunner = async (args, { cwd }) => {
      if (args[0] === 'list' && cwd === world.repo && !args.includes('--archived')) return listing(world.repo, ['alpha'])
      if (args[0] === 'status' && cwd === world.repo && args[2] === 'alpha') {
        return call(JSON.stringify({
          changeRoot,
          artifactPaths: { proposal: { existingOutputPaths: [path.join(changeRoot, 'proposal.md')] } },
        }))
      }
      return notFound()
    }
    const artifacts = moduleFor(runner)
    messages = []
    await artifacts.handle(connection, { type: 'team-plan-workspace-artifacts-open', teamPath: world.repo, planId, changeName: 'alpha' })
    const push = last('team-plan-workspace-artifacts')!
    expect(push.view).toMatchObject({ ok: true })
    if (!push.view.ok) return
    expect(push.view.source).toEqual({ kind: 'main', worktreeId: world.repo })
    expect(push.view.artifacts).toEqual([
      { kind: 'proposal', relativePath: wtRel(path.join(changeRoot, 'proposal.md')) },
    ])
    artifacts.stop()
    expect(agentStarts).toBe(0)
  })

  test('an active change in its listed convention worktree enumerates from that worktree', async () => {
    const { planId } = await bench.draftInReview()
    const convention = conventionOf('alpha')
    listedRoots = [world.repo, convention]
    const changeRoot = path.join(convention, 'openspec', 'changes', 'alpha')
    fs.mkdirSync(changeRoot, { recursive: true })
    fs.writeFileSync(path.join(changeRoot, 'tasks.md'), '# Tasks\n')
    const runner: OpenspecRunner = async (args, { cwd }) => {
      if (args[0] === 'list' && cwd === convention && !args.includes('--archived')) return listing(convention, ['alpha'])
      if (args[0] === 'status' && cwd === convention && args[2] === 'alpha') {
        return call(JSON.stringify({
          changeRoot,
          artifactPaths: { tasks: { existingOutputPaths: [path.join(changeRoot, 'tasks.md')] } },
        }))
      }
      return notFound()
    }
    const artifacts = moduleFor(runner)
    messages = []
    await artifacts.handle(connection, { type: 'team-plan-workspace-artifacts-open', teamPath: world.repo, planId, changeName: 'alpha' })
    const push = last('team-plan-workspace-artifacts')!
    expect(push.view).toMatchObject({ ok: true })
    if (!push.view.ok) return
    expect(push.view.source).toEqual({ kind: 'worktree', worktreeId: convention })
    // The address is relative to the SOURCE worktree (B1): inside the
    // convention worktree's own space, derived by the mapping formula.
    const expectedRel = path.relative(convention, path.join(changeRoot, 'tasks.md')).split(path.sep).join('/')
    expect(push.view.artifacts).toEqual([{ kind: 'tasks', relativePath: expectedRel }])
    artifacts.stop()
    expect(agentStarts).toBe(0)
  })

  test('missing in its convention worktree reads missing-in-worktree; main is never substituted', async () => {
    const { planId } = await bench.draftInReview()
    const convention = conventionOf('alpha')
    listedRoots = [world.repo, convention]
    const cwds: string[] = []
    const runner: OpenspecRunner = async (args, { cwd }) => {
      cwds.push(`${cwd}:${args.join(' ')}`)
      // Main's active listing WOULD have alpha — the substitution must never
      // even be consulted (design D4: the convention worktree decides).
      if (args[0] === 'list' && cwd === world.repo && !args.includes('--archived')) return listing(world.repo, ['alpha'])
      if (args[0] === 'list' && cwd === convention && !args.includes('--archived')) return listing(convention, [])
      if (args[0] === 'list' && cwd === convention && args.includes('--archived')) return listing(convention, [])
      return notFound()
    }
    const artifacts = moduleFor(runner)
    messages = []
    await artifacts.handle(connection, { type: 'team-plan-workspace-artifacts-open', teamPath: world.repo, planId, changeName: 'alpha' })
    const push = last('team-plan-workspace-artifacts')!
    expect(push.view).toMatchObject({ ok: false, state: 'missing-in-worktree' })
    expect(cwds.some(entry => entry.startsWith(`${world.repo}:list`))).toBe(false)
    artifacts.stop()
    expect(agentStarts).toBe(0)
  })

  test('two matching archive entries read ambiguous, naming entries only', async () => {
    const { planId } = await bench.draftInReview()
    const runner: OpenspecRunner = async (args, { cwd }) => {
      if (args[0] === 'list' && cwd === world.repo) {
        return args.includes('--archived')
          ? listing(world.repo, ['2026-01-15-alpha', '2026-02-20-alpha'])
          : listing(world.repo, [])
      }
      return notFound()
    }
    const artifacts = moduleFor(runner)
    messages = []
    await artifacts.handle(connection, { type: 'team-plan-workspace-artifacts-open', teamPath: world.repo, planId, changeName: 'alpha' })
    const push = last('team-plan-workspace-artifacts')!
    expect(push.view).toMatchObject({ ok: false, state: 'ambiguous' })
    if (push.view.ok) return
    expect(push.view.message).toContain('2026-01-15-alpha')
    expect(push.view.message).toContain('2026-02-20-alpha')
    expect(push.view.message).not.toContain(world.repo)
    artifacts.stop()
    expect(agentStarts).toBe(0)
  })
})

describe('nested monorepo archive (projectRoot mapping)', () => {
  const projectRootAt = (name: string): string => path.join(world.repo, 'packages', name)

  /** The archive listing double: the entry lives under the CURRENT projectRoot. */
  const nestedRunner = (current: () => string): OpenspecRunner => async (args, { cwd }) => {
    if (args[0] === 'list' && cwd === world.repo) {
      return args.includes('--archived') ? listing(current(), [ENTRY]) : listing(world.repo, [])
    }
    return notFound()
  }

  test('a nested projectRoot archive maps by the formula and round-trips document-open', async () => {
    const { planId } = await bench.draftInReview()
    const projectRoot = projectRootAt('app')
    writeNestedFixture(projectRoot)
    const artifacts = moduleFor(nestedRunner(() => projectRoot))
    const documents = documentsFor(nestedRunner(() => projectRoot))
    messages = []
    await artifacts.handle(connection, { type: 'team-plan-workspace-artifacts-open', teamPath: world.repo, planId, changeName: 'nested' })
    const push = last('team-plan-workspace-artifacts')!
    expect(push.view).toMatchObject({ ok: true })
    if (!push.view.ok) return
    expect(push.view.source).toEqual({ kind: 'archive', worktreeId: world.repo, entry: ENTRY })
    // Derived expectation (B1): path.relative from the listed root — no
    // hardcoded openspec prefix, nested projectRoot included.
    const archiveRoot = path.join(projectRoot, 'openspec', 'changes', 'archive', ENTRY)
    const expected = [
      { kind: 'proposal', relativePath: wtRel(path.join(archiveRoot, 'proposal.md')) },
      { kind: 'tasks', relativePath: wtRel(path.join(archiveRoot, 'tasks.md')) },
      { kind: 'specs', relativePath: wtRel(path.join(archiveRoot, 'specs', 'nested', 'spec.md')) },
    ]
    expect(push.view.artifacts).toEqual(expected)
    // B2 round-trip: every pushed pair opens the SAME file through the
    // existing document subscription, with the same observed metadata.
    for (const descriptor of push.view.artifacts) {
      messages = []
      await documents.handle(connection, { type: 'team-plan-workspace-document-open', teamPath: world.repo, planId,
        worktreeId: push.view.source.worktreeId, relativePath: descriptor.relativePath })
      const document = last('team-plan-workspace-document')!
      expect(document.view.availability, `reason: ${document.view.reason}`).toBe('current')
      const absolute = path.join(world.repo, descriptor.relativePath)
      expect(document.view.contentHash).toBe(sha(fs.readFileSync(absolute, 'utf8')))
      expect(document.view.size).toBe(fs.statSync(absolute).size)
    }
    artifacts.stop()
    documents.stop()
    expect(agentStarts).toBe(0)
  })

  test('an equal view from a moved projectRoot still moves the watch target (F4)', async () => {
    const { planId } = await bench.draftInReview()
    let current = projectRootAt('app')
    writeNestedArchiveDir(current)
    const archiveRootAt = (root: string): string => path.join(root, 'openspec', 'changes', 'archive', ENTRY)
    const artifacts = moduleFor(nestedRunner(() => current))
    messages = []
    await artifacts.handle(connection, { type: 'team-plan-workspace-artifacts-open', teamPath: world.repo, planId, changeName: 'nested' })
    expect(all('team-plan-workspace-artifacts')).toHaveLength(1)
    expect(fixture.watchers.has(archiveRootAt(current))).toBe(true)
    // The listing's projectRoot moves while the entry holds no artifacts:
    // the view (empty descriptors) stays byte-equal, so nothing pushes —
    // but the watch target must move to the new archive root all the same,
    // or the subscription never hears about future artifacts there (F4).
    current = projectRootAt('app2')
    writeNestedArchiveDir(current)
    fixture.reconcile()
    await tick()
    expect(all('team-plan-workspace-artifacts')).toHaveLength(1)
    expect(fixture.watchers.has(archiveRootAt(current))).toBe(true)
    expect(fixture.watchers.has(archiveRootAt(projectRootAt('app')))).toBe(false)
    artifacts.stop()
    expect(agentStarts).toBe(0)
  })
})

describe('uncontained producer', () => {
  test('a worktrees.list that omits the source root refuses uncontained with no id', async () => {
    const { planId } = await bench.draftInReview()
    const changeRoot = path.join(world.repo, 'openspec', 'changes', 'alpha')
    fs.mkdirSync(changeRoot, { recursive: true })
    fs.writeFileSync(path.join(changeRoot, 'proposal.md'), '# A\n')
    // The producer names only the feature worktree: the main checkout (the
    // source this change resolves to) is not a listed root of this team.
    listedRoots = [world.feature]
    const runner: OpenspecRunner = async (args, { cwd }) => {
      if (args[0] === 'list' && cwd === world.repo && !args.includes('--archived')) return listing(world.repo, ['alpha'])
      if (args[0] === 'status' && cwd === world.repo && args[2] === 'alpha') {
        return call(JSON.stringify({
          changeRoot,
          artifactPaths: { proposal: { existingOutputPaths: [path.join(changeRoot, 'proposal.md')] } },
        }))
      }
      return notFound()
    }
    const artifacts = moduleFor(runner)
    messages = []
    await artifacts.handle(connection, { type: 'team-plan-workspace-artifacts-open', teamPath: world.repo, planId, changeName: 'alpha' })
    const push = last('team-plan-workspace-artifacts')!
    expect(push.view).toMatchObject({ ok: false, state: 'uncontained' })
    // No id, no address: an uncontained view names no source at all.
    expect('source' in push.view).toBe(false)
    if (push.view.ok) return
    expect(push.view.message).not.toContain(world.repo)
    expect(push.view.message).not.toContain(world.feature)
    artifacts.stop()
    expect(agentStarts).toBe(0)
  })
})

describe('the shared resolver pool (expansion 3)', () => {
  test('documents and artifacts share one 2-slot pool: a third resolve waits', async () => {
    const { planId } = await bench.draftInReview()
    // Fixtures: two active checklists and one archived change for artifacts.
    for (const name of ['alpha', 'beta']) {
      const changeRoot = path.join(world.repo, 'openspec', 'changes', name)
      fs.mkdirSync(changeRoot, { recursive: true })
      fs.writeFileSync(path.join(changeRoot, 'tasks.md'), `# ${name}\n\n- [ ] one\n`)
    }
    writeNestedFixture(projectRootOf())
    const ENTRY_G = ENTRY
    let inflight = 0
    let maxInflight = 0
    const waiters: Array<() => void> = []
    let hold = true
    const gated: OpenspecRunner = async (args, opts) => {
      inflight += 1
      maxInflight = Math.max(maxInflight, inflight)
      if (hold) await new Promise<void>(resolve => { waiters.push(resolve) })
      inflight -= 1
      if (args[0] === 'list') {
        if (!args.includes('--archived')) return listing(opts.cwd, ['alpha', 'beta'])
        return listing(world.repo, [ENTRY_G])
      }
      if (args[0] === 'status') {
        const changeRoot = path.join(opts.cwd, 'openspec', 'changes', args[2]!)
        return call(JSON.stringify({
          changeRoot,
          artifactPaths: { tasks: { existingOutputPaths: [path.join(changeRoot, 'tasks.md')] } },
        }))
      }
      return notFound()
    }
    // Production wiring: ONE resolver injected through ChatConnections.
    const chat = new ChatConnections(managerDouble, undefined, undefined, { planWorkspaceResolver: new ChangeArtifactsResolver(gated) })
    const route = (message: ClientMessage) => chat.handle(connection, message as Parameters<typeof chat.handle>[1])
    messages = []
    const open1 = route({ type: 'team-plan-workspace-checklist-open', teamPath: world.repo, planId, changeName: 'alpha' })
    await tick()
    expect(maxInflight).toBe(1)
    const open2 = route({ type: 'team-plan-workspace-checklist-open', teamPath: world.repo, planId, changeName: 'beta' })
    await tick()
    expect(maxInflight).toBe(2)
    // The artifacts resolve cannot start: the one shared pool is full. Two
    // independent 2-slot pools would start it here (max 3).
    const open3 = route({ type: 'team-plan-workspace-artifacts-open', teamPath: world.repo, planId, changeName: 'gamma' })
    await tick()
    expect(inflight).toBe(2)
    expect(all('team-plan-workspace-artifacts')).toHaveLength(0)
    hold = false
    for (const release of waiters.splice(0)) release()
    await Promise.all([open1, open2, open3])
    expect(maxInflight).toBe(2)
    expect(all('team-plan-workspace-checklist')).toHaveLength(2)
    expect(all('team-plan-workspace-artifacts')).toHaveLength(1)
    chat.stop()
    expect(agentStarts).toBe(0)
  })
})

/** The nested fixture's projectRoot (the shared-pool test's archive location). */
function projectRootOf(): string {
  return path.join(world.repo, 'packages', 'app')
}
