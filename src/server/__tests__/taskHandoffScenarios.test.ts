// Scenario witnesses of task-publication-handoffs and team-workspace that no
// table row states alone (owner-publication-handoff D2–D8): a request leaves
// the human's draft alone; two simultaneous prepared publishes write one
// revision, one published event, one wakeup and one message, and both return
// that revision; the requester re-prepares a stale handoff; a refused
// reserved-key publication followed by the restart sweep leaves the handoff
// open and sends nothing; answering a decision card about the correction
// clears the card's item while the handoff's item stays.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import type { ChatSessionRecord } from '../db'
import { schemaCopy } from './schemaDb'
import { MailboxStore } from '../team/mailboxStore'
import { TaskStore } from '../team/taskStore'
import { TaskService, type TaskCaller } from '../team/TaskService'
import { RESERVED_KEY_REFUSAL, type HandoffRequestInput } from '../team/taskHandoffService'
import { attentionItems, type AttentionInput } from '../team/workspaceRead'
import type { PlanAttentionFact } from '../team/planAttention'
import { clearTeamCache, resolveTeam, type TeamIdentity } from '../team/teamIdentity'
import { SYSTEM_ACTOR } from '../../shared/team'
import type { DecisionCard } from '../../shared/planDecisions'

function git(args: string[], cwd?: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
}

let root: string
let repo: string
let db: Database
let service: TaskService
let team: TeamIdentity
const human = (): TaskCaller => ({ kind: 'human', team })
const agent = (sessionId: string): TaskCaller => ({ kind: 'agent', sessionId })
const row = (sessionId: string): ChatSessionRecord => ({
  sessionId, groupId: 'leads', projectPath: repo, name: sessionId, sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '',
})
const kawaiTask = () => service.store.create({ teamId: team.teamId, title: 'Export', direction: 'CSV', creator: SYSTEM_ACTOR })
const request = (extra: Partial<HandoffRequestInput> = {}): HandoffRequestInput => ({
  baseRevision: 1, direction: 'CSV with headers', rationale: 'Headers were missing', notify: false, requestKey: 'k1', ...extra,
})
const count = (table: string, where = '1 = 1', ...args: string[]) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...args) as { n: number }).n
const rows = () => Object.fromEntries(['team_task_handoffs', 'team_task_handoff_events', 'team_task_handoff_wakeups', 'team_task_revisions', 'team_messages']
  .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-handoff-scenarios-')))
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
  const records = new Map([['lead', row('lead')]])
  service = new TaskService(new TaskStore(db, new MailboxStore(db)), { getSession: id => records.get(id), homeDir: path.join(root, 'home') })
})

describe('task-publication-handoffs scenarios', () => {
  // @covers: task-publication-handoffs › A handoff is never a revision › A draft survives a request
  test('a request leaves the human\'s saved draft exactly as it was', async () => {
    const task = kawaiTask()
    service.store.drafts.save(task.id, { baseRevision: 1, direction: 'My own edit', acceptance: null, rationale: 'mine' }, '2026-11-22T00:00:00.000Z')
    const before = service.store.drafts.get(task.id)
    await service.handoffs.request(agent('lead'), task.id, request())
    expect(service.store.drafts.get(task.id)).toEqual(before)
    expect(before).toMatchObject({ direction: 'My own edit', handoffId: null, lineageId: null })
  })

  // @covers: task-publication-handoffs › A handoff is published at most once › Two clicks publish once
  test('two simultaneous prepared publishes write one revision, event, wakeup and message, and both return that revision', async () => {
    const task = kawaiTask()
    const { handoff } = await service.handoffs.request(agent('lead'), task.id, request())
    const [first, second] = await Promise.all([1, 2].map(() => service.handoffs.publish(human(), task.id, handoff.id, [])))
    expect([first!.revision.revision, second!.revision.revision]).toEqual([2, 2])
    expect([first!.replay, second!.replay].sort()).toEqual([false, true])
    expect(count('team_task_revisions', 'task_id = ?', task.id)).toBe(2)
    expect(count('team_task_handoff_events', "handoff_id = ? AND to_state = 'published'", handoff.id)).toBe(1)
    expect(count('team_task_handoff_wakeups', 'handoff_id = ?', handoff.id)).toBe(1)
    expect(count('team_messages')).toBe(1)
    expect(service.handoffs.store.get(handoff.id)).toMatchObject({ state: 'published', publishedRevision: 2 })
  })

  // @covers: task-publication-handoffs › Another publication makes a pending handoff stale › Re-preparing a stale handoff
  test('the requester re-prepares a stale handoff on the new revision: the old one reads superseded and the new one is open', async () => {
    const task = kawaiTask()
    const stale = (await service.handoffs.request(agent('lead'), task.id, request())).handoff
    await service.publish(human(), task.id, { direction: 'Mine', rationale: 'own', notify: false })
    expect(service.handoffs.store.get(stale.id)!.state).toBe('stale')
    const next = await service.handoffs.request(agent('lead'), task.id, request({ baseRevision: 2, requestKey: 'k2', direction: 'Mine with headers' }))
    expect(next).toMatchObject({ replay: false, superseded: stale.id, handoff: { state: 'open', baseRevision: 2 } })
    expect(service.handoffs.store.get(stale.id)).toMatchObject({ state: 'superseded', supersededBy: next.handoff.id })
  })

  // @covers: task-publication-handoffs › Handoffs survive restart and reconcile once › A refused key changes nothing at restart
  test('a refused reserved-key publication, then the restart sweep: the handoff stays open and no message about it is sent', async () => {
    const task = kawaiTask()
    const { handoff } = await service.handoffs.request(agent('lead'), task.id, request())
    const before = rows()
    await expect(service.publish(human(), task.id, { direction: 'Taken', rationale: 'mine', notify: false, requestKey: `handoff:${handoff.id}` }))
      .rejects.toThrow(RESERVED_KEY_REFUSAL)
    expect(service.handoffs.reconcile()).toEqual([])
    expect(rows()).toEqual(before)
    expect(service.handoffs.store.get(handoff.id)!.state).toBe('open')
  })
})

describe('team-workspace scenarios', () => {
  const card: DecisionCard = {
    id: 'card-1', kind: 'question', teamId: 'team', planId: 'plan-1', revision: 2, change: 'api', taskId: 'task-api',
    question: 'Publish the corrected contract?', options: ['Yes', 'No'], context: null,
    askedBy: { session: 'lead', group: 'leads', profile: 'default' }, addressedTo: 'owner', addressedGroup: null, messageId: null,
    createdAt: '2026-11-22T09:00:00.000Z',
  }
  const plan = (openCards: DecisionCard[]): PlanAttentionFact => ({
    teamId: 'team', planId: 'plan-1', planTitle: 'Wave', leadGroup: 'leads', executionId: 'exec-1',
    changes: [], openCards, fixes: [], failedPromotion: null, correctionOpen: false,
  } as unknown as PlanAttentionFact)
  const items = async (openCards: DecisionCard[]) => {
    const task = kawaiTask()
    const { handoff } = await service.handoffs.request(agent('lead'), task.id, request())
    return attentionItems({
      sessions: [], messages: [], waiting: {}, taskTitle: () => null, nameOf: (id: string) => id, pendingAcceptance: [], outboundViolations: [],
      plans: [plan(openCards)],
      handoffs: [{ handoff, taskTitle: 'Export', requesterName: 'lead', liveOwner: null, requesterLive: true, taskRevision: 1 }],
    } as unknown as AttentionInput).map(item => item.kind)
  }

  // @covers: team-workspace › The attention queue lists pending publication handoffs › Answering a card leaves the item
  test('while the card is open both items stand; once it is answered only the handoff item remains', async () => {
    expect((await items([card])).sort()).toEqual(['decision-question', 'publication-handoff'])
    expect(await items([])).toEqual(['publication-handoff'])
  })
})
