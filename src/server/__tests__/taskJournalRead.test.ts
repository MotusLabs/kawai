// The lossless entry reader and the service rules of the bounded reads
// (bounded-log-reads-and-task-get D4–D6): rows R1–R4 and R6–R10 at the store
// and service, R5's store guard, T5 and T14 through the service and the
// seal, and P4. The adapter envelopes (R5's schema, T5–T7, R6) are in
// taskJournalTools.test.ts. Ground truth is the stored bytes.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import type { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import type { ChatSessionRecord } from '../db'
import { schemaCopy } from './schemaDb'
import { AssignmentService } from '../team/AssignmentService'
import { AssignmentStore } from '../team/assignmentStore'
import { MailboxStore } from '../team/mailboxStore'
import { TaskStore } from '../team/taskStore'
import { TaskService, type TaskCaller } from '../team/TaskService'
import { TaskResultService } from '../team/TaskResultService'
import { TaskJournalReads, utf8Exact } from '../team/taskJournalWindow'
import { WorktreeStaffing } from '../team/staffing'
import { TeamCaps } from '../team/teamCaps'
import { TeamWorktrees } from '../team/worktreeRoots'
import { clearTeamCache, resolveTeam, type TeamIdentity } from '../team/teamIdentity'
import type { TaskJournalChunk } from '../../shared/teamTasks'
import { at, mulberry32, rawNote } from './taskJournalFixture'

const bytes = (...parts: Array<string | number[]>) =>
  Buffer.concat(parts.map(part => typeof part === 'string' ? Buffer.from(part, 'utf8') : Buffer.from(part)))
const decoded = (chunk: TaskJournalChunk) => Buffer.from(chunk.dataBase64, 'base64')

describe('entry reader (R1–R5, R7–R9) and P4', () => {
  let db: Database
  let store: TaskStore
  let taskId: string
  beforeEach(() => {
    db?.close()
    db = schemaCopy()
    store = new TaskStore(db, new MailboxStore(db))
    taskId = store.create({ teamId: 'team', title: 'T', direction: 'd', creator: { kind: 'human', sessionId: null } }).id
  })
  const read = (id: string, offset?: number) => store.journalWindow.readEntry(taskId, id, offset)
  /** Every chunk from `offset` to the end, each checked against the stored bytes. */
  const readAll = (id: string, stored: Buffer, offset = 0) => {
    const chunks: TaskJournalChunk[] = []
    let next: number | null = offset
    while (next !== null) {
      const chunk = read(id, next)
      chunks.push(chunk)
      expect(chunk.totalBytes).toBe(stored.length)
      expect(decoded(chunk).equals(stored.subarray(next, next + chunk.returnedBytes))).toBe(true)
      if (chunk.text !== null) expect(Buffer.from(chunk.text, 'utf8').equals(decoded(chunk))).toBe(true)
      if (chunk.nextOffsetBytes !== null) {
        expect(chunk.returnedBytes).toBeGreaterThanOrEqual(1)
        expect(chunk.returnedBytes).toBeLessThanOrEqual(8192)
        expect(chunk.nextOffsetBytes).toBe(next + chunk.returnedBytes)
      } else {
        expect(next + chunk.returnedBytes).toBe(stored.length)
      }
      next = chunk.nextOffsetBytes
    }
    return chunks
  }

  test('R1: a 20,000-byte ASCII entry reads 8,192 bytes of exact text with next 8,192', () => {
    const stored = bytes('x'.repeat(20000))
    const id = rawNote(db, taskId, stored, at(1))
    expect(read(id)).toEqual({
      entryId: id, offsetBytes: 0, totalBytes: 20000, returnedBytes: 8192,
      dataBase64: Buffer.from('x'.repeat(8192)).toString('base64'), text: 'x'.repeat(8192), nextOffsetBytes: 8192,
    })
    expect(Buffer.concat(readAll(id, stored).map(decoded)).equals(stored)).toBe(true)
  })

  test('R2: a multi-byte character straddling the chunk end is left for the next chunk', () => {
    const stored = bytes('a'.repeat(8190), '€', 'tail')
    const id = rawNote(db, taskId, stored, at(1))
    const first = read(id)
    expect(first).toMatchObject({ returnedBytes: 8190, text: 'a'.repeat(8190), nextOffsetBytes: 8190 })
    expect(read(id, 8190)).toMatchObject({ returnedBytes: 7, text: '€tail', nextOffsetBytes: null })
  })

  test('R3: offset = total and an empty entry at 0 return an empty chunk with no next offset', () => {
    const id = rawNote(db, taskId, bytes('abc'), at(1))
    expect(read(id, 3)).toEqual({ entryId: id, offsetBytes: 3, totalBytes: 3, returnedBytes: 0, dataBase64: '', text: '', nextOffsetBytes: null })
    const empty = rawNote(db, taskId, new Uint8Array(0), at(2))
    expect(read(empty)).toEqual({ entryId: empty, offsetBytes: 0, totalBytes: 0, returnedBytes: 0, dataBase64: '', text: '', nextOffsetBytes: null })
  })

  test('R4: an offset beyond the total is refused naming the offset and the total', () => {
    const id = rawNote(db, taskId, bytes('abc'), at(1))
    expect(() => read(id, 4)).toThrow("offset_bytes 4 is beyond the entry's 3 bytes")
    expect(() => read(id, Number.MAX_SAFE_INTEGER)).toThrow(`offset_bytes ${Number.MAX_SAFE_INTEGER} is beyond the entry's 3 bytes`)
  })

  test('R5 (store guard): a negative, fractional, or unsafe offset is refused', () => {
    const id = rawNote(db, taskId, bytes('abc'), at(1))
    for (const offset of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
      expect(() => read(id, offset)).toThrow('offset_bytes must be a safe non-negative integer')
    }
  })

  test('R6 (store): an entry of another task, or an unknown id, is refused naming the id', () => {
    const other = store.create({ teamId: 'team', title: 'O', direction: 'd', creator: { kind: 'human', sessionId: null } }).id
    const foreign = rawNote(db, other, bytes('x'), at(1))
    expect(() => read(foreign)).toThrow(`Unknown journal entry for this task: ${foreign}`)
    expect(() => read('note-missing')).toThrow('Unknown journal entry for this task: note-missing')
  })

  test('R7: an entry with a NUL counts every byte, and the chunks include the suffix', () => {
    const stored = bytes('a', [0], 'SUFFIX', 'z'.repeat(9000))
    const id = rawNote(db, taskId, stored, at(1))
    const chunks = readAll(id, stored)
    expect(chunks[0]!.totalBytes).toBe(9008)
    expect(chunks[0]!.text!.startsWith('a\u0000SUFFIX')).toBe(true)
    expect(Buffer.concat(chunks.map(decoded)).equals(stored)).toBe(true)
  })

  test('R8: a leading byte-order mark is kept in the text', () => {
    const id = rawNote(db, taskId, bytes([0xef, 0xbb, 0xbf], 'hi'), at(1))
    expect(read(id)).toMatchObject({ text: '﻿hi', returnedBytes: 5, dataBase64: '77u/aGk=' })
  })

  test('R9: invalid bytes, or an offset inside a character, give null text with raw base64 of at least one byte', () => {
    const invalid = bytes([0xef, 0xbb, 0xbf], 'a', [0], 'b', [0xff], '€')
    const id = rawNote(db, taskId, invalid, at(1))
    expect(read(id)).toEqual({ entryId: id, offsetBytes: 0, totalBytes: 10, returnedBytes: 10, dataBase64: invalid.toString('base64'), text: null, nextOffsetBytes: null })
    const euro = rawNote(db, taskId, bytes('€'.repeat(5000)), at(2))
    const inside = read(euro, 1)
    expect(inside.text).toBeNull()
    expect(inside.returnedBytes).toBe(8192)
    expect(decoded(inside).equals(bytes('€'.repeat(5000)).subarray(1, 8193))).toBe(true)
    expect(read(euro, 14999)).toMatchObject({ returnedBytes: 1, text: null, nextOffsetBytes: null })
  })

  test('utf8Exact keeps a BOM and NUL, and refuses invalid or truncated bytes', () => {
    expect(utf8Exact(bytes([0xef, 0xbb, 0xbf], 'a', [0], 'b'))).toBe('﻿a\u0000b')
    expect(utf8Exact(bytes([0xff]))).toBeNull()
    expect(utf8Exact(bytes([0xe2, 0x82]))).toBeNull()
    expect(utf8Exact(bytes([0xed, 0xa0, 0x80]))).toBeNull()
    expect(utf8Exact(new Uint8Array(0))).toBe('')
  })

  test('P4: seed 0x6a726e6c, 200 entries of 0–40,000 bytes read from random offsets reproduce the stored bytes', () => {
    const rand = mulberry32(0x6a726e6c)
    const pieces: number[][] = [[0x00], [0xef, 0xbb, 0xbf], [0xf0, 0x9f, 0x98, 0x80], [0xe4, 0xb8, 0xad], [0xd0, 0x96], [0xff], [0x80], [0xe2, 0x82], [0xc0, 0xaf]]
    for (let caseIndex = 0; caseIndex < 200; caseIndex++) {
      const length = Math.floor(rand() * 40001)
      const out: number[] = []
      while (out.length < length) {
        if (rand() < 0.5) { const run = 1 + Math.floor(rand() * 300); for (let i = 0; i < run; i++) out.push(0x20 + Math.floor(rand() * 95)) }
        else out.push(...pieces[Math.floor(rand() * pieces.length)]!)
      }
      const stored = Buffer.from(out.slice(0, length))
      const id = rawNote(db, taskId, stored, at(caseIndex))
      expect(Buffer.concat(readAll(id, stored).map(decoded)).equals(stored), `case ${caseIndex}`).toBe(true)
      const start = Math.floor(rand() * (length + 1))
      readAll(id, stored, start)
    }
  })
})

describe('service rules (T5, R6, R10, T14) and the seal', () => {
  let root: string
  let repo: string
  let team: TeamIdentity
  let db: Database
  let records: Map<string, ChatSessionRecord>
  let tasks: TaskService
  let reads: TaskJournalReads
  let results: TaskResultService
  let assignments: AssignmentService
  const agent = (sessionId: string): TaskCaller => ({ kind: 'agent', sessionId })
  const row = (sessionId: string, groupId: string, projectPath = repo): ChatSessionRecord => ({
    sessionId, groupId, projectPath, name: sessionId, sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '',
  })
  const git = (args: string[], cwd: string) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
    if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  }

  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-journal-read-')))
    repo = path.join(root, 'repo')
    for (const dir of [repo, path.join(root, 'other')]) {
      git(['init', '-q', dir], root)
      git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], dir)
    }
    fs.mkdirSync(path.join(repo, '.kawai', 'groups'), { recursive: true })
    fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'leads.md'), '---\ncanCreateTasks: true\n---\nLead.')
    fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'devs.md'), 'Build.')
    fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'reviewers.md'), 'Review.')
    clearTeamCache()
    team = await resolveTeam(repo)
  })
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

  beforeEach(() => {
    records = new Map([['lead', row('lead', 'leads')], ['dev', row('dev', 'devs')], ['reviewer', row('reviewer', 'reviewers')],
      ['stranger', row('stranger', 'leads', path.join(root, 'other'))]])
    db?.close()
    db = schemaCopy()
    const mail = new MailboxStore(db)
    const assignmentStore = new AssignmentStore(db, mail)
    tasks = new TaskService(new TaskStore(db, mail, assignmentStore), { getSession: id => records.get(id) })
    reads = new TaskJournalReads(tasks)
    const staffing = new WorktreeStaffing(db, mail, {
      records: () => records.values(), teamOf: () => undefined, caps: new TeamCaps({}), worktrees: new TeamWorktrees(),
      spawn: () => Promise.resolve({ ok: false, error: 'no spawn in tests' }),
    })
    assignments = new AssignmentService(db, assignmentStore, tasks.store, mail, {
      getSession: id => records.get(id), records: () => records.values(), teamOf: () => undefined, staffing, caps: new TeamCaps({}),
      worktrees: new TeamWorktrees(),
    })
    results = new TaskResultService(tasks, { getSession: id => records.get(id), assignments })
  })

  test('R10/T5: a caller of another team is refused as task_get refuses it; a foreign entry is refused naming it', async () => {
    const task = await tasks.create(agent('lead'), { title: 'Mine', direction: 'd' })
    const other = await tasks.create(agent('lead'), { title: 'Other', direction: 'd' })
    const note = await tasks.note(agent('lead'), task.id, 'hello')
    const foreign = await tasks.note(agent('lead'), other.id, 'elsewhere')
    const refusal = `Task not found in this team: ${task.id}`
    await expect(tasks.get(agent('stranger'), task.id)).rejects.toThrow(refusal)
    await expect(reads.agentGet(agent('stranger'), task.id)).rejects.toThrow(refusal)
    await expect(reads.journalRead(agent('stranger'), task.id, note.id)).rejects.toThrow(refusal)
    await expect(reads.agentGet(agent('dev'), task.id, { journalBefore: foreign.id })).rejects.toThrow(`Unknown journal entry for this task: ${foreign.id}`)
    await expect(reads.journalRead(agent('dev'), task.id, foreign.id)).rejects.toThrow(`Unknown journal entry for this task: ${foreign.id}`)
    await expect(reads.agentGet({ kind: 'agent', sessionId: 'ghost' }, task.id)).rejects.toThrow('Unknown calling session: ghost')
    expect((await reads.journalRead(agent('dev'), task.id, note.id)).text).toBe('hello')
    expect((await reads.agentGet({ kind: 'human', team }, task.id)).journal.map(entry => entry.text)).toEqual(['hello'])
  })

  test('T14: more than 50 results and revisions stay whole, and the seal projects the bounded detail as it projects task_get', async () => {
    const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1' })
    for (let i = 2; i <= 55; i++) await tasks.amend(agent('lead'), task.id, { direction: `v${i}` })
    const coverage = [{ clause: 'A clean export downloads', tests: ['`src/export.test.ts` › `downloads a csv`'] }]
    let last = ''
    for (let i = 0; i < 52; i++) {
      last = (await results.submit(agent('dev'), task.id, { summary: `r${i}`, commit: `c${i}`, coverage, tests: [{ description: 'bun run test', outcome: 'pass' }] })).id
    }
    await results.handoff(agent('lead'), task.id, { kind: 'review', resultId: last, target: { kind: 'session', id: 'reviewer' }, instructions: 'Review', expectedResponse: null })
    const bounded = await reads.agentGet(agent('reviewer'), task.id)
    const whole = await tasks.get(agent('reviewer'), task.id)
    expect(bounded.revisions).toEqual(whole.revisions)
    expect(bounded.revisions).toHaveLength(55)
    expect(bounded.results).toEqual(whole.results)
    expect(bounded.results).toHaveLength(52)
    for (const key of ['assignments', 'publications', 'acknowledgements'] as const) expect(bounded[key]).toEqual(whole[key])
    expect(bounded.task).toEqual(whole.task)
    const sealedBounded = results.applySeal(agent('reviewer'), task.id, bounded)
    const sealedWhole = results.applySeal(agent('reviewer'), task.id, whole)
    expect(sealedBounded.results).toEqual(sealedWhole.results!)
    expect(sealedBounded.results![0]!.coverage).toEqual({ withheld: true, clauses: 1 })
    expect(sealedBounded.bounds).toBe(bounded.bounds)
    // The human reads it unsealed.
    expect(results.applySeal({ kind: 'human', team }, task.id, bounded).results![0]!.coverage).toEqual(coverage)
  })
})
