// Plan store (durable-plans 2.1/2.2): the four tables and the team_tasks
// link columns migrate on fresh and pre-existing databases, the partial
// index refuses a second approved revision, a command id is unique per plan
// at the database, and every row survives a reopen.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, type SessionDatabase } from '../db'
import { MailboxStore } from '../team/mailboxStore'
import { TaskStore } from '../team/taskStore'
import { PlanApprovedRaceError, PlanCommandRaceError, PlanStore } from '../plans/planStore'
import { normalizePlanContent, type PlanActor } from '../../shared/plans'
import { planInput } from '../../shared/__tests__/planFixtures'
import { hashPlanDraft, hashPlanRevision } from '../plans/planHash'

const TEAM = '/repo/.git'
const human: PlanActor = { kind: 'human', sessionId: null }
const agent: PlanActor = { kind: 'agent', sessionId: 'chat-lead' }

describe('PlanStore', () => {
  let dir: string
  let db: SessionDatabase
  let tasks: TaskStore
  let plans: PlanStore

  const open = () => {
    db = initDatabase({ path: path.join(dir, 'plans.db') })
    tasks = new TaskStore(db.db, new MailboxStore(db.db))
    plans = new PlanStore(db.db)
  }
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-plans-'))
    open()
  })
  afterEach(() => {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const reopen = () => { db.close(); open() }

  const content = normalizePlanContent(planInput())
  const seed = () => {
    const id = plans.insertPlan({ teamId: TEAM, title: 'Wave C', creator: agent })
    const revision = (n: number) => plans.insertRevision(id, { content, contentHash: hashPlanRevision(content, null) + n, pin: null, author: agent })
    return { id, revision }
  }

  test('fresh database: the plan tables, the partial index, and the task link columns exist', () => {
    const tables = (db.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'plan%'`).all() as Array<{ name: string }>).map(row => row.name)
    expect(tables.sort()).toEqual(['plan_drafts', 'plan_events', 'plan_revisions', 'plans'])
    const indexes = (db.db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all() as Array<{ name: string }>).map(row => row.name)
    expect(indexes).toContain('plan_revisions_one_approved')
    expect(indexes).toContain('team_tasks_plan')
    const columns = (db.db.prepare('PRAGMA table_info(team_tasks)').all() as Array<{ name: string }>).map(row => row.name)
    expect(columns).toContain('plan_id')
    expect(columns).toContain('plan_change')
  })

  test('pre-existing team_tasks without the columns: tasks read back unlinked, and a reopen round-trips', () => {
    db.close()
    const legacyPath = path.join(dir, 'legacy.db')
    const legacy = new Database(legacyPath)
    legacy.exec(`CREATE TABLE team_tasks (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
        creator_kind TEXT NOT NULL, creator_session TEXT, parent_id TEXT, worktree TEXT, openspec_change TEXT, revision INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE team_task_revisions (task_id TEXT NOT NULL, revision INTEGER NOT NULL, direction TEXT NOT NULL, acceptance TEXT,
        author_kind TEXT NOT NULL, author_session TEXT, created_at TEXT NOT NULL, PRIMARY KEY (task_id, revision));
      INSERT INTO team_tasks VALUES ('task-old', '${TEAM}', 'Old', 'open', 'human', NULL, NULL, NULL, NULL, 1, '2026-01-01', '2026-01-01');
      INSERT INTO team_task_revisions VALUES ('task-old', 1, 'Keep me', NULL, 'human', NULL, '2026-01-01');`)
    legacy.close()
    db = initDatabase({ path: legacyPath })
    tasks = new TaskStore(db.db, new MailboxStore(db.db))
    plans = new PlanStore(db.db)
    expect(tasks.get('task-old')).toMatchObject({ title: 'Old', direction: 'Keep me', planId: null, planChange: null, planTitle: null })
    db.close()
    db = initDatabase({ path: legacyPath })
    tasks = new TaskStore(db.db, new MailboxStore(db.db))
    expect(tasks.get('task-old')).toMatchObject({ title: 'Old', planId: null })
  })

  test('the partial index refuses a second approved revision', () => {
    const { id, revision } = seed()
    revision(1)
    revision(2)
    plans.setRevisionStatus(id, 1, 'approved')
    expect(() => plans.setRevisionStatus(id, 2, 'approved')).toThrow(PlanApprovedRaceError)
    plans.setRevisionStatus(id, 1, 'superseded')
    plans.setRevisionStatus(id, 2, 'approved')
    expect(plans.revisions(id).map(entry => entry.status)).toEqual(['superseded', 'approved'])
  })

  test('a duplicate command id is refused at the database; agent events without one are not', () => {
    const { id } = seed()
    plans.insertEvent(id, { kind: 'created', actor: agent })
    plans.insertEvent(id, { kind: 'submitted', actor: agent, revision: 1 })
    plans.insertEvent(id, { kind: 'reopened', actor: human, commandId: 'cmd-1', payload: { command: 'reopen' } })
    expect(() => plans.insertEvent(id, { kind: 'reopened', actor: human, commandId: 'cmd-1' })).toThrow(PlanCommandRaceError)
    expect(plans.eventByCommand(id, 'cmd-1')).toMatchObject({ payload: { command: 'reopen' } })
    // Another plan may reuse the id: uniqueness is per plan.
    const other = seed()
    plans.insertEvent(other.id, { kind: 'reopened', actor: human, commandId: 'cmd-1' })
  })

  test('drafts: CAS on hash and base, new author on save, missing draft expected missing', () => {
    const { id } = seed()
    const hash = hashPlanDraft(content)
    const first = plans.writeDraft(id, { draftId: 'd', author: agent, content, contentHash: hash, expectedDraftHash: null })
    expect(first.ok).toBe(true)
    expect(plans.writeDraft(id, { draftId: 'd', author: agent, content, contentHash: hash, expectedDraftHash: null }))
      .toMatchObject({ ok: false, reason: 'conflict', stored: { draftId: 'd', contentHash: hash } })
    expect(plans.writeDraft(id, { draftId: 'd', author: agent, content, contentHash: hash, expectedDraftHash: hash, expectedBaseRevision: 3 }))
      .toMatchObject({ ok: false, reason: 'conflict' })
    const next = { kind: 'agent' as const, sessionId: 'chat-new-lead' }
    expect(plans.writeDraft(id, { draftId: 'd', author: next, content, contentHash: hash, expectedDraftHash: hash, expectedBaseRevision: null }))
      .toMatchObject({ ok: true, draft: { author: next } })
    expect(plans.writeDraft(id, { draftId: 'gone', author: agent, content, contentHash: hash, expectedDraftHash: hash }))
      .toMatchObject({ ok: false, stored: null })
  })

  test('every row survives a reopen', () => {
    const { id, revision } = seed()
    revision(1)
    plans.setRevisionStatus(id, 1, 'approved')
    plans.setCurrentApproved(id, 1)
    plans.writeDraft(id, { draftId: 'd', author: agent, content, contentHash: hashPlanDraft(content), expectedDraftHash: null })
    plans.insertEvent(id, { kind: 'approved', actor: human, revision: 1, commandId: 'c1', payload: { command: 'approve' } })
    const task = tasks.create({ teamId: TEAM, title: 'API', direction: 'Build it', creator: agent, planId: id, planChange: 'api' })
    const before = plans.detail(id)
    reopen()
    expect(plans.detail(id)).toEqual(before)
    expect(before).toMatchObject({ plan: { state: 'in-progress', currentApprovedRevision: 1, linkedTaskCount: 1 }, drafts: [{ draftId: 'd' }] })
    expect(before!.progress!.changes[0]).toMatchObject({ change: 'api', status: 'in-progress' })
    expect(tasks.get(task.id)).toMatchObject({ planId: id, planChange: 'api', planTitle: 'Wave C' })
    expect(plans.list(TEAM).map(plan => plan.id)).toEqual([id])
    expect(plans.openPlans(TEAM).map(plan => plan.id)).toEqual([id])
    expect(plans.openPlans('/other/.git')).toEqual([])
    expect(plans.forTeam('/other/.git', id)).toBeNull()
  })

  test('revisionsPinnedTo reads every revision pinned to a strategy', () => {
    const { id } = seed()
    const pin = { strategyId: 'strategy-1', revision: 2, hash: 'h' }
    plans.insertRevision(id, { content, contentHash: hashPlanRevision(content, pin), pin, author: agent })
    plans.insertRevision(id, { content, contentHash: hashPlanRevision(content, null), pin: null, author: agent })
    expect(plans.revisionsPinnedTo('strategy-1').map(entry => [entry.planId, entry.revision.revision, entry.revision.pin])).toEqual([[id, 1, pin]])
  })
})
