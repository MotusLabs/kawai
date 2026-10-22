// Writer side of the mailboxStoreBusy handshake (N3): the test holds RESERVED
// on the main thread while this worker runs the writing attempt on its own
// thread, so the holder can commit mid-wait — no wall-clock margin involved.
// The protocol per round: the worker opens its connection and reads the
// holder's marker row of THIS round (its uncommitted token, in table t) —
// invisible while the holder still holds — and reports the read; only then
// does the main thread commit (one macrotask after the report, so the commit
// never lands inside the worker's read→attempt window). The attempt starts
// within microseconds of the read, so its BEGIN meets a still-held lock and
// can only complete by waiting the holder out.
import { Database, type Database as Db } from 'bun:sqlite'
import { MailboxStore } from '../team/mailboxStore'

export type WriterRequest =
  | { type: 'immediate'; path: string; token: string }
  | { type: 'settle'; path: string; id: string; token: string }
  | { type: 'claimWhen'; path: string; id: string; token: string }
  | { type: 'cancel'; path: string; id: string; token: string }

export type WriterRead = { type: 'read'; held: boolean }
export type WriterDone = { type: 'done'; ok: boolean; error: string | null }

/** Long enough that only a genuinely stuck lock (a protocol bug) reaches it;
 * still below bun's 5 s per-test default so a stuck round fails, not times out. */
const BUDGET_MS = 4_000

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

self.onmessage = (event: MessageEvent<WriterRequest>) => {
  const request = event.data
  let db: Db | null = null
  try {
    db = new Database(request.path)
    db.exec(`PRAGMA busy_timeout = ${BUDGET_MS}`)
    // The holder's row of THIS round (earlier rounds' committed rows stay in
    // the table): visible only once this round's commit landed, which — by
    // protocol — happens only after this read is reported.
    const held = db.query('SELECT v FROM t WHERE v = $token').get({ $token: request.token }) !== null
    postMessage({ type: 'read', held } satisfies WriterRead)
    let error: string | null = null
    try {
      if (request.type === 'immediate') {
        const run = db.transaction(() => {
          db!.query('SELECT COUNT(*) AS n FROM t').get()
          db!.prepare("INSERT INTO t VALUES ('x')").run()
        })
        run.immediate()
      } else {
        const store = new MailboxStore(db)
        if (request.type === 'settle') store.markDelivered(request.id)
        else if (request.type === 'claimWhen') {
          store.claimWhen(request.id, 's1', () => {
            void store.get(request.id)
            return true
          })
        } else store.cancel(request.id, { kind: 'human' })
      }
    } catch (caught) {
      error = messageOf(caught)
    }
    postMessage({ type: 'done', ok: error === null, error } satisfies WriterDone)
  } catch (caught) {
    postMessage({ type: 'done', ok: false, error: messageOf(caught) } satisfies WriterDone)
  } finally {
    db?.close()
  }
}
