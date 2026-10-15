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
import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { initDatabase } from '../db'
import { applyBaselineSchema } from '../dbSafety/baseline'
import { schemaShape, type SchemaShape } from './fixtures/schemaShape'
import master from './fixtures/masterSchemaShape.json'

const expected = master as SchemaShape

test('a fresh baseline reproduces master bdc0131 schema exactly', () => {
  const db = new Database(':memory:')
  applyBaselineSchema(db)
  expect(schemaShape(db)).toEqual(expected)
  db.close()
})

// Migration 2 `outbound-audit` (execution-safety-recovery D6): the three
// append-only audit tables join the expected shape; the fixture stays master's.
const withOutboundAudit: SchemaShape = {
  tables: {
    ...expected.tables,
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
      indexes: [
        { name: 'outbound_calls_team_time', unique: 0, columns: ['team_id', 'created_at', 'id'] },
      ],
    },
    outbound_outcomes: {
      columns: [
        { name: 'session_id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
        { name: 'tool_use_id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
        { name: 'outcome', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
        { name: 'detail', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
        { name: 'duration_ms', type: 'INTEGER', notnull: 0, dflt_value: null, pk: 0 },
        { name: 'created_at', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      ],
      indexes: [],
    },
    outbound_acknowledgements: {
      columns: [
        { name: 'id', type: 'TEXT', notnull: 0, dflt_value: null, pk: 1 },
        { name: 'team_id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
        { name: 'command_id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
        { name: 'rule', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
        { name: 'destination', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
        { name: 'through_created_at', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
        { name: 'through_call_id', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
        { name: 'note', type: 'TEXT', notnull: 0, dflt_value: null, pk: 0 },
        { name: 'acknowledged_at', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      ],
      indexes: [],
    },
  },
}

test('a fresh database opened by this build has the same shape plus only schema_migrations', () => {
  const session = initDatabase({ path: ':memory:' })
  expect(schemaShape(session.db)).toEqual(withOutboundAudit)
  const extra = session.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get()
  expect(extra).toEqual({ name: 'schema_migrations' })
  session.close()
})
