// `task_transfer_owner` (group-mail-task-affinity D7, task 2.3): rows T1–T11
// of design.md's "Ownership transfer" table through the production
// `TaskService` and its tool handlers, and property P4 — seeded sequences of
// creates, transfers, takeovers, archives, and flags after which every agent
// task has exactly one owner, its last journaled move (or its creator) names
// that owner, and a refused call changes nothing.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import type { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import type { ChatSessionRecord } from '../db'
import { MailboxStore } from '../team/mailboxStore'
import { TaskStore } from '../team/taskStore'
import { TaskService, type TaskCaller } from '../team/TaskService'
import { taskHandlers } from '../team/taskTools'
import { clearTeamCache, resolveTeam, type TeamIdentity } from '../team/teamIdentity'
import { schemaCopy } from './schemaDb'

let root: string
let repo: string
let team: TeamIdentity
let db: Database
let service: TaskService
let records: Map<string, ChatSessionRecord>
const agent = (sessionId: string): TaskCaller => ({ kind: 'agent', sessionId })
const tool = (sessionId: string) => taskHandlers(service, sessionId).task_transfer_owner

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-transfer-owner-')))
  repo = path.join(root, 'repo')
  fs.mkdirSync(repo)
  for (const args of [['init', '-q'], ['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init']]) {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: cleanGitEnv() })
    if (result.status !== 0) throw new Error(result.stderr)
  }
  fs.mkdirSync(path.join(repo, '.kawai', 'groups'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'lead.md'), '---\ncanCreateTasks: true\n---\nLead.')
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'devs.md'), '---\n---\nBuild.')
  team = await resolveTeam(repo)
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

const row = (sessionId: string, groupId: string): ChatSessionRecord => ({
  sessionId, groupId, projectPath: repo, name: sessionId, sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '',
})
beforeEach(() => {
  clearTeamCache()
  records = new Map(['lead-a', 'lead-b', 'lead-c'].map(id => [id, row(id, 'lead')]))
  records.set('dev', row('dev', 'devs'))
  db?.close()
  db = schemaCopy()
  service = new TaskService(new TaskStore(db, new MailboxStore(db)), { getSession: id => records.get(id) })
})

const create = async (owner = 'lead-a') => (await service.create(agent(owner), { title: 'T', direction: 'go' })).id
const ownerOf = (id: string) => service.store.get(id)!.ownerSession
// The journaled moves, oldest first; a direct read keeps P4's 3,600 steps cheap.
const moves = (id: string) => (db.prepare("SELECT text FROM team_task_journal WHERE task_id = ? AND text LIKE 'owner: %' ORDER BY created_at, rowid")
  .all(id) as Array<{ text: string }>).map(row => row.text)
const archive = (id: string) => { records.get(id)!.archivedAt = '2026-11-05T10:00:00.000Z' }
const flag = (id: string) => { records.get(id)!.contextExhausted = { at: '2026-11-05T10:00:00.000Z', reason: 'blocking_limit' } }

/** Runs a call that must refuse, and checks that nothing changed. */
async function refused(call: Promise<unknown>, message: string | RegExp, ids: string[]) {
  const before = ids.map(id => [ownerOf(id), moves(id).length])
  await expect(call).rejects.toThrow(message)
  expect(ids.map(id => [ownerOf(id), moves(id).length])).toEqual(before)
}

describe('task_transfer_owner (T1–T11)', () => {
  // @covers: team-tasks › Agents transfer task ownership › Owner hands a task over
  test('T1: the owner hands a task to a live session of its group; the move is journaled by the owner', async () => {
    const id = await create()
    expect(await tool('lead-a')({ task_id: id, to_session: 'lead-b', reason: 'leaving' })).toEqual({ from: 'lead-a', to: 'lead-b', taskIds: [id] })
    expect(ownerOf(id)).toBe('lead-b')
    expect(moves(id)).toEqual(['owner: lead-a -> lead-b by lead-a (leaving)'])
    expect(service.store.detail(id)!.journal.at(-1)!.author).toEqual({ kind: 'agent', sessionId: 'lead-a' })
  })

  // @covers: team-tasks › Agents transfer task ownership › Target outside the group or flagged
  test('T2: a target in another group, archived, flagged, or unknown is refused naming it', async () => {
    const id = await create()
    await refused(tool('lead-a')({ task_id: id, to_session: 'dev' }), 'Session dev is not in your group (lead)', [id])
    archive('lead-b')
    await refused(tool('lead-a')({ task_id: id, to_session: 'lead-b' }), 'Session lead-b cannot take the task: it is archived', [id])
    flag('lead-c')
    await refused(tool('lead-a')({ task_id: id, to_session: 'lead-c' }), 'Session lead-c cannot take the task: it is context-exhausted', [id])
    await refused(tool('lead-a')({ task_id: id, to_session: 'nobody' }), 'Session nobody cannot take the task: it is not a session of this team', [id])
    await refused(tool('lead-a')({ task_id: id }), 'You already own this task', [id])
  })

  // @covers: team-tasks › Agents transfer task ownership › Taking over from an archived owner
  test('T3: a session of the group takes over from an archived or gone owner', async () => {
    const archived = await create('lead-a')
    archive('lead-a')
    expect((await tool('lead-b')({ task_id: archived })).taskIds).toEqual([archived])
    expect(ownerOf(archived)).toBe('lead-b')
    expect(moves(archived)).toEqual(['owner: lead-a -> lead-b by lead-b'])
    // A gone owner (no record left) is matched by the caller's right to own tasks.
    const orphan = await create('lead-c')
    records.delete('lead-c')
    expect((await tool('lead-b')({ task_id: orphan })).to).toBe('lead-b')
  })

  test('T4: a session of the group takes over from a context-exhausted owner', async () => {
    const id = await create()
    flag('lead-a')
    await tool('lead-b')({ task_id: id, to_session: 'lead-b' })
    expect(ownerOf(id)).toBe('lead-b')
  })

  // @covers: team-tasks › Agents transfer task ownership › Live owner refuses a takeover
  test('T5: a live, unflagged owner is never taken over; the refusal names it and suggests messaging it', async () => {
    const id = await create()
    await refused(tool('lead-b')({ task_id: id }), 'Session lead-a owns this and is still live; message it', [id])
  })

  // @covers: team-tasks › Agents transfer task ownership › Caller outside the owner's group
  test('T6: a caller outside the owner\'s group is refused, even from a departed owner', async () => {
    const id = await create()
    archive('lead-a')
    await refused(tool('dev')({ task_id: id }), 'Only a session of group lead can take over', [id])
    await refused(tool('dev')({ from_session: 'lead-a' }), 'Only a session of group lead can take over', [id])
    records.delete('lead-a')
    await refused(tool('dev')({ task_id: id }), "Only a session of the owner's group can take over", [id])
  })

  // @covers: team-tasks › Agents transfer task ownership › Taking every task of a departed owner
  test('T7: from_session takes every open, active, and blocked task; done and cancelled keep their owner', async () => {
    const open = await create()
    const active = await create()
    const blocked = await create()
    const done = await create()
    const cancelled = await create()
    const others = await create('lead-b')
    await service.setStatus(agent('lead-a'), active, 'active')
    await service.setStatus(agent('lead-a'), blocked, 'blocked')
    await service.setStatus(agent('lead-a'), done, 'done')
    await service.setStatus(agent('lead-a'), cancelled, 'cancelled')
    flag('lead-a')
    expect(await tool('lead-c')({ from_session: 'lead-a' })).toEqual({ from: 'lead-a', to: 'lead-c', taskIds: [open, active, blocked] })
    expect([open, active, blocked, done, cancelled, others].map(ownerOf)).toEqual(['lead-c', 'lead-c', 'lead-c', 'lead-a', 'lead-a', 'lead-b'])
    // Nothing left to take: an empty move, not a refusal.
    expect((await tool('lead-c')({ from_session: 'lead-a' })).taskIds).toEqual([])
  })

  test('T8: from_session naming a live owner is refused naming it', async () => {
    const id = await create()
    await refused(tool('lead-b')({ from_session: 'lead-a' }), 'Session lead-a owns this and is still live', [id])
  })

  // @covers: team-tasks › Agents transfer task ownership › Ownerless task
  test('T9: a human or Kawai task has no owner and never moves', async () => {
    const id = (await service.create({ kind: 'human', team }, { title: 'H', direction: 'go' })).id
    await refused(tool('lead-a')({ task_id: id, to_session: 'lead-b' }), 'has no owner', [id])
  })

  // @covers: team-tasks › Agents transfer task ownership › Neither or both selectors
  test('T10: both selectors or neither are refused', async () => {
    const id = await create()
    archive('lead-a')
    await refused(tool('lead-b')({ task_id: id, from_session: 'lead-a' }), 'Give exactly one of task_id', [id])
    await refused(tool('lead-b')({}), 'Give exactly one of task_id', [id])
  })

  test('T11: a takeover names only the caller', async () => {
    const id = await create()
    archive('lead-a')
    await refused(tool('lead-b')({ task_id: id, to_session: 'lead-c' }), 'A takeover moves tasks only to yourself', [id])
  })

  test('the tool binds the calling session and ignores a forged caller', async () => {
    const id = await create()
    await refused(taskHandlers(service, 'lead-b').task_transfer_owner({ task_id: id, to_session: 'lead-b', session_id: 'lead-a' }), 'still live', [id])
  })

  test('a move that finds the owner changed writes nothing', async () => {
    const id = await create()
    archive('lead-a')
    const original = service.store.setOwner.bind(service.store)
    // Another taker wins between the check and the write.
    service.store.setOwner = (taskId, from, to) => {
      db.prepare('UPDATE team_tasks SET owner_session = ? WHERE id = ?').run('lead-c', taskId)
      return original(taskId, from, to)
    }
    await expect(tool('lead-b')({ task_id: id })).rejects.toThrow("owner changed while this transfer ran")
    service.store.setOwner = original
    expect(moves(id)).toEqual([])
  })
})

/** A small seeded generator (mulberry32), so a failing case replays exactly. */
function rng(seed: number) {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

test('P4: after every step each agent task has one owner, journaled, and a refusal changes nothing (seed 2718, 300 cases)', async () => {
  const random = rng(2718)
  const leads = ['lead-a', 'lead-b', 'lead-c']
  const pick = <T>(items: readonly T[]) => items[Math.floor(random() * items.length)]!
  let moved = 0
  let refusals = 0
  for (let index = 0; index < 300; index++) {
    clearTeamCache()
    records = new Map(leads.map(id => [id, row(id, 'lead')]))
    records.set('dev', row('dev', 'devs'))
    db.close()
    db = schemaCopy()
    service = new TaskService(new TaskStore(db, new MailboxStore(db)), { getSession: id => records.get(id) })
    const ids: string[] = []
    for (let step = 0; step < 12; step++) {
      const roll = random()
      const caller = pick([...leads, 'dev'])
      const live = (id: string) => records.has(id) && !records.get(id)!.archivedAt && !records.get(id)!.contextExhausted
      if (roll < 0.2 && live(caller) && caller !== 'dev') {
        ids.push(await create(caller))
      } else if (roll < 0.3) {
        const id = pick(leads)
        if (random() < 0.5) records.get(id)!.archivedAt = 'now'
        else records.get(id)!.contextExhausted = { at: 'now', reason: 'blocking_limit' }
      } else if (ids.length > 0 && live(caller)) {
        const input = random() < 0.7
          ? { task_id: pick(ids), ...(random() < 0.5 ? { to_session: pick([...leads, 'dev']) } : {}) }
          : { from_session: pick(leads) }
        const before = ids.map(id => [ownerOf(id), moves(id).length])
        try {
          moved += (await tool(caller)(input)).taskIds.length
        } catch {
          refusals++
          expect(ids.map(id => [ownerOf(id), moves(id).length])).toEqual(before)
        }
      }
      for (const id of ids) {
        const task = service.store.get(id)!
        const last = moves(id).at(-1)
        const expected = last ? last.split(' -> ')[1]!.split(' by ')[0] : task.creator.sessionId
        expect(task.ownerSession).toBe(expected)
        expect(typeof task.ownerSession).toBe('string')
      }
    }
  }
  // The sequences exercise both outcomes, not only refusals.
  expect(moved).toBeGreaterThanOrEqual(50)
  expect(refusals).toBeGreaterThan(100)
}, 20_000)
