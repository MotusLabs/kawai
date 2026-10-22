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
import type { WorkspaceDocumentView, WorkspaceExecutionMatch } from '../../shared/planWorkspace'
import type { OpenspecRunner } from '../plans/validation/openspecAdapter'
import { ExecutionStore } from '../plans/execution/executionStore'
import { ChangeArtifactsResolver } from '../plans/workspace/changeArtifacts'
import { GIT_MAX_OUTPUT_BYTES } from '../git/gitCommand'
import { executionMatchFor, type CurrentDocument, type ExecutionPin } from '../plans/workspace/executionPin'
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

/**
 * The executionMatch oracle's decision table (B1+O1, the fix brief E1–E9):
 * one row per case. The manifest hashes git show's UTF-8-decoded stdout cut
 * at GIT_MAX_OUTPUT_BYTES; the reader hashes raw bytes, so only a BOM-free,
 * fatally valid, within-bound markdown compares. Mutants each row kills:
 * E3 drops the kind check, E4 the size check, E5 the BOM check (E6 covers
 * the fatal decode), E9 (above) the plan-wide latest attempt.
 */
describe('the executionMatch oracle (table E1–E8)', () => {
  const PATH = 'notes/design.md'
  const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text)
  const hashOf = (bytes: Uint8Array): string => crypto.createHash('sha256').update(bytes).digest('hex')
  const pinAt = (hash: string, executionId = 'exec-e'): ExecutionPin => ({ executionId, artifacts: { [PATH]: hash } })
  const markdown = (text: string): CurrentDocument => {
    const bytes = bytesOf(text)
    return { kind: 'markdown', hash: hashOf(bytes), size: bytes.length, bytes }
  }
  const unchanged = hashOf(bytesOf('alpha content\n'))

  const rows: Array<{ id: string; pin: ExecutionPin | null; current: CurrentDocument | null; match: WorkspaceExecutionMatch; executionId: string | null }> = [
    { id: 'E1: no pin reads unknown and names no execution', pin: null, current: markdown('alpha content\n'), match: 'unknown', executionId: null },
    { id: 'E2: a path absent from the pin map reads unknown, naming the execution', pin: { executionId: 'exec-2', artifacts: { 'other/file.md': unchanged } }, current: markdown('alpha content\n'), match: 'unknown', executionId: 'exec-2' },
    // An image is never comparable, whatever its bytes decode to: the
    // manifest has no identity for it. The bytes are valid BOM-free UTF-8 so
    // this row isolates the kind check.
    { id: 'E3: an image reads unknown even when its bytes are unchanged', pin: pinAt(unchanged), current: { kind: 'image', hash: unchanged, size: bytesOf('alpha content\n').length, bytes: bytesOf('alpha content\n') }, match: 'unknown', executionId: 'exec-e' },
    { id: 'E4: markdown one byte past the git output bound reads unknown', pin: pinAt(hashOf(bytesOf('a'.repeat(GIT_MAX_OUTPUT_BYTES + 1)))), current: { kind: 'markdown', hash: hashOf(bytesOf('a'.repeat(GIT_MAX_OUTPUT_BYTES + 1))), size: GIT_MAX_OUTPUT_BYTES + 1, bytes: bytesOf('a'.repeat(GIT_MAX_OUTPUT_BYTES + 1)) }, match: 'unknown', executionId: 'exec-e' },
    { id: 'E5: markdown starting with a UTF-8 BOM reads unknown', pin: pinAt(hashOf(bytesOf('﻿alpha content\n'))), current: markdown('﻿alpha content\n'), match: 'unknown', executionId: 'exec-e' },
    { id: 'E6: invalid UTF-8 reads unknown', pin: pinAt(hashOf(Uint8Array.from([0xff, 0xfe, 0x61]))), current: { kind: 'markdown', hash: hashOf(Uint8Array.from([0xff, 0xfe, 0x61])), size: 3, bytes: Uint8Array.from([0xff, 0xfe, 0x61]) }, match: 'unknown', executionId: 'exec-e' },
    { id: 'E7: comparable and equal reads match', pin: pinAt(unchanged), current: markdown('alpha content\n'), match: 'match', executionId: 'exec-e' },
    { id: 'E7: the largest comparable size (exactly the bound) reads match', pin: pinAt(hashOf(bytesOf('a'.repeat(GIT_MAX_OUTPUT_BYTES)))), current: { kind: 'markdown', hash: hashOf(bytesOf('a'.repeat(GIT_MAX_OUTPUT_BYTES))), size: GIT_MAX_OUTPUT_BYTES, bytes: bytesOf('a'.repeat(GIT_MAX_OUTPUT_BYTES)) }, match: 'match', executionId: 'exec-e' },
    { id: 'E8: comparable and different reads mismatch', pin: pinAt(hashOf(bytesOf('other\n'))), current: markdown('alpha content\n'), match: 'mismatch', executionId: 'exec-e' },
    { id: 'no current content never compares, naming the pin when one exists', pin: pinAt(unchanged), current: null, match: 'unknown', executionId: 'exec-e' },
  ]

  test.each(rows)('$id', ({ pin, current, match, executionId }) => {
    expect(executionMatchFor(pin, PATH, current)).toEqual({ match, executionId })
  })
})
