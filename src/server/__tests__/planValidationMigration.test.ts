// Schema migration `plan-validation` (plan-validation D1 on
// execution-safety-recovery D13–D14): a database written by the build before
// it — with durable-plans rows — upgrades to this build's newest version
// keeping every row after its pre-migration backup, a fresh database ends at
// the newest version with the three validation tables, and a database a
// newer build migrated is still refused before any write. Number-agnostic
// where easy: the last migration is `plan-validation`, and the build before
// it is `MIGRATIONS` without the last entry. Every database lives in a
// temporary directory.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { initDatabase } from '../db'
import { DatabaseStartupError, MIGRATIONS, type Migration } from '../dbSafety/migrations'
import { PlanStore } from '../plans/planStore'
import { CREATE_PLAN_TABLES_SQL } from '../plans/planSchema'
import { ValidationStore } from '../plans/validation/validationStore'
import { normalizePlanContent } from '../../shared/plans'
import { hashPlanDraft } from '../plans/planHash'
import { VALIDATION_CHECKS_VERSION, type ValidationInputs } from '../../shared/planValidation'

const VALIDATION_TABLES = ['plan_assessments', 'plan_validation_decisions', 'plan_validation_reports']
const human = { kind: 'human' as const, sessionId: null }

let dir: string
let dbPath: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-plan-validation-migration-'))
  dbPath = path.join(dir, 'agentboard.db')
})
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

/** Every table's rows (schema_migrations aside), read-only, for a before/after comparison. */
function rows(file: string): Record<string, unknown[]> {
  const db = new Database(file, { readonly: true })
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations' ORDER BY name").all() as Array<{ name: string }>)
      .map(row => row.name)
    return Object.fromEntries(tables.map(name => [name, db.prepare(`SELECT * FROM ${name} ORDER BY rowid`).all()]))
  } finally { db.close() }
}

function versions(file: string): Array<{ version: number; name: string; backup_path: string | null }> {
  const db = new Database(file, { readonly: true })
  try {
    return db.prepare('SELECT version, name, backup_path FROM schema_migrations ORDER BY version').all() as never
  } finally { db.close() }
}

const inputs = (planId: string, revision: number): ValidationInputs => ({
  checksVersion: VALIDATION_CHECKS_VERSION,
  plan: { planId, revision, contentHash: 'hash' },
  impactStateKey: 'impact',
  adapter: { tool: 'openspec', version: '1.14.2', capabilities: ['show-deltas-json', 'validate-strict-json'] },
  changes: [{ change: 'alpha', status: 'registered', artifacts: { 'proposal.md': 'a' }, baseSpecs: {}, config: 'c' }],
  catalog: { groups: {}, profiles: 'p' },
  claims: { branch: [], changes: {} },
  records: { assessments: [], decisions: [] },
})

// The build that introduced plan-validation: every migration through it.
// Later migrations have their own tests.
const AT = MIGRATIONS.findIndex(migration => migration.name === 'plan-validation')
const THROUGH_VALIDATION = MIGRATIONS.slice(0, AT + 1)

/** A database as the build before this change leaves it: a plan with a submitted revision. */
function planAtPreviousVersion(): string {
  const session = initDatabase({ path: dbPath, migrations: MIGRATIONS.slice(0, AT) })
  const store = new PlanStore(session.db)
  const planId = store.insertPlan({ teamId: '/repo/.git', title: 'Plan', creator: human })
  store.insertRevision(planId, { content: normalizePlanContent({ goal: 'g', changes: [{ change: 'alpha' }] }), contentHash: hashPlanDraft(normalizePlanContent({ goal: 'g' })), pin: null, author: human })
  session.close()
  return planId
}

test('the registry holds plan-validation as the dense next numbered migration', () => {
  const migration = MIGRATIONS[AT]!
  expect(migration.version).toBe((MIGRATIONS[AT - 1]?.version ?? 1) + 1)
  expect(checkDense(MIGRATIONS)).toBe(true)
})

function checkDense(migrations: readonly Migration[]): boolean {
  return migrations.every((migration, index) => migration.version === index + 2)
}

test('a database written by the build before plan-validation upgrades keeping every plan row', () => {
  const planId = planAtPreviousVersion()
  const before = rows(dbPath)
  expect(before.plans).toHaveLength(1)
  expect(before.plan_revisions).toHaveLength(1)
  expect(VALIDATION_TABLES.filter(table => table in before)).toEqual([])
  const previous = versions(dbPath)

  const session = initDatabase({ path: dbPath, migrations: THROUGH_VALIDATION })
  // The new tables are usable at once: a report, an assessment, a decision.
  const validation = new ValidationStore(session.db)
  validation.insertReport({
    planId, revision: 1, inputHash: 'h1', inputs: inputs(planId, 1), findings: [], relations: [], evidence: {
      changes: {}, branch: null, capacity: [],
    }, readiness: { ready: false, errors: [], unansweredQuestions: [], unacceptedWarnings: [], alignment: { state: 'unassessed', reason: null, effective: null }, carriedConditions: [] }, ready: false,
    requestedBy: { kind: 'human', sessionId: null },
  })
  validation.insertAssessment({ planId, revision: 1, kind: 'question', payload: { text: 'q', mandatory: true, subject: null }, author: { kind: 'agent', sessionId: 'chat-1' }, commandId: null })
  validation.insertDecision({ planId, revision: 1, kind: 'answer', target: 'pas-1', text: 'yes', scope: null, commandId: 'cmd-1', payload: {} })
  session.close()

  const after = rows(dbPath)
  for (const [table, tableRows] of Object.entries(before)) expect(after[table]).toEqual(tableRows)
  expect(Object.keys(after).filter(table => !(table in before)).sort()).toEqual(VALIDATION_TABLES)
  const recorded = versions(dbPath)
  expect(recorded.map(row => row.version)).toEqual([...previous.map(row => row.version), previous.at(-1)!.version + 1])
  expect(recorded.at(-1)!.name).toBe('plan-validation')
  const backup = recorded.at(-1)!.backup_path!
  expect(path.basename(backup)).toMatch(new RegExp(`-pre-migration-${recorded.at(-1)!.version}\\.db$`))
  expect(VALIDATION_TABLES.filter(table => table in rows(backup))).toEqual([])
})

test('a fresh database ends at the newest version with the validation tables', () => {
  initDatabase({ path: dbPath }).close()
  const newest = MIGRATIONS.at(-1)!.version
  expect(versions(dbPath).map(row => row.name)).toEqual(['baseline', ...MIGRATIONS.map(migration => migration.name)])
  expect(Object.keys(rows(dbPath))).toEqual(expect.arrayContaining([
    ...VALIDATION_TABLES, ...CREATE_PLAN_TABLES_SQL.match(/CREATE TABLE IF NOT EXISTS (\w+)/g)!.map(match => match.split(' ')[5]!),
  ]))
  const db = new Database(dbPath, { readonly: true })
  expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: newest })
  db.close()
})

test('a database a newer build migrated past this version is still refused before any write', () => {
  const later: Migration = { version: MIGRATIONS.at(-1)!.version + 1, name: 'later', up: db => db.exec('CREATE TABLE later_rows (id TEXT PRIMARY KEY)') }
  initDatabase({ path: dbPath, migrations: [...MIGRATIONS, later] }).close()
  const bytes = fs.readFileSync(dbPath)
  let error: unknown
  try { initDatabase({ path: dbPath }) } catch (caught) { error = caught }
  expect(error).toBeInstanceOf(DatabaseStartupError)
  expect((error as Error).message).toContain(`schema version ${later.version}`)
  expect((error as Error).message).toContain(`only up to version ${MIGRATIONS.at(-1)!.version}`)
  expect(fs.readFileSync(dbPath).equals(bytes)).toBe(true)
})
