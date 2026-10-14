// Task service and tools (team-tasks D2): creation rights read from the
// caller's current group file, same-team references, worktree and OpenSpec
// validation, the amend/status permission matrix, and identity binding.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import { initDatabase, type ChatSessionRecord, type SessionDatabase } from '../db'
import { MailboxStore } from '../team/mailboxStore'
import { TaskStore } from '../team/taskStore'
import { TaskService, type TaskCaller } from '../team/TaskService'
import { taskHandlers } from '../team/taskTools'
import { clearTeamCache, resolveTeam, type TeamIdentity } from '../team/teamIdentity'

function git(args: string[], cwd?: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
}

let root: string
let repo: string
let feature: string
let other: string
let home: string
let db: SessionDatabase
let records: Map<string, ChatSessionRecord>
let service: TaskService
let team: TeamIdentity
const human = (): TaskCaller => ({ kind: 'human', team })
const agent = (sessionId: string): TaskCaller => ({ kind: 'agent', sessionId })

const writeGroup = (id: string, content: string) => {
  fs.mkdirSync(path.join(repo, '.kawai', 'groups'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', `${id}.md`), content)
}
const row = (sessionId: string, groupId: string | null, projectPath = repo): ChatSessionRecord => ({
  sessionId, groupId, projectPath, name: sessionId, sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '',
})

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-task-service-')))
  repo = path.join(root, 'repo')
  feature = path.join(root, 'repo-feature')
  other = path.join(root, 'other')
  home = path.join(root, 'home')
  for (const dir of [repo, other]) {
    git(['init', '-q', dir])
    git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], dir)
  }
  git(['worktree', 'add', '-q', '-b', 'feature', feature], repo)
  fs.mkdirSync(path.join(repo, 'openspec', 'changes', 'add-export'), { recursive: true })
  fs.mkdirSync(path.join(feature, 'openspec', 'changes', 'branch-only'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'openspec', 'changes', 'archive'), { recursive: true })
  team = await resolveTeam(repo)
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  clearTeamCache()
  fs.rmSync(path.join(repo, '.kawai'), { recursive: true, force: true })
  writeGroup('leads', '---\ncanCreateTasks: true\n---\nLead.')
  writeGroup('devs', 'Build.')
  records = new Map([
    ['lead', row('lead', 'leads')],
    ['lead2', row('lead2', 'leads')],
    ['dev', row('dev', 'devs', path.join(feature))],
    ['solo', row('solo', null)],
    ['stranger', row('stranger', 'leads', other)],
  ])
  db?.close()
  db = initDatabase({ path: path.join(fs.mkdtempSync(path.join(root, 'db-')), 'tasks.db') })
  service = new TaskService(new TaskStore(db.db, new MailboxStore(db.db)), { getSession: id => records.get(id), homeDir: home })
})

describe('creation rights', () => {
  test('a permitted group member creates a task and becomes its creator', async () => {
    const task = await service.create(agent('lead'), { title: 'Export', direction: 'CSV' })
    expect(task).toMatchObject({ teamId: team.teamId, status: 'open', revision: 1, creator: { kind: 'agent', sessionId: 'lead' } })
  })

  test('the default (no canCreateTasks) and group-less sessions are refused; nothing is written', async () => {
    await expect(service.create(agent('dev'), { title: 'x', direction: 'y' })).rejects.toThrow('cannot create tasks')
    await expect(service.create(agent('solo'), { title: 'x', direction: 'y' })).rejects.toThrow('cannot create tasks')
    expect(await service.list(human())).toEqual([])
  })

  test('the setting is read fresh from the group file on every call', async () => {
    writeGroup('devs', '---\ncanCreateTasks: true\n---\nBuild.')
    expect((await service.create(agent('dev'), { title: 'x', direction: 'y' })).creator).toEqual({ kind: 'agent', sessionId: 'dev' })
    writeGroup('leads', 'Lead.')
    await expect(service.create(agent('lead'), { title: 'x', direction: 'y' })).rejects.toThrow('cannot create tasks')
  })

  test('the human always creates; an unknown caller session is refused', async () => {
    expect((await service.create(human(), { title: 'x', direction: 'y' })).creator).toEqual({ kind: 'human', sessionId: null })
    await expect(service.create(agent('ghost'), { title: 'x', direction: 'y' })).rejects.toThrow('Unknown calling session')
  })

  test('blank title or direction is refused', async () => {
    await expect(service.create(human(), { title: ' ', direction: 'y' })).rejects.toThrow('title')
    await expect(service.create(human(), { title: 'x', direction: '' })).rejects.toThrow('direction')
  })
})

describe('references', () => {
  test('parent of the same team; another team’s parent or task is not found', async () => {
    const parent = await service.create(human(), { title: 'parent', direction: 'p' })
    const child = await service.create(agent('lead'), { title: 'child', direction: 'c', parent_id: parent.id })
    expect(child.parentId).toBe(parent.id)
    const foreign = await service.create({ kind: 'human', team: await resolveTeam(other) }, { title: 'foreign', direction: 'f' })
    await expect(service.create(agent('lead'), { title: 'x', direction: 'y', parent_id: foreign.id })).rejects.toThrow('Parent task not found')
    await expect(service.get(agent('lead'), foreign.id)).rejects.toThrow('not found in this team')
    await expect(service.note(agent('dev'), foreign.id, 'hi')).rejects.toThrow('not found in this team')
    expect((await service.list(agent('lead'))).map(task => task.title)).toEqual(['parent', 'child'])
  })

  test('worktree targets normalize to their root; other paths are refused by name', async () => {
    const task = await service.create(human(), { title: 'x', direction: 'y', worktree: `${feature}/` })
    expect(task.worktree).toBe(feature)
    const sub = path.join(repo, 'src')
    fs.mkdirSync(sub, { recursive: true })
    await expect(service.create(human(), { title: 'x', direction: 'y', worktree: sub })).rejects.toThrow(sub)
    await expect(service.create(human(), { title: 'x', direction: 'y', worktree: other })).rejects.toThrow(other)
  })

  test('linked OpenSpec changes must exist in the main checkout or the task worktree', async () => {
    expect((await service.create(human(), { title: 'x', direction: 'y', openspec_change: 'add-export' })).openspecChange).toBe('add-export')
    expect((await service.create(human(), { title: 'x', direction: 'y', worktree: feature, openspec_change: 'branch-only' })).openspecChange).toBe('branch-only')
    for (const name of ['branch-only', 'missing', 'archive', '../escape']) {
      await expect(service.create(human(), { title: 'x', direction: 'y', openspec_change: name })).rejects.toThrow('OpenSpec change not found')
    }
  })
})

describe('permission matrix', () => {
  test('amend: creator and human only; contributors are pointed to a note or message', async () => {
    const task = await service.create(agent('lead'), { title: 'x', direction: 'v1' })
    await expect(service.amend(agent('dev'), task.id, { direction: 'hijack' })).rejects.toThrow(/task_note.*message the creator \(lead\)/)
    await expect(service.amend(agent('lead2'), task.id, { direction: 'hijack' })).rejects.toThrow('creator')
    expect((await service.amend(agent('lead'), task.id, { direction: 'v2' })).revision).toBe(2)
    expect((await service.amend(human(), task.id, { acceptance: 'ships' })).revision).toBe(3)
    expect((await service.get(human(), task.id)).revisions.map(revision => revision.direction)).toEqual(['v1', 'v2', 'v2'])
    await expect(service.amend(agent('lead'), task.id, {})).rejects.toThrow('Nothing to amend')
  })

  test('a human-created task can be amended by no agent', async () => {
    const task = await service.create(human(), { title: 'x', direction: 'v1' })
    await expect(service.amend(agent('lead'), task.id, { direction: 'v2' })).rejects.toThrow('message the creator (the human)')
  })

  test('notes and active/blocked are open to every member; done/cancelled to the creator', async () => {
    const task = await service.create(agent('lead'), { title: 'x', direction: 'y' })
    expect((await service.note(agent('dev'), task.id, 'Picked option B')).author).toEqual({ kind: 'agent', sessionId: 'dev' })
    expect((await service.setStatus(agent('dev'), task.id, 'active')).status).toBe('active')
    expect((await service.setStatus(agent('dev'), task.id, 'blocked', 'waiting on API')).status).toBe('blocked')
    await expect(service.setStatus(agent('dev'), task.id, 'done')).rejects.toThrow('Only the task\'s creator')
    await expect(service.setStatus(agent('dev'), task.id, 'cancelled')).rejects.toThrow('Only the task\'s creator')
    await expect(service.setStatus(agent('lead'), task.id, 'open')).rejects.toThrow('Only the human can reopen')
    expect((await service.get(human(), task.id)).task.status).toBe('blocked')
    expect((await service.setStatus(agent('lead'), task.id, 'done')).status).toBe('done')
    expect((await service.get(human(), task.id)).journal.map(entry => entry.text)).toEqual(['Picked option B', 'waiting on API'])
  })

  test('the human reopens, closes, and amends a task whose creator was killed', async () => {
    const task = await service.create(agent('lead'), { title: 'x', direction: 'y' })
    await service.setStatus(agent('lead'), task.id, 'done')
    records.delete('lead')
    expect((await service.setStatus(human(), task.id, 'open')).status).toBe('open')
    expect((await service.amend(human(), task.id, { direction: 'new plan' })).direction).toBe('new plan')
    expect((await service.setStatus(human(), task.id, 'cancelled')).status).toBe('cancelled')
    expect((await service.note(human(), task.id, 'closing')).author).toEqual({ kind: 'human', sessionId: null })
    await expect(service.note(agent('lead'), task.id, 'ghost')).rejects.toThrow('Unknown calling session')
  })
})

describe('task tools', () => {
  test('each tool binds the calling session and ignores forged identity fields', async () => {
    const lead = taskHandlers(service, 'lead')
    const dev = taskHandlers(service, 'dev')
    const task = await lead.task_create({ title: 'Export', direction: 'CSV', creator: 'dev', team_id: '/elsewhere', worktree: feature })
    expect(task).toMatchObject({ creator: { kind: 'agent', sessionId: 'lead' }, teamId: team.teamId, worktree: feature })
    await expect(dev.task_create({ title: 'x', direction: 'y' })).rejects.toThrow('cannot create tasks')
    await dev.task_note({ task_id: task.id, text: 'started', author: 'lead' })
    await dev.task_update_status({ task_id: task.id, status: 'active' })
    await expect(dev.task_amend({ task_id: task.id, direction: 'mine', session_id: 'lead' })).rejects.toThrow('creator')
    await lead.task_amend({ task_id: task.id, acceptance: 'A file downloads' })
    const full = await dev.task_get({ task_id: task.id })
    expect(full.task).toMatchObject({ status: 'active', revision: 2, acceptance: 'A file downloads' })
    expect(full.journal).toMatchObject([{ text: 'started', author: { kind: 'agent', sessionId: 'dev' } }])
    expect(new Set(full.task.participants)).toEqual(new Set(['lead', 'dev']))
    expect((await dev.task_list({})).map(row => row.id)).toEqual([task.id])
    expect(await dev.task_list({ status: 'done' })).toEqual([])
    await expect(dev.task_update_status({ task_id: task.id, status: 'finished' })).rejects.toThrow()
  })
})

describe('spawn-time registration', () => {
  test('the team MCP server carries mailbox and task tools, all allowed without cards', async () => {
    const { createMailboxServer, TEAM_ALLOWED_TOOLS } = await import('../team/mailboxTools')
    const { TeamMailbox } = await import('../team/TeamMailbox')
    const mailbox = new TeamMailbox(new MailboxStore(db.db), { getSession: id => records.get(id), homeDir: home })
    const { MailboxManagement } = await import('../team/mailboxManagement')
    const management = new MailboxManagement(mailbox.store, { getSession: id => records.get(id), tasks: service, homeDir: home })
    const server = await createMailboxServer(mailbox, 'lead', service, undefined, management)
    const registered = Object.keys((server.instance as unknown as { _registeredTools: Record<string, unknown> })._registeredTools)
    const expected = ['send_message', 'reply', 'schedule_message', 'list_groups', 'list_mailbox', 'cancel_message', 'discard_message', 'task_create', 'task_get', 'task_note', 'task_update_status', 'task_amend', 'task_list']
    expect(registered.sort()).toEqual([...expected].sort())
    // Product strategy (product-strategy 3.2) rides the same allowed list —
    // read/propose only, no approve/publish/withdraw tool anywhere.
    expect(TEAM_ALLOWED_TOOLS).toEqual([...expected, 'strategy_list', 'strategy_get', 'strategy_save_draft', 'strategy_submit_for_review']
      .map(name => `mcp__kawai-team__${name}`))
    await server.instance.close()
  })
})
