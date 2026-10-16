// Schema migration 2 `strategy-impact` (strategy-revision-impact D1 on
// execution-safety-recovery D13–D14): a version-1 database written by the
// build before it upgrades to version 2 keeping every row (its strategy
// impact reviews included) after its pre-migration-2 backup, a fresh database
// ends at version 2 with the impact tables, and a database a newer build
// migrated is still refused before any write. Every database lives in a
// temporary directory.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Database } from 'bun:sqlite'
import { initDatabase } from '../db'
import { DatabaseStartupError, MIGRATIONS, type Migration } from '../dbSafety/migrations'
import { StrategyStore } from '../strategy/strategyStore'
import { ImpactStore } from '../strategy/impactStore'
import { normalizeStrategyContent } from '../../shared/productStrategy'

const human = { kind: 'human' as const, sessionId: null }
const IMPACT_TABLES = ['strategy_impact_decisions', 'strategy_impact_proposals', 'strategy_impact_requests']

let dir: string
let dbPath: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-impact-migration-'))
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

/** A version-1 database as the build before this change leaves it: a strategy with an approval's impact review. */
function versionOneWithReview(): { strategyId: string } {
  const session = initDatabase({ path: dbPath, migrations: [] })
  const strategies = new StrategyStore(session.db)
  const strategy = strategies.create({ productId: 'kawai', title: 'Kawai', owner: human, teamId: '/repo/.git', worktrees: [] })
  const submitted = strategies.submitRevision(strategy.id, { author: human, content: normalizeStrategyContent({ purpose: 'p' }) })
  if (!submitted.ok) throw new Error('submit failed')
  const approved = strategies.approve(strategy.id, {
    revision: 1, contentHash: submitted.revision.contentHash, commandId: 'approve-1', expectedCurrentRevision: null, actor: human,
  })
  if (!approved.ok) throw new Error('approve failed')
  session.setAppSetting('theme', 'dark')
  session.close()
  return { strategyId: strategy.id }
}

test('this build registers migration 2 strategy-impact', () => {
  expect(MIGRATIONS.filter(migration => migration.name === 'strategy-impact').map(migration => migration.version)).toEqual([2])
})

test('a version-1 database upgrades to 2 after its pre-migration-2 backup and keeps every row', () => {
  const { strategyId } = versionOneWithReview()
  const before = rows(dbPath)
  expect(versions(dbPath).map(row => row.version)).toEqual([1])
  expect(IMPACT_TABLES.filter(table => table in before)).toEqual([])
  expect(before.strategy_impact_reviews).toHaveLength(1)

  // Isolate the upgrade to exactly version 2: later migrations (this build's
  // plan-validation and outbound-audit, later builds' entries) have their own tests.
  const session = initDatabase({ path: dbPath, migrations: MIGRATIONS.filter(migration => migration.version <= 2) })
  const reviews = new StrategyStore(session.db).impactReviews(strategyId)
  // The new tables are usable at once: a decision on the existing review.
  new ImpactStore(session.db).insertDecision({
    strategyId, reviewId: reviews[0]!.id, planId: 'plan-1', disposition: 'continue', rationale: 'still fits',
    proposalId: null, supersedesDecisionId: null, planSnapshot: [], commandId: 'decide-1', payload: {},
  })
  session.close()

  const after = rows(dbPath)
  for (const [table, tableRows] of Object.entries(before)) expect(after[table]).toEqual(tableRows)
  expect(Object.keys(after).filter(table => !(table in before)).sort()).toEqual(IMPACT_TABLES)
  expect(after.strategy_impact_decisions).toHaveLength(1)
  const recorded = versions(dbPath)
  expect(recorded.map(row => [row.version, row.name])).toEqual([[1, 'baseline'], [2, 'strategy-impact']])
  // The backup is the database as version 1 left it: no impact tables.
  const backup = recorded[1]!.backup_path!
  expect(path.basename(backup)).toMatch(/-pre-migration-2\.db$/)
  expect(IMPACT_TABLES.filter(table => table in rows(backup))).toEqual([])
  expect(versions(backup).map(row => row.version)).toEqual([1])
})

test('a fresh database ends at the newest version with the impact tables', () => {
  initDatabase({ path: dbPath }).close()
  expect(versions(dbPath).map(row => row.name)).toEqual(['baseline', ...MIGRATIONS.map(migration => migration.name)])
  expect(Object.keys(rows(dbPath))).toEqual(expect.arrayContaining([...IMPACT_TABLES, 'strategy_impact_reviews']))
  const db = new Database(dbPath, { readonly: true })
  expect(db.prepare('PRAGMA user_version').get()).toEqual({ user_version: MIGRATIONS.at(-1)!.version })
  db.close()
})

test('a database a newer build migrated past this version is still refused before any write', () => {
  const next = MIGRATIONS.at(-1)!.version + 1
  const later: Migration = { version: next, name: 'later', up: db => db.exec('CREATE TABLE later_rows (id TEXT PRIMARY KEY)') }
  initDatabase({ path: dbPath, migrations: [...MIGRATIONS, later] }).close()
  const bytes = fs.readFileSync(dbPath)
  let error: unknown
  try { initDatabase({ path: dbPath }) } catch (caught) { error = caught }
  expect(error).toBeInstanceOf(DatabaseStartupError)
  expect((error as Error).message).toContain(`schema version ${next}`)
  expect((error as Error).message).toContain(`only up to version ${MIGRATIONS.at(-1)!.version}`)
  expect((error as Error).message).toMatch(new RegExp(`-pre-migration-${next}\\.db`))
  expect(fs.readFileSync(dbPath).equals(bytes)).toBe(true)
})
