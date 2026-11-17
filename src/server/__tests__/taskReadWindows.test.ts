// The child, message, and history windows of the agent's task_get at the
// production reader (bounded-task-reads D5, D6, D9, D10): rows G1, G3–G5b,
// G14, G15, H1, H2, H4, and H6 for bodies and rationales, through
// TaskStore.journalWindow.agentDetail over real stores and services, with the
// real seal. The same sections through both tool runtimes are in
// taskReadTools.test.ts. Ground truth is the insertion order and the stored
// bytes.
import { describe, expect, test } from 'bun:test'
import type { AgentTaskDetail } from '../../shared/teamTasks'
import type { TaskReadRequest } from '../team/taskReadWindows'
import { agent, useTaskToolHarness } from './taskToolHarness'
import { at } from './taskJournalFixture'
import { bytesOf, rawAssignment, rawHolder, rawMessage, rawResult, rawRevisions, storedHash } from './taskReadFixture'

const h = useTaskToolHarness('kawai-read-windows-')
const newTask = (direction = 'CSV') => h.tasks.store.create({ teamId: h.team.teamId, title: 'Export', direction, creator: { kind: 'agent', sessionId: 'lead' } }, at(0))
const read = (taskId: string, request: TaskReadRequest = {}, session = 'dev'): AgentTaskDetail =>
  h.tasks.store.journalWindow.agentDetail(taskId, request, h.results.wholeResultSeal(agent(session), taskId))
const ids = (rows: Array<{ id: string }>) => rows.map(row => row.id)
const message = (taskId: string, seconds: number, body?: string | Uint8Array) => rawMessage(h.db, h.mail, h.team.teamId, taskId, seconds, body)
const child = (parentId: string, seconds: number, direction = 'd') =>
  h.tasks.store.create({ teamId: h.team.teamId, title: `child ${seconds}`, direction, creator: { kind: 'agent', sessionId: 'lead' }, parentId }, at(seconds)).id

/** Every page of one oldest-first section from the default read, following its anchor; pages come back newest page first. */
function walk<K>(taskId: string, section: 'subtasks' | 'messages' | 'assignments' | 'publications' | 'acknowledgements',
  anchorOf: (key: K) => TaskReadRequest, base: TaskReadRequest = {}): AgentTaskDetail[] {
  const pages: AgentTaskDetail[] = []
  let request: TaskReadRequest = base
  for (;;) {
    const page = read(taskId, request)
    pages.push(page)
    const next = page.bounds[section].nextBefore as K | null
    if (next === null) return pages
    request = { ...base, ...anchorOf(next) }
  }
}

describe('subtasks (D5)', () => {
  // @covers: team-tasks › task_get subtasks are compact rows › Umbrella task subtasks
  test('G1: 163 subtasks whose directions total 336 KB read as the newest 100 task_list rows with no direction text, total 163, truncated, and a next anchor', () => {
    const task = newTask()
    // Clustered creation times: runs of four subtasks share a timestamp.
    const children = Array.from({ length: 163 }, (_, i) => child(task.id, 10 + Math.floor(i / 4), `${i} `.padEnd(2062, 'x')))
    expect(h.tasks.store.detail(task.id)!.subtasks.reduce((sum, row) => sum + Buffer.byteLength(row.direction), 0)).toBe(163 * 2062)
    // Some subtasks carry an outstanding result and an assignment, so the derived assignee and result matter.
    for (const id of children.slice(150, 153)) {
      rawResult(h.tasks.store, h.team.teamId, id, 5000)
      rawHolder(h.db, h.mail, h.team.teamId, id, 5000)
    }
    const detail = read(task.id)
    expect(detail.subtasks.filter(row => row.result !== null && row.assignee !== null)).toHaveLength(3)
    expect(ids(detail.subtasks)).toEqual(children.slice(-100))
    expect(JSON.stringify(detail.subtasks)).not.toContain('xxxxxxxx')
    expect(detail.subtasks.every(row => !('direction' in row) && !('acceptance' in row) && !('participants' in row) && !('assignment' in row))).toBe(true)
    const listed = h.tasks.store.listWindow.agentList(h.team.teamId, { status: 'all', limit: 200 }).tasks
    for (const row of detail.subtasks) expect(row).toEqual(listed.find(entry => entry.id === row.id)!)
    expect(detail.bounds.subtasks).toEqual({ total: 163, returned: 100, truncated: true, nextBefore: children[63] })
  })

  // @covers: team-tasks › task_get subtasks are compact rows › Paging subtasks to the end
  test('G1 walk: paging with each read\'s subtasks anchor returns every subtask of the unchanged task once, ties included, and ends with a null anchor', () => {
    const task = newTask()
    const children = Array.from({ length: 163 }, (_, i) => child(task.id, 10 + Math.floor(i / 7)))
    const pages = walk<string>(task.id, 'subtasks', id => ({ subtasksBefore: id }))
    expect(pages.map(page => page.subtasks.length)).toEqual([100, 63])
    expect(pages.reverse().flatMap(page => ids(page.subtasks))).toEqual(children)
    expect(pages[0]!.bounds.subtasks).toEqual({ total: 163, returned: 63, truncated: false, nextBefore: null })
  })

  test('G2 (store): a subtask of another parent, the task itself, and an unknown id are refused naming the id', () => {
    const task = newTask()
    const other = newTask()
    child(task.id, 1)
    const foreign = child(other.id, 2)
    for (const anchor of [foreign, task.id, 'task-unknown', '']) expect(() => read(task.id, { subtasksBefore: anchor })).toThrow(`Unknown subtask of this task: ${anchor}`)
  })
})

describe('message previews and full bodies (D6)', () => {
  // @covers: team-tasks › task_get message bodies are previews › Long instruction mail
  // @covers: team-tasks › task_get returns full message bodies on request › Default stays a preview
  test('G3, G4: a 6,000-byte ASCII body previews its first 2,000 bytes, cut; a 4-byte character straddling byte 2,000 ends the preview before it', () => {
    const task = newTask()
    const long = message(task.id, 1, 'a'.repeat(6000))
    const straddle = message(task.id, 2, bytesOf('b'.repeat(1998), '😀', 'tail'))
    const short = message(task.id, 3, 'short')
    const byId = new Map(read(task.id).messages.map(row => [row.id, row]))
    expect(byId.get(long)).toMatchObject({ body: 'a'.repeat(2000), bodyBytes: 6000, bodyCut: true })
    expect(byId.get(straddle)).toMatchObject({ body: 'b'.repeat(1998), bodyBytes: 2006, bodyCut: true })
    expect(byId.get(short)).toMatchObject({ body: 'short', bodyBytes: 5, bodyCut: false })
    // Every other message field is the store's own.
    const { body: _body, bodyBytes: _bytes, bodyCut: _cut, ...rest } = byId.get(short)!
    const { body: _storedBody, ...stored } = h.mail.get(short)!
    expect(rest).toEqual(stored)
  })

  // @covers: team-tasks › task_get returns full message bodies on request › Asking for full bodies
  test('G5a: full_messages returns the whole 6,000 bytes, not cut, and every other section deep-equals the default read', () => {
    const task = newTask()
    const long = message(task.id, 1, 'a'.repeat(6000))
    child(task.id, 2)
    const preview = read(task.id)
    const full = read(task.id, { fullMessages: true })
    expect(full.messages.find(row => row.id === long)).toMatchObject({ body: 'a'.repeat(6000), bodyBytes: 6000, bodyCut: false })
    const { messages: _full, ...fullRest } = full
    const { messages: _preview, ...previewRest } = preview
    expect(fullRest).toEqual(previewRest)
    expect(ids(full.messages)).toEqual(ids(preview.messages))
  })

  // @covers: team-tasks › task_get message bodies are previews › Paging messages to the end
  // @covers: team-tasks › task_get returns full message bodies on request › Full bodies while paging
  test('G5b: 114 messages page to the end once each, and a full_messages walk holds the same ids per page with each stored body whole', () => {
    const task = newTask()
    const bodies = Array.from({ length: 114 }, (_, i) => `${i}:${'é'.repeat(i * 13)}`)
    const sent = bodies.map((body, i) => message(task.id, Math.floor(i / 3), body))
    const plain = walk<string>(task.id, 'messages', id => ({ messagesBefore: id }))
    const full = walk<string>(task.id, 'messages', id => ({ messagesBefore: id }), { fullMessages: true })
    expect(plain.map(page => ids(page.messages))).toEqual(full.map(page => ids(page.messages)))
    expect([...plain].reverse().flatMap(page => ids(page.messages))).toEqual(sent)
    expect(plain.map(page => page.bounds.messages.total)).toEqual([114, 114, 114])
    const wholeBodies = [...full].reverse().flatMap(page => page.messages.map(row => row.body))
    expect(wholeBodies).toEqual(bodies)
    expect([...full].reverse().flatMap(page => page.messages).every(row => !row.bodyCut && row.bodyBytes === Buffer.byteLength(row.body!))).toBe(true)
  })

  test('G5 (store): a message of another task, or no message, is refused naming the id, with or without full_messages', () => {
    const task = newTask()
    const other = newTask()
    message(task.id, 1)
    const foreign = message(other.id, 2)
    for (const fullMessages of [false, true]) {
      for (const anchor of [foreign, 'msg-unknown']) expect(() => read(task.id, { messagesBefore: anchor, fullMessages })).toThrow(`Unknown message of this task: ${anchor}`)
    }
  })

  test('H6 (bodies): exact byte metadata at 1,999/2,000/2,001, invalid bytes read null, BOM and NUL kept, never replacement decoding', () => {
    const task = newTask()
    const cases = [
      { body: bytesOf('a'.repeat(1999)), text: 'a'.repeat(1999), cut: false },
      { body: bytesOf('a'.repeat(2000)), text: 'a'.repeat(2000), cut: false },
      { body: bytesOf('a'.repeat(2001)), text: 'a'.repeat(2000), cut: true },
      { body: bytesOf('﻿bom\u0000nul'), text: '﻿bom\u0000nul', cut: false },
      { body: bytesOf('ok', [0xff], 'tail'), text: null, cut: false },
      { body: bytesOf('c'.repeat(1990), [0xc3], 'd'.repeat(20)), text: null, cut: true },
      { body: bytesOf('e'.repeat(1999), '€'), text: 'e'.repeat(1999), cut: true },
    ]
    const sent = cases.map((entry, i) => message(task.id, i, entry.body))
    const rows = new Map(read(task.id).messages.map(row => [row.id, row]))
    const full = new Map(read(task.id, { fullMessages: true }).messages.map(row => [row.id, row]))
    cases.forEach((entry, i) => {
      expect(rows.get(sent[i]!)).toMatchObject({ body: entry.text, bodyBytes: entry.body.length, bodyCut: entry.cut })
      // Whole bodies decode exactly or read null: the invalid ones stay null in full mode too.
      expect(full.get(sent[i]!)!.body).toBe(entry.text === null ? null : entry.body.toString('utf8'))
    })
    expect(JSON.stringify([...rows.values()])).not.toContain('�')
  })
})

describe('assignment, publication, and acknowledgement windows (D9)', () => {
  // @covers: team-tasks › task_get assignment history is compact › Instruction appears once
  test('G14: an outstanding assignment and three superseded ones — the instruction rides task.assignment once, and no history row carries one', () => {
    const task = newTask()
    const old = Array.from({ length: 3 }, (_, i) => rawAssignment(h.db, h.team.teamId, task.id, i, { instruction: `old ${i}`, supersededBy: 'later' }))
    const current = rawHolder(h.db, h.mail, h.team.teamId, task.id, 10, 'dev', 'the current instruction '.repeat(200))
    const detail = read(task.id)
    expect(ids(detail.assignments)).toEqual([...old, current])
    expect(detail.assignments.every(row => !('instruction' in row))).toBe(true)
    expect(detail.task.assignment).toMatchObject({ id: current, instruction: 'the current instruction '.repeat(200) })
    // Each row is the store's own assignment, less the instruction.
    const whole = h.tasks.store.assignmentsOf(task.id)
    expect(detail.assignments).toEqual(whole.map(({ instruction: _instruction, ...row }) => row))
    expect(detail.bounds.assignments).toEqual({ total: 4, returned: 4, truncated: false, nextBefore: null })
  })

  // @covers: team-tasks › task_get assignment history is compact › Long publication history
  test('G15: 70 acknowledgements read as the newest 50, total 70, truncated', () => {
    const task = newTask()
    rawRevisions(h.db, task.id, 2, 8)
    const written: Array<{ sessionId: string; revision: number }> = []
    for (let s = 0; s < 9; s++) {
      for (let revision = 1; revision <= (s === 8 ? 6 : 8); revision++) {
        h.tasks.store.acknowledgements.record(task.id, `session-${s}`, revision, null, at(100 + Math.floor(written.length / 5)))
        written.push({ sessionId: `session-${s}`, revision })
      }
    }
    expect(written).toHaveLength(70)
    const detail = read(task.id)
    expect(detail.acknowledgements.map(row => ({ sessionId: row.sessionId, revision: row.revision }))).toEqual(written.slice(-50))
    expect(detail.bounds.acknowledgements).toEqual({ total: 70, returned: 50, truncated: true, nextBefore: written[20] })
    expect(detail.acknowledgements.every(row => row.assignmentId === null)).toBe(true)
  })

  // @covers: team-tasks › Remaining task histories have continuation anchors › Histories remain reachable
  test('H1: 0, 1, 49, 50, 51, and 70 assignments, publications, and acknowledgements with tied times page newest 50 then the rest, each row once, last nextBefore null', () => {
    for (const n of [0, 1, 49, 50, 51, 70]) {
      const task = newTask()
      const assignments = Array.from({ length: n }, (_, i) => rawAssignment(h.db, h.team.teamId, task.id, Math.floor(i / 6), { instruction: `secret ${i}` }))
      rawHolder(h.db, h.mail, h.team.teamId, task.id, 1000)
      // A publication count n needs n + 1 revisions; rationales run past the preview.
      if (n > 0) rawRevisions(h.db, task.id, 2, n + 1, rev => `${rev}:${'r'.repeat(2100)}`, rev => Math.floor(rev / 4))
      const acks = Array.from({ length: n }, (_, i) => {
        h.tasks.store.acknowledgements.record(task.id, `s${i}`, 1, null, at(Math.floor(i / 6)))
        return { sessionId: `s${i}`, revision: 1 }
      })
      const assignmentPages = walk<string>(task.id, 'assignments', id => ({ assignmentsBefore: id }))
      const walked = [...assignmentPages].reverse().flatMap(page => ids(page.assignments))
      expect(walked).toEqual([...assignments, ids(h.tasks.store.assignmentsOf(task.id)).at(-1)!])
      expect(assignmentPages[0]!.bounds.assignments.total).toBe(n + 1)
      expect(JSON.stringify(assignmentPages.map(page => page.assignments))).not.toContain('secret')
      const publicationPages = walk<number>(task.id, 'publications', revision => ({ publicationsBefore: revision }))
      const revisions = [...publicationPages].reverse().flatMap(page => page.publications.map(row => row.revision))
      expect(revisions).toEqual(Array.from({ length: n }, (_, i) => i + 2))
      expect(publicationPages[0]!.publications.length).toBe(Math.min(n, 50))
      for (const row of publicationPages.flatMap(page => page.publications)) {
        expect(row).toMatchObject({ rationale: `${row.revision}:${'r'.repeat(2100)}`.slice(0, 2000), rationaleCut: true, rationaleBytes: `${row.revision}:`.length + 2100 })
        expect(row.recipients).toHaveLength(1)
      }
      const ackPages = walk<{ sessionId: string; revision: number }>(task.id, 'acknowledgements', key => ({ acknowledgementsBefore: key }))
      expect([...ackPages].reverse().flatMap(page => page.acknowledgements.map(row => ({ sessionId: row.sessionId, revision: row.revision })))).toEqual(acks)
      // Newest 50 first, then the rest: one page up to 50 rows, two past it (the holder is the 71st assignment).
      expect([assignmentPages.length, publicationPages.length, ackPages.length]).toEqual([n + 1 > 50 ? 2 : 1, n > 50 ? 2 : 1, n > 50 ? 2 : 1])
      expect(ackPages[0]!.bounds.acknowledgements).toEqual({ total: n, returned: Math.min(n, 50), truncated: n > 50, nextBefore: n > 50 ? acks[n - 50] : null })
    }
  })

  // @covers: team-tasks › Remaining task histories have continuation anchors › Invalid history anchors
  test('H2 (store): unknown, malformed, and foreign history anchors — alone or beside valid arguments — are refused naming the anchor, and no stored row changes', () => {
    const task = newTask()
    const other = newTask()
    rawRevisions(h.db, task.id, 2, 4)
    rawRevisions(h.db, other.id, 2, 6)
    const mine = rawAssignment(h.db, h.team.teamId, task.id, 1)
    const foreignAssignment = rawAssignment(h.db, h.team.teamId, other.id, 2)
    h.tasks.store.acknowledgements.record(task.id, 'dev', 2, null, at(3))
    h.tasks.store.acknowledgements.record(other.id, 'dev', 3, null, at(4))
    const valid: TaskReadRequest = { assignmentsBefore: mine, publicationsBefore: 3, acknowledgementsBefore: { sessionId: 'dev', revision: 2 } }
    const before = storedHash(h.db)
    const refusals: Array<[TaskReadRequest, string]> = [
      [{ assignmentsBefore: foreignAssignment }, `Unknown assignment of this task: ${foreignAssignment}`],
      [{ assignmentsBefore: 'assignment-unknown' }, 'Unknown assignment of this task: assignment-unknown'],
      [{ publicationsBefore: 1 }, 'Unknown publication of this task: 1'],
      [{ publicationsBefore: 5 }, 'Unknown publication of this task: 5'],
      [{ publicationsBefore: 2.5 }, 'Unknown publication of this task: 2.5'],
      [{ acknowledgementsBefore: { sessionId: 'dev', revision: 3 } }, 'Unknown acknowledgement of this task: dev revision 3'],
      [{ acknowledgementsBefore: { sessionId: 'ghost', revision: 2 } }, 'Unknown acknowledgement of this task: ghost revision 2'],
      [{ acknowledgementsBefore: { sessionId: 'dev', revision: 2.5 } }, 'Unknown acknowledgement of this task: dev revision 2.5'],
    ]
    for (const [bad, error] of refusals) {
      expect(() => read(task.id, bad)).toThrow(error)
      // One bad anchor among valid arguments refuses the whole read.
      expect(() => read(task.id, { ...valid, ...bad })).toThrow(error)
    }
    expect(read(task.id, valid).bounds.assignments.returned).toBe(0)
    expect(storedHash(h.db)).toBe(before)
  })

  // @covers: team-tasks › Task read identities survive paging and concurrent writes › New activity between pages
  test('H4: mail, assignments, publications, and acknowledgements written after the first page never enter older pages; totals are the current read\'s', () => {
    const task = newTask()
    const sent = Array.from({ length: 60 }, (_, i) => message(task.id, i))
    const assignments = Array.from({ length: 60 }, (_, i) => rawAssignment(h.db, h.team.teamId, task.id, i))
    rawRevisions(h.db, task.id, 2, 61)
    for (let i = 0; i < 60; i++) h.tasks.store.acknowledgements.record(task.id, `s${i}`, 1, null, at(i))
    const first = read(task.id)
    // New activity, newer than everything (and one tied with the anchor's time).
    const later = [message(task.id, 500), message(task.id, 10)]
    rawAssignment(h.db, h.team.teamId, task.id, 500)
    rawRevisions(h.db, task.id, 62, 62, () => 'new', () => 500)
    h.tasks.store.acknowledgements.record(task.id, 'late', 1, null, at(500))
    const second = read(task.id, {
      messagesBefore: first.bounds.messages.nextBefore!, assignmentsBefore: first.bounds.assignments.nextBefore!,
      publicationsBefore: first.bounds.publications.nextBefore!, acknowledgementsBefore: first.bounds.acknowledgements.nextBefore!,
    })
    expect(ids(second.messages)).toEqual(sent.slice(0, 10))
    expect(ids(second.messages)).not.toContain(later[0])
    expect(ids(second.assignments)).toEqual(assignments.slice(0, 10))
    expect(second.publications.map(row => row.revision)).toEqual(Array.from({ length: 10 }, (_, i) => i + 2))
    expect(second.acknowledgements.map(row => row.sessionId)).toEqual(Array.from({ length: 10 }, (_, i) => `s${i}`))
    expect(second.bounds.messages.total).toBe(62)
    expect(second.bounds.assignments.total).toBe(61)
    expect(second.bounds.publications.total).toBe(61)
    expect(second.bounds.acknowledgements.total).toBe(61)
    expect(second.task.revision).toBe(62)
  })
})
