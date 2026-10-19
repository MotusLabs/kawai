// Whole-operation SQLITE_BUSY retry for the e2e `bun -e` seed helpers, which
// write to the running fixture server's database over a second connection.
// The server keeps the rollback journal (src/server/db.ts), and its seed
// transactions are DEFERRED: the opening read takes SHARED, the first write
// then needs RESERVED, and when the server already holds RESERVED SQLite
// returns SQLITE_BUSY at once — the busy handler is bypassed on this upgrade
// path, so `PRAGMA busy_timeout` cannot help (db.ts keeps its pragma; it
// still covers plain writer-vs-writer waits). bun:sqlite rolls a failed
// db.transaction back before the throw escapes, so nothing partial survives
// and the operation can simply be run again as a whole — which is why the
// retry wraps the operation, never statements inside it, and why polling
// reads stay outside it.

/** Total attempts, not retries: the first try plus this many minus one more. */
export const BUSY_RETRY_ATTEMPTS = 20
export const BUSY_RETRY_DELAY_MS = 250

export function isSqliteBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  if ((error as { code?: unknown }).code === 'SQLITE_BUSY') return true
  return error.message.includes('database is locked')
}

export interface BusyRetryOptions {
  /** Total attempts including the first; the last BUSY is rethrown. */
  attempts?: number
  /** Pause between attempts; about 20 × 250 ms by default. */
  delayMs?: number
  /** Injectable pause so tests stay deterministic. */
  sleep?: (ms: number) => Promise<void>
}

export async function retryOnSqliteBusy<T>(op: () => T | Promise<T>, options: BusyRetryOptions = {}): Promise<T> {
  const attempts = options.attempts ?? BUSY_RETRY_ATTEMPTS
  const delayMs = options.delayMs ?? BUSY_RETRY_DELAY_MS
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await op()
    } catch (error) {
      if (!isSqliteBusyError(error) || attempt === attempts) throw error
    }
    await sleep(delayMs)
  }
  throw new Error('unreachable: the attempt loop always returns or throws')
}
