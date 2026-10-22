// Document and checklist subscriptions over the chat connection (2.4):
// invalidation on a watch event and through the reconciliation pass, source
// deletion holding last-valid content labelled stale, the execution pin's
// match/mismatch/unknown, and the refusal of unlisted worktrees and foreign
// ids before any read. Every path asserts zero agent starts (invariant I6).
// Fixtures live in the plan harness's temporary repository; the openspec
// listing the checklist resolver sees is a runner double, so no CLI runs.
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
import type { WorkspaceDocumentView } from '../../shared/planWorkspace'
import type { OpenspecRunner } from '../plans/validation/openspecAdapter'
import { ExecutionStore } from '../plans/execution/executionStore'
import { ChangeArtifactsResolver } from '../plans/workspace/changeArtifacts'
import type { ExecutionPinStore } from '../plans/workspace/executionPin'
import { PlanWorkspaceDocumentConnections } from '../plans/workspace/workspaceDocuments'
import type { WorkspaceWatcherHost } from '../workspace/workspaceWatcher'
import { createPlanBench, createPlanWorld, sessionRow, type PlanWorld } from './planHarness'

/**
 * The watcher host double: watch callbacks and timers are recorded, so a
 * test fires a change, flushes the debounce, or runs the reconciliation
 * pass deterministically.
 */
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
    debounce,
    intervals,
    fireWatch: (directory: string, name: string) => watchers.get(directory)?.(path.join(directory, name)),
    flushDebounce: () => {
      const armed = debounce.splice(0)
      for (const { callback } of armed) callback()
    },
    reconcile: () => {
      for (const { callback } of intervals) callback()
    },
  }
}

let fixture: ReturnType<typeof fixtureHost>

/**
 * The openspec listing double: `alpha` is active in the main checkout, the
 * archive holds nothing, and alpha's status names its tasks artifact.
 */
const runner: OpenspecRunner = async (args, { cwd }) => {
  const call = (stdout: string) => ({ ok: true, exitCode: 0, stdout, stderr: '', timedOut: false })
  if (args[0] === 'list' && cwd === world.repo) {
    const names = args.includes('--archived') ? [] : ['alpha', 'notasks']
    return call(JSON.stringify({ changes: names.map(name => ({ name })), root: { path: world.repo } }))
  }
  if (args[0] === 'status' && cwd === world.repo && args[2] === 'alpha') {
    const changeRoot = path.join(world.repo, 'openspec', 'changes', 'alpha')
    return call(JSON.stringify({
      changeRoot,
      artifactPaths: { tasks: { existingOutputPaths: [path.join(changeRoot, 'tasks.md')] } },
    }))
  }
  if (args[0] === 'status' && cwd === world.repo && args[2] === 'notasks') {
    return call(JSON.stringify({ changeRoot: path.join(world.repo, 'openspec', 'changes', 'notasks'), artifactPaths: {} }))
  }
  return { ok: false, exitCode: 1, stdout: '', stderr: 'not found', timedOut: false }
}

const writeChecklistFixture = (): void => {
  const changeRoot = path.join(world.repo, 'openspec', 'changes', 'alpha')
  fs.mkdirSync(changeRoot, { recursive: true })
  fs.writeFileSync(path.join(changeRoot, 'tasks.md'), '# Tasks\n\n- [ ] first\n- [x] second\n')
}

let world: PlanWorld
let bench: ReturnType<typeof createPlanBench>
let connections: ChatConnections
let messages: ServerMessage[]
let executions: ExecutionStore
let agentStarts = 0
const records = new Map<string, ReturnType<typeof sessionRow>>()
const teamOfMap = new Map<string, TeamIdentity>()
const connection = { send: (message: ServerMessage) => messages.push(message) }

const sha = (text: string): string => crypto.createHash('sha256').update(text).digest('hex')
const docDir = () => path.join(world.feature, 'notes')
const docPath = () => path.join(docDir(), 'design.md')
const writeDoc = (text: string): void => {
  fs.mkdirSync(docDir(), { recursive: true })
  fs.writeFileSync(docPath(), text)
}

beforeAll(async () => {
  world = await createPlanWorld('kawai-plan-workspace-documents-')
})
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))
beforeEach(() => {
  fs.rmSync(path.join(world.feature, 'notes'), { recursive: true, force: true })
  fs.rmSync(path.join(world.repo, 'openspec'), { recursive: true, force: true })
  bench = createPlanBench(world)
  fixture = fixtureHost()
  executions = new ExecutionStore(bench.db.db)
  messages = []
  agentStarts = 0
  records.clear()
  for (const id of ['lead-chat']) records.set(id, sessionRow(id, 'leads', world.repo))
  teamOfMap.clear()
  for (const id of records.keys()) teamOfMap.set(id, world.team)
  const forbidden = (what: string) => () => { agentStarts += 1; throw new Error(`I6: ${what} must not be called`) }
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
  documents = new PlanWorkspaceDocumentConnections(managerDouble, { host: fixture.host, resolver: new ChangeArtifactsResolver(runner) })
})

let managerDouble: ChatSessionManager
let documents: PlanWorkspaceDocumentConnections
const docSend = (message: ClientMessage) => documents.handle(connection, message as Parameters<typeof documents.handle>[1])

const send = (message: ClientMessage) => connections.handle(connection, message)
const all = <T extends ServerMessage['type']>(type: T) =>
  messages.filter((message): message is Extract<ServerMessage, { type: T }> => message.type === type)
const last = <T extends ServerMessage['type']>(type: T) => all(type).at(-1)
type DocumentPush = Extract<ServerMessage, { type: 'team-plan-workspace-document' }>

async function untilDocument(check: (view: WorkspaceDocumentView) => boolean, tries = 400): Promise<DocumentPush> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const arrived = all('team-plan-workspace-document').filter(message => check(message.view))
    if (arrived.length > 0) return arrived[arrived.length - 1]!
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('no document push arrived')
}

/** One execution with the named changes, all waiting. */
function insertExecutionRow(planId: string, changes: string[]): string {
  return executions.insertExecution({
    teamId: world.team.teamId, planId, revision: 1, contentHash: 'h', reportId: 'r', inputHash: 'i',
    landingMode: 'direct', baseBranch: 'master', baseCommit: 'base',
    floor: { version: 1, map: { lint: ['ci'], typecheck: ['ci'], 'unit-tests': ['ci'], 'ci-e2e': ['e2e'] } },
    maxParallel: 2, mergeMethod: 'merge', changes: changes.map(change => ({ change, landed: false })),
  }).id
}

/** Provision one execution change in a worktree (the pin is worktree-scoped, O1). */
function provisionChange(executionId: string, change: string, worktree: string): void {
  const row = executions.change(executionId, change)!
  executions.transition(executionId, change, { state: row.state, generation: row.generation }, {
    worktree, branch: `${change}-branch`, baselineCommit: 'base',
  })
}

/** One attempt on a change whose manifest pins `artifacts`. */
function insertAttemptPinning(executionId: string, change: string, artifacts: Record<string, string>): void {
  executions.insertAttempt({
    executionId, change, kind: 'implement', assignmentId: null,
    manifest: {
      version: 1, plan: { id: executions.execution(executionId)!.planId, revision: 1, contentHash: 'h' }, execution: executionId,
      task: { id: 'task-x', revision: 1 }, validation: { reportId: 'r', inputHash: 'i' },
      baseline: 'base', startCommit: 'base', artifacts, roleProfiles: [],
    },
    manifestHash: 'mh',
  })
}

/** One execution whose single change is provisioned in the feature worktree, its attempt pinning `artifacts`. */
function insertPinnedExecution(planId: string, artifacts: Record<string, string>): string {
  const executionId = insertExecutionRow(planId, ['alpha'])
  provisionChange(executionId, 'alpha', world.feature)
  insertAttemptPinning(executionId, 'alpha', artifacts)
  return executionId
}

const openDocument = async (planId: string, extra: Record<string, unknown> = {}): Promise<void> =>
  docSend({
    type: 'team-plan-workspace-document-open',
    teamPath: world.repo, planId, worktreeId: world.feature, relativePath: 'notes/design.md', ...extra,
  })

describe('document subscriptions', () => {
  test('an external edit invalidates the hash and refreshes the subscription', async () => {
    const { planId } = await bench.draftInReview()
    writeDoc('alpha content\n')
    await openDocument(planId)
    expect(last('team-plan-workspace-document')!.view).toMatchObject({
      availability: 'current', stale: false, kind: 'markdown', contentHash: sha('alpha content\n'), text: 'alpha content\n',
    })
    writeDoc('changed content\n')
    fixture.fireWatch(docDir(), 'design.md')
    fixture.flushDebounce()
    const push = await untilDocument(view => view.contentHash === sha('changed content\n'))
    expect(push.view).toMatchObject({ availability: 'current', stale: false, reason: null, text: 'changed content\n' })
    expect(agentStarts).toBe(0)
  })

  test('a deleted source flips the view to missing with last-valid content labelled stale', async () => {
    const { planId } = await bench.draftInReview()
    writeDoc('alpha content\n')
    await openDocument(planId)
    fs.rmSync(docPath())
    fixture.fireWatch(docDir(), 'design.md')
    fixture.flushDebounce()
    const push = await untilDocument(view => view.availability === 'missing')
    expect(push.view).toMatchObject({
      availability: 'missing', stale: true, reason: 'missing',
      contentHash: sha('alpha content\n'), text: 'alpha content\n', kind: 'markdown',
    })
    expect(agentStarts).toBe(0)
  })

  test('the reconciliation pass recovers a missed watcher event', async () => {
    const { planId } = await bench.draftInReview()
    writeDoc('alpha content\n')
    await openDocument(planId)
    // No watch event fires for this edit: only the periodic pass sees it.
    writeDoc('reconciled content\n')
    fixture.reconcile()
    const push = await untilDocument(view => view.contentHash === sha('reconciled content\n'))
    expect(push.view).toMatchObject({ availability: 'current', stale: false })
    expect(agentStarts).toBe(0)
  })

  test('an unchanged document reads match against the selected execution\'s pin', async () => {
    const { planId } = await bench.draftInReview()
    writeDoc('alpha content\n')
    const executionId = insertPinnedExecution(planId, { 'notes/design.md': sha('alpha content\n') })
    await openDocument(planId, { executionId })
    expect(last('team-plan-workspace-document')!.view).toMatchObject({
      availability: 'current', executionMatch: 'match', executionId,
    })
    expect(agentStarts).toBe(0)
  })

  test('a changed document reads mismatch against the pin', async () => {
    const { planId } = await bench.draftInReview()
    writeDoc('alpha content\n')
    const executionId = insertPinnedExecution(planId, { 'notes/design.md': sha('different content\n') })
    await openDocument(planId, { executionId })
    expect(last('team-plan-workspace-document')!.view).toMatchObject({
      availability: 'current', executionMatch: 'mismatch', executionId,
    })
    expect(agentStarts).toBe(0)
  })

  test('no execution, or a path absent from the pin, reads unknown', async () => {
    const { planId } = await bench.draftInReview()
    writeDoc('alpha content\n')
    // No execution at all: unknown, and no execution is named.
    await openDocument(planId)
    expect(last('team-plan-workspace-document')!.view).toMatchObject({ executionMatch: 'unknown', executionId: null })
    // An execution whose pin does not name the path: still unknown.
    const executionId = insertPinnedExecution(planId, { 'other/file.md': sha('alpha content\n') })
    await docSend({ type: 'team-plan-workspace-document-close', teamPath: world.repo, planId, worktreeId: world.feature, relativePath: 'notes/design.md' })
    await openDocument(planId, { executionId })
    expect(last('team-plan-workspace-document')!.view).toMatchObject({ executionMatch: 'unknown', executionId })
    expect(agentStarts).toBe(0)
  })

  test('E9: the pin is the document worktree\'s own change, never the plan-wide newest attempt', async () => {
    const { planId } = await bench.draftInReview()
    writeDoc('alpha content\n')
    const executionId = insertExecutionRow(planId, ['alpha-a', 'alpha-b'])
    provisionChange(executionId, 'alpha-a', world.feature)
    provisionChange(executionId, 'alpha-b', path.join(world.root, 'repo-b'))
    insertAttemptPinning(executionId, 'alpha-a', { 'notes/design.md': sha('alpha content\n') })
    // B's attempt is the execution's newest; the plan-wide rule would pin A's
    // worktree with it and read a false mismatch here.
    insertAttemptPinning(executionId, 'alpha-b', { 'notes/design.md': sha('other content\n') })
    await openDocument(planId, { executionId })
    expect(last('team-plan-workspace-document')!.view).toMatchObject({ executionMatch: 'match', executionId })
    // The main checkout hosts no change of the execution: no pin at all.
    await docSend({ type: 'team-plan-workspace-document-close', teamPath: world.repo, planId, worktreeId: world.feature, relativePath: 'notes/design.md' })
    await docSend({ type: 'team-plan-workspace-document-open', teamPath: world.repo, planId, worktreeId: world.repo, relativePath: 'notes/design.md' })
    expect(last('team-plan-workspace-document')!.view).toMatchObject({ executionMatch: 'unknown', executionId: null })
    expect(agentStarts).toBe(0)
  })

  test('a compose throw answers the open with an explicit unavailable state (O3)', async () => {
    const { planId } = await bench.draftInReview()
    const throwing = new PlanWorkspaceDocumentConnections(managerDouble, {
      host: fixture.host,
      resolver: new ChangeArtifactsResolver(runner),
      read: async () => { throw new Error('reader exploded') },
    })
    const sendTo = (target: PlanWorkspaceDocumentConnections, message: ClientMessage) =>
      target.handle(connection, message as Parameters<typeof target.handle>[1])
    // A document open still answers: missing, with the failure named.
    await sendTo(throwing, { type: 'team-plan-workspace-document-open', teamPath: world.repo, planId, worktreeId: world.feature, relativePath: 'notes/design.md' })
    const document = last('team-plan-workspace-document')!
    expect(document.view).toMatchObject({ availability: 'missing', stale: false, executionMatch: 'unknown', executionId: null })
    expect(document.view.reason).toContain('reader exploded')
    // A checklist open still answers: explicitly unreadable, not silence.
    await sendTo(throwing, { type: 'team-plan-workspace-checklist-open', teamPath: world.repo, planId, changeName: 'alpha' })
    const checklist = last('team-plan-workspace-checklist')!
    expect(checklist.checklist).toBeNull()
    expect(checklist.unavailable).toMatchObject({ state: 'unreadable' })
    expect(checklist.unavailable!.message).toContain('reader exploded')
    throwing.stop()
    expect(agentStarts).toBe(0)
  })

  test('stop() closes every watcher and clears the debounce and reconcile timers (O2)', async () => {
    const { planId } = await bench.draftInReview()
    writeDoc('alpha content\n')
    await openDocument(planId)
    expect(fixture.watchers.size).toBeGreaterThan(0)
    expect(fixture.intervals.length).toBeGreaterThan(0)
    // A pending change has armed a debounce timer; stop() must clear it too.
    fixture.fireWatch(docDir(), 'design.md')
    expect(fixture.debounce.length).toBeGreaterThan(0)
    documents.stop()
    expect(fixture.watchers.size).toBe(0)
    expect(fixture.debounce.length).toBe(0)
    expect(fixture.intervals.length).toBe(0)
    expect(agentStarts).toBe(0)
  })

  test('a missing document is never substituted from another worktree', async () => {
    const { planId } = await bench.draftInReview()
    // The file exists in the main checkout only; the open names the feature worktree.
    fs.mkdirSync(path.join(world.repo, 'notes'), { recursive: true })
    fs.writeFileSync(path.join(world.repo, 'notes', 'design.md'), 'main checkout content\n')
    await openDocument(planId)
    const push = await untilDocument(view => view.availability === 'missing')
    expect(push.view).toMatchObject({
      availability: 'missing', stale: false, reason: 'missing',
      contentHash: null, text: null, worktreeId: world.feature,
    })
    expect(agentStarts).toBe(0)
  })
})

describe('checklist subscriptions', () => {
  test('a checklist open projects the tasks artifact; a missing change reads explicitly unavailable', async () => {
    const { planId } = await bench.draftInReview()
    writeChecklistFixture()
    await docSend({ type: 'team-plan-workspace-checklist-open', teamPath: world.repo, planId, changeName: 'alpha' })
    const push = last('team-plan-workspace-checklist')!
    expect(push).toMatchObject({ teamPath: world.repo, planId, changeName: 'alpha', unavailable: null })
    expect(push.checklist!.sections).toHaveLength(1)
    expect(push.checklist!.sections[0]).toMatchObject({ heading: 'Tasks', depth: 1 })
    expect(push.checklist!.sections[0]!.items).toEqual([
      { key: `${sha('# Tasks\n\n- [ ] first\n- [x] second\n')}:3`, text: 'first', checked: false, line: 3, depth: 1 },
      { key: `${sha('# Tasks\n\n- [ ] first\n- [x] second\n')}:4`, text: 'second', checked: true, line: 4, depth: 1 },
    ])
    // A change absent from both listings is an explicit unavailable state,
    // not a silent empty projection.
    await docSend({ type: 'team-plan-workspace-checklist-open', teamPath: world.repo, planId, changeName: 'ghost' })
    const missing = last('team-plan-workspace-checklist')!
    expect(missing.checklist).toBeNull()
    expect(missing.unavailable).toMatchObject({ state: 'missing' })
    expect(agentStarts).toBe(0)
  })

  test('a change with no tasks artifact reads explicitly unavailable, not zero completion', async () => {
    const { planId } = await bench.draftInReview()
    await docSend({ type: 'team-plan-workspace-checklist-open', teamPath: world.repo, planId, changeName: 'notasks' })
    const push = last('team-plan-workspace-checklist')!
    expect(push.checklist).toBeNull()
    expect(push.unavailable).toMatchObject({ state: 'unreadable' })
    expect(push.unavailable!.message).toContain('no tasks artifact')
    expect(agentStarts).toBe(0)
  })

  test('a checklist invalidation re-projects after an edit through the reconciliation pass', async () => {
    const { planId } = await bench.draftInReview()
    writeChecklistFixture()
    await docSend({ type: 'team-plan-workspace-checklist-open', teamPath: world.repo, planId, changeName: 'alpha' })
    expect(all('team-plan-workspace-checklist')).toHaveLength(1)
    const tasksPath = path.join(world.repo, 'openspec', 'changes', 'alpha', 'tasks.md')
    fs.writeFileSync(tasksPath, '# Tasks\n\n- [x] first\n- [x] second\n- [ ] third\n')
    fixture.reconcile()
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (all('team-plan-workspace-checklist').length > 1) break
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    const refreshed = last('team-plan-workspace-checklist')!
    expect(refreshed.checklist!.sections[0]!.items).toHaveLength(3)
    expect(agentStarts).toBe(0)
  })
})

describe('subscription refusals', () => {
  test('a document open refuses an unlisted worktree, a foreign team and a foreign execution before any read', async () => {
    const { planId } = await bench.draftInReview()
    writeDoc('alpha content\n')
    await docSend({
      type: 'team-plan-workspace-document-open',
      teamPath: world.repo, planId, worktreeId: world.other, relativePath: 'notes/design.md',
    })
    expect(messages).toEqual([{ type: 'error', message: expect.stringContaining('Worktree not listed') }])
    expect(all('team-plan-workspace-document')).toHaveLength(0)
    messages = []
    // Another team's directory resolves to no team at all.
    await docSend({
      type: 'team-plan-workspace-document-open',
      teamPath: world.other, planId, worktreeId: world.other, relativePath: 'notes/design.md',
    })
    expect(messages).toEqual([{ type: 'error', message: expect.stringContaining('team') }])
    messages = []
    // An execution id of no execution in this plan is refused at open.
    await docSend({
      type: 'team-plan-workspace-document-open',
      teamPath: world.repo, planId, worktreeId: world.feature, relativePath: 'notes/design.md', executionId: 'exec-gone',
    })
    expect(messages).toEqual([{ type: 'error', message: expect.stringContaining('Execution not found in this plan') }])
    expect(all('team-plan-workspace-document')).toHaveLength(0)
    expect(agentStarts).toBe(0)
  })

  test('a document open dispatched through ChatConnections reaches the document connections', async () => {
    const { planId } = await bench.draftInReview()
    writeDoc('alpha content\n')
    // The real host watches the temporary fixture directory; the production
    // resolver is never touched because a document open reads no listing.
    await send({
      type: 'team-plan-workspace-document-open',
      teamPath: world.repo, planId, worktreeId: world.feature, relativePath: 'notes/design.md',
    })
    expect(last('team-plan-workspace-document')!.view).toMatchObject({
      availability: 'current', contentHash: sha('alpha content\n'),
    })
    expect(agentStarts).toBe(0)
  })
})

describe('the plan-execution seam (O4)', () => {
  test('the manager seam is read-only: the pin accessors answer, no writer is reachable', () => {
    const seam: ExecutionPinStore = executions
    expect(seam.execution('no-such-execution')).toBeNull()
    expect(seam.latestForPlan('no-such-plan')).toBeNull()
    expect(seam.changes('no-such-execution')).toEqual([])
    expect(seam.latestAttemptForChange('no-such-execution', 'alpha')).toBeNull()
    // The type-level half: widening the interface to expose a writer fails typecheck.
    // @ts-expect-error no writer is reachable through the read-only seam
    void seam.insertExecution
    expect(agentStarts).toBe(0)
  })
})
