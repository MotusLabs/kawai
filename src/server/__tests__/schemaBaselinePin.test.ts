// Pins the baseline (execution-safety-recovery D13) to master's schema: a
// fresh database must have exactly the tables, columns (name, type, notnull,
// default, pk), and indexes that master bdc0131's own code produced, recorded
// in fixtures/masterSchemaShape.json. A baseline that dropped one of master's
// ALTERs or migrate steps fails here.
//
// Regenerate the fixture with the command in fixtures/generateMasterSchemaShape.ts
// (a temp extract of bdc0131, then one bun run); only a change to the pinned
// commit calls for it. The baseline is frozen, so the first test never
// changes. A later numbered migration changes the second test's expectation
// on purpose: that migration's change applies its delta to `expected` there
// (added tables, columns, indexes), and the fixture itself stays master's.
// Migration 2 (`strategy-impact`) adds the three strategy impact tables below.
import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { initDatabase } from '../db'
import { applyBaselineSchema } from '../dbSafety/baseline'
import { schemaShape, type SchemaShape } from './fixtures/schemaShape'
import master from './fixtures/masterSchemaShape.json'

const expected = master as SchemaShape

const column = (name: string, notnull = 1, pk = 0) => ({ name, type: 'TEXT', notnull, dflt_value: null, pk })
const id = column('id', 0, 1)
const optional = (name: string) => column(name, 0)

/** Migration 2's delta: the impact proposal, decision, and request tables (strategy-revision-impact D1). */
const migration2: SchemaShape['tables'] = {
  strategy_impact_proposals: {
    columns: [id, ...['strategy_id', 'review_id', 'plan_id', 'disposition', 'rationale', 'author_session', 'created_at'].map(name => column(name))],
    indexes: [{ name: 'strategy_impact_proposals_plan', unique: 0, columns: ['review_id', 'plan_id', 'created_at'] }],
  },
  strategy_impact_decisions: {
    columns: [
      id, ...['strategy_id', 'review_id', 'plan_id', 'disposition', 'rationale'].map(name => column(name)),
      optional('proposal_id'), optional('supersedes_decision_id'),
      ...['plan_snapshot_json', 'actor_kind', 'command_id', 'payload_json', 'created_at'].map(name => column(name)),
    ],
    // The chain index's third column is the expression IFNULL(supersedes_decision_id, ''), which has no name.
    indexes: [{ name: 'strategy_impact_decisions_chain', unique: 1, columns: ['review_id', 'plan_id', null as unknown as string] }],
  },
  strategy_impact_requests: {
    columns: [id, ...['strategy_id', 'review_id', 'target_group', 'message_id', 'command_id', 'payload_json', 'created_at'].map(name => column(name))],
    indexes: [],
  },
}

test('a fresh baseline reproduces master bdc0131 schema exactly', () => {
  const db = new Database(':memory:')
  applyBaselineSchema(db)
  expect(schemaShape(db)).toEqual(expected)
  db.close()
})

test('a fresh database opened by this build has the same shape plus each migration\'s delta and schema_migrations', () => {
  const session = initDatabase({ path: ':memory:' })
  expect(Object.keys(migration2).filter(table => table in expected.tables)).toEqual([])
  expect(schemaShape(session.db)).toEqual({ tables: { ...expected.tables, ...migration2 } })
  const extra = session.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get()
  expect(extra).toEqual({ name: 'schema_migrations' })
  session.close()
})
