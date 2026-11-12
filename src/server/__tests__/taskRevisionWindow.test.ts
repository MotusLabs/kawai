// The agent's revision rows and whole-revision read at the store
// (bounded-metrics-and-task-get D7, task 3.3): rows G6, G6a–G6d, G7, G8, the
// statement assertions that keep the window and the hashing in SQL's limit,
// the human detail and stored rows left unchanged (P4), and P3 for
// revisions. The same rows through both tool runtimes are in
// taskJournalTools.test.ts. Ground truth is the inserted fields and the
// store's own `revisions()` (the whole read the identity must equal).
import { beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import type { Database } from 'bun:sqlite'
import { parseContract } from '../../shared/implementationContract'
import { schemaCopy } from './schemaDb'
import { MailboxStore } from '../team/mailboxStore'
import { TaskStore } from '../team/taskStore'
import { REVISION_WINDOW } from '../team/taskRevisionWindow'
import { at, mulberry32, observeQueries } from './taskJournalFixture'
import { CONTRACT_MARKDOWN } from './convergenceGenerator'
import { propertyCases } from './helpers/propertyCases'

let db: Database
let store: TaskStore
let observer: ReturnType<typeof observeQueries>

beforeEach(() => {
  db?.close()
  db = schemaCopy()
  observer = observeQueries(db)
  store = new TaskStore(db, new MailboxStore(db))
})

const lead = { kind: 'agent' as const, sessionId: 'lead' }
const newTask = (direction = 'd1') => store.create({ teamId: 'team', title: 'T', direction, creator: lead }, at(0))
const publish = (id: string, input: { direction?: string; acceptance?: string | null; rationale?: string | null; notify?: boolean }, seconds: number) =>
  store.publish(id, { notify: false, ...input }, lead, at(seconds))!
const contract = parseContract(CONTRACT_MARKDOWN).contract!
const bytes = (text: string | null) => text === null ? 0 : Buffer.byteLength(text, 'utf8')
const sha = (text: string | Buffer) => createHash('sha256').update(text).digest('hex')
/** The detail's revision numbers, oldest first. */
const numbers = (rows: Array<{ revision: number }>) => rows.map(row => row.revision)

/** Revisions 2..count written as rows, as a long history would be, without the publication machinery. */
function insertRevisions(taskId: string, rows: Array<{ direction: string; acceptance: string | null; rationale: string | null; at: string }>) {
  db.transaction(() => {
    rows.forEach((row, index) => {
      db.prepare(`INSERT INTO team_task_revisions (task_id, revision, direction, acceptance, author_kind, author_session, created_at, rationale, notify)
        VALUES (?, ?, ?, ?, 'agent', 'lead', ?, ?, ?)`).run(taskId, index + 2, row.direction, row.acceptance, row.at, row.rationale, index % 2)
    })
    db.prepare('UPDATE team_tasks SET revision = ? WHERE id = ?').run(rows.length + 1, taskId)
  })()
}

/** A snapshot of every stored row a read could change (P4). */
function storedRows(): string {
  const tables = ['team_tasks', 'team_task_revisions', 'team_task_journal', 'team_messages', 'team_task_results', 'team_task_acknowledgements']
  return sha(JSON.stringify(tables.map(table => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())))
}

describe('revision rows (G6)', () => {
  /** Eight revisions: 1 text-only, 2 the first with a contract (later ones carry it), non-ASCII text, null and set acceptance and rationale. */
  function eight() {
    const task = newTask('start é')
    publish(task.id, { direction: 'second €uro', acceptance: 'ok', rationale: 'why — 😀', notify: true }, 1)
    store.publish(task.id, { notify: false, contract, direction: 'third', acceptance: null }, lead, at(2))
    for (let n = 4; n <= 8; n++) publish(task.id, { direction: `v${n} ${'é'.repeat(n)}`, acceptance: n % 2 ? `acc ${n}` : null, rationale: n === 5 ? '' : null, notify: n % 2 === 0 }, n)
    return task.id
  }

  // @covers: team-tasks › task_get revisions are rows › Eight revisions
  test('G6: 8 rows without direction/acceptance keys, with stored UTF-8 byte lengths and the store\'s identity and contract hash per revision', () => {
    const id = eight()
    const whole = store.revisions(id)
    expect(whole).toHaveLength(8)
    const detail = store.journalWindow.agentDetail(id)
    expect(detail.revisions).toHaveLength(8)
    for (const [index, row] of detail.revisions.entries()) {
      const stored = whole[index]!
      expect(Object.keys(row).sort()).toEqual(['acceptanceBytes', 'author', 'contractHash', 'createdAt', 'directionBytes', 'identity', 'notify', 'rationale', 'rationaleBytes', 'rationaleCut', 'revision'])
      expect(row).toEqual({
        revision: stored.revision, identity: stored.identity!, contractHash: stored.contractHash ?? null, author: stored.author, createdAt: stored.createdAt,
        notify: stored.notify ?? null, directionBytes: bytes(stored.direction), acceptanceBytes: bytes(stored.acceptance),
        rationale: stored.rationale ?? null, rationaleBytes: bytes(stored.rationale ?? null), rationaleCut: false,
      })
    }
    // Both kinds are present, and no row reports the current revision's identity.
    expect(detail.revisions.map(row => row.contractHash === null)).toEqual([true, true, false, false, false, false, false, false])
    expect(new Set(detail.revisions.map(row => row.identity)).size).toBe(8)
    expect(detail.revisions[0]!.identity).toMatch(/^r1#[0-9a-f]{12}$/)
    expect(detail.revisions[7]!.identity).toBe(detail.task.identity!)
    expect(detail.revisions[0]!.identity).not.toBe(detail.task.identity!)
    expect(detail.bounds.revisions).toEqual({ total: 8, returned: 8, truncated: false, nextBefore: null })
    expect(detail.revisionText).toBeUndefined()
    // Non-ASCII text: the lengths are bytes, not UTF-16 units.
    expect(detail.revisions[0]!.directionBytes).toBe(Buffer.byteLength('start é'))
    expect(detail.revisions[0]!.directionBytes).not.toBe('start é'.length)
    expect(detail.revisions[1]!.rationaleBytes).toBe(Buffer.byteLength('why — 😀'))
    // A stored empty rationale stays empty, not null; no rationale is null with no bytes.
    expect(detail.revisions[4]).toMatchObject({ rationale: '', rationaleBytes: 0, rationaleCut: false })
    expect(detail.revisions[5]).toMatchObject({ rationale: null, rationaleBytes: 0, rationaleCut: false })
  })

  // @covers: team-tasks › task_get revisions are rows › Long revision history
  test('G6a/G6b: 70 revisions give the newest 50 (21–70) oldest first, then 1–20 before 21', () => {
    const task = newTask()
    insertRevisions(task.id, Array.from({ length: 69 }, (_, i) => ({ direction: `d${i + 2}`, acceptance: null, rationale: null, at: at(i + 1) })))
    const first = store.journalWindow.agentDetail(task.id)
    expect(numbers(first.revisions)).toEqual(Array.from({ length: 50 }, (_, i) => i + 21))
    expect(first.bounds.revisions).toEqual({ total: 70, returned: 50, truncated: true, nextBefore: 21 })
    const second = store.journalWindow.agentDetail(task.id, { revisionsBefore: 21 })
    expect(numbers(second.revisions)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
    expect(second.bounds.revisions).toEqual({ total: 70, returned: 20, truncated: false, nextBefore: null })
    // The current direction is read once, in the task.
    expect(first.task.direction).toBe('d70')
  })

  // @covers: team-tasks › task_get revisions are rows › Unknown revision anchor
  test('G6c: revisions_before 0, 1, 71, 1.5, NaN, and -3 are refused naming the value; 2 and 70 are accepted', () => {
    const task = newTask()
    insertRevisions(task.id, Array.from({ length: 69 }, (_, i) => ({ direction: `d${i + 2}`, acceptance: null, rationale: null, at: at(i + 1) })))
    for (const value of [0, 1, 71, 1.5, Number.NaN, -3]) {
      expect(() => store.journalWindow.agentDetail(task.id, { revisionsBefore: value }), String(value))
        .toThrow(`Unknown revision of this task: ${value}`)
    }
    expect(numbers(store.journalWindow.agentDetail(task.id, { revisionsBefore: 2 }).revisions)).toEqual([1])
    expect(store.journalWindow.agentDetail(task.id, { revisionsBefore: 70 }).revisions).toHaveLength(50)
  })

  // @covers: team-tasks › task_get revisions are rows › Long rationale
  test('G6d: a 5,000-byte rationale is a 2,000-byte preview, cut, with 5,000 bytes; revision returns it whole', () => {
    const task = newTask()
    const long = 'x'.repeat(5000)
    publish(task.id, { direction: 'two', rationale: long }, 1)
    const detail = store.journalWindow.agentDetail(task.id, { revision: 2 })
    expect(detail.revisions[1]).toMatchObject({ rationale: 'x'.repeat(2000), rationaleBytes: 5000, rationaleCut: true })
    expect(detail.revisionText).toEqual({ revision: 2, direction: 'two', acceptance: null, rationale: long })
    // Exactly 2,000 bytes is whole; one more is cut. A 4-byte character across byte 2,000 is dropped whole.
    publish(task.id, { rationale: 'y'.repeat(2000) }, 2)
    publish(task.id, { rationale: 'z'.repeat(1999) + '😀' }, 3)
    const rows = store.journalWindow.agentDetail(task.id).revisions
    expect(rows[2]).toMatchObject({ rationale: 'y'.repeat(2000), rationaleBytes: 2000, rationaleCut: false })
    expect(rows[3]).toMatchObject({ rationale: 'z'.repeat(1999), rationaleBytes: 2003, rationaleCut: true })
  })
})

describe('one revision whole (G7, G8)', () => {
  const history = () => {
    const task = newTask('first')
    publish(task.id, { direction: 'second é', acceptance: 'accept 2', rationale: 'because 2' }, 1)
    publish(task.id, { direction: 'third 😀', acceptance: null, rationale: null }, 2)
    publish(task.id, { direction: 'fourth', rationale: 'because 4' }, 3)
    return task.id
  }

  // @covers: team-tasks › task_get reads one revision whole › Reading an earlier revision
  test('G7: revision 3 returns revision 3\'s stored direction, acceptance, and rationale; others stay rows', () => {
    const id = history()
    const whole = store.revisions(id)
    for (const n of [1, 2, 3, 4]) {
      const detail = store.journalWindow.agentDetail(id, { revision: n })
      const stored = whole[n - 1]!
      expect(detail.revisionText).toEqual({ revision: n, direction: stored.direction, acceptance: stored.acceptance, rationale: stored.rationale ?? null })
      expect(detail.revisions).toHaveLength(4)
      expect(detail.revisions.every(row => !('direction' in row) && !('acceptance' in row))).toBe(true)
    }
    expect(store.journalWindow.agentDetail(id, { revision: 3 }).revisionText).toMatchObject({ direction: 'third 😀', acceptance: null, rationale: null })
  })

  // @covers: team-tasks › task_get reads one revision whole › Unknown revision
  test('G8: revision 0, 5, 1.5, NaN, and -1 are refused naming the value; 1 and the current revision are read', () => {
    const id = history()
    for (const value of [0, 5, 1.5, Number.NaN, -1]) {
      expect(() => store.journalWindow.agentDetail(id, { revision: value }), String(value)).toThrow(`Unknown revision of this task: ${value}`)
    }
    expect(store.journalWindow.agentDetail(id, { revision: 1 }).revisionText!.direction).toBe('first')
    expect(store.journalWindow.agentDetail(id, { revision: 4 }).revisionText!.direction).toBe('fourth')
    // An anchor and a selection together: each is checked on its own, and the anchor still pages.
    const both = store.journalWindow.agentDetail(id, { revisionsBefore: 3, revision: 4 })
    expect(numbers(both.revisions)).toEqual([1, 2])
    expect(both.revisionText!.revision).toBe(4)
  })
})

describe('bounded reads (statements) and unchanged sections', () => {
  const bigHistory = (count: number) => {
    const task = newTask()
    insertRevisions(task.id, Array.from({ length: count - 1 }, (_, i) => ({ direction: `d${i + 2} ${'é'.repeat(40)}`, acceptance: `a${i}`, rationale: `r${i}`, at: at(i + 1) })))
    return task.id
  }

  test('the window and the hashing stay in the SQL limit: no statement returns revision text for more than 50 rows', () => {
    for (const count of [70, 400]) {
      const id = bigHistory(count)
      observer.queries.length = 0
      observer.during(() => store.journalWindow.agentDetail(id))
      const revisionStatements = observer.queries.filter(query => query.sql.includes('FROM team_task_revisions'))
      expect(revisionStatements.length).toBeGreaterThan(0)
      const withText = revisionStatements.filter(query => 'direction' in query.columnBytes || 'acceptance' in query.columnBytes)
      expect(withText).toHaveLength(1)
      expect(withText[0]!.sql).toContain(`ORDER BY revision DESC LIMIT ${REVISION_WINDOW}`)
      expect(withText[0]!.rows).toBe(REVISION_WINDOW)
      // Every other revision statement carries no direction or acceptance, whatever its row count.
      for (const query of revisionStatements.filter(entry => !withText.includes(entry))) {
        expect('direction' in query.columnBytes || 'acceptance' in query.columnBytes).toBe(false)
      }
    }
  })

  test('the rationale preview is projected in SQL: no revision statement returns more than 2,000 rationale bytes', () => {
    const task = newTask()
    publish(task.id, { direction: 'two', rationale: 'é'.repeat(5000) }, 1)
    observer.queries.length = 0
    const detail = observer.during(() => store.journalWindow.agentDetail(task.id))
    expect(detail.revisions[1]).toMatchObject({ rationaleBytes: 10000, rationaleCut: true })
    const preview = observer.queries.find(query => 'rationale_preview' in query.columnBytes)!
    expect(preview.columnBytes.rationale_preview).toBe(2000)
    expect(preview.columnBytes.rationale_bytes ?? 0).toBeLessThan(100)
  })

  // @covers: team-tasks › task_get bounds its growing lists › Human detail stays complete
  test('the human detail keeps every revision whole, and the agent read changes no stored row', () => {
    const id = bigHistory(70)
    const before = storedRows()
    const human = store.humanDetail(id)!
    expect(human.revisions).toHaveLength(70)
    expect(human.revisions[0]!.direction).toBe('d1')
    expect(human.revisions.every(revision => revision.identity !== undefined && typeof revision.direction === 'string')).toBe(true)
    expect('bounds' in human).toBe(false)
    store.journalWindow.agentDetail(id)
    store.journalWindow.agentDetail(id, { revisionsBefore: 30, revision: 5 })
    for (const bad of [0, 71, 1.5]) {
      expect(() => store.journalWindow.agentDetail(id, { revisionsBefore: bad })).toThrow()
      expect(() => store.journalWindow.agentDetail(id, { revision: bad })).toThrow()
    }
    expect(storedRows()).toBe(before)
  })

  test('the non-revision sections of a long-history task equal those of a one-revision read', () => {
    const task = newTask()
    const others = newTask()
    // Everything but the revision rows, their bound, and the task's own revision fields.
    const sections = (id: string) => {
      const { revisions: _rows, revisionText: _text, task: _task, bounds, ...rest } = store.journalWindow.agentDetail(id)
      const { revisions: _bound, ...otherBounds } = bounds
      return { ...rest, bounds: otherBounds }
    }
    insertRevisions(task.id, Array.from({ length: 80 }, (_, i) => ({ direction: `d${i + 2}`, acceptance: null, rationale: null, at: at(i + 1) })))
    expect(sections(task.id)).toEqual(sections(others.id))
  })
})

describe('P3 for revisions: every window pages exactly once', () => {
  const CASES = 200
  /** The first 2,000 bytes of `text`, whole characters only: the independent oracle for a preview. */
  const previewOf = (text: string) => {
    let out = ''
    let size = 0
    for (const char of text) {
      const next = Buffer.byteLength(char, 'utf8')
      if (size + next > 2000) break
      out += char
      size += next
    }
    return out
  }
  const RATIONALES = [() => null, () => 'short why', () => 'x'.repeat(2000), () => 'é'.repeat(1500), () => `${'a'.repeat(1999)}😀tail`, () => '日本語'.repeat(900)]

  // @covers: team-tasks › task_get revisions are rows › Long revision history
  test('P3: seed 0x5AB7, 200 histories of 1–400 revisions with clustered times page each revision once, newest windows first', () => {
    const rand = mulberry32(0x5ab7)
    for (let caseIndex = 0; caseIndex < propertyCases(CASES); caseIndex++) {
      const task = newTask()
      const count = 1 + Math.floor(rand() * 400)
      let second = 0
      const model = Array.from({ length: count - 1 }, (_, i) => {
        second += Math.floor(rand() * 3)
        const rationale = RATIONALES[Math.floor(rand() * RATIONALES.length)]!()
        return { direction: `c${caseIndex}d${i + 2} é`, acceptance: rand() < 0.5 ? null : `a${i}`, rationale, at: at(second) }
      })
      insertRevisions(task.id, model)
      const whole = store.revisions(task.id)
      const expectedRows = (low: number, high: number) => whole.filter(revision => revision.revision >= low && revision.revision <= high)
      const check = (detail: ReturnType<typeof store.journalWindow.agentDetail>, low: number, high: number) => {
        const wanted = expectedRows(low, high)
        expect(numbers(detail.revisions), `case ${caseIndex} ${low}-${high}`).toEqual(wanted.map(revision => revision.revision))
        for (const [index, row] of detail.revisions.entries()) {
          const stored = wanted[index]!
          expect(row.identity).toBe(stored.identity!)
          expect(row.directionBytes).toBe(Buffer.byteLength(stored.direction, 'utf8'))
          expect(row.acceptanceBytes).toBe(bytes(stored.acceptance))
          expect(row.rationaleBytes).toBe(bytes(stored.rationale ?? null))
          expect(row.rationale).toBe(stored.rationale == null ? null : previewOf(stored.rationale))
          expect(row.rationaleCut).toBe(bytes(stored.rationale ?? null) > 2000)
        }
        expect(detail.bounds.revisions.total).toBe(count)
        expect(detail.bounds.revisions.returned).toBe(wanted.length)
        expect(detail.bounds.revisions.truncated).toBe(low > 1)
        expect(detail.bounds.revisions.nextBefore).toBe(low > 1 ? low : null)
      }
      // Walk from the newest window: every revision exactly once, pages move toward older rows.
      const seen: number[] = []
      let before: number | undefined
      for (let guard = 0; guard <= count; guard++) {
        const high = before === undefined ? count : before - 1
        const page = store.journalWindow.agentDetail(task.id, { revisionsBefore: before })
        check(page, Math.max(1, high - REVISION_WINDOW + 1), high)
        seen.unshift(...numbers(page.revisions))
        if (page.bounds.revisions.nextBefore === null) break
        before = page.bounds.revisions.nextBefore
      }
      expect(seen).toEqual(whole.map(revision => revision.revision))
      // Random anchors, valid and not.
      if (count >= 2) {
        const anchor = 2 + Math.floor(rand() * (count - 1))
        check(store.journalWindow.agentDetail(task.id, { revisionsBefore: anchor }), Math.max(1, anchor - REVISION_WINDOW), anchor - 1)
      }
      expect(() => store.journalWindow.agentDetail(task.id, { revisionsBefore: count + 1 })).toThrow(`Unknown revision of this task: ${count + 1}`)
      const chosen = 1 + Math.floor(rand() * count)
      expect(store.journalWindow.agentDetail(task.id, { revision: chosen }).revisionText).toEqual({
        revision: chosen, direction: whole[chosen - 1]!.direction, acceptance: whole[chosen - 1]!.acceptance, rationale: whole[chosen - 1]!.rationale ?? null,
      })
    }
  })
})
