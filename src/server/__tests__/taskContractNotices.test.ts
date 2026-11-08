// Contract revisions notify like any other (implementation-contract D3,
// task-revision-publication): the human's contract-only publication and the
// creating lead's `task_amend` replacing the contract each publish one new
// revision carrying the new contract identity, and the claimed developer
// receives one notice whose delivered header names that identity.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import { initDatabase, type ChatSessionRecord, type SessionDatabase } from '../db'
import { AssignmentStore } from '../team/assignmentStore'
import { MailboxStore } from '../team/mailboxStore'
import { TaskStore } from '../team/taskStore'
import { TaskService } from '../team/TaskService'
import { taskHandlers } from '../team/taskTools'
import { contractHash } from '../team/contractHash'
import { buildTaskContext, formatTaskHeader } from '../team/taskContext'
import { clearTeamCache, resolveTeam, type TeamIdentity } from '../team/teamIdentity'
import { parseContract } from '../../shared/implementationContract'
import type { TeamTask } from '../../shared/teamTasks'

const contractText = (excluded: string[]) => ['## Implementation contract', '### Acceptance', '- A1: Lists tasks', '### Invariants',
  '### Scope', '- `src/server/team/**`', '### Verification', '- V1: check passes', '### Excluded',
  ...excluded.map((text, index) => `- X${index + 1}: ${text}`)].join('\n')
const A = contractText(['The client'])
const B = contractText(['The client', 'The CLI'])
const identityOf = (revision: number, text: string) => `r${revision}#${contractHash(parseContract(text).contract!).slice(0, 12)}`

let root: string
let repo: string
let team: TeamIdentity
let session: SessionDatabase
let mail: MailboxStore
let assignments: AssignmentStore
let service: TaskService
const records = new Map<string, ChatSessionRecord>()
const human = () => ({ kind: 'human' as const, team })

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-contract-notices-')))
  repo = path.join(root, 'repo')
  for (const args of [['init', '-q', repo], ['-C', repo, '-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init']]) {
    const result = spawnSync('git', args, { encoding: 'utf8', env: cleanGitEnv() })
    if (result.status !== 0) throw new Error(result.stderr)
  }
  fs.mkdirSync(path.join(repo, '.kawai', 'groups'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'leads.md'), '---\ncanCreateTasks: true\n---\nLead.')
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'devs.md'), 'Devs.')
  for (const [id, groupId] of [['lead', 'leads'], ['dev', 'devs']] as const) {
    records.set(id, { sessionId: id, groupId, projectPath: repo, name: id, sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '' })
  }
  clearTeamCache()
  team = await resolveTeam(repo)
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  session = initDatabase({ path: path.join(fs.mkdtempSync(path.join(root, 'db-')), 'tasks.db') })
  mail = new MailboxStore(session.db)
  assignments = new AssignmentStore(session.db, mail)
  service = new TaskService(new TaskStore(session.db, mail, assignments), { getSession: id => records.get(id), homeDir: path.join(root, 'home') })
})
afterEach(() => { assignments.close(); session.close() })

/** The developer claims the task's instruction, so it holds the assignment a notice goes to. */
function claimedByDev(task: TeamTask) {
  const { assignment } = assignments.insert({ teamId: team.teamId, taskId: task.id, requestKey: 'assign-1', targetKind: 'session',
    targetId: 'dev', role: 'devs', instruction: 'Build it', creator: { kind: 'human', sessionId: null } })
  const instruction = mail.enqueue({ teamId: team.teamId, toKind: 'session', toId: 'dev', fromSession: null, fromGroup: null,
    originPath: repo, body: 'Build it', taskId: task.id })
  assignments.setMessage(assignment.id, instruction.id)
  mail.claim(instruction.id, 'dev')
}
const notices = (taskId: string) => mail.forTask(taskId).filter(message => message.tags.includes('task-revision'))
/** The notice as delivered: the task header at delivery above the notice body. */
const deliveredHeader = (taskId: string) => formatTaskHeader(buildTaskContext(service.store, taskId)!)

// @covers: task-revision-publication › Publication records one immutable revision per intent › Contract-only revision notifies
test('the human publishing and notifying a contract-only draft publishes revision 2 with the new identity, and the developer gets one notice naming it', async () => {
  const task = await service.create(human(), { title: 'Export', direction: 'v1', contract: A })
  claimedByDev(task)
  await service.saveDraft(human(), task.id, { direction: 'v1', rationale: 'Exclude the CLI', contract: B })
  await service.publish(human(), task.id, { direction: 'v1', rationale: 'Exclude the CLI', baseRevision: 1, requestKey: 'k1', fromDraft: true, contract: B, notify: true })
  const latest = service.store.revisions(task.id).at(-1)!
  expect(latest).toMatchObject({ revision: 2, direction: 'v1', identity: identityOf(2, B) })
  expect(notices(task.id)).toMatchObject([{ toId: 'dev', revisionNotice: { revision: 2 } }])
  expect(deliveredHeader(task.id)).toContain(`Implementation contract ${identityOf(2, B)}`)
})

// @covers: task-revision-publication › Agent creators publish without drafts › Lead replaces the contract
test('the creating lead\'s task_amend adding X2 with notify publishes that contract, and the one notice names its identity', async () => {
  const lead = taskHandlers(service, 'lead')
  const task = await lead.task_create({ title: 'Export', direction: 'v1', contract: A }) as TeamTask
  claimedByDev(task)
  const published = await lead.task_amend({ task_id: task.id, contract: B, rationale: 'Exclude the CLI', notify: true }) as TeamTask
  expect(published.revision).toBe(2)
  expect(service.store.revisions(task.id).at(-1)!.contract!.excluded.map(clause => clause.id)).toEqual(['X1', 'X2'])
  expect(notices(task.id)).toMatchObject([{ toId: 'dev', fromSession: 'lead', revisionNotice: { revision: 2 } }])
  expect(deliveredHeader(task.id)).toContain(`Implementation contract ${identityOf(2, B)}`)
})
