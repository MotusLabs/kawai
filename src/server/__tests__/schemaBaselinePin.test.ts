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
// Migration 2 (`strategy-impact`) adds the three strategy impact tables and
// migration 3 (`plan-validation`) the three validation tables below.
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
const integer = (name: string) => ({ name, type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 })

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

/** Migration 3's delta: the report, assessment, and decision tables (plan-validation D1). */
const migration3: SchemaShape['tables'] = {
  plan_validation_reports: {
    columns: [
      id, column('plan_id'), integer('revision'), integer('seq'), column('input_hash'),
      ...['inputs_json', 'findings_json', 'relations_json', 'evidence_json', 'readiness_json'].map(name => column(name)),
      integer('ready'), column('requested_kind'), optional('requested_session'), column('created_at'),
    ],
    indexes: [],
  },
  plan_assessments: {
    columns: [id, column('plan_id'), integer('revision'), column('kind'), column('payload_json'), column('author_kind'), optional('author_session'), optional('command_id'), column('created_at')],
    indexes: [{ name: 'plan_assessments_revision', unique: 0, columns: ['plan_id', 'revision', 'created_at'] }],
  },
  plan_validation_decisions: {
    columns: [id, column('plan_id'), integer('revision'), column('kind'), column('target'), column('text'), optional('scope'), column('actor_kind'), column('command_id'), column('payload_json'), column('created_at')],
    indexes: [{ name: 'plan_validation_decisions_revision', unique: 0, columns: ['plan_id', 'revision', 'created_at'] }],
  },
}

// Migration 2 (`strategy-impact`) adds the strategy impact tables; migration 4
// (`outbound-audit`, execution-safety-recovery D6) adds the three append-only
// audit tables below. Each keeps its own delta; the fixture stays master's.
const migration4: SchemaShape['tables'] = {
  outbound_calls: {
    columns: [
      { name: 'id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 1 },
      { name: 'team_id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'session_id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'spawn_id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'group_id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
      { name: 'profile_id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
      { name: 'task_id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
      { name: 'agent_id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
      { name: 'tool', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'mcp_server', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
      { name: 'tool_use_id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'command', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'truncated', type: 'INTEGER', notnull: 1, dflt_value: '0', pk: 0 },
      { name: 'rule', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'verdict', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'destination', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'matches', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'classifier_version', type: 'INTEGER', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'cwd', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      { name: 'created_at', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
    ],
    indexes: [{ name: 'outbound_calls_team_time', unique: 0, columns: ['team_id', 'created_at', 'id'] }],
  },
  outbound_outcomes: {
    columns: [
      ...['session_id', 'tool_use_id', 'outcome'].map(name => column(name)),
      optional('detail'),
      { name: 'duration_ms', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 },
      column('created_at'),
    ],
    indexes: [],
  },
  outbound_acknowledgements: {
    columns: [
      id,
      ...['team_id', 'command_id', 'rule', 'destination', 'through_created_at', 'through_call_id'].map(name => column(name)),
      optional('note'),
      column('acknowledged_at'),
    ],
    indexes: [],
  },
}

test('a fresh database opened by this build has the same shape plus each migration\'s delta and schema_migrations', () => {
  const session = initDatabase({ path: ':memory:' })
  expect(Object.keys(migration2).filter(table => table in expected.tables)).toEqual([])
  expect(Object.keys(migration3).filter(table => table in expected.tables)).toEqual([])
  expect(Object.keys(migration4).filter(table => table in expected.tables || table in migration2 || table in migration3)).toEqual([])
  expect(schemaShape(session.db)).toEqual({ tables: { ...expected.tables, ...migration2, ...migration3, ...migration4 } })
  const extra = session.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get()
  expect(extra).toEqual({ name: 'schema_migrations' })
  session.close()
})
