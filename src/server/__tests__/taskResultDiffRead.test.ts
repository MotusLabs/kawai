// The lossless diff reader (bounded-task-reads D8a): rows G13a–G13f and P5
// at the production reader behind `task_result_diff_read`
// (TaskJournalReads.diffRead over readResultDiff), with task_get's caller and
// team rules. The same rows through both tool runtimes are in
// taskReadTools.test.ts. Ground truth is the stored diff bytes.
import { describe, expect, test } from 'bun:test'
import type { AgentWholeResult, TaskResultDiffChunk } from '../../shared/teamTasks'
import type { TaskCaller } from '../team/TaskService'
import { TaskJournalReads } from '../team/taskJournalWindow'
import { readResultDiff } from '../team/taskResultDiffRead'
import { agent, useTaskToolHarness } from './taskToolHarness'
import { mulberry32 } from './taskJournalFixture'
import { bytesOf, rawResult } from './taskReadFixture'
import { propertyCases } from './helpers/propertyCases'

const h = useTaskToolHarness('kawai-diff-read-')
const newTask = async () => h.tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })
const decoded = (chunk: TaskResultDiffChunk) => Buffer.from(chunk.dataBase64, 'base64')

/** Every chunk from `offset` to the end, each checked against the stored bytes; returns the concatenation. */
async function readAll(caller: TaskCaller, taskId: string, resultId: string, stored: Buffer, offset = 0): Promise<{ bytes: Buffer; chunks: TaskResultDiffChunk[] }> {
  const reads = new TaskJournalReads(h.tasks)
  const chunks: TaskResultDiffChunk[] = []
  let next: number | null = offset
  while (next !== null) {
    const chunk: TaskResultDiffChunk = await reads.diffRead(caller, taskId, resultId, next)
    expect(chunk).toMatchObject({ resultId, offsetBytes: next, totalBytes: stored.length })
    expect(decoded(chunk).equals(stored.subarray(next, next + chunk.returnedBytes))).toBe(true)
    if (chunk.text !== null) expect(Buffer.from(chunk.text, 'utf8').equals(decoded(chunk))).toBe(true)
    if (chunk.nextOffsetBytes !== null) {
      expect(chunk.returnedBytes).toBeGreaterThanOrEqual(1)
      expect(chunk.returnedBytes).toBeLessThanOrEqual(8192)
      expect(chunk.nextOffsetBytes).toBe(next + chunk.returnedBytes)
    } else expect(next + chunk.returnedBytes).toBe(stored.length)
    chunks.push(chunk)
    next = chunk.nextOffsetBytes
  }
  return { bytes: Buffer.concat([stored.subarray(0, offset), ...chunks.map(decoded)]), chunks }
}

describe('task_result_diff_read (D8a)', () => {
  // @covers: team-tasks › task_result_diff_read returns any diff losslessly › Reading a diff-only result whole
  test('G13a: a diff-only result with a 300 KB diff, walked from offset 0, concatenates to the stored diff; the last next offset is null', async () => {
    const task = await newTask()
    const stored = bytesOf('x'.repeat(127200), 'é€😀'.repeat(20000))
    expect(stored.length).toBe(307200)
    const id = rawResult(h.tasks.store, h.team.teamId, task.id, 1, { diff: stored, commit: null })
    expect(h.tasks.store.results.get(id)!.commit).toBeNull()
    const { bytes, chunks } = await readAll(agent('dev'), task.id, id, stored)
    expect(bytes.equals(stored)).toBe(true)
    expect(chunks.at(-1)!.nextOffsetBytes).toBeNull()
  })

  // @covers: team-tasks › task_result_diff_read returns any diff losslessly › Continuing a preview
  test('G13b: reading from a whole result\'s diffResumeOffsetBytes starts at the byte after its preview', async () => {
    const task = await newTask()
    const stored = bytesOf('a'.repeat(8190), '€', 'tail'.repeat(5000))
    const id = rawResult(h.tasks.store, h.team.teamId, task.id, 1, { diff: stored })
    const whole = h.tasks.store.journalWindow.agentDetail(task.id).results[0] as AgentWholeResult
    expect(whole).toMatchObject({ diffBytes: stored.length, diffCut: true, diffResumeOffsetBytes: 8190, diff: 'a'.repeat(8190) })
    const first = readResultDiff(h.db, task.id, id, whole.diffResumeOffsetBytes)
    expect(first.offsetBytes).toBe(8190)
    expect(decoded(first).subarray(0, 3).equals(bytesOf('€'))).toBe(true)
    const { bytes } = await readAll(agent('dev'), task.id, id, stored, whole.diffResumeOffsetBytes)
    expect(Buffer.concat([Buffer.from(whole.diff!, 'utf8'), bytes.subarray(whole.diffResumeOffsetBytes)]).equals(stored)).toBe(true)
  })

  // @covers: team-tasks › task_result_diff_read returns any diff losslessly › Offset beyond the diff
  test('G13c, G13c2 (store): a negative, fractional, or unsafe offset and one past the total are refused naming it; the total itself reads zero bytes and a null next', async () => {
    const task = await newTask()
    const id = rawResult(h.tasks.store, h.team.teamId, task.id, 1, { diff: '€uro' })
    for (const offset of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(() => readResultDiff(h.db, task.id, id, offset)).toThrow(`offset_bytes must be a safe non-negative integer: ${offset}`)
    expect(() => readResultDiff(h.db, task.id, id, 7)).toThrow('offset_bytes 7 is beyond the diff\'s 6 bytes')
    expect(readResultDiff(h.db, task.id, id, 6)).toEqual({ resultId: id, offsetBytes: 6, totalBytes: 6, returnedBytes: 0, dataBase64: '', text: '', nextOffsetBytes: null })
  })

  // @covers: team-tasks › task_result_diff_read returns any diff losslessly › Result without a diff
  test('G13d: a result with a commit and no diff reads total 0, no bytes, and a null next offset', async () => {
    const task = await newTask()
    const id = (await h.results.submit(agent('dev'), task.id, { summary: 's', commit: 'abc' })).id
    expect(await new TaskJournalReads(h.tasks).diffRead(agent('dev'), task.id, id)).toEqual({ resultId: id, offsetBytes: 0, totalBytes: 0, returnedBytes: 0, dataBase64: '', text: '', nextOffsetBytes: null })
    expect(() => readResultDiff(h.db, task.id, id, 1)).toThrow('offset_bytes 1 is beyond the diff\'s 0 bytes')
  })

  test('G13e: bytes that are not exact UTF-8 at a chunk edge return untrimmed with null text, and the walk stays lossless', async () => {
    const task = await newTask()
    const stored = bytesOf('a'.repeat(8191), [0xff, 0xfe], 'b'.repeat(100))
    const id = rawResult(h.tasks.store, h.team.teamId, task.id, 1, { diff: stored })
    const first = readResultDiff(h.db, task.id, id)
    expect(first).toMatchObject({ returnedBytes: 8192, text: null, nextOffsetBytes: 8192 })
    expect(decoded(first).equals(stored.subarray(0, 8192))).toBe(true)
    const inside = readResultDiff(h.db, task.id, id, 8190)
    expect(inside.text).toBeNull()
    expect((await readAll(agent('dev'), task.id, id, stored)).bytes.equals(stored)).toBe(true)
  })

  // @covers: team-tasks › task_result_diff_read returns any diff losslessly › Foreign result
  test('G13f (service): another task\'s result and another team\'s task are refused as not found; an override caller is refused as a system read, an execution reads', async () => {
    const task = await newTask()
    const other = await newTask()
    const id = rawResult(h.tasks.store, h.team.teamId, task.id, 1, { diff: 'mine' })
    const foreign = rawResult(h.tasks.store, h.team.teamId, other.id, 2, { diff: 'theirs' })
    const reads = new TaskJournalReads(h.tasks)
    await expect(reads.diffRead(agent('dev'), task.id, foreign)).rejects.toThrow(`Result not found for this task: ${foreign}`)
    await expect(reads.diffRead(agent('dev'), task.id, 'result-unknown')).rejects.toThrow('Result not found for this task: result-unknown')
    await expect(reads.diffRead(agent('stranger'), task.id, id)).rejects.toThrow(`Task not found in this team: ${task.id}`)
    const override: TaskCaller = { kind: 'system', team: h.team, origin: { kind: 'override', decisionId: 'd-1' } }
    const expected = await h.tasks.get(override, task.id).then(() => 'allowed', (error: Error) => error.message)
    expect(expected).not.toBe('allowed')
    await expect(reads.diffRead(override, task.id, id)).rejects.toThrow(expected)
    const execution: TaskCaller = { kind: 'system', team: h.team, origin: { kind: 'execution', executionId: 'exec-1' } }
    expect((await reads.diffRead(execution, task.id, id)).text).toBe('mine')
  })
})

// P5/I3: seed 0xD1FF, 300 arbitrary diffs through the actual reader and the whole result's preview.
test('P5: seed 0xD1FF, 300 diffs of 0–40,000 bytes with BOM, NUL, and invalid edges round-trip exactly through the reader, and every preview is an exact prefix', async () => {
  const CASES = 300
  const rand = mulberry32(0xd1ff)
  const task = await newTask()
  const pieces = [bytesOf('a'), bytesOf('é'), bytesOf('€'), bytesOf('😀'), bytesOf('﻿'), bytesOf('\u0000'), Buffer.from([0xff]), Buffer.from([0xc3]), Buffer.from([0xe2, 0x82]), Buffer.from([0x80])]
  for (let c = 0; c < propertyCases(CASES); c++) {
    const target = Math.floor(rand() * 40001)
    const parts: Buffer[] = []
    let length = 0
    // Mostly runs of ASCII with scattered multibyte and invalid pieces, often near the 8,192-byte edges.
    while (length < target) {
      const run = rand() < 0.5 ? Buffer.from('x'.repeat(Math.min(target - length, 1 + Math.floor(rand() * 9000)))) : pieces[Math.floor(rand() * pieces.length)]!
      parts.push(run)
      length += run.length
    }
    const stored = Buffer.concat(parts)
    const id = rawResult(h.tasks.store, h.team.teamId, task.id, c, { diff: stored })
    expect((await readAll(agent('dev'), task.id, id, stored)).bytes.equals(stored), `case ${c}`).toBe(true)
    const whole = h.tasks.store.journalWindow.agentDetail(task.id).results[0] as AgentWholeResult
    expect(whole.diffBytes).toBe(stored.length)
    expect(whole.diffCut).toBe(stored.length > 8192)
    if (whole.diff !== null) {
      const preview = Buffer.from(whole.diff, 'utf8')
      expect(preview.equals(stored.subarray(0, preview.length)), `case ${c} preview`).toBe(true)
      expect(preview.length).toBeLessThanOrEqual(8192)
      expect(whole.diffResumeOffsetBytes).toBe(preview.length)
      if (!whole.diffCut) expect(preview.length).toBe(stored.length)
    } else expect(whole.diffResumeOffsetBytes).toBe(0)
    expect(whole.diff ?? '').not.toContain('\ufffd')
  }
}, 120_000)
