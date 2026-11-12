// Owner rights (group-mail-task-affinity D7, task 2.2): rows O1–O4 of
// design.md's "Rights after a move" table, through the production
// `TaskService`. The move itself is `task_transfer_owner` (task 2.3); here
// the owner column is written directly, so the rows test the rights alone.
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
import { statusRefusal, taskOwner } from '../team/taskStatusRights'
import { clearTeamCache, resolveTeam, type TeamIdentity } from '../team/teamIdentity'
import { SYSTEM_ACTOR } from '../../shared/team'
import type { TeamTask } from '../../shared/teamTasks'
import { schemaCopy } from './schemaDb'

let root: string
let repo: string
let team: TeamIdentity
let db: Database
let service: TaskService
let records: Map<string, ChatSessionRecord>
const human = (): TaskCaller => ({ kind: 'human', team })
const agent = (sessionId: string): TaskCaller => ({ kind: 'agent', sessionId })

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-owner-rights-')))
  repo = path.join(root, 'repo')
  const git = (args: string[]) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: cleanGitEnv() })
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  }
  fs.mkdirSync(repo)
  git(['init', '-q'])
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'])
  fs.mkdirSync(path.join(repo, '.kawai', 'groups'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'lead.md'), '---\ncanCreateTasks: true\n---\nLead.')
  team = await resolveTeam(repo)
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  clearTeamCache()
  const row = (sessionId: string): ChatSessionRecord => ({
    sessionId, groupId: 'lead', projectPath: repo, name: sessionId, sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '',
  })
  records = new Map([['lead-a', row('lead-a')], ['lead-b', row('lead-b')]])
  db?.close()
  db = schemaCopy()
  service = new TaskService(new TaskStore(db, new MailboxStore(db)), { getSession: id => records.get(id) })
})

/** A task lead-a created, moved to lead-b. */
async function moved(): Promise<string> {
  const task = await service.create(agent('lead-a'), { title: 'T', direction: 'v1' })
  db.prepare('UPDATE team_tasks SET owner_session = ? WHERE id = ?').run('lead-b', task.id)
  return task.id
}

describe('rights after a move (O1–O4)', () => {
  // @covers: team-tasks › Only the creator or the human amends direction › New owner amends, former owner cannot
  test('O1, O2: the new owner amends; the former owner, still the creator, is refused naming the owner', async () => {
    const id = await moved()
    const amended = await service.amend(agent('lead-b'), id, { direction: 'v2' })
    expect(amended).toMatchObject({ revision: 2, creator: { kind: 'agent', sessionId: 'lead-a' }, ownerSession: 'lead-b' })
    await expect(service.amend(agent('lead-a'), id, { direction: 'v3' })).rejects.toThrow('message the owner (lead-b)')
    expect(service.store.get(id)!.revision).toBe(2)
  })

  test('O1, O2: revision notices follow the owner', async () => {
    const id = await moved()
    await expect(service.notify(agent('lead-a'), id, 1, 'k')).rejects.toThrow("Only the task's owner or the human can send revision notices; the owner is the owner (lead-b).")
    // The new owner passes the rights check; this service has no notices store.
    await expect(service.notify(agent('lead-b'), id, 1, 'k')).rejects.toThrow('Revision notices are not available')
  })

  // @covers: team-tasks › Task status and closing › New owner closes
  test('O1: the new owner closes the task', async () => {
    const id = await moved()
    expect((await service.setStatus(agent('lead-b'), id, 'done')).status).toBe('done')
  })

  test('O2: the former owner cannot close or cancel it', async () => {
    const id = await moved()
    for (const status of ['done', 'cancelled'] as const) {
      await expect(service.setStatus(agent('lead-a'), id, status)).rejects.toThrow("Only the task's owner can set it to")
    }
    expect(service.store.get(id)!.status).toBe('open')
  })

  test('O3: the human amends and closes a moved task', async () => {
    const id = await moved()
    expect((await service.amend(human(), id, { direction: 'v2' })).revision).toBe(2)
    expect((await service.setStatus(human(), id, 'cancelled')).status).toBe('cancelled')
  })

  test('O4: Kawai closes exactly the tasks it created, as before', () => {
    const base = { id: 't', teamId: team.teamId, title: 'T', status: 'open', parentId: null, worktree: null, openspecChange: null,
      revision: 1, direction: 'go', acceptance: null, createdAt: '', updatedAt: '' } as const
    const kawai: TeamTask = { ...base, creator: SYSTEM_ACTOR, ownerSession: null }
    const agents: TeamTask = { ...base, creator: { kind: 'agent', sessionId: 'lead-a' }, ownerSession: 'lead-b' }
    expect(statusRefusal(SYSTEM_ACTOR, kawai, 'done')).toBeNull()
    expect(statusRefusal(SYSTEM_ACTOR, agents, 'done')).toBe('Kawai sets done only on the tasks it created.')
  })
})

test('a record without the owner field reads its creating agent as owner', () => {
  const base = { id: 't', teamId: 'team', title: 'T', status: 'open', parentId: null, worktree: null, openspecChange: null,
    revision: 1, direction: 'go', acceptance: null, createdAt: '', updatedAt: '' } as const
  expect(taskOwner({ ...base, creator: { kind: 'agent', sessionId: 'lead-a' } })).toBe('lead-a')
  expect(taskOwner({ ...base, creator: { kind: 'human', sessionId: null } })).toBeNull()
  expect(taskOwner({ ...base, creator: { kind: 'agent', sessionId: 'lead-a' }, ownerSession: null })).toBeNull()
})
