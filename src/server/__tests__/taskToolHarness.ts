// The two registered tool runtimes over one real team (bounded-task-reads
// H8): the Claude team MCP server's registered tools and the Codex
// dynamic-tool dispatch, both built from teamToolTable over real stores and
// services (TaskService, TaskResultService with its seal, AssignmentService,
// TeamMailbox). `useTaskToolHarness` registers the lifecycle hooks of the
// calling test file and returns its live state.
import { afterAll, afterEach, beforeAll, beforeEach } from 'bun:test'
import { spawnSync } from 'node:child_process'
import type { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import type { ChatSessionRecord } from '../db'
import { schemaCopy } from './schemaDb'
import { AssignmentService } from '../team/AssignmentService'
import { AssignmentStore } from '../team/assignmentStore'
import { MailboxStore } from '../team/mailboxStore'
import { createMailboxServer, teamToolTable, type MailboxServerServices } from '../team/mailboxTools'
import { TeamMailbox } from '../team/TeamMailbox'
import { TaskStore } from '../team/taskStore'
import { TaskService, type TaskCaller } from '../team/TaskService'
import { TaskResultService } from '../team/TaskResultService'
import { WorktreeStaffing } from '../team/staffing'
import { TeamCaps } from '../team/teamCaps'
import { TeamWorktrees } from '../team/worktreeRoots'
import { clearTeamCache, resolveTeam, type TeamIdentity } from '../team/teamIdentity'
import { CodexToolSessions } from './codexToolSession'

export type Outcome = { error: string; value: null } | { error: null; value: any }
type Registered = Record<string, { handler: (args: unknown, extra: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> }>
export type ToolCall = (sessionId: string, name: string, args: unknown) => Promise<Outcome>

export interface TaskToolHarness {
  root: string
  repo: string
  team: TeamIdentity
  db: Database
  mail: MailboxStore
  assignmentStore: AssignmentStore
  tasks: TaskService
  results: TaskResultService
  assignments: AssignmentService
  mailbox: TeamMailbox
  records: Map<string, ChatSessionRecord>
  /** Both runtimes, Claude first. */
  runtimes: ReadonlyArray<{ runtime: 'Claude' | 'Codex'; call: ToolCall }>
}

export const agent = (sessionId: string): TaskCaller => ({ kind: 'agent', sessionId })

/** Sessions lead (leads), dev (devs), reviewer (reviewers), and stranger (another team). */
export function useTaskToolHarness(prefix: string): TaskToolHarness {
  const state = {} as TaskToolHarness
  const servers: Array<{ instance: { close: () => Promise<void> } }> = []
  const row = (sessionId: string, groupId: string, projectPath = state.repo): ChatSessionRecord => ({
    sessionId, groupId, projectPath, name: sessionId, sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '',
  })
  const git = (args: string[], cwd: string) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  }
  const services = (): MailboxServerServices => ({ tasks: state.tasks, results: state.results })
  const viaClaude: ToolCall = async (sessionId, name, args) => {
    const server = await createMailboxServer(state.mailbox, sessionId, services())
    servers.push(server as unknown as { instance: { close: () => Promise<void> } })
    const tool = (server.instance as unknown as { _registeredTools: Registered })._registeredTools[name]!
    const result = await tool.handler(args, {})
    const text = result.content[0]!.text
    return result.isError ? { error: text, value: null } : { error: null, value: JSON.parse(text) }
  }
  const codex = new CodexToolSessions(sessionId => teamToolTable(state.mailbox, sessionId, services()))
  const viaCodex: ToolCall = async (sessionId, name, args) => {
    const answer = await codex.call(sessionId, name, args)
    const item = answer.contentItems[0]!
    const text = item.type === 'inputText' ? item.text ?? '' : ''
    return answer.success ? { error: null, value: JSON.parse(text) } : { error: text, value: null }
  }
  state.runtimes = [{ runtime: 'Claude', call: viaClaude }, { runtime: 'Codex', call: viaCodex }]

  beforeAll(async () => {
    state.root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
    state.repo = path.join(state.root, 'repo')
    for (const dir of [state.repo, path.join(state.root, 'other')]) {
      git(['init', '-q', dir], state.root)
      git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], dir)
    }
    fs.mkdirSync(path.join(state.repo, '.kawai', 'groups'), { recursive: true })
    fs.writeFileSync(path.join(state.repo, '.kawai', 'groups', 'leads.md'), '---\ncanCreateTasks: true\n---\nLead.')
    fs.writeFileSync(path.join(state.repo, '.kawai', 'groups', 'devs.md'), 'Build.')
    fs.writeFileSync(path.join(state.repo, '.kawai', 'groups', 'reviewers.md'), 'Review.')
    clearTeamCache()
    state.team = await resolveTeam(state.repo)
  })
  afterAll(() => fs.rmSync(state.root, { recursive: true, force: true }))
  beforeEach(() => {
    state.records = new Map([['lead', row('lead', 'leads')], ['dev', row('dev', 'devs')], ['reviewer', row('reviewer', 'reviewers')],
      ['stranger', row('stranger', 'leads', path.join(state.root, 'other'))]])
    state.db?.close()
    state.db = schemaCopy()
    state.mail = new MailboxStore(state.db)
    state.assignmentStore = new AssignmentStore(state.db, state.mail)
    state.tasks = new TaskService(new TaskStore(state.db, state.mail, state.assignmentStore), { getSession: id => state.records.get(id) })
    const staffing = new WorktreeStaffing(state.db, state.mail, {
      records: () => state.records.values(), teamOf: () => undefined, caps: new TeamCaps({}), worktrees: new TeamWorktrees(),
      spawn: () => Promise.resolve({ ok: false, error: 'no spawn in tests' }),
    })
    state.assignments = new AssignmentService(state.db, state.assignmentStore, state.tasks.store, state.mail, {
      getSession: id => state.records.get(id), records: () => state.records.values(), teamOf: () => undefined, staffing, caps: new TeamCaps({}),
      worktrees: new TeamWorktrees(),
    })
    state.results = new TaskResultService(state.tasks, { getSession: id => state.records.get(id), assignments: state.assignments })
    state.mailbox = new TeamMailbox(state.mail, { getSession: id => state.records.get(id), homeDir: state.root })
  })
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(server => server.instance.close()))
    await codex.closeAll()
  })
  return state
}
