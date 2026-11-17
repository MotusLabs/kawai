// The bounded task sections through both registered tool runtimes
// (bounded-task-reads H2, H8): the Claude team MCP server and the Codex
// dynamic-tool dispatch, built from teamToolTable over real services, with
// the blind-first seal applied in the read transaction. Ground truth is the
// stored rows and the stores' own derivations.
import { describe, expect, test } from 'bun:test'
import { agent, useTaskToolHarness } from './taskToolHarness'
import { at } from './taskJournalFixture'
import { bytesOf, rawAssignment, rawMessage, rawResult, rawRevisions, storedHash } from './taskReadFixture'

const h = useTaskToolHarness('kawai-read-tools-')
const newTask = async () => h.tasks.create(agent('lead'), { title: 'Export', direction: 'CSV' })
const message = (taskId: string, seconds: number, body?: string | Uint8Array) => rawMessage(h.db, h.mail, h.team.teamId, taskId, seconds, body)
const coverage = [{ clause: 'A clean export downloads', tests: ['`src/export.test.ts` › `downloads a csv`'] }]
const submit = async (taskId: string, summary = 'r') => (await h.results.submit(agent('dev'), taskId, { summary, commit: 'abc', coverage, tests: [{ description: 't', outcome: 'pass' }] })).id
const child = (parentId: string, seconds: number) =>
  h.tasks.store.create({ teamId: h.team.teamId, title: `child ${seconds}`, direction: 'd'.repeat(2000), creator: { kind: 'agent', sessionId: 'lead' }, parentId }, at(seconds))

for (const { runtime, call } of h.runtimes) {
  describe(`task_get sections through the ${runtime} adapter`, () => {
    // @covers: team-tasks › task_get subtasks are compact rows › Foreign subtask anchor
    test('G1, G2 (each runtime): subtasks are task_list rows with a next anchor, and a foreign or unknown subtask anchor is refused naming it', async () => {
      const task = await newTask()
      const other = await newTask()
      const children = Array.from({ length: 103 }, (_, i) => child(task.id, i).id)
      const foreign = child(other.id, 200).id
      const { error, value } = await call('dev', 'task_get', { task_id: task.id })
      expect(error).toBeNull()
      expect(value.subtasks.map((row: { id: string }) => row.id)).toEqual(children.slice(-100))
      expect(value.subtasks.every((row: Record<string, unknown>) => !('direction' in row) && !('participants' in row) && !('acceptance' in row))).toBe(true)
      const listed = (await call('dev', 'task_list', { status: 'all', limit: 200 })).value.tasks
      expect(value.subtasks[0]).toEqual(listed.find((row: { id: string }) => row.id === children[3]))
      expect(value.bounds.subtasks).toEqual({ total: 103, returned: 100, truncated: true, nextBefore: children[3] })
      for (const anchor of [foreign, 'task-unknown', other.id]) {
        const refused = await call('dev', 'task_get', { task_id: task.id, subtasks_before: anchor })
        expect(refused.value).toBeNull()
        expect(refused.error).toContain(`Unknown subtask of this task: ${anchor}`)
      }
    })

    // @covers: team-tasks › task_get returns full message bodies on request › Non-boolean value
    test('G3, G5, G5a, G5c (each runtime): previews by default, whole bodies with full_messages, a foreign message anchor and a non-boolean full_messages refused', async () => {
      const task = await newTask()
      const other = await newTask()
      const long = message(task.id, 1, 'a'.repeat(6000))
      const foreign = message(other.id, 2)
      const preview = (await call('dev', 'task_get', { task_id: task.id })).value
      expect(preview.messages.find((row: { id: string }) => row.id === long)).toMatchObject({ body: 'a'.repeat(2000), bodyBytes: 6000, bodyCut: true })
      const full = (await call('dev', 'task_get', { task_id: task.id, full_messages: true })).value
      expect(full.messages.find((row: { id: string }) => row.id === long)).toMatchObject({ body: 'a'.repeat(6000), bodyBytes: 6000, bodyCut: false })
      expect({ ...full, messages: null }).toEqual({ ...preview, messages: null })
      expect((await call('dev', 'task_get', { task_id: task.id, messages_before: foreign })).error).toContain(`Unknown message of this task: ${foreign}`)
      for (const value of ['yes', 1, null]) {
        const refused = await call('dev', 'task_get', { task_id: task.id, full_messages: value })
        expect(refused.value).toBeNull()
        expect(refused.error).toContain('full_messages must be a boolean')
      }
    })

    // @covers: team-tasks › task_get lists results as rows › Result anchor not of this task
    // @covers: team-tasks › task_get reads one result whole › Result of another task
    test('G9c, G10, G11, G12 (each runtime): result rows page, result_id reads whole under the real seal, and foreign, outstanding, or unknown result ids are refused naming them', async () => {
      const task = await newTask()
      const other = await newTask()
      const old = await submit(task.id, 'old')
      const current = await submit(task.id, 'current')
      const foreign = await submit(other.id)
      await h.results.handoff(agent('lead'), task.id, { kind: 'review', resultId: current, target: { kind: 'session', id: 'reviewer' }, instructions: 'Review', expectedResponse: null })
      const sealed = (await call('reviewer', 'task_get', { task_id: task.id, result_id: current })).value
      expect(sealed.results[0].coverage).toEqual({ withheld: true, clauses: 1 })
      expect(sealed.resultDetail).toEqual(sealed.results[0])
      expect(sealed.results[1]).toMatchObject({ id: old, summary: 'old', summaryBytes: 3, summaryCut: false })
      expect('coverage' in sealed.results[1]).toBe(false)
      const selected = (await call('reviewer', 'task_get', { task_id: task.id, result_id: old })).value.resultDetail
      expect(selected).toMatchObject({ id: old, summary: 'old', coverage: { withheld: true, clauses: 1 }, diff: null, diffBytes: 0 })
      expect((await call('dev', 'task_get', { task_id: task.id, result_id: old })).value.resultDetail.coverage).toEqual(coverage)
      for (const id of [foreign, 'result-unknown']) expect((await call('dev', 'task_get', { task_id: task.id, result_id: id })).error).toContain(`Unknown result of this task: ${id}`)
      for (const id of [current, foreign, 'result-unknown']) expect((await call('dev', 'task_get', { task_id: task.id, results_before: id })).error).toContain(`Unknown result of this task: ${id}`)
    })

    // @covers: team-tasks › Remaining task histories have continuation anchors › Invalid history anchors
    test('H2 (each runtime): a bad anchor among valid arguments, wrong anchor types, and forged extra arguments refuse or are stripped, and no stored row changes', async () => {
      const task = await newTask()
      rawRevisions(h.db, task.id, 2, 4)
      const mine = rawAssignment(h.db, h.team.teamId, task.id, 1)
      h.tasks.store.acknowledgements.record(task.id, 'dev', 2, null, at(3))
      const valid = { task_id: task.id, assignments_before: mine, publications_before: 3, acknowledgements_before: { session_id: 'dev', revision: 2 }, full_messages: false }
      expect((await call('dev', 'task_get', valid)).error).toBeNull()
      const before = storedHash(h.db)
      const refusals: Array<[Record<string, unknown>, string]> = [
        [{ assignments_before: 'assignment-unknown' }, 'Unknown assignment of this task: assignment-unknown'],
        [{ assignments_before: 7 }, 'assignments_before must be an id string'],
        [{ subtasks_before: 7 }, 'subtasks_before must be an id string'],
        [{ messages_before: null }, 'messages_before must be an id string'],
        [{ results_before: ['r'] }, 'results_before must be an id string'],
        [{ result_id: 1 }, 'result_id must be an id string'],
        [{ publications_before: 9 }, 'Unknown publication of this task: 9'],
        [{ publications_before: '3' }, 'Unknown publication of this task: 3'],
        [{ acknowledgements_before: { session_id: 'dev', revision: 4 } }, 'Unknown acknowledgement of this task: dev revision 4'],
        [{ acknowledgements_before: 'dev' }, 'acknowledgements_before must be { session_id, revision }'],
        [{ acknowledgements_before: { session_id: 'dev' } }, 'acknowledgements_before must be { session_id, revision }'],
      ]
      for (const [bad, error] of refusals) {
        const refused = await call('dev', 'task_get', { ...valid, ...bad })
        expect(refused.value, JSON.stringify(bad)).toBeNull()
        expect(refused.error).toContain(error)
      }
      // A forged caller or team never reaches the service: another team's session still reads nothing.
      const forged = { session_id: 'dev', sessionId: 'dev', caller: { kind: 'human' }, team_id: h.team.teamId }
      expect((await call('stranger', 'task_get', { ...valid, ...forged })).error).toContain(`Task not found in this team: ${task.id}`)
      expect(storedHash(h.db)).toBe(before)
    })
  })

  describe(`task_result_diff_read through the ${runtime} adapter`, () => {
    test('G13a, G13c, G13c2, G13d, G13f (each runtime): a diff reads losslessly from the whole result\'s resume offset; bad offsets, a foreign result, and another team are refused', async () => {
      const task = await newTask()
      const other = await newTask()
      const stored = bytesOf('a'.repeat(9000), '€', [0xff], 'tail')
      const id = rawResult(h.tasks.store, h.team.teamId, task.id, 1, { diff: stored, commit: null })
      const foreign = rawResult(h.tasks.store, h.team.teamId, other.id, 2, { diff: 'x' })
      const whole = (await call('dev', 'task_get', { task_id: task.id })).value.results[0]
      expect(whole).toMatchObject({ diffBytes: stored.length, diffCut: true, diffResumeOffsetBytes: 8192 })
      const chunks = [Buffer.from(whole.diff, 'utf8')]
      let next: number | null = whole.diffResumeOffsetBytes
      while (next !== null) {
        const chunk: any = (await call('dev', 'task_result_diff_read', { task_id: task.id, result_id: id, offset_bytes: next })).value
        chunks.push(Buffer.from(chunk.dataBase64, 'base64'))
        next = chunk.nextOffsetBytes
      }
      expect(Buffer.concat(chunks).equals(stored)).toBe(true)
      expect((await call('dev', 'task_result_diff_read', { task_id: task.id, result_id: id, offset_bytes: stored.length })).value)
        .toMatchObject({ returnedBytes: 0, dataBase64: '', nextOffsetBytes: null })
      for (const offset of [-1, 1.5, '0']) {
        expect((await call('dev', 'task_result_diff_read', { task_id: task.id, result_id: id, offset_bytes: offset })).error).toContain('offset_bytes must be a safe non-negative integer')
      }
      expect((await call('dev', 'task_result_diff_read', { task_id: task.id, result_id: id, offset_bytes: stored.length + 1 })).error)
        .toContain(`offset_bytes ${stored.length + 1} is beyond the diff's ${stored.length} bytes`)
      expect((await call('dev', 'task_result_diff_read', { task_id: task.id, result_id: foreign })).error).toContain(`Result not found for this task: ${foreign}`)
      expect((await call('stranger', 'task_result_diff_read', { task_id: task.id, result_id: id })).error).toContain(`Task not found in this team: ${task.id}`)
      const noDiff = await submit(task.id)
      expect((await call('dev', 'task_result_diff_read', { task_id: task.id, result_id: noDiff })).value)
        .toEqual({ resultId: noDiff, offsetBytes: 0, totalBytes: 0, returnedBytes: 0, dataBase64: '', text: '', nextOffsetBytes: null })
    })
  })
}

describe('descriptions and the shared catalogue (H8)', () => {
  test('H8: task_get and task_result_diff_read describe every section anchor, whole-read route, unbounded exception, and the old catalogue limitation, and both runtimes serve it', async () => {
    const { teamToolTable } = await import('../team/mailboxTools')
    const table = teamToolTable(h.mailbox, 'dev', { tasks: h.tasks, results: h.results })
    const text = (name: string) => table.find(tool => tool.name === name)!.description
    for (const term of ['subtasks_before', 'messages_before', 'full_messages', 'results_before', 'result_id', 'resultDetail', 'task_result_diff_read',
      'diffResumeOffsetBytes', 'assignments_before', 'publications_before', 'acknowledgements_before', 'bodyBytes', 'bodyCut', 'summaryCut', 'diffCut',
      'journal_before', 'journal_limit', 'task_journal_read', 'revisions_before', 'revision (an integer', 'Not byte-bounded', 'potentially large',
      'keeps its original catalogue']) {
      expect(text('task_get')).toContain(term)
    }
    for (const term of ['8,192 stored bytes', 'dataBase64', 'authoritative', 'diffResumeOffsetBytes', 'nextOffsetBytes', 'Read-only']) expect(text('task_result_diff_read')).toContain(term)
    for (const name of ['task_get', 'task_result_diff_read']) expect(text(name)).not.toMatch(/whole journal|full journal/)
    for (const { call } of h.runtimes) expect((await call('dev', 'task_get', { task_id: (await newTask()).id })).error).toBeNull()
  })
})
