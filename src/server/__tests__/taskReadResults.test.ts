// The result section of the agent's task_get at the production reader
// (bounded-task-reads D8, D10): rows G9–G13g, H3, H5, H6 for summaries and
// diffs, H7, and P6, through TaskStore.journalWindow.agentDetail with the
// real TaskResultService seal, against the existing seal applied to the
// whole store detail (the authorized reader view). Ground truth is the
// stored results and their submission pins.
import { describe, expect, test } from 'bun:test'
import type { AgentResultRow, AgentTaskDetail, AgentWholeResult, TaskResult } from '../../shared/teamTasks'
import type { TaskReadRequest } from '../team/taskReadWindows'
import { agent, useTaskToolHarness } from './taskToolHarness'
import { at, mulberry32 } from './taskJournalFixture'
import { bytesOf, rawResult } from './taskReadFixture'
import { propertyCases } from './helpers/propertyCases'

const h = useTaskToolHarness('kawai-read-results-')
const newTask = async () => h.tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })
const read = (taskId: string, request: TaskReadRequest = {}, session = 'dev'): AgentTaskDetail =>
  h.tasks.store.journalWindow.agentDetail(taskId, request, h.results.wholeResultSeal(agent(session), taskId))
const result = (taskId: string, seconds: number, fields: Parameters<typeof rawResult>[4] = {}) => rawResult(h.tasks.store, h.team.teamId, taskId, seconds, fields)
const isRow = (entry: AgentWholeResult | AgentResultRow): entry is AgentResultRow => !('findings' in entry)
const coverage = [{ clause: 'A clean export downloads', tests: ['`src/export.test.ts` › `downloads a csv`'] }]
const submit = async (taskId: string, summary = 'r') => (await h.results.submit(agent('dev'), taskId, { summary, commit: 'abc', coverage, tests: [{ description: 't', outcome: 'pass' }] })).id
const review = (taskId: string, resultId: string, session = 'reviewer') =>
  h.results.handoff(agent('lead'), taskId, { kind: 'review', resultId, target: { kind: 'session', id: session }, instructions: 'Review', expectedResponse: null })
/** The authorized reader view of one result: the existing seal over the whole store detail, less the diff. */
function authorized(session: string, taskId: string, id: string): Omit<TaskResult, 'diff'> {
  const { diff: _diff, ...rest } = h.results.applySeal(agent(session), taskId, h.tasks.store.detail(taskId)!).results!.find(entry => entry.id === id)!
  return rest
}
const withoutDiff = (whole: AgentWholeResult) => {
  const { diff: _diff, diffBytes: _bytes, diffCut: _cut, diffResumeOffsetBytes: _resume, ...rest } = whole
  return rest
}

describe('result rows and the outstanding result (G9)', () => {
  // @covers: team-tasks › task_get lists results as rows › Five results
  test('G9: one outstanding and four superseded results — the outstanding whole first, then four rows without findings, coverage, maps, or diff', () => {
    const task = h.tasks.store.create({ teamId: h.team.teamId, title: 'T', direction: 'd', creator: { kind: 'agent', sessionId: 'lead' } }, at(0))
    const ids = Array.from({ length: 5 }, (_, i) => result(task.id, 10 + i, { diff: `diff ${i}` }))
    const detail = read(task.id)
    expect(detail.results.map(entry => entry.id)).toEqual([...ids].reverse())
    const [whole, ...rows] = detail.results
    expect(isRow(whole!)).toBe(false)
    expect(withoutDiff(whole as AgentWholeResult)).toEqual(authorized('dev', task.id, ids[4]!))
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['acceptedAt', 'commit', 'createdAt', 'id', 'reviewVerdict', 'submittedBy', 'summary', 'summaryBytes', 'summaryCut', 'supersededBy', 'taskRevision'])
    }
    const stored = h.tasks.store.detail(task.id)!.results!
    expect(rows).toEqual(stored.slice(1).map(entry => ({
      id: entry.id, commit: entry.commit, taskRevision: entry.taskRevision, submittedBy: entry.submittedBy, supersededBy: entry.supersededBy,
      acceptedAt: entry.acceptedAt, reviewVerdict: h.tasks.store.results.reviewVerdict(task.id, entry.id), createdAt: entry.createdAt,
      summary: entry.summary, summaryBytes: Buffer.byteLength(entry.summary), summaryCut: false,
    })))
    expect(detail.bounds.results).toEqual({ total: 4, returned: 4, truncated: false, nextBefore: null })
  })

  // @covers: team-tasks › task_get lists results as rows › Long result history
  test('G9a, G9b: 1 outstanding and 70 superseded results — the outstanding whole in every read, 50 newest rows then the 20 oldest, each once', () => {
    const task = h.tasks.store.create({ teamId: h.team.teamId, title: 'T', direction: 'd', creator: { kind: 'agent', sessionId: 'lead' } }, at(0))
    // Ties: runs of three results share a submission time.
    const ids = Array.from({ length: 71 }, (_, i) => result(task.id, 10 + Math.floor(i / 3)))
    const outstanding = ids[70]!
    const first = read(task.id)
    expect(first.results[0]!.id).toBe(outstanding)
    expect(first.results.slice(1).map(entry => entry.id)).toEqual(ids.slice(20, 70).reverse())
    expect(first.bounds.results).toEqual({ total: 70, returned: 50, truncated: true, nextBefore: ids[20] })
    const second = read(task.id, { resultsBefore: first.bounds.results.nextBefore! })
    expect(second.results[0]).toEqual(first.results[0])
    expect(second.results.slice(1).map(entry => entry.id)).toEqual(ids.slice(0, 20).reverse())
    expect(second.bounds.results).toEqual({ total: 70, returned: 20, truncated: false, nextBefore: null })
  })

  test('G9c (store): the outstanding result, another task\'s result, and an unknown id are refused as results_before naming the id', async () => {
    const task = await newTask()
    const other = await newTask()
    await submit(task.id)
    const outstanding = await submit(task.id)
    const foreign = await submit(other.id)
    for (const anchor of [outstanding, foreign, 'result-unknown']) expect(() => read(task.id, { resultsBefore: anchor })).toThrow(`Unknown result of this task: ${anchor}`)
  })

  test('G9d, H6 (summaries): a 5,000-byte summary previews 2,000 bytes, cut; 1,999/2,000/2,001 bytes and invalid bytes read exactly', () => {
    const task = h.tasks.store.create({ teamId: h.team.teamId, title: 'T', direction: 'd', creator: { kind: 'agent', sessionId: 'lead' } }, at(0))
    const cases = [
      { summary: bytesOf('s'.repeat(5000)), text: 's'.repeat(2000), cut: true },
      { summary: bytesOf('s'.repeat(1999)), text: 's'.repeat(1999), cut: false },
      { summary: bytesOf('s'.repeat(2000)), text: 's'.repeat(2000), cut: false },
      { summary: bytesOf('s'.repeat(2001)), text: 's'.repeat(2000), cut: true },
      { summary: bytesOf('ok', [0xfe]), text: null, cut: false },
      { summary: bytesOf('﻿\u0000x'), text: '﻿\u0000x', cut: false },
    ]
    const ids = cases.map((entry, i) => result(task.id, i, { summary: entry.summary }))
    result(task.id, 100)
    const rows = new Map((read(task.id).results.filter(isRow)).map(row => [row.id, row]))
    cases.forEach((entry, i) => expect(rows.get(ids[i]!)).toMatchObject({ summary: entry.text, summaryBytes: entry.summary.length, summaryCut: entry.cut }))
  })

  test('H7: a task without an outstanding result reads only bounded rows, counts every result in the total, and still reads a result whole', () => {
    const empty = h.tasks.store.create({ teamId: h.team.teamId, title: 'T', direction: 'd', creator: { kind: 'agent', sessionId: 'lead' } }, at(0))
    expect(read(empty.id).results).toEqual([])
    expect(read(empty.id).bounds.results).toEqual({ total: 0, returned: 0, truncated: false, nextBefore: null })
    // Historical rows can supersede each other in a cycle, leaving no outstanding result.
    const task = h.tasks.store.create({ teamId: h.team.teamId, title: 'T', direction: 'd', creator: { kind: 'agent', sessionId: 'lead' } }, at(0))
    const a = result(task.id, 1)
    const b = result(task.id, 2)
    h.db.prepare('UPDATE team_task_results SET supersedes_result_id = ? WHERE id = ?').run(b, a)
    expect(h.tasks.store.results.outstandingId(task.id)).toBeNull()
    const detail = read(task.id, { resultId: a })
    expect(detail.results.every(isRow)).toBe(true)
    expect(detail.results.map(entry => entry.id)).toEqual([b, a])
    expect(detail.bounds.results).toEqual({ total: 2, returned: 2, truncated: false, nextBefore: null })
    expect(detail.resultDetail!.id).toBe(a)
    expect(read(task.id, { resultsBefore: b }).results.map(entry => entry.id)).toEqual([a])
  })
})

describe('one result whole and the diff preview (G10–G13g, H5)', () => {
  // @covers: team-tasks › task_get reads one result whole › Reading a superseded result
  test('G10: result_id of a superseded result returns it whole beside the outstanding one, equal to the authorized reader view apart from the diff preview', async () => {
    const task = await newTask()
    const old = await submit(task.id, 'first')
    h.db.prepare('UPDATE team_task_results SET diff_ref = ? WHERE id = ?').run('old diff', old)
    const current = await submit(task.id, 'second')
    const detail = read(task.id, { resultId: old })
    expect(detail.results[0]!.id).toBe(current)
    expect(withoutDiff(detail.resultDetail!)).toEqual(authorized('dev', task.id, old))
    expect(detail.resultDetail).toMatchObject({ diff: 'old diff', diffBytes: 8, diffCut: false, diffResumeOffsetBytes: 8, summary: 'first' })
    expect(read(task.id).resultDetail).toBeUndefined()
  })

  // @covers: team-tasks › task_get reads one result whole › Sealed reviewer asks for a result
  test('G11: the reviewer holding the review handoff, with no map, reads the submitter\'s coverage withheld by default and by result_id, and only its own maps', async () => {
    const task = await newTask()
    const resultId = await submit(task.id)
    await h.results.submitCoverage(agent('second'), task.id, { resultId, coverage: [{ clause: 'Second reading', tests: [] }] })
    await review(task.id, resultId)
    const detail = read(task.id, { resultId }, 'reviewer')
    for (const whole of [detail.results[0] as AgentWholeResult, detail.resultDetail!]) {
      expect(whole.coverage).toEqual({ withheld: true, clauses: 1 })
      expect(whole.reviewerMaps).toEqual([])
      expect(JSON.stringify(whole)).not.toContain('Second reading')
    }
    expect(withoutDiff(detail.resultDetail!)).toEqual(authorized('reviewer', task.id, resultId))
    // The submitter is not sealed and sees every map.
    expect(read(task.id, { resultId }, 'dev').resultDetail!.coverage).toEqual(coverage)
  })

  test('G12 (store): result_id of another task\'s result, or no result, is refused naming the id', async () => {
    const task = await newTask()
    const other = await newTask()
    await submit(task.id)
    const foreign = await submit(other.id)
    for (const id of [foreign, 'result-unknown']) expect(() => read(task.id, { resultId: id })).toThrow(`Unknown result of this task: ${id}`)
  })

  // @covers: team-tasks › task_get reads one result whole › Large diff
  // @covers: team-tasks › task_get reads one result whole › Diff fits the preview
  test('G13, G13g, H6 (diffs): 300 KB previews 8,192 bytes, cut; 2,001 and 8,192 bytes read whole with resume equal to total; 8,191/8,193 and invalid edges exact', () => {
    const task = h.tasks.store.create({ teamId: h.team.teamId, title: 'T', direction: 'd', creator: { kind: 'agent', sessionId: 'lead' } }, at(0))
    const cases = [
      { diff: bytesOf('d'.repeat(307200)), text: 'd'.repeat(8192), cut: true, resume: 8192 },
      { diff: bytesOf('d'.repeat(2001)), text: 'd'.repeat(2001), cut: false, resume: 2001 },
      { diff: bytesOf('d'.repeat(8192)), text: 'd'.repeat(8192), cut: false, resume: 8192 },
      { diff: bytesOf('d'.repeat(8191)), text: 'd'.repeat(8191), cut: false, resume: 8191 },
      { diff: bytesOf('d'.repeat(8193)), text: 'd'.repeat(8192), cut: true, resume: 8192 },
      { diff: bytesOf('d'.repeat(8190), '😀'), text: 'd'.repeat(8190), cut: true, resume: 8190 },
      { diff: bytesOf('d'.repeat(10), [0x80], 'd'.repeat(9000)), text: null, cut: true, resume: 0 },
      { diff: bytesOf('﻿\u0000'), text: '﻿\u0000', cut: false, resume: 4 },
    ]
    for (const entry of cases) {
      const id = result(task.id, 1, { diff: entry.diff, commit: null })
      const whole = read(task.id).results[0] as AgentWholeResult
      expect(whole.id).toBe(id)
      expect({ diff: whole.diff, diffBytes: whole.diffBytes, diffCut: whole.diffCut, diffResumeOffsetBytes: whole.diffResumeOffsetBytes })
        .toEqual({ diff: entry.text, diffBytes: entry.diff.length, diffCut: entry.cut, diffResumeOffsetBytes: entry.resume })
    }
    const noDiff = result(task.id, 2)
    expect(read(task.id, { resultId: noDiff }).resultDetail).toMatchObject({ diff: null, diffBytes: 0, diffCut: false, diffResumeOffsetBytes: 0 })
  })

  test('H5: result_id naming the outstanding result returns the same whole result in both fields, sealed or not, including redacted check outcomes and comparisons', async () => {
    const task = await newTask()
    const resultId = await submit(task.id)
    const check = h.tasks.store.checks.pendingForResult(resultId)!
    h.tasks.store.checks.settle(check.id, 'done', JSON.stringify({ version: 1, coverage: [['ran-passed']] }), null)
    await h.results.submitCoverage(agent('second'), task.id, { resultId, coverage: [{ clause: 'Second', tests: [] }] })
    await review(task.id, resultId)
    const sealed = read(task.id, { resultId }, 'reviewer')
    expect(sealed.resultDetail).toEqual(sealed.results[0] as AgentWholeResult)
    expect(JSON.stringify(sealed.resultDetail)).not.toContain('ran-passed')
    const open = read(task.id, { resultId }, 'second')
    expect(open.resultDetail).toEqual(open.results[0] as AgentWholeResult)
    expect(open.resultDetail!.comparison).not.toBeNull()
    expect(JSON.stringify(open.resultDetail)).toContain('ran-passed')
  })
})

describe('identities across writes (H3, P6)', () => {
  // @covers: team-tasks › Task read identities survive paging and concurrent writes › Result superseded between pages
  test('H3: an amendment, a superseding result, and a handoff between reads — current identity advances, pins stay, the new outstanding is whole and sealed by the current predicate, an anchor now outstanding is refused', async () => {
    const task = await newTask()
    const r1 = await submit(task.id, 'one')
    const r2 = await submit(task.id, 'two')
    const before = read(task.id, {}, 'reviewer')
    expect(before.results.map(entry => entry.id)).toEqual([r2, r1])
    await h.tasks.amend(agent('lead'), task.id, { direction: 'v2' })
    const r3 = await submit(task.id, 'three')
    await review(task.id, r3)
    const after = read(task.id, { resultsBefore: r2 }, 'reviewer')
    expect(after.task.revision).toBe(2)
    expect(after.task.identity).toBe(h.tasks.store.get(task.id)!.identity)
    expect(after.task.identity).not.toBe(before.task.identity)
    expect(after.results[0]).toMatchObject({ id: r3, taskRevision: 2, coverage: { withheld: true, clauses: 1 } })
    expect(after.results.slice(1).map(entry => [entry.id, entry.taskRevision])).toEqual([[r1, 1]])
    expect(read(task.id, { resultId: r1 }, 'reviewer').resultDetail).toMatchObject({ taskRevision: 1, needsReevaluation: true, coverage: { withheld: true, clauses: 1 } })
    // r3 is outstanding now: an anchor naming it is refused.
    expect(() => read(task.id, { resultsBefore: r3 })).toThrow(`Unknown result of this task: ${r3}`)
  })

  // P6/I4: seed 0x5EA1, 200 sequences of amend/submit/handoff/map/read through the real services.
  test('P6: seed 0x5EA1, 200 sequences of amend, submit, handoff, map, and read keep every submission pin and seal default and selected whole results as the existing seal does', async () => {
    const CASES = 200
    const rand = mulberry32(0x5ea1)
    const pick = <T>(items: readonly T[]) => items[Math.floor(rand() * items.length)]!
    for (let c = 0; c < propertyCases(CASES); c++) {
      const task = await newTask()
      const pins = new Map<string, number>()
      const steps = 2 + Math.floor(rand() * 7)
      for (let s = 0; s < steps; s++) {
        const op = pick(['amend', 'submit', 'submit', 'handoff', 'map', 'read'] as const)
        const ids = [...pins.keys()]
        if (op === 'amend') await h.tasks.amend(agent('lead'), task.id, { direction: `v${c}.${s}` })
        else if (op === 'submit') pins.set(await submit(task.id, `c${c}s${s}`), h.tasks.store.get(task.id)!.revision)
        else if (op === 'handoff' && ids.length > 0) await review(task.id, h.tasks.store.results.outstandingId(task.id)!, pick(['reviewer', 'second']))
        else if (op === 'map' && ids.length > 0) await h.results.submitCoverage(agent(pick(['reviewer', 'second'])), task.id, { resultId: pick(ids), coverage: [{ clause: `m${s}`, tests: [] }] })
        for (const session of ['dev', 'reviewer', 'second']) {
          const detail = read(task.id, {}, session)
          for (const entry of detail.results) expect(entry.taskRevision, `${c}:${s} pin`).toBe(pins.get(entry.id)!)
          if (detail.results[0] && !isRow(detail.results[0])) expect(withoutDiff(detail.results[0])).toEqual(authorized(session, task.id, detail.results[0].id))
          for (const id of ids) {
            const selected = read(task.id, { resultId: id }, session).resultDetail!
            expect(selected.taskRevision).toBe(pins.get(id)!)
            expect(withoutDiff(selected), `${c}:${s} ${session} ${id}`).toEqual(authorized(session, task.id, id))
          }
        }
      }
    }
  }, 120_000)
})
