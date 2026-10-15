// A database's schema shape for the baseline pin (execution-safety-recovery
// D13): every table's columns (`PRAGMA table_info`: name, type, notnull,
// default, pk) and every named index (unique flag and columns), sorted, with
// `schema_migrations` left out (master had no such table). Shared by the
// pinning test and by `generateMasterSchemaShape.ts`, which records the shape
// master's own code produced.
import type { Database } from 'bun:sqlite'

export interface SchemaShape {
  tables: Record<string, {
    columns: Array<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }>
    indexes: Array<{ name: string; unique: number; columns: string[] }>
  }>
}

export function schemaShape(db: Database): SchemaShape {
  const tables = (db.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations' ORDER BY name",
  ).all() as Array<{ name: string }>).map(row => row.name)
  return {
    tables: Object.fromEntries(tables.map(table => {
      const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as SchemaShape['tables'][string]['columns'])
        .map(({ name, type, notnull, dflt_value, pk }) => ({ name, type, notnull, dflt_value, pk }))
      const indexes = (db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string; unique: number }>)
        .filter(index => !index.name.startsWith('sqlite_'))
        .map(index => ({
          name: index.name,
          unique: index.unique,
          columns: (db.prepare(`PRAGMA index_info(${index.name})`).all() as Array<{ seqno: number; name: string }>)
            .sort((a, b) => a.seqno - b.seqno).map(column => column.name),
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
      return [table, { columns, indexes }]
    })),
  }
}
