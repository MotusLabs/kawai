// H-DRAFT publish's submitted base (owner-publication-handoff design
// "H-DRAFT", the submitted-base axis): the command's base and the stored
// linked draft's base are independent observations. Paired witnesses from one
// lawful snapshot — H loaded into the draft at r1, then an explicit ordinary
// r2 leaves H stale and the r1 draft in place — through the real
// `team-task-publish` WS command over a real TaskService and store, holding
// the payload, the stored draft and the intent fixed: ordinary at r1 is
// T-stale and ordinary at r2 is H44 (r3, the draft and H unchanged); linked
// at r1 is H38s and linked at r2 is H38m, the stored-base refusal. Each
// command is classified from the snapshot first (`observeDraftPublish`), the
// classification equals the observed outcome, and the old conflation —
// reading the stored draft's base as the command's — disagrees on H44 and H38m.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import type { ChatSessionRecord } from '../db'
import type { ChatConnection } from '../chat/ChatConnections'
import { schemaCopy } from './schemaDb'
import { MailboxStore } from '../team/mailboxStore'
import { TaskStore } from '../team/taskStore'
import { TaskService } from '../team/TaskService'
import { TaskConnections } from '../team/taskConnections'
import { clearTeamCache, resolveTeam, type TeamIdentity } from '../team/teamIdentity'
import { H_DRAFT_PUBLISH, classify, observeDraftPublish, submittedOf, type Tuple } from './helpers/handoffClassifier'
import { SYSTEM_ACTOR } from '../../shared/team'

function git(args: string[], cwd?: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
}

let root: string
let repo: string
let db: Database
let service: TaskService
let team: TeamIdentity
let ws: TaskConnections
const sent: Array<Record<string, unknown>> = []
const connection = { send: (message: Record<string, unknown>) => sent.push(message) } as unknown as ChatConnection
let serial = 0
const lead = (): ChatSessionRecord => ({ sessionId: 'lead', groupId: 'leads', projectPath: repo, name: 'lead', sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '' })

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-handoff-draft-base-')))
  repo = path.join(root, 'repo')
  git(['init', '-q', repo])
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], repo)
  fs.mkdirSync(path.join(repo, '.kawai', 'groups'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'leads.md'), '---\ncanCreateTasks: true\n---\nLead.')
  clearTeamCache()
  team = await resolveTeam(repo)
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))
beforeEach(() => {
  db?.close()
  db = schemaCopy()
  service = new TaskService(new TaskStore(db, new MailboxStore(db)), { getSession: id => (id === 'lead' ? lead() : undefined), homeDir: path.join(root, 'home') })
  const manager = { teamScopes: { resolve: async (p: string) => (p === repo ? team : null) }, tasks: service, directory: { list: () => [] } }
  ws = new TaskConnections(manager as never)
  sent.length = 0
})

/** One human WS command; its `team-task-result` error, or null. */
async function command(message: Record<string, unknown>): Promise<string | null> {
  await ws.handle(connection, { ...message, teamPath: repo, requestId: `r${++serial}` } as never)
  const reply = sent.at(-1) as { type: string; error?: string }
  expect(reply.type).toBe('team-task-result')
  return reply.error ?? null
}
const snapshot = () => Object.fromEntries(['team_tasks', 'team_task_drafts', 'team_task_handoffs', 'team_task_handoff_events', 'team_task_handoff_wakeups', 'team_task_revisions', 'team_messages']
  .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))

/** The paired snapshot: H loaded into the draft at r1, then an explicit ordinary r2 (H stale, the r1 draft kept). */
async function pairedSnapshot() {
  const task = service.store.create({ teamId: team.teamId, title: 'Export', direction: 'CSV', creator: SYSTEM_ACTOR })
  const { handoff } = await service.handoffs.request({ kind: 'agent', sessionId: 'lead' }, task.id, { baseRevision: 1, direction: 'CSV with headers', rationale: 'Headers were missing', notify: false, requestKey: 'k1' })
  expect(await command({ type: 'team-task-handoff-load-draft', taskId: task.id, handoffId: handoff.id, replace: false })).toBeNull()
  const lineage = service.store.drafts.get(task.id)!.lineageId!
  expect(await command({ type: 'team-task-publish', taskId: task.id, baseRevision: 1, direction: 'Other', rationale: 'meanwhile', requestKey: 'o1', notify: false, fromDraft: false })).toBeNull()
  expect([service.store.get(task.id)!.revision, service.handoffs.store.get(handoff.id)!.state, service.store.drafts.get(task.id)!.baseRevision]).toEqual([2, 'stale', 1])
  return { taskId: task.id, handoffId: handoff.id, lineage }
}

/** The caller axes every witness shares: an ordinary fresh key, a rationale, the human's right, the observed identity. */
const CALLER = { key: 'ordinary', raw: 'bare', rationale: 'given', right: 'ok', replay: 'new', observed: 'stored' }
/** The old conflation: the stored draft's base read as the command's. */
const conflated = (tuple: Tuple) => classify(H_DRAFT_PUBLISH, { ...tuple, submitted: tuple.draftRevision === 'current' ? 'r2' : 'r1' })
/** The row a command's observed outcome is. */
function outcomeRow(intent: string, error: string | null): string {
  if (error === null) return intent === 'ordinary' ? 'H44' : 'published'
  if (error.startsWith('Stale: revision 2 was published since revision 1')) return intent === 'ordinary' ? 'T-stale' : 'H38s'
  if (error.startsWith('The stored draft is based on revision 1, not 2; nothing was published. Refresh')) return 'H38m'
  return error
}

describe('H-DRAFT publish: the submitted base apart from the stored draft', () => {
  // @covers: task-publication-handoffs › A loaded draft stays linked only as the draft that was loaded › An explicit ordinary publication passes a loaded draft
  test('paired witnesses on one snapshot: ordinary r1 T-stale, linked r1 H38s, linked r2 H38m write nothing; ordinary r2 is H44 with r3, the r1 draft and stale H kept; the conflation misreads H44 and H38m', async () => {
    const { taskId, handoffId, lineage } = await pairedSnapshot()
    const draft = service.store.drafts.get(taskId)
    const stale = service.handoffs.store.get(handoffId)
    const witnesses: Array<{ intent: 'ordinary' | 'draft'; base: number; row: string; conflated: string }> = [
      { intent: 'ordinary', base: 1, row: 'T-stale', conflated: 'T-stale' },
      { intent: 'draft', base: 1, row: 'H38s', conflated: 'H38s' },
      { intent: 'draft', base: 2, row: 'H38m', conflated: 'H38s' },
      { intent: 'ordinary', base: 2, row: 'H44', conflated: 'T-stale' },
    ]
    for (const [at, witness] of witnesses.entries()) {
      const tuple = { ...CALLER, intent: witness.intent, ...observeDraftPublish(db, taskId, witness.base)! }
      const before = snapshot()
      const error = await command({
        type: 'team-task-publish', taskId, baseRevision: witness.base, direction: 'CSV with headers and a BOM', rationale: 'edited', requestKey: `w${at}`,
        notify: false, fromDraft: witness.intent === 'draft', ...(witness.intent === 'draft' ? { observedDraft: lineage } : {}),
      })
      const label = [witness.intent, witness.base]
      expect([label, classify(H_DRAFT_PUBLISH, tuple), outcomeRow(witness.intent, error)]).toEqual([label, { kind: 'healthy', row: witness.row }, witness.row])
      expect([label, conflated(tuple)]).toEqual([label, { kind: 'healthy', row: witness.conflated }])
      if (witness.row !== 'H44') expect([label, snapshot()]).toEqual([label, before])
    }
    // H44: ordinary r3 with no association; the exact r1 draft and its link, and the stale H, are unchanged.
    expect(db.prepare('SELECT revision, direction, request_key, handoff_id FROM team_task_revisions WHERE task_id = ? ORDER BY revision DESC LIMIT 1').get(taskId))
      .toEqual({ revision: 3, direction: 'CSV with headers and a BOM', request_key: 'w3', handoff_id: null })
    expect(service.store.drafts.get(taskId)).toEqual(draft)
    expect(service.handoffs.store.get(handoffId)).toEqual(stale)
  })

  test('the representative keeps both relations: equal to the task revision, and equal to the stored draft base', () => {
    for (let task = 1; task <= 4; task++) {
      for (let stored = 1; stored <= task; stored++) {
        for (let submitted = 0; submitted <= task + 2; submitted++) {
          const t = { submitted: submittedOf(submitted, task, stored), draftRevision: stored === task ? 'current' : 'behind' }
          const isStored = t.submitted === (t.draftRevision === 'current' ? 'r2' : 'r1')
          expect([task, stored, submitted, t.submitted === 'r2', isStored]).toEqual([task, stored, submitted, submitted === task, submitted === stored])
        }
      }
    }
  })
})
