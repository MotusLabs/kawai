// The session-record lifecycle hook (team-workspace review item 6): a chat
// session's creation, archive, restore, and kill each reach
// `onSessionRecordChange`, which bootstrap wires to the team workspace's
// live-membership push — so Members moves without waiting for unrelated
// task or mail activity. The same handler's turn-end bookkeeping is pinned
// here too: a failing turn-end write or a failing teamMail.turnEnded is
// contained, so the rest of the turn bookkeeping still runs.
import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ChatSessionManager } from '../chat/ChatSessionManager'
import { initDatabase, type SessionDatabase } from '../db'
import { logger } from '../logger'
import { SessionRegistry } from '../SessionRegistry'
import { resolveTeam } from '../team/teamIdentity'

let tempDir: string
let project: string
let home: string
let db: SessionDatabase
const originalApiKey = process.env.ANTHROPIC_API_KEY

beforeEach(() => {
  tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-chat-workspace-hooks-')))
  project = path.join(tempDir, 'project')
  home = path.join(tempDir, 'home')
  fs.mkdirSync(path.join(project, '.kawai', 'groups'), { recursive: true })
  fs.writeFileSync(path.join(project, '.kawai', 'groups', 'devs.md'), 'Build.')
  db = initDatabase({ path: path.join(tempDir, 'test.db') })
  process.env.ANTHROPIC_API_KEY = 'sk-test-key'
})

afterEach(() => {
  if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = originalApiKey
  db.close()
  fs.rmSync(tempDir, { recursive: true, force: true })
})

interface Harness {
  manager: ChatSessionManager
  changed: string[]
}

/** Wait until `done` holds: team resolution spawns git, so its hook lands after an unknown delay. */
async function until(done: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (!done() && Date.now() < deadline) await Bun.sleep(5)
}

const createManager = (): Harness => {
  const changed: string[] = []
  const manager = new ChatSessionManager({
    db,
    registry: new SessionRegistry(),
    onEvent: () => {},
    profileCatalogHome: home,
    availabilityProbe: async () => {},
    onSessionRecordChange: sessionId => changed.push(sessionId),
  })
  return { manager, changed }
}

test('a session created with a group reaches the hook once its team resolves', async () => {
  const { manager, changed } = createManager()
  try {
    const result = await manager.createAvailableSession({ projectPath: project, groupId: 'devs' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // onResolved fires from the track promise once git answers; let it land.
    await until(() => changed.includes(result.session.id))
    expect(changed).toContain(result.session.id)
  } finally { manager.shutdown() }
})

test('archive, restore, and kill each reach the hook', async () => {
  const { manager, changed } = createManager()
  try {
    const result = await manager.createAvailableSession({ projectPath: project, groupId: 'devs' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const { id } = result.session
    await until(() => changed.includes(id))
    changed.length = 0
    expect(manager.archive(id).ok).toBe(true)
    expect(changed).toEqual([id])
    changed.length = 0
    expect(manager.restore(id).ok).toBe(true)
    expect(changed).toEqual([id])
    changed.length = 0
    expect(manager.kill(id)).toBe(true)
    expect(changed).toEqual([id])
  } finally { manager.shutdown() }
})

test('a status move reaches the hook; usage and activity stamps do not', async () => {
  const { manager, changed } = createManager()
  try {
    const result = await manager.createAvailableSession({ projectPath: project, groupId: 'devs' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const { id } = result.session
    await until(() => changed.includes(id))
    changed.length = 0
    const patcher = manager as unknown as {
      applyPatch(sessionId: string, patch: Partial<{ status: string; lastActivityAt: string }>): void
    }
    patcher.applyPatch(id, { lastActivityAt: '2026-10-14T02:00:00Z' })
    expect(changed).toEqual([])
    patcher.applyPatch(id, { status: 'working' })
    expect(changed).toEqual([id])
  } finally { manager.shutdown() }
})

test('a task-bound turn end writes a durable row with its outcome; a taskless one writes nothing', async () => {
  const { manager } = createManager()
  try {
    // A real task row: the summary's team scoping joins team_tasks on it.
    const caller = { kind: 'human' as const, team: await resolveTeam(project) }
    const task = await manager.tasks.create(caller, { title: 'Worked on', direction: 'd' })
    const bound = await manager.createAvailableSession({ projectPath: project, groupId: 'devs', taskId: task.id })
    const free = await manager.createAvailableSession({ projectPath: project, groupId: 'devs' })
    expect(bound.ok && free.ok).toBe(true)
    if (!bound.ok || !free.ok) return
    await until(() => manager.teams.teamOf(bound.session.id) !== undefined && manager.teams.teamOf(free.session.id) !== undefined)
    const feed = (manager as unknown as { handleDriverEvent: (sessionId: string, event: Record<string, unknown>) => void })
      .handleDriverEvent.bind(manager)
    const turnEnd = (id: string, at: string, subtype = 'success') => ({
      type: 'turn_completed', subtype, id: `evt-${id}`, sequence: 1, turnId: `t-${id}`, at,
    })
    feed(bound.session.id, turnEnd('bound', '2026-10-14T08:00:00Z'))
    feed(bound.session.id, turnEnd('errored', '2026-10-14T08:30:00Z', 'error_during_execution'))
    feed(free.session.id, turnEnd('free', '2026-10-14T08:01:00Z'))
    expect(manager.turnEnds.since('2026-10-13T00:00:00Z')).toEqual([
      { sessionId: bound.session.id, taskId: task.id, endedAt: '2026-10-14T08:00:00Z', ok: true },
      { sessionId: bound.session.id, taskId: task.id, endedAt: '2026-10-14T08:30:00Z', ok: false },
    ])
    // The errored turn is recorded but never counts as finished work, and
    // the team's rows are the join's, not the live session set's.
    const teamId = manager.teams.teamOf(bound.session.id)!.teamId
    expect(manager.turnEnds.finishedForTeam(teamId, '2026-10-13T00:00:00Z')).toEqual([
      { sessionId: bound.session.id, taskId: task.id, endedAt: '2026-10-14T08:00:00Z', ok: true },
    ])
  } finally { manager.shutdown() }
})

test('a success result flagged is_error is a failed turn for turn ends, usage, and mail outcomes', async () => {
  const { manager } = createManager()
  try {
    const caller = { kind: 'human' as const, team: await resolveTeam(project) }
    const task = await manager.tasks.create(caller, { title: 'Go', direction: 'd' })
    const bound = await manager.createAvailableSession({ projectPath: project, groupId: 'devs', taskId: task.id })
    if (!bound.ok) throw new Error(bound.error)
    const { id } = bound.session
    await until(() => manager.teams.teamOf(id) !== undefined)
    const mail = (manager as unknown as { teamMail: { turnEnded: (id: string, ok: boolean) => void } }).teamMail
    const ended = spyOn(mail, 'turnEnded')
    try {
      const feed = (manager as unknown as { handleDriverEvent: (sessionId: string, event: Record<string, unknown>) => void })
        .handleDriverEvent.bind(manager)
      feed(id, { type: 'turn_started', id: 's-1', sequence: 1, turnId: 't-1', at: '2026-10-18T08:28:00Z' })
      feed(id, {
        // A non-exhausting reason: an exhausting one takes the exhaustion
        // outcome instead (chatContextExhaustedFlag.test.ts).
        type: 'turn_completed', subtype: 'success', isError: true, terminalReason: 'api_error',
        id: 'e-1', sequence: 2, turnId: 't-1', at: '2026-10-18T08:28:01Z',
      })
      expect(ended).toHaveBeenCalledWith(id, false)
      expect(manager.turnEnds.since('2026-10-13T00:00:00Z')).toEqual([
        { sessionId: id, taskId: task.id, endedAt: '2026-10-18T08:28:01Z', ok: false },
      ])
      // The morning summary's finished turns never include it.
      expect(manager.turnEnds.finishedForTeam(manager.teams.teamOf(id)!.teamId, '2026-10-13T00:00:00Z')).toEqual([])
      expect(manager.turnUsage.forSession(id)).toEqual([expect.objectContaining({ ok: false })])
    } finally { ended.mockRestore() }
  } finally { manager.shutdown() }
})

test('a failing turn-end write is contained: the turn bookkeeping still runs, nothing escapes', async () => {
  const { manager } = createManager()
  try {
    const bound = await manager.createAvailableSession({ projectPath: project, groupId: 'devs', taskId: 'task-1' })
    expect(bound.ok).toBe(true)
    if (!bound.ok) return
    const { id } = bound.session
    // A store whose every write blows up (disk full, busy past the timeout).
    ;(manager as unknown as { turnEnds: unknown }).turnEnds = {
      record: () => { throw new Error('disk full') },
      since: () => [],
      finishedForTeam: () => [],
    }
    const feed = (manager as unknown as { handleDriverEvent: (sessionId: string, event: Record<string, unknown>) => void })
      .handleDriverEvent.bind(manager)
    const activityAt = () =>
      (manager as unknown as { records: Map<string, { lastActivityAt: string }> }).records.get(id)!.lastActivityAt
    // A stale stamp, so touch() moving it to now is unambiguous even within
    // one millisecond.
    ;(manager as unknown as { applyPatch: (sessionId: string, patch: Record<string, unknown>) => void })
      .applyPatch(id, { lastActivityAt: '2020-01-01T00:00:00Z' })
    const before = activityAt()
    let escaped: unknown = null
    try {
      feed(id, { type: 'turn_completed', subtype: 'success', id: 'evt-1', sequence: 1, turnId: 't-1', at: '2026-10-14T08:00:00Z' })
    } catch (error) { escaped = error }
    expect(escaped).toBeNull()
    // touch() ran after the failing write: the activity stamp moved.
    expect(activityAt()).not.toBe(before)
    expect(Date.parse(activityAt())).toBeGreaterThan(Date.UTC(2021, 0, 1))
  } finally { manager.shutdown() }
})

test('a failing teamMail.turnEnded is contained: the turn bookkeeping still runs, nothing escapes', async () => {
  const { manager } = createManager()
  try {
    const bound = await manager.createAvailableSession({ projectPath: project, groupId: 'devs', taskId: 'task-1' })
    expect(bound.ok).toBe(true)
    if (!bound.ok) return
    const { id } = bound.session
    // A mailbox whose turn-end hook blows up; every other method stays the
    // real one (the manager's background paths keep using it).
    const real = (manager as unknown as { teamMail: Record<string, unknown> }).teamMail
    const stub: Record<string, unknown> = Object.create(real)
    stub.turnEnded = () => { throw new Error('mailbox store closed') }
    ;(manager as unknown as { teamMail: unknown }).teamMail = stub
    const feed = (manager as unknown as { handleDriverEvent: (sessionId: string, event: Record<string, unknown>) => void })
      .handleDriverEvent.bind(manager)
    const activityAt = () =>
      (manager as unknown as { records: Map<string, { lastActivityAt: string }> }).records.get(id)!.lastActivityAt
    ;(manager as unknown as { applyPatch: (sessionId: string, patch: Record<string, unknown>) => void })
      .applyPatch(id, { lastActivityAt: '2020-01-01T00:00:00Z' })
    const before = activityAt()
    const warn = spyOn(logger, 'warn').mockImplementation(() => {})
    let escaped: unknown = null
    try {
      feed(id, { type: 'turn_completed', subtype: 'success', id: 'evt-1', sequence: 1, turnId: 't-1', at: '2026-10-14T08:00:00Z' })
    } catch (error) { escaped = error }
    expect(escaped).toBeNull()
    expect(warn.mock.calls.filter(([event]) => event === 'chat_turn_mail_ended_failed')).toHaveLength(1)
    warn.mockRestore()
    // The durable turn-end row and the activity stamp both landed.
    expect(manager.turnEnds.since('2026-10-13T00:00:00Z')).toEqual([
      { sessionId: id, taskId: 'task-1', endedAt: '2026-10-14T08:00:00Z', ok: true },
    ])
    expect(activityAt()).not.toBe(before)
  } finally { manager.shutdown() }
})

test('every completed turn writes a usage row: task-bound, task-less, and group-less; a kill keeps them', async () => {
  const { manager } = createManager()
  try {
    const bound = await manager.createAvailableSession({ projectPath: project, groupId: 'devs', taskId: 'task-1' })
    const free = await manager.createAvailableSession({ projectPath: project, groupId: 'devs' })
    const loose = await manager.createAvailableSession({ projectPath: project })
    if (!bound.ok || !free.ok || !loose.ok) throw new Error('create failed')
    await until(() => [bound, free, loose].every(r => manager.teams.teamOf(r.session.id) !== undefined))
    const feed = (manager as unknown as { handleDriverEvent: (sessionId: string, event: Record<string, unknown>) => void })
      .handleDriverEvent.bind(manager)
    const turn = (id: string, turnId: string) => {
      feed(id, { type: 'turn_started', id: `s-${turnId}`, sequence: 1, turnId, at: '2026-10-14T08:00:00Z' })
      feed(id, { type: 'turn_completed', subtype: 'success', id: `e-${turnId}`, sequence: 2, turnId, at: '2026-10-14T08:01:00Z', numTurns: 4,
        usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheCreationTokens: 4 } })
    }
    turn(bound.session.id, 't-bound')
    turn(free.session.id, 't-free')
    turn(loose.session.id, 't-loose')
    const teamId = manager.teams.teamOf(bound.session.id)!.teamId
    expect(manager.turnUsage.forSession(bound.session.id)).toEqual([expect.objectContaining({ taskId: 'task-1', groupId: 'devs', teamId, profileId: 'default', numTurns: 4 })])
    expect(manager.turnUsage.forSession(free.session.id)).toEqual([expect.objectContaining({ taskId: null, groupId: 'devs', teamId })])
    expect(manager.turnUsage.forSession(loose.session.id)).toEqual([expect.objectContaining({ taskId: null, groupId: null, teamId })])
    expect(manager.kill(bound.session.id)).toBe(true)
    expect(manager.turnUsage.forSession(bound.session.id)).toHaveLength(1)
  } finally { manager.shutdown() }
})

test('a failing usage write is logged and leaves mail settlement intact', async () => {
  const { manager } = createManager()
  try {
    const bound = await manager.createAvailableSession({ projectPath: project, groupId: 'devs' })
    if (!bound.ok) throw new Error(bound.error)
    const { id } = bound.session
    const record = spyOn(manager.turnUsage, 'record').mockImplementation(() => { throw new Error('disk full') })
    const settle = spyOn((manager as unknown as { teamMail: { settleRecipient: (id: string) => void } }).teamMail, 'settleRecipient')
    const warn = spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      const feed = (manager as unknown as { handleDriverEvent: (sessionId: string, event: Record<string, unknown>) => void })
        .handleDriverEvent.bind(manager)
      feed(id, { type: 'turn_completed', subtype: 'success', id: 'evt-1', sequence: 1, turnId: 't-1', at: '2026-10-14T08:00:00Z' })
      expect(record).toHaveBeenCalledTimes(1)
      expect(settle).toHaveBeenCalledWith(id)
      expect(warn.mock.calls.filter(([event]) => event === 'chat_turn_usage_record_failed')).toHaveLength(1)
    } finally { record.mockRestore(); settle.mockRestore(); warn.mockRestore() }
  } finally { manager.shutdown() }
})
