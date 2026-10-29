// Helpers for the bounded task-read tests (bounded-log-reads-and-task-get
// D4–D6): journal rows stored as exact bytes, seeded randomness, and the
// test-side query observer (design, Planned mutants), which records every
// executed statement, its returned rows before projection, and the byte
// size of each returned column — what reaches JavaScript, not native memory.
import type { Database } from 'bun:sqlite'

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Store `bytes` as an entry's TEXT unchanged — historical rows may hold NUL, a BOM, or invalid UTF-8. */
export function rawNote(db: Database, taskId: string, bytes: Uint8Array | string, createdAt: string, id = `note-${crypto.randomUUID()}`): string {
  const value = typeof bytes === 'string' ? Buffer.from(bytes, 'utf8') : bytes
  db.prepare(`INSERT INTO team_task_journal (id, task_id, author_kind, author_session, text, created_at)
    VALUES (?, ?, 'agent', 'writer', CAST(? AS TEXT), ?)`).run(id, taskId, value, createdAt)
  return id
}

/** An ISO timestamp `seconds` after a fixed base. */
export const at = (seconds: number) => new Date(Date.UTC(2026, 9, 1) + seconds * 1000).toISOString()

export interface ObservedQuery {
  sql: string
  rows: number
  /** The largest byte size seen per returned column. */
  columnBytes: Record<string, number>
}

const byteSize = (value: unknown) =>
  value instanceof Uint8Array ? value.length : typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : 0

/**
 * Wrap `prepare` and `query` on `db` so each statement's executions are
 * recorded while `active` is set. Install before any store prepares (and
 * caches) its statements.
 */
export function observeQueries(db: Database): { queries: ObservedQuery[]; during<T>(run: () => T): T } {
  const queries: ObservedQuery[] = []
  let active = false
  const record = (sql: string, result: unknown) => {
    if (!active) return result
    const rows = Array.isArray(result) ? result : result === null || result === undefined ? [] : [result]
    const columnBytes: Record<string, number> = {}
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue
      for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
        columnBytes[key] = Math.max(columnBytes[key] ?? 0, byteSize(value))
      }
    }
    queries.push({ sql: sql.replace(/\s+/g, ' ').trim(), rows: rows.length, columnBytes })
    return result
  }
  for (const method of ['prepare', 'query'] as const) {
    const original = db[method].bind(db) as (sql: string, ...rest: unknown[]) => any
    ;(db as any)[method] = (sql: string, ...rest: unknown[]) => {
      const statement = original(sql, ...rest)
      return new Proxy(statement, {
        get(target, key) {
          const value = Reflect.get(target, key, target)
          if (key !== 'all' && key !== 'get') return typeof value === 'function' ? value.bind(target) : value
          return (...args: unknown[]) => record(sql, value.apply(target, args))
        },
      })
    }
  }
  return {
    queries,
    during<T>(run: () => T): T {
      active = true
      try { return run() } finally { active = false }
    },
  }
}
