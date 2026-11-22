// Table H-DRAFT (owner-publication-handoff D3) through the real WS draft
// commands — `team-task-handoff-load-draft`, `team-task-draft` save and
// rebase, `team-task-publish` — handled by TaskConnections over a real
// TaskService and store, each row read back as the stored draft (text, base,
// lineage identity, link), the handoff row and the revisions. A refused row
// writes nothing: the draft, handoff, event, wakeup, revision and mail rows
// are identical before and after. The traces are the design's: load, save,
// publish, resend after the discard; load, stale, rebase, publish; a stale
// form against a re-load; and the paired H43/H44 witnesses on one snapshot.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import type { ChatSessionRecord } from '../db'
import type { ChatConnection } from '../chat/ChatConnections'
import { CHAT_CONNECTION_TYPES } from '../chat/chatConnectionTypes'
import { schemaCopy } from './schemaDb'
import { MailboxStore } from '../team/mailboxStore'
import { TaskStore } from '../team/taskStore'
import { TaskService, type TaskCaller } from '../team/TaskService'
import { TaskConnections } from '../team/taskConnections'
import { loadHandoffDraft } from '../team/taskHandoffDrafts'
import { REPLACED_DRAFT_REFUSAL } from '../team/taskDrafts'
import { clearTeamCache, resolveTeam, type TeamIdentity } from '../team/teamIdentity'
import { SYSTEM_ACTOR } from '../../shared/team'
import type { ClientMessage } from '../../shared/types'
import type { TaskDraft } from '../../shared/teamTasks'

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
const agent = (sessionId: string): TaskCaller => ({ kind: 'agent', sessionId })
const row = (sessionId: string, groupId: string): ChatSessionRecord => ({
  sessionId, groupId, projectPath: repo, name: sessionId, sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '',
})
let serial = 0

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-handoff-drafts-')))
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
  const records = new Map([['lead', row('lead', 'leads')], ['owner', row('owner', 'leads')]])
  service = new TaskService(new TaskStore(db, new MailboxStore(db)), { getSession: id => records.get(id), homeDir: path.join(root, 'home') })
  const manager = { teamScopes: { resolve: async (p: string) => (p === repo ? team : null) }, tasks: service, directory: { list: () => [] } }
  ws = new TaskConnections(manager as never)
  sent.length = 0
})

type Command = Omit<Extract<ClientMessage, { requestId: string }>, 'teamPath' | 'requestId'>
/** One human WS command; its `team-task-result` error, or null. */
async function command(message: Command): Promise<string | null> {
  await ws.handle(connection, { ...message, teamPath: repo, requestId: `r${++serial}` } as never)
  const reply = sent.at(-1) as { type: string; error?: string }
  expect(reply.type).toBe('team-task-result')
  return reply.error ?? null
}
const load = (taskId: string, handoffId: string, replace = false) => command({ type: 'team-task-handoff-load-draft', taskId, handoffId, replace } as Command)
const save = (taskId: string, draft: Pick<TaskDraft, 'baseRevision' | 'direction'>, observedDraft?: string | null) => command({
  type: 'team-task-draft', taskId, action: 'save', baseRevision: draft.baseRevision, direction: draft.direction, rationale: 'why',
  ...(observedDraft ? { observedDraft } : {}),
} as Command)
const rebase = (taskId: string, observedDraft?: string | null) => command({ type: 'team-task-draft', taskId, action: 'rebase', ...(observedDraft ? { observedDraft } : {}) } as Command)
const publish = (taskId: string, fields: { baseRevision: number; direction: string; requestKey: string; fromDraft: boolean; observedDraft?: string | null; rationale?: string }) => command({
  type: 'team-task-publish', taskId, baseRevision: fields.baseRevision, direction: fields.direction, requestKey: fields.requestKey,
  rationale: fields.rationale ?? 'publish it', notify: false, fromDraft: fields.fromDraft, ...(fields.observedDraft ? { observedDraft: fields.observedDraft } : {}),
} as Command)

const kawaiTask = () => service.store.create({ teamId: team.teamId, title: 'Export', direction: 'CSV', creator: SYSTEM_ACTOR })
const requestOn = async (taskId: string, key = `k${++serial}`, direction = 'CSV with headers') =>
  (await service.handoffs.request(agent('lead'), taskId, { baseRevision: service.store.get(taskId)!.revision, direction, rationale: 'Headers were missing', notify: false, requestKey: key })).handoff
const draft = (taskId: string) => service.store.drafts.get(taskId)
const handoff = (id: string) => service.handoffs.store.get(id)!
const revisions = (taskId: string) => db.prepare('SELECT revision, direction, request_key, handoff_id FROM team_task_revisions WHERE task_id = ? ORDER BY revision').all(taskId)
const snapshot = () => Object.fromEntries(['team_task_drafts', 'team_task_handoffs', 'team_task_handoff_events', 'team_task_handoff_wakeups', 'team_task_revisions', 'team_messages']
  .map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]))
async function refused(run: () => Promise<string | null>, message: string | RegExp) {
  const before = snapshot()
  expect(await run()).toMatch(message)
  expect(snapshot()).toEqual(before)
}
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const H43 = new RegExp(escape(REPLACED_DRAFT_REFUSAL))

describe('H-DRAFT: load', () => {
  test('the load command is in the chat router whitelist', () => {
    expect(CHAT_CONNECTION_TYPES).toContain('team-task-handoff-load-draft')
  })

  test('H36: an agent cannot load a handoff into the draft', async () => {
    const task = kawaiTask()
    const h = await requestOn(task.id)
    const before = snapshot()
    await expect(loadHandoffDraft(service, agent('lead'), task.id, h.id, true)).rejects.toThrow(/Drafts are the human's/)
    expect(snapshot()).toEqual(before)
  })

  // @covers: task-publication-handoffs › Editing before publishing still fulfills the handoff › A stale handoff cannot be loaded
  test('H37: a stale or ended handoff is refused naming its state, the draft unchanged', async () => {
    const task = kawaiTask()
    const h = await requestOn(task.id)
    await service.publish({ kind: 'human', team }, task.id, { direction: 'Mine', rationale: 'own', notify: false })
    await refused(() => load(task.id, h.id, true), /handoff is stale/)
    const declined = await requestOn(task.id)
    await service.handoffs.settle({ kind: 'human', team }, declined.id, 'decline', 'no')
    await refused(() => load(task.id, declined.id, true), /handoff is declined/)
  })

  // @covers: task-publication-handoffs › Editing before publishing still fulfills the handoff › An existing draft is not overwritten silently
  test('H18 then H19: an existing draft needs replace; the accepted load holds the prepared fields, the base, a fresh identity and the link', async () => {
    const task = kawaiTask()
    const h = await requestOn(task.id)
    expect(await save(task.id, { baseRevision: 1, direction: 'My own edit' })).toBeNull()
    await refused(() => load(task.id, h.id), /confirm replacing it/)
    expect(await load(task.id, h.id, true)).toBeNull()
    const first = draft(task.id)!
    expect(first).toMatchObject({ baseRevision: 1, direction: 'CSV with headers', rationale: 'Headers were missing', handoffId: h.id })
    expect(first.lineageId).toMatch(/^[0-9a-f-]{36}$/)
    expect(handoff(h.id).state).toBe('open')
    expect(await load(task.id, h.id, true)).toBeNull()
    expect(draft(task.id)!.lineageId).not.toBe(first.lineageId)
  })
})

describe('H-DRAFT: save and rebase', () => {
  // @covers: task-publication-handoffs › A loaded draft stays linked only as the draft that was loaded › Saving the loaded draft keeps its link
  // @covers: task-publication-handoffs › A loaded draft stays linked only as the draft that was loaded › A resend after publishing returns the same revision
  // @covers: task-publication-handoffs › Editing before publishing still fulfills the handoff › Published as edited
  test('trace: load, save at the same base (H41), publish (H17), resend after the discard (H17r)', async () => {
    const task = kawaiTask()
    const h = await requestOn(task.id)
    await load(task.id, h.id)
    const lineage = draft(task.id)!.lineageId!
    expect(await save(task.id, { baseRevision: 1, direction: 'CSV with headers and a BOM' }, lineage)).toBeNull()
    expect(draft(task.id)).toMatchObject({ direction: 'CSV with headers and a BOM', handoffId: h.id, lineageId: lineage })
    expect(handoff(h.id).state).toBe('open')
    const fields = { baseRevision: 1, direction: 'CSV with headers and a BOM', requestKey: 'pub-1', fromDraft: true, observedDraft: lineage }
    expect(await publish(task.id, fields)).toBeNull()
    expect(revisions(task.id)).toEqual([
      { revision: 1, direction: 'CSV', request_key: null, handoff_id: null },
      { revision: 2, direction: 'CSV with headers and a BOM', request_key: 'pub-1', handoff_id: h.id },
    ])
    expect(handoff(h.id)).toMatchObject({ state: 'published', publishedRevision: 2 })
    expect(handoff(h.id).publishedPayloadHash).not.toBe(handoff(h.id).payloadHash)
    expect(draft(task.id)).toBeNull()
    expect(db.prepare("SELECT transition FROM team_task_handoff_wakeups WHERE handoff_id = ?").all(h.id)).toEqual([{ transition: 'published' }])
    const before = snapshot()
    expect(await publish(task.id, fields)).toBeNull()
    expect((sent.at(-1) as { replay: boolean; revision: number })).toMatchObject({ replay: true, revision: 2 })
    expect(snapshot()).toEqual(before)
  })

  // @covers: task-publication-handoffs › A loaded draft stays linked only as the draft that was loaded › Rebasing the loaded draft drops its link
  test('trace: load, another revision makes H stale (H20), rebase detaches (H42), publish is ordinary and H stays stale (H21)', async () => {
    const task = kawaiTask()
    const h = await requestOn(task.id)
    await load(task.id, h.id)
    const lineage = draft(task.id)!.lineageId!
    await service.publish({ kind: 'human', team }, task.id, { direction: 'Other', rationale: 'meanwhile', notify: false })
    expect(handoff(h.id).state).toBe('stale')
    expect(await rebase(task.id, lineage)).toBeNull()
    expect(draft(task.id)).toMatchObject({ baseRevision: 2, direction: 'CSV with headers', handoffId: null, lineageId: null })
    expect(await publish(task.id, { baseRevision: 2, direction: 'CSV with headers', requestKey: 'pub-2', fromDraft: true })).toBeNull()
    expect(revisions(task.id).at(-1)).toEqual({ revision: 3, direction: 'CSV with headers', request_key: 'pub-2', handoff_id: null })
    expect(handoff(h.id).state).toBe('stale')
  })

  test('H42: a save that moves the base keeps the text and detaches the link; the handoff is unchanged', async () => {
    const task = kawaiTask()
    await service.publish({ kind: 'human', team }, task.id, { direction: 'Two', rationale: 'r', notify: false })
    const h = await requestOn(task.id)
    await load(task.id, h.id)
    const lineage = draft(task.id)!.lineageId!
    const before = handoff(h.id)
    expect(await save(task.id, { baseRevision: 1, direction: 'On the first revision' }, lineage)).toBeNull()
    expect(draft(task.id)).toMatchObject({ baseRevision: 1, direction: 'On the first revision', handoffId: null, lineageId: null })
    expect(handoff(h.id)).toEqual(before)
  })

  // @covers: task-publication-handoffs › A loaded draft stays linked only as the draft that was loaded › A stale form cannot write over a replacement draft
  test("trace: form A loads H, form B re-loads it, A's save, rebase and publish are refused (H43); B's linked publish fulfills H (H17)", async () => {
    const task = kawaiTask()
    const h = await requestOn(task.id)
    await load(task.id, h.id)
    const formA = draft(task.id)!.lineageId!
    await load(task.id, h.id, true)
    const formB = draft(task.id)!.lineageId!
    await refused(() => save(task.id, { baseRevision: 1, direction: 'A edits' }, formA), H43)
    await refused(() => rebase(task.id, formA), H43)
    await refused(() => publish(task.id, { baseRevision: 1, direction: 'A edits', requestKey: 'a', fromDraft: true, observedDraft: formA }), H43)
    expect(await publish(task.id, { baseRevision: 1, direction: 'CSV with headers', requestKey: 'b', fromDraft: true, observedDraft: formB, rationale: 'Headers were missing' })).toBeNull()
    expect(handoff(h.id)).toMatchObject({ state: 'published', publishedRevision: 2 })
    expect(handoff(h.id).publishedPayloadHash).toBe(handoff(h.id).payloadHash)
  })
})

describe('H-DRAFT: publish', () => {
  // @covers: task-publication-handoffs › A loaded draft stays linked only as the draft that was loaded › An older form keeps its draft intent
  // @covers: task-publication-handoffs › A loaded draft stays linked only as the draft that was loaded › An explicit ordinary publication passes a loaded draft
  test('paired witnesses on one snapshot: a form editing an earlier ordinary draft publishes as a draft → H43; the same values as an ordinary publication → H44', async () => {
    const task = kawaiTask()
    await save(task.id, { baseRevision: 1, direction: 'My ordinary edit' })
    const h = await requestOn(task.id)
    await load(task.id, h.id, true)
    const loaded = draft(task.id)!
    const values = { baseRevision: 1, direction: 'My ordinary edit', requestKey: 'mine' }
    await refused(() => publish(task.id, { ...values, fromDraft: true }), H43)
    expect(await publish(task.id, { ...values, fromDraft: false })).toBeNull()
    expect(revisions(task.id).at(-1)).toEqual({ revision: 2, direction: 'My ordinary edit', request_key: 'mine', handoff_id: null })
    expect(handoff(h.id).state).toBe('stale')
    expect(draft(task.id)).toEqual(loaded)
  })

  // @covers: task-publication-handoffs › A loaded draft stays linked only as the draft that was loaded › An ordinary publication keeps a loaded draft
  test("H44: the owner's task_amend while the human's draft is loaded from H turns H stale and keeps the draft", async () => {
    const task = await service.create(agent('owner'), { title: 'Owned', direction: 'CSV' })
    const h = await requestOn(task.id)
    await load(task.id, h.id)
    const loaded = draft(task.id)!
    await service.amend(agent('owner'), task.id, { direction: 'Owner edit' })
    expect(handoff(h.id).state).toBe('stale')
    expect(draft(task.id)).toEqual(loaded)
  })

  // @covers: task-publication-handoffs › A loaded draft stays linked only as the draft that was loaded › A reused key with another linked draft is refused
  test('H17m: a linked publish reusing a key refuses a different payload and, with the same payload, a different linked handoff', async () => {
    const task = kawaiTask()
    const h = await requestOn(task.id)
    await load(task.id, h.id)
    const lineage = draft(task.id)!.lineageId!
    expect(await publish(task.id, { baseRevision: 1, direction: 'CSV with headers', requestKey: 'shared', fromDraft: false })).toBeNull()
    await refused(() => publish(task.id, { baseRevision: 1, direction: 'Changed', requestKey: 'shared', fromDraft: true, observedDraft: lineage }), /different direction/)
    await refused(() => publish(task.id, { baseRevision: 1, direction: 'CSV with headers', requestKey: 'shared', fromDraft: true, observedDraft: lineage }), /different linked handoff/)
  })

  // @covers: task-publication-handoffs › Editing before publishing still fulfills the handoff › A linked draft outlives its handoff
  test('H38: a linked draft whose handoff was declined publishes an ordinary revision; a superseded one leaves the superseding handoff stale', async () => {
    const task = kawaiTask()
    const h = await requestOn(task.id)
    await load(task.id, h.id)
    const lineage = draft(task.id)!.lineageId!
    await service.handoffs.settle({ kind: 'human', team }, h.id, 'decline', 'not this')
    expect(await publish(task.id, { baseRevision: 1, direction: 'CSV with headers', requestKey: 'p', fromDraft: true, observedDraft: lineage })).toBeNull()
    expect(revisions(task.id).at(-1)).toMatchObject({ revision: 2, handoff_id: null })
    expect(handoff(h.id).state).toBe('declined')

    const next = await requestOn(task.id)
    await load(task.id, next.id)
    const second = draft(task.id)!.lineageId!
    const superseding = await requestOn(task.id, 'k-again', 'Re-prepared')
    expect(handoff(next.id).state).toBe('superseded')
    expect(await publish(task.id, { baseRevision: 2, direction: 'CSV with headers', requestKey: 'q', fromDraft: true, observedDraft: second })).toBeNull()
    expect(revisions(task.id).at(-1)).toMatchObject({ revision: 3, handoff_id: null })
    expect([handoff(next.id).state, handoff(superseding.id).state]).toEqual(['superseded', 'stale'])
  })

  test('H43 inside the transaction: a replacement linked draft landing after the form read, before the publish writes, is refused, not discarded', async () => {
    const task = kawaiTask()
    const h = await requestOn(task.id)
    await load(task.id, h.id)
    const lineage = draft(task.id)!.lineageId!
    const original = service.store.publish.bind(service.store)
    service.store.publish = (id, input, author, now) => {
      // Another window re-loads H between this request's checks and its transaction.
      service.store.drafts.save(id, { baseRevision: 1, direction: 'Replacement', acceptance: null, rationale: 'r' }, undefined, { handoffId: h.id, lineageId: 'replacement' })
      return original(id, input, author, now)
    }
    expect(await publish(task.id, { baseRevision: 1, direction: 'CSV with headers', requestKey: 'race', fromDraft: true, observedDraft: lineage })).toMatch(H43)
    expect(draft(task.id)).toMatchObject({ direction: 'Replacement', lineageId: 'replacement', handoffId: h.id })
    expect([revisions(task.id).length, handoff(h.id).state]).toEqual([1, 'open'])
  })

  test('H38s: after a prepared publish of the same handoff, the linked draft meets the stale-base check; no second revision', async () => {
    const task = kawaiTask()
    const h = await requestOn(task.id)
    await load(task.id, h.id)
    const lineage = draft(task.id)!.lineageId!
    expect(await command({ type: 'team-task-handoff-publish', taskId: task.id, handoffId: h.id, requestKey: 'prep' } as Command)).toBeNull()
    await refused(() => publish(task.id, { baseRevision: 1, direction: 'CSV with headers', requestKey: 'late', fromDraft: true, observedDraft: lineage }), /Stale: revision 2/)
    expect(revisions(task.id)).toHaveLength(2)
  })
})
