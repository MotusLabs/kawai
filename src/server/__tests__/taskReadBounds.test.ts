// Size, human-detail, and paging properties of the agent's bounded task_get
// (bounded-task-reads G16, G17, P3, P4) at the production reader with the
// real seal. G16's byte budget holds for the deterministic umbrella fixture
// of design.md only — not a live measurement, and no universal response
// bound. G17 compares the human detail with its digest measured on the
// pre-change baseline (1254f41c) from the same fixture builder.
import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import type { AgentTaskDetail } from '../../shared/teamTasks'
import { taskHandlers } from '../team/taskTools'
import type { TaskReadRequest } from '../team/taskReadWindows'
import { agent, useTaskToolHarness } from './taskToolHarness'
import { at, mulberry32, observeQueries, rawNote } from './taskJournalFixture'
import { clearHashedTables, normalizedJson, rawAssignment, rawHolder, rawMessage, rawResult, rawRevisions, storedHash, umbrellaFixture } from './taskReadFixture'
import { propertyCases } from './helpers/propertyCases'

const h = useTaskToolHarness('kawai-read-bounds-')
const read = (taskId: string, request: TaskReadRequest = {}, session = 'dev'): AgentTaskDetail =>
  h.tasks.store.journalWindow.agentDetail(taskId, request, h.results.wholeResultSeal(agent(session), taskId))
/** The human detail's digest for umbrellaFixture, measured at 1254f41c (the pre-change baseline). */
const BASELINE_HUMAN_DETAIL = { sha: '825d7bcdb61d975d0022eb7a1d708c3675b01dca245cb09498d26e26c25e5d19', bytes: 2071769 }
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

describe('the umbrella fixture (G16, G17)', () => {
  // @covers: team-tasks › task_get bounds its growing lists › Umbrella task fits a context
  test('G16: the default read of the deterministic umbrella fixture serializes under 256 KB', () => {
    const task = umbrellaFixture(h.db, h.tasks.store, h.mail, 'team-umbrella')
    // The fixture is what design.md defines.
    const whole = h.tasks.store.detail(task)!
    expect([whole.journal.length, whole.subtasks.length, whole.messages.length, whole.revisions.length, whole.results!.length,
      whole.assignments.length, whole.acknowledgements!.length, whole.publications!.length]).toEqual([1993, 163, 114, 8, 5, 70, 70, 7])
    expect(whole.results!.every(result => Buffer.byteLength(result.diff!) === 307200 && Buffer.byteLength(result.summary) === 32)).toBe(true)
    expect(whole.publications!.every(publication => publication.recipients.length === 1)).toBe(true)
    expect([whole.task.direction, whole.task.acceptance!, whole.task.assignment!.instruction].map(text => Buffer.byteLength(text))).toEqual([128, 128, 128])
    const serialized = JSON.stringify(read(task))
    const bytes = Buffer.byteLength(serialized)
    // Measured 2026-11-17 on this fixture: 149,322 bytes, against 2.07 MB for the whole human detail.
    expect(bytes).toBeLessThan(256 * 1024)
    expect(Buffer.byteLength(JSON.stringify(whole))).toBeGreaterThan(1_500_000)
  })

  // @covers: team-tasks › task_get bounds its growing lists › Human detail stays complete
  test('G17: the human detail of the same task is unchanged — every section whole, equal to the pre-change detail — before and after agent reads', () => {
    const task = umbrellaFixture(h.db, h.tasks.store, h.mail, 'team-umbrella')
    const first = normalizedJson(h.tasks.store.humanDetail(task))
    expect({ sha: sha(first), bytes: first.length }).toEqual(BASELINE_HUMAN_DETAIL)
    read(task, { fullMessages: true, resultId: h.tasks.store.results.listByTask(task).at(-1)!.id })
    expect(() => read(task, { messagesBefore: 'msg-unknown' })).toThrow('Unknown message of this task: msg-unknown')
    expect(normalizedJson(h.tasks.store.humanDetail(task))).toBe(first)
    const human = h.tasks.store.humanDetail(task)!
    expect(human.messages.every(entry => Buffer.byteLength(entry.body) === 32)).toBe(true)
    expect(human.results!.every(result => Buffer.byteLength(result.diff!) === 307200)).toBe(true)
    expect(human.assignments.every(row => Buffer.byteLength(row.instruction) === 128)).toBe(true)
  })
})

// Projection versus derivation (design D5): the window statements themselves take their
// limits and byte projections in SQL; the summary and derived internals (outstanding
// assignment and result) may still read whole rows, and are not asserted here.
test('G16 statements: each window statement returns at most one row past its window and never selects an instruction, a whole body, summary, rationale, or diff', () => {
  const task = umbrellaFixture(h.db, h.tasks.store, h.mail, 'team-umbrella')
  h.db.transaction(() => {
    for (let i = 0; i < 70; i++) rawResult(h.tasks.store, 'team-umbrella', task, 2000 + i, { summary: 's'.repeat(3000), diff: 'd'.repeat(9000) })
    for (let i = 0; i < 70; i++) rawAssignment(h.db, 'team-umbrella', task, 3000 + i, { supersededBy: 'x', instruction: 'i'.repeat(3000) })
    for (let i = 0; i < 70; i++) rawMessage(h.db, h.mail, 'team-umbrella', task, 4000 + i, 'b'.repeat(3000))
  })()
  const observer = observeQueries(h.db)
  observer.during(() => read(task, { resultId: h.tasks.store.results.listByTask(task).at(-1)!.id }))
  const windows: Array<[RegExp, number, string[]]> = [
    [/FROM team_tasks WHERE parent_id = \$task/, 101, ['direction']],
    [/FROM team_messages WHERE task_id = \$taskId/, 51, ['body']],
    [/FROM team_task_results r WHERE task_id = \$task/, 51, ['diff_ref', 'summary', 'coverage']],
    [/FROM team_task_assignments WHERE task_id = \$task/, 51, ['instruction']],
    [/FROM team_task_revisions WHERE task_id = \$task AND revision >= 2/, 51, ['rationale', 'direction']],
    [/FROM team_task_acknowledgements\s+WHERE task_id = \$task/, 51, []],
  ]
  for (const [pattern, most, forbidden] of windows) {
    const found = observer.queries.filter(query => pattern.test(query.sql))
    expect(found.length, String(pattern)).toBeGreaterThanOrEqual(1)
    for (const query of found) {
      expect(query.sql, String(pattern)).toMatch(/LIMIT \$(take|limit)/)
      expect(query.rows, String(pattern)).toBeLessThanOrEqual(most)
      for (const column of forbidden) expect(Object.keys(query.columnBytes), `${String(pattern)} ${column}`).not.toContain(column)
    }
  }
  // Whole bodies on request keep the same 50-row window in SQL.
  const fullRead = observeQueries(h.db)
  fullRead.during(() => read(task, { fullMessages: true }))
  const fullMessages = fullRead.queries.filter(query => /FROM team_messages WHERE task_id = \$taskId/.test(query.sql))
  expect(fullMessages.length).toBeGreaterThanOrEqual(1)
  for (const query of fullMessages) expect(query.rows).toBeLessThanOrEqual(51)
  // The byte projections: previews in SQL, the diff of a whole result at most 8,192 bytes.
  const projected = (column: string) => Math.max(0, ...observer.queries.map(query => query.columnBytes[column] ?? 0))
  expect(projected('kawai_body')).toBe(2000)
  expect(projected('summary_preview')).toBe(2000)
  expect(projected('rationale_preview')).toBe(32)
  expect(projected('kawai_diff')).toBe(8192)
  expect(observer.queries.some(query => /FROM team_task_results WHERE id = \? AND task_id = \?/.test(query.sql) && 'diff_ref' in query.columnBytes)).toBe(false)
})

// P3/I1: seed 0x5AB7, 200 histories of 0–400 rows with tied times; every section pages once, in order.
test('P3: seed 0x5AB7, 200 histories of 0–400 rows with tied times page each unchanged section exactly once in its order, the outstanding result in every read', () => {
  const CASES = 200
  const rand = mulberry32(0x5ab7)
  const sections = ['subtasks', 'messages', 'results', 'assignments', 'publications', 'acknowledgements'] as const
  // The H1 boundaries first, then random sizes.
  const forced = [0, 1, 49, 50, 51, 70, 99, 100, 101, 200]
  for (let c = 0; c < propertyCases(CASES); c++) {
    const section = sections[c % sections.length]!
    const n = c < forced.length * sections.length ? forced[Math.floor(c / sections.length)]! : Math.floor(rand() * 401)
    const tie = 1 + Math.floor(rand() * 8)
    const task = h.tasks.store.create({ teamId: h.team.teamId, title: 'T', direction: 'd', creator: { kind: 'agent', sessionId: 'lead' } }, at(0)).id
    let expected: unknown[] = []
    h.db.transaction(() => {
      if (section === 'subtasks') expected = Array.from({ length: n }, (_, i) => h.tasks.store.create({ teamId: h.team.teamId, title: `c${i}`, direction: 'd', creator: { kind: 'agent', sessionId: 'lead' }, parentId: task }, at(Math.floor(i / tie))).id)
      if (section === 'messages') expected = Array.from({ length: n }, (_, i) => rawMessage(h.db, h.mail, h.team.teamId, task, Math.floor(i / tie)))
      if (section === 'results') expected = Array.from({ length: n }, (_, i) => rawResult(h.tasks.store, h.team.teamId, task, Math.floor(i / tie))).reverse()
      if (section === 'assignments') expected = Array.from({ length: n }, (_, i) => rawAssignment(h.db, h.team.teamId, task, Math.floor(i / tie)))
      if (section === 'publications') { if (n > 0) rawRevisions(h.db, task, 2, n + 1, () => null, rev => Math.floor(rev / tie)); expected = Array.from({ length: n }, (_, i) => i + 2) }
      if (section === 'acknowledgements') {
        expected = Array.from({ length: n }, (_, i) => { h.tasks.store.acknowledgements.record(task, `s${i}`, 1, null, at(Math.floor(i / tie))); return `s${i}` })
      }
    })()
    const key = (row: any) => (section === 'publications' ? row.revision : section === 'acknowledgements' ? row.sessionId : row.id)
    const anchorArg = (next: any): TaskReadRequest => ({
      subtasks: { subtasksBefore: next }, messages: { messagesBefore: next }, results: { resultsBefore: next }, assignments: { assignmentsBefore: next },
      publications: { publicationsBefore: next }, acknowledgements: { acknowledgementsBefore: next },
    })[section]
    const outstanding = section === 'results' && n > 0 ? expected.shift() : undefined
    const pages: unknown[][] = []
    let request: TaskReadRequest = {}
    for (;;) {
      const page = read(task, request)
      const rows = (page[section] as unknown[]).filter((row: any) => section !== 'results' || 'summaryBytes' in row)
      if (section === 'results' && outstanding !== undefined) expect(page.results[0]!.id, `case ${c}`).toBe(outstanding as string)
      expect(rows.length).toBeLessThanOrEqual(section === 'subtasks' ? 100 : 50)
      expect(page.bounds[section].total, `case ${c} total`).toBe(expected.length)
      pages.push(rows.map(key))
      const next = page.bounds[section].nextBefore
      if (next === null) break
      request = anchorArg(next)
    }
    // Results run newest first; every other section is oldest first within a page, pages newest first.
    const walked = section === 'results' ? pages.flat() : [...pages].reverse().flat()
    expect(walked, `case ${c} ${section} n=${n} tie=${tie}`).toEqual(expected)
  }
}, 300_000)

// P4/I2: seed 0xC0DE, 200 fixtures with valid and refused reads change no stored byte and no human detail.
test('P4: seed 0xC0DE, 200 fixtures with valid and refused reads through the handler and the reader leave every stored row and the whole human detail unchanged', async () => {
  const CASES = 200
  const rand = mulberry32(0xc0de)
  const count = (max: number) => Math.floor(rand() * (max + 1))
  for (let c = 0; c < propertyCases(CASES); c++) {
    // Each case starts from empty task tables; otherwise hashing every stored row grows quadratically.
    clearHashedTables(h.db)
    const task = (await h.tasks.create(agent('lead'), { title: 'T', direction: 'd' })).id
    const other = (await h.tasks.create(agent('lead'), { title: 'O', direction: 'd' })).id
    h.db.transaction(() => {
      for (let i = count(60); i > 0; i--) rawNote(h.db, task, `n${i}`, at(i))
      for (let i = count(120); i > 0; i--) h.tasks.store.create({ teamId: h.team.teamId, title: `c${i}`, direction: 'd', creator: { kind: 'agent', sessionId: 'lead' }, parentId: task }, at(i % 7))
      for (let i = count(70); i > 0; i--) rawMessage(h.db, h.mail, h.team.teamId, task, i % 9, 'x'.repeat(count(3000)))
      for (let i = count(60); i > 0; i--) rawResult(h.tasks.store, h.team.teamId, task, i % 5, { diff: 'd'.repeat(count(9000)) })
      for (let i = count(60); i > 0; i--) rawAssignment(h.db, h.team.teamId, task, i % 4)
      rawHolder(h.db, h.mail, h.team.teamId, task, 100)
      const revisions = count(60)
      if (revisions > 1) rawRevisions(h.db, task, 2, revisions, n => 'r'.repeat(n * 50))
      for (let i = count(60); i > 0; i--) h.tasks.store.acknowledgements.record(task, `s${i}`, 1, null, at(i % 3))
    })()
    rawMessage(h.db, h.mail, h.team.teamId, other, 1)
    const baseline = { stored: storedHash(h.db), human: normalizedJson(h.tasks.store.humanDetail(task)) }
    const first = read(task)
    const pick = <T>(items: T[]) => items[Math.floor(rand() * items.length)]
    const foreignResult = rawResult(h.tasks.store, h.team.teamId, other, 1)
    const afterForeign = storedHash(h.db)
    const candidates: Array<Record<string, unknown>> = [
      {}, { full_messages: true }, { subtasks_before: first.bounds.subtasks.nextBefore ?? 'task-x' }, { messages_before: first.bounds.messages.nextBefore ?? 'msg-x' },
      { results_before: first.bounds.results.nextBefore ?? 'result-x' }, { result_id: pick(first.results.map(row => row.id)) ?? foreignResult },
      { assignments_before: first.bounds.assignments.nextBefore ?? 'assignment-x' }, { publications_before: first.bounds.publications.nextBefore ?? 1 },
      { acknowledgements_before: first.bounds.acknowledgements.nextBefore ? { session_id: first.bounds.acknowledgements.nextBefore.sessionId, revision: first.bounds.acknowledgements.nextBefore.revision } : { session_id: 'x', revision: 1 } },
      { result_id: foreignResult }, { messages_before: 'msg-unknown', full_messages: true }, { full_messages: 'yes' }, { publications_before: 'x' }, { subtasks_before: other },
    ]
    for (let r = 0; r < 4; r++) {
      const args = { task_id: task, ...pick(candidates)!, ...(rand() < 0.3 ? pick(candidates) : {}) }
      await taskHandlers(h.tasks, pick(['dev', 'reviewer', 'second'])!, h.results).task_get(args).catch(() => null)
    }
    expect(storedHash(h.db), `case ${c}`).toBe(afterForeign)
    expect(normalizedJson(h.tasks.store.humanDetail(task)), `case ${c} human`).toBe(baseline.human)
    expect(baseline.stored).not.toBe(afterForeign)
  }
}, 300_000)
