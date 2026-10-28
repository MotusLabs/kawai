// The agent's bounded task detail at the store (bounded-log-reads-and-task-get
// D4/D5, rows T1–T4, T7–T13, T15, T16, the store side of T5 and T6, and P3),
// and the known-invalid tails at a cut; the rows through both tool adapters
// are in taskJournalTools.test.ts. Ground truth comes from the insertion
// order and bytes, or from the unbounded loaders the human path keeps.
import { beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { schemaCopy } from './schemaDb'
import { MailboxStore } from '../team/mailboxStore'
import { TaskStore } from '../team/taskStore'
import { JOURNAL_PREVIEW_BYTES, journalPreview, trimIncompleteTail } from '../team/taskJournalWindow'
import { at, mulberry32, observeQueries, rawNote, type ObservedQuery } from './taskJournalFixture'

let db: Database
let mail: MailboxStore
let store: TaskStore
let observer: ReturnType<typeof observeQueries>

beforeEach(() => {
  db?.close()
  db = schemaCopy()
  observer = observeQueries(db)
  mail = new MailboxStore(db)
  store = new TaskStore(db, mail)
})

const newTask = (parentId: string | null = null, seconds = 0) =>
  store.create({ teamId: 'team', title: 'T', direction: 'd', creator: { kind: 'agent', sessionId: 'lead' }, parentId }, at(seconds))
const notes = (taskId: string, count: number, text = (i: number) => `entry ${i}`, time = (i: number) => at(i)) => {
  const ids: string[] = []
  db.transaction(() => { for (let i = 0; i < count; i++) ids.push(rawNote(db, taskId, text(i), time(i))) })()
  return ids
}
const message = (taskId: string, seconds: number) => mail.enqueue({
  teamId: 'team', toKind: 'group', toId: 'devs', fromSession: 'lead', fromGroup: null, originPath: '/repo', body: `m${seconds}`, taskId,
}, at(seconds))
const ids = (rows: Array<{ id: string }>) => rows.map(row => row.id)
const bytes = (...parts: Array<string | number[]>) =>
  Buffer.concat(parts.map(part => typeof part === 'string' ? Buffer.from(part, 'utf8') : Buffer.from(part)))

describe('windows (T1–T4, T11–T13, T15)', () => {
  test('T1: a small task is whole and readable; nothing truncated or cut', () => {
    const task = newTask()
    const written = notes(task.id, 3, i => `note ${i} ${'x'.repeat(600 * i)}`)
    message(task.id, 10)
    const detail = store.journalWindow.agentDetail(task.id)
    expect(ids(detail.journal)).toEqual(written)
    expect(detail.journal.map(entry => entry.text)).toEqual(store.detail(task.id)!.journal.map(entry => entry.text))
    expect(detail.journal.every(entry => !entry.cut && entry.resumeOffsetBytes === entry.totalBytes && entry.previewBytes === entry.totalBytes)).toBe(true)
    expect(detail.subtasks).toEqual([])
    expect(detail.messages.map(row => row.body)).toEqual(['m10'])
    expect(detail.bounds).toEqual({
      journal: { total: 3, returned: 3, olderRemaining: false, nextBefore: null },
      subtasks: { total: 0, returned: 0, truncated: false },
      messages: { total: 1, returned: 1, truncated: false },
    })
  })

  test('T2/T11/T15: 1,198 entries, 149 subtasks, 60 messages give the newest 50, 100, and 50; the human detail stays whole', () => {
    const task = newTask()
    const written = notes(task.id, 1198)
    const children = Array.from({ length: 149 }, (_, i) => newTask(task.id, 10 + i).id)
    const sent = Array.from({ length: 60 }, (_, i) => message(task.id, 100 + i))
    // Any state stays in the window, as forTask selects it.
    mail.claim(sent[59]!.id, 'dev')
    mail.claim(sent[20]!.id, 'dev')
    const detail = store.journalWindow.agentDetail(task.id)
    expect(ids(detail.journal)).toEqual(written.slice(-50))
    expect(detail.bounds.journal).toEqual({ total: 1198, returned: 50, olderRemaining: true, nextBefore: written[1148] })
    expect(ids(detail.subtasks)).toEqual(children.slice(-100))
    expect(detail.bounds.subtasks).toEqual({ total: 149, returned: 100, truncated: true })
    expect(ids(detail.messages)).toEqual(ids(sent.slice(-50)))
    expect(ids(detail.messages)).toEqual(ids(mail.forTask(task.id).slice(-50)))
    expect(detail.messages.at(-1)!.state).toBe('claimed')
    expect(detail.bounds.messages).toEqual({ total: 60, returned: 50, truncated: true })
    // Subtask summaries are the store's own.
    expect(detail.subtasks[0]).toEqual(store.list('team').find(row => row.id === children[49])!)
    // T15: the human detail is untouched.
    const human = store.humanDetail(task.id)!
    expect(ids(human.journal)).toEqual(written)
    expect(ids(human.subtasks)).toEqual(children)
    expect(ids(human.messages)).toEqual(ids(sent))
    expect('bounds' in human).toBe(false)
  })

  test('T3/T4: a window before entry k holds k−100…k−1; before entry 30 it holds 0…29 and ends', () => {
    const task = newTask()
    const written = notes(task.id, 600)
    for (const k of [100, 101, 500]) {
      const page = store.journalWindow.agentDetail(task.id, { journalBefore: written[k], journalLimit: 100 })
      expect(ids(page.journal)).toEqual(written.slice(k - 100, k))
      expect(page.bounds.journal).toEqual({ total: 600, returned: 100, olderRemaining: k - 100 > 0, nextBefore: k - 100 > 0 ? written[k - 100] : null })
    }
    const last = store.journalWindow.agentDetail(task.id, { journalBefore: written[30], journalLimit: 100 })
    expect(ids(last.journal)).toEqual(written.slice(0, 30))
    expect(last.bounds.journal).toEqual({ total: 600, returned: 30, olderRemaining: false, nextBefore: null })
  })

  test('T12: limits 1 and 200 give exact windows; an empty journal gives [] with total 0', () => {
    const task = newTask()
    const written = notes(task.id, 250)
    expect(ids(store.journalWindow.agentDetail(task.id, { journalLimit: 1 }).journal)).toEqual(written.slice(-1))
    const wide = store.journalWindow.agentDetail(task.id, { journalLimit: 200 })
    expect(ids(wide.journal)).toEqual(written.slice(-200))
    expect(wide.bounds.journal).toEqual({ total: 250, returned: 200, olderRemaining: true, nextBefore: written[50] })
    const empty = store.journalWindow.agentDetail(newTask().id)
    expect(empty.journal).toEqual([])
    expect(empty.bounds.journal).toEqual({ total: 0, returned: 0, olderRemaining: false, nextBefore: null })
  })

  test('T13: entries sharing created_at order by rowid with no duplicates or gaps across pages', () => {
    const task = newTask()
    const written = notes(task.id, 23, undefined, i => at(Math.floor(i / 5)))
    const seen: string[][] = []
    let before: string | undefined
    for (;;) {
      const page = store.journalWindow.agentDetail(task.id, { journalBefore: before, journalLimit: 4 })
      seen.unshift(ids(page.journal))
      if (!page.bounds.journal.olderRemaining) break
      before = page.bounds.journal.nextBefore!
    }
    expect(seen.flat()).toEqual(written)
  })
})

describe('anchor and limit refusals (store side of T5–T7)', () => {
  test('T5/T7: an entry of another task, or no entry, is refused naming the id', () => {
    const task = newTask()
    const other = newTask()
    notes(task.id, 3)
    const foreign = notes(other.id, 1)[0]!
    expect(() => store.journalWindow.agentDetail(task.id, { journalBefore: foreign })).toThrow(`Unknown journal entry for this task: ${foreign}`)
    expect(() => store.journalWindow.agentDetail(task.id, { journalBefore: 'note-missing' })).toThrow('Unknown journal entry for this task: note-missing')
  })

  test('T6 (store guard): a limit of 0, 201, or 1.5 is refused naming 1 to 200', () => {
    const task = newTask()
    for (const limit of [0, 201, 1.5]) {
      expect(() => store.journalWindow.agentDetail(task.id, { journalLimit: limit })).toThrow(`journal_limit must be an integer from 1 to 200: ${limit}`)
    }
  })

  test('an unknown task is refused', () => {
    expect(() => store.journalWindow.agentDetail('task-missing')).toThrow('Task not found: task-missing')
  })
})

describe('previews (T8–T10, T16, I-P)', () => {
  const previewOf = (stored: Uint8Array) => {
    const task = newTask()
    const id = rawNote(db, task.id, stored, at(1))
    const entry = store.journalWindow.agentDetail(task.id).journal[0]!
    expect(entry.id).toBe(id)
    return entry
  }

  test('T8: a 5,000-byte ASCII entry previews 2,000 bytes, cut, resuming at 2,000', () => {
    expect(previewOf(bytes('a'.repeat(5000)))).toMatchObject({ text: 'a'.repeat(2000), previewBytes: 2000, totalBytes: 5000, cut: true, resumeOffsetBytes: 2000 })
  })

  test('T9: a four-byte character straddling byte 2,000 is left out; the resume offset is the preview length', () => {
    for (const lead of [1997, 1998, 1999]) {
      const entry = previewOf(bytes('a'.repeat(lead), '😀', 'tail'))
      expect(entry).toMatchObject({ text: 'a'.repeat(lead), previewBytes: lead, cut: true, resumeOffsetBytes: lead, totalBytes: lead + 8 })
    }
    // A character ending exactly at 2,000 is kept whole.
    expect(previewOf(bytes('a'.repeat(1996), '😀', 'tail'))).toMatchObject({ text: `${'a'.repeat(1996)}😀`, previewBytes: 2000, resumeOffsetBytes: 2000 })
  })

  test('T10: invalid UTF-8 within the first 2,000 bytes of a longer entry gives null text and resume 0', () => {
    expect(previewOf(bytes('a'.repeat(10), [0xff], 'b'.repeat(3000)))).toMatchObject({ text: null, resumeOffsetBytes: 0, totalBytes: 3011, cut: true })
    expect(previewOf(bytes('a'.repeat(10), [0x80], 'b'.repeat(10)))).toMatchObject({ text: null, resumeOffsetBytes: 0, totalBytes: 21, cut: false, previewBytes: 21 })
  })

  test('T16: a one-byte FF entry has null text, resume 0, total 1, not cut; its valid sibling stays whole', () => {
    const task = newTask()
    rawNote(db, task.id, bytes([0xff]), at(1))
    rawNote(db, task.id, bytes('valid sibling'), at(2))
    const [ff, sibling] = store.journalWindow.agentDetail(task.id).journal
    expect(ff).toMatchObject({ text: null, resumeOffsetBytes: 0, totalBytes: 1, previewBytes: 1, cut: false })
    expect(sibling).toMatchObject({ text: 'valid sibling', resumeOffsetBytes: 13, totalBytes: 13, cut: false })
  })

  test('NUL and a byte-order mark count as bytes and stay in the text', () => {
    expect(previewOf(bytes([0xef, 0xbb, 0xbf], 'a', [0], 'SUFFIX'))).toMatchObject({ text: '﻿a\u0000SUFFIX', totalBytes: 11, previewBytes: 11, cut: false, resumeOffsetBytes: 11 })
    const empty = previewOf(new Uint8Array(0))
    expect(empty).toMatchObject({ text: '', totalBytes: 0, previewBytes: 0, cut: false, resumeOffsetBytes: 0 })
  })

  test('cut is totalBytes > 2,000: exactly 2,000 bytes is whole, 2,001 is cut', () => {
    expect(journalPreview(JOURNAL_PREVIEW_BYTES, bytes('a'.repeat(2000)))).toMatchObject({ cut: false, resumeOffsetBytes: 2000 })
    expect(journalPreview(JOURNAL_PREVIEW_BYTES + 1, bytes('a'.repeat(2000)))).toMatchObject({ cut: true, resumeOffsetBytes: 2000 })
  })

  test('trimIncompleteTail drops at most an incomplete trailing lead sequence, never to empty', () => {
    expect([...trimIncompleteTail(bytes('ab', [0xe2, 0x82]))]).toEqual([0x61, 0x62])
    expect([...trimIncompleteTail(bytes('ab', [0xf0, 0x9f, 0x98]))]).toEqual([0x61, 0x62])
    expect([...trimIncompleteTail(bytes('ab', [0xe2, 0x82, 0xac]))]).toEqual([0x61, 0x62, 0xe2, 0x82, 0xac])
    expect([...trimIncompleteTail(bytes([0xe2, 0x82]))]).toEqual([0xe2, 0x82])
    expect([...trimIncompleteTail(bytes('a', [0x80, 0x80, 0x80]))]).toEqual([0x61, 0x80, 0x80, 0x80])
  })

  // An invalid lead (FF, C0, C1, F5) or an impossible prefix (E0 80, ED A0,
  // F0 80, F4 90) at a cut stays untrimmed, so the bytes do not decode: the
  // preview is T-invalid and the reader returns the raw chunk. The valid
  // incomplete prefixes beside them are trimmed to the character boundary.
  const INVALID_TAILS = [[0xff], [0xc0], [0xc1], [0xf5], [0xe0, 0x80], [0xed, 0xa0], [0xf0, 0x80], [0xf4, 0x90]]
  const VALID_TAILS = [[0xc2], [0xe0, 0xa0], [0xed, 0x9f], [0xf0, 0x90], [0xf4, 0x8f], [0xf4, 0x8f, 0xbf]]

  // @covers: team-tasks › task_get journal previews are byte-bounded › Invalid bytes in the preview
  test('a known-invalid tail at the 2,000-byte cut is not trimmed: null text and resume 0; valid prefixes are trimmed', () => {
    const task = newTask()
    const previewOf = (tail: number[]) => {
      const id = rawNote(db, task.id, bytes('a'.repeat(JOURNAL_PREVIEW_BYTES - tail.length), tail, 'z'.repeat(100)), at(1))
      return store.journalWindow.agentDetail(task.id).journal.find(entry => entry.id === id)!
    }
    for (const tail of INVALID_TAILS) {
      expect(previewOf(tail)).toMatchObject({ text: null, previewBytes: 2000, totalBytes: 2100, cut: true, resumeOffsetBytes: 0 })
    }
    for (const tail of VALID_TAILS) {
      const kept = 2000 - tail.length
      expect(previewOf(tail)).toMatchObject({ text: 'a'.repeat(kept), previewBytes: kept, totalBytes: 2100, cut: true, resumeOffsetBytes: kept })
    }
  })

  // @covers: team-tasks › task_journal_read returns any entry losslessly › Offset inside a character or invalid bytes
  test('a known-invalid tail at the 8,192-byte chunk end is returned raw with null text; valid prefixes end the chunk before them', () => {
    const task = newTask()
    const chunkOf = (tail: number[]) => {
      const stored = bytes('a'.repeat(8192 - tail.length), tail, 'z'.repeat(100))
      return { stored, chunk: store.journalWindow.readEntry(task.id, rawNote(db, task.id, stored, at(1))) }
    }
    for (const tail of INVALID_TAILS) {
      const { stored, chunk } = chunkOf(tail)
      expect(chunk).toMatchObject({ text: null, returnedBytes: 8192, totalBytes: 8292, nextOffsetBytes: 8192 })
      expect(Buffer.from(chunk.dataBase64, 'base64').equals(stored.subarray(0, 8192))).toBe(true)
    }
    for (const tail of VALID_TAILS) {
      const kept = 8192 - tail.length
      expect(chunkOf(tail).chunk).toMatchObject({ text: 'a'.repeat(kept), returnedBytes: kept, nextOffsetBytes: kept })
    }
  })
})

describe('query observer scopes (C2: M4 and M5)', () => {
  const isListRead = (query: ObservedQuery) =>
    /FROM team_task_journal|FROM team_messages|FROM team_tasks/.test(query.sql) &&
    !/UNION|COUNT\(\*\)/.test(query.sql) && !/WHERE (t\.)?id = |WHERE id = \?/.test(query.sql)

  test('the agent detail runs only the three limited list statements and a journal preview of at most 2,000 raw bytes', () => {
    const task = newTask()
    notes(task.id, 400, i => (i % 7 === 0 ? 'z'.repeat(9000) : `short ${i}`))
    for (let i = 0; i < 130; i++) newTask(task.id, 10 + i)
    for (let i = 0; i < 70; i++) message(task.id, 500 + i)
    observer.queries.length = 0
    observer.during(() => store.journalWindow.agentDetail(task.id, { journalLimit: 120 }))
    const lists = observer.queries.filter(isListRead)
    // Exactly the journal, subtask, and message windows read lists.
    expect(lists).toHaveLength(3)
    const [journal, subtasks, messages] = lists
    expect(journal!.sql).toContain('LIMIT $take')
    expect(journal!.rows).toBe(121)
    expect(subtasks!.sql).toContain('LIMIT 100')
    expect(subtasks!.rows).toBe(100)
    expect(messages!.sql).toContain('LIMIT $limit')
    expect(messages!.rows).toBe(50)
    // M5's scope: the preview column, before any JavaScript trim; no text column at all.
    expect(journal!.columnBytes.preview).toBe(2000)
    expect(Object.keys(journal!.columnBytes)).not.toContain('text')
    for (const query of observer.queries.filter(query => /team_task_journal/.test(query.sql))) {
      expect(query.sql).not.toMatch(/SELECT \*|[ ,]text[ ,]/)
    }
    // M4's scope: no unbounded loader ran.
    const unbounded = observer.queries.filter(query => isListRead(query) && !/LIMIT/.test(query.sql))
    expect(unbounded).toEqual([])
  })

  test('the human detail still runs the unbounded loaders (outside M4)', () => {
    const task = newTask()
    notes(task.id, 3)
    observer.queries.length = 0
    observer.during(() => store.humanDetail(task.id))
    expect(observer.queries.some(query => query.sql === 'SELECT * FROM team_task_journal WHERE task_id = ? ORDER BY created_at, rowid')).toBe(true)
  })
})

// P3 (D5): paging a fixed journal from the newest window returns every entry exactly once, in store order.
test('P3: seed 0x7461736b, 200 journals of 0–600 entries paged with random limits return every id once', () => {
  const rand = mulberry32(0x7461736b)
  for (let caseIndex = 0; caseIndex < 200; caseIndex++) {
    const task = newTask()
    const count = Math.floor(rand() * 601)
    // Timestamps step forward by 0–2 seconds, so runs share a created_at.
    let second = 0
    const times: number[] = []
    for (let i = 0; i < count; i++) { second += Math.floor(rand() * 3); times.push(second) }
    const written = notes(task.id, count, i => `c${caseIndex}e${i}`, i => at(times[i]!))
    const pages: string[][] = []
    let before: string | undefined
    for (let guard = 0; guard <= count + 1; guard++) {
      const page = store.journalWindow.agentDetail(task.id, { journalBefore: before, journalLimit: 1 + Math.floor(rand() * 200) })
      expect(page.bounds.journal.total).toBe(count)
      pages.unshift(ids(page.journal))
      if (!page.bounds.journal.olderRemaining) break
      before = page.bounds.journal.nextBefore!
    }
    expect(pages.flat(), `case ${caseIndex}`).toEqual(written)
  }
})
