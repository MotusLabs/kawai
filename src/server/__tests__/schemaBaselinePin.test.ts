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

test('a fresh database opened by this build has the same shape plus only schema_migrations', () => {
  const session = initDatabase({ path: ':memory:' })
  expect(schemaShape(session.db)).toEqual(expected)
  const extra = session.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get()
  expect(extra).toEqual({ name: 'schema_migrations' })
  session.close()
})
