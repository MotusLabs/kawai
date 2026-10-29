// The registered `task_get` and `task_journal_read` tools
// (bounded-log-reads-and-task-get D4–D7, tasks 3.4, 4.2): rows T1–T16 and
// R1–R10 through both runtimes' real adapters — the Claude team MCP server's
// registered tools and the Codex dynamic-tool dispatch, both built from
// teamToolTable — with their refusal envelopes, the blind-first seal through
// the real handler, identity bound to the calling session, the system
// caller's read right, and the one catalogue both runtimes share. Ground
// truth is the stored bytes and the insertion order.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import type { Database } from 'bun:sqlite'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { cleanGitEnv } from '../git/gitCommand'
import type { ChatSessionRecord } from '../db'
import { schemaCopy } from './schemaDb'
import { AssignmentService } from '../team/AssignmentService'
import { AssignmentStore } from '../team/assignmentStore'
import { MailboxStore } from '../team/mailboxStore'
import { createMailboxServer, TEAM_ALLOWED_TOOLS, teamToolTable, type MailboxServerServices } from '../team/mailboxTools'
import { TeamMailbox } from '../team/TeamMailbox'
import { TaskStore } from '../team/taskStore'
import { TaskService, type TaskCaller } from '../team/TaskService'
import { TaskResultService } from '../team/TaskResultService'
import { TaskJournalReads } from '../team/taskJournalWindow'
import { TASK_TOOL_NAMES } from '../team/taskTools'
import { WorktreeStaffing } from '../team/staffing'
import { TeamCaps } from '../team/teamCaps'
import { TeamWorktrees } from '../team/worktreeRoots'
import { clearTeamCache, resolveTeam, type TeamIdentity } from '../team/teamIdentity'
import { dispatchTeamToolCall, teamNamespaceSpec } from '../chat/codex/codexTools'
import { at, rawNote } from './taskJournalFixture'

const THREAD = 'thread-journal-tools'
type Outcome = { error: string; value: null } | { error: null; value: any }
type Registered = Record<string, { handler: (args: unknown, extra: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> }>

let root: string
let repo: string
let team: TeamIdentity
let db: Database
let mail: MailboxStore
let records: Map<string, ChatSessionRecord>
let tasks: TaskService
let results: TaskResultService
let mailbox: TeamMailbox
const servers: Array<{ instance: { close: () => Promise<void> } }> = []

const agent = (sessionId: string): TaskCaller => ({ kind: 'agent', sessionId })
const row = (sessionId: string, groupId: string, projectPath = repo): ChatSessionRecord => ({
  sessionId, groupId, projectPath, name: sessionId, sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '',
})
const git = (args: string[], cwd: string) => {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
}
const services = (): MailboxServerServices => ({ tasks, results })
const bytes = (...parts: Array<string | number[]>) =>
  Buffer.concat(parts.map(part => typeof part === 'string' ? Buffer.from(part, 'utf8') : Buffer.from(part)))

/** The Claude runtime: the session's real team MCP server and its registered tool, which answers isError text on a refusal. */
async function viaClaude(sessionId: string, name: string, args: unknown): Promise<Outcome> {
  const server = await createMailboxServer(mailbox, sessionId, services())
  servers.push(server as unknown as { instance: { close: () => Promise<void> } })
  const tool = (server.instance as unknown as { _registeredTools: Registered })._registeredTools[name]!
  const result = await tool.handler(args, {})
  const text = result.content[0]!.text
  return result.isError ? { error: text, value: null } : { error: null, value: JSON.parse(text) }
}

/** The Codex runtime: the dynamic-tool dispatch over the same table, which answers success false with text on a refusal. */
async function viaCodex(sessionId: string, name: string, args: unknown): Promise<Outcome> {
  const answer = await dispatchTeamToolCall(teamToolTable(mailbox, sessionId, services()), THREAD,
    { threadId: THREAD, namespace: 'kawai-team', tool: name, arguments: args } as never)
  const item = answer.contentItems[0]!
  const text = item.type === 'inputText' ? item.text : ''
  return answer.success ? { error: null, value: JSON.parse(text) } : { error: text, value: null }
}

const RUNTIMES = [{ runtime: 'Claude', call: viaClaude }, { runtime: 'Codex', call: viaCodex }] as const

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-journal-tools-')))
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
  mail = new MailboxStore(db)
  const assignmentStore = new AssignmentStore(db, mail)
  tasks = new TaskService(new TaskStore(db, mail, assignmentStore), { getSession: id => records.get(id) })
  const staffing = new WorktreeStaffing(db, mail, {
    records: () => records.values(), teamOf: () => undefined, caps: new TeamCaps({}), worktrees: new TeamWorktrees(),
    spawn: () => Promise.resolve({ ok: false, error: 'no spawn in tests' }),
  })
  const assignments = new AssignmentService(db, assignmentStore, tasks.store, mail, {
    getSession: id => records.get(id), records: () => records.values(), teamOf: () => undefined, staffing, caps: new TeamCaps({}),
    worktrees: new TeamWorktrees(),
  })
  results = new TaskResultService(tasks, { getSession: id => records.get(id), assignments })
  mailbox = new TeamMailbox(mail, { getSession: id => records.get(id), homeDir: root })
})
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.instance.close()))
})

const newTask = async () => tasks.create(agent('lead'), { title: 'Export', direction: 'CSV' })
const notes = (taskId: string, count: number, text = (i: number) => `entry ${i}`) => {
  const ids: string[] = []
  db.transaction(() => { for (let i = 0; i < count; i++) ids.push(rawNote(db, taskId, text(i), at(i))) })()
  return ids
}
const message = (taskId: string, seconds: number) => mail.enqueue({
  teamId: team.teamId, toKind: 'group', toId: 'devs', fromSession: 'lead', fromGroup: null, originPath: repo, body: `m${seconds}`, taskId,
}, at(seconds))
const ids = (rows: Array<{ id: string }>) => rows.map(entry => entry.id)

for (const { runtime, call } of RUNTIMES) {
  describe(`task_get through the ${runtime} adapter (T1–T13, T16)`, () => {
    // @covers: team-tasks › task_get bounds its growing lists › Small task is whole
    test('T1: a small task is whole and readable with the default window', async () => {
      const task = await newTask()
      const written = notes(task.id, 3, i => `note ${i} ${'x'.repeat(600 * i)}`)
      message(task.id, 10)
      const { error, value } = await call('dev', 'task_get', { task_id: task.id })
      expect(error).toBeNull()
      expect(ids(value.journal)).toEqual(written)
      expect(value.journal.map((entry: { text: string }) => entry.text)).toEqual(written.map((_, i) => `note ${i} ${'x'.repeat(600 * i)}`))
      expect(value.journal.every((entry: Record<string, unknown>) => !entry.cut && entry.resumeOffsetBytes === entry.totalBytes)).toBe(true)
      expect(value.messages.map((entry: { body: string }) => entry.body)).toEqual(['m10'])
      expect(value.bounds).toEqual({
        journal: { total: 3, returned: 3, olderRemaining: false, nextBefore: null },
        subtasks: { total: 0, returned: 0, truncated: false },
        messages: { total: 1, returned: 1, truncated: false },
      })
    })

    // @covers: team-tasks › task_get bounds its growing lists › Long-running task read by an agent
    // @covers: team-tasks › task_get pages the journal › Reading older entries
    // @covers: team-tasks › task_get pages the journal › Last page
    test('T2–T4, T11, T12: newest windows with totals, then paging returns every entry once', async () => {
      const task = await newTask()
      const written = notes(task.id, 1198)
      for (let i = 0; i < 149; i++) tasks.store.create({ teamId: team.teamId, title: `s${i}`, direction: 'd', creator: { kind: 'agent', sessionId: 'lead' }, parentId: task.id }, at(i))
      for (let i = 0; i < 60; i++) message(task.id, i)
      const first = (await call('dev', 'task_get', { task_id: task.id })).value
      expect(ids(first.journal)).toEqual(written.slice(-50))
      expect(first.subtasks).toHaveLength(100)
      expect(first.messages.map((entry: { body: string }) => entry.body)).toEqual(Array.from({ length: 50 }, (_, i) => `m${i + 10}`))
      expect(first.bounds).toEqual({
        journal: { total: 1198, returned: 50, olderRemaining: true, nextBefore: written[1148] },
        subtasks: { total: 149, returned: 100, truncated: true },
        messages: { total: 60, returned: 50, truncated: true },
      })
      const k = 700
      const t3 = (await call('dev', 'task_get', { task_id: task.id, journal_before: written[k], journal_limit: 100 })).value
      expect(ids(t3.journal)).toEqual(written.slice(k - 100, k))
      expect(t3.bounds.journal).toMatchObject({ olderRemaining: true, nextBefore: written[k - 100] })
      const t4 = (await call('dev', 'task_get', { task_id: task.id, journal_before: written[30], journal_limit: 100 })).value
      expect(ids(t4.journal)).toEqual(written.slice(0, 30))
      expect(t4.bounds.journal).toEqual({ total: 1198, returned: 30, olderRemaining: false, nextBefore: null })
      expect(ids((await call('dev', 'task_get', { task_id: task.id, journal_limit: 1 })).value.journal)).toEqual(written.slice(-1))
      const paged: string[] = []
      let before: string | null = null
      do {
        const page: any = (await call('dev', 'task_get', { task_id: task.id, journal_limit: 200, ...(before ? { journal_before: before } : {}) })).value
        expect(page.journal.length).toBeLessThanOrEqual(200)
        paged.unshift(...ids(page.journal))
        before = page.bounds.journal.nextBefore
      } while (before !== null)
      expect(paged).toEqual(written)
      const empty = await newTask()
      expect((await call('dev', 'task_get', { task_id: empty.id })).value.bounds.journal).toEqual({ total: 0, returned: 0, olderRemaining: false, nextBefore: null })
    })

    // @covers: team-tasks › task_get pages the journal › Reading older entries
    test('T13: entries sharing created_at page in insertion order with no duplicates or gaps', async () => {
      const task = await newTask()
      // Runs of five entries share a created_at, so pages of four cut through ties;
      // the expected order is the insertion (rowid) order rawNote recorded.
      const written: string[] = []
      db.transaction(() => { for (let i = 0; i < 23; i++) written.push(rawNote(db, task.id, `tie ${i}`, at(Math.floor(i / 5)))) })()
      const paged: string[] = []
      let before: string | null = null
      for (let end = 23; end > 0; end -= 4) {
        const start = Math.max(0, end - 4)
        const { error, value }: { error: string | null; value: any } =
          await call('dev', 'task_get', { task_id: task.id, journal_limit: 4, ...(before ? { journal_before: before } : {}) })
        expect(error).toBeNull()
        expect(ids(value.journal)).toEqual(written.slice(start, end))
        expect(value.bounds.journal).toEqual({
          total: 23, returned: end - start, olderRemaining: start > 0, nextBefore: start > 0 ? written[start] : null,
        })
        paged.unshift(...ids(value.journal))
        before = value.bounds.journal.nextBefore
      }
      expect(before).toBeNull()
      expect(paged).toEqual(written)
      expect(new Set(paged).size).toBe(23)
    })

    // @covers: team-tasks › task_get pages the journal › Unknown or foreign entry id
    // @covers: team-tasks › task_get pages the journal › Limit out of range
    test('T5–T7: a foreign or unknown anchor and an out-of-range limit are refused in the runtime\'s envelope', async () => {
      const task = await newTask()
      const other = await newTask()
      const foreign = (await tasks.note(agent('lead'), other.id, 'elsewhere')).id
      for (const anchor of [foreign, 'note-unknown']) {
        const { error, value } = await call('dev', 'task_get', { task_id: task.id, journal_before: anchor })
        expect(value).toBeNull()
        expect(error).toContain(`Unknown journal entry for this task: ${anchor}`)
      }
      for (const limit of [0, 201, 1.5, '5']) {
        const { error, value } = await call('dev', 'task_get', { task_id: task.id, journal_limit: limit })
        expect(value).toBeNull()
        expect(error).toContain('journal_limit must be an integer from 1 to 200')
      }
      expect((await call('dev', 'task_get', { task_id: 'task-unknown' })).error).toContain('task-unknown')
    })

    // @covers: team-tasks › task_get journal previews are byte-bounded › Oversized entry
    // @covers: team-tasks › task_get journal previews are byte-bounded › Character straddling the limit
    // @covers: team-tasks › task_get journal previews are byte-bounded › Invalid bytes in the preview
    // @covers: team-tasks › task_get journal previews are byte-bounded › Short invalid historical entry
    test('T8–T10, T16: byte-bounded previews, and the lossless reader returns an FF entry exactly', async () => {
      const task = await newTask()
      const ascii = rawNote(db, task.id, 'a'.repeat(5000), at(1))
      const straddle = rawNote(db, task.id, bytes('b'.repeat(1998), '😀', 'tail'), at(2))
      const invalid = rawNote(db, task.id, bytes('c'.repeat(10), [0xff], 'd'.repeat(3000)), at(3))
      const ff = rawNote(db, task.id, bytes([0xff]), at(4))
      const sibling = rawNote(db, task.id, 'whole sibling', at(5))
      const journal: Array<Record<string, unknown>> = (await call('dev', 'task_get', { task_id: task.id })).value.journal
      const byId = new Map(journal.map(entry => [entry.id as string, entry]))
      expect(byId.get(ascii)).toMatchObject({ text: 'a'.repeat(2000), previewBytes: 2000, totalBytes: 5000, cut: true, resumeOffsetBytes: 2000 })
      expect(byId.get(straddle)).toMatchObject({ text: 'b'.repeat(1998), previewBytes: 1998, cut: true, resumeOffsetBytes: 1998 })
      expect(byId.get(invalid)).toMatchObject({ text: null, previewBytes: 2000, totalBytes: 3011, cut: true, resumeOffsetBytes: 0 })
      expect(byId.get(ff)).toMatchObject({ text: null, previewBytes: 1, totalBytes: 1, cut: false, resumeOffsetBytes: 0 })
      expect(byId.get(sibling)).toMatchObject({ text: 'whole sibling', cut: false })
      const read = (await call('dev', 'task_journal_read', { task_id: task.id, entry_id: ff })).value
      expect(read).toEqual({ entryId: ff, offsetBytes: 0, totalBytes: 1, returnedBytes: 1, dataBase64: Buffer.from([0xff]).toString('base64'), text: null, nextOffsetBytes: null })
    })
  })

  describe(`task_journal_read through the ${runtime} adapter (R1–R10)`, () => {
    // @covers: team-tasks › task_journal_read returns any entry losslessly › Reading a long entry
    // @covers: team-tasks › task_journal_read returns any entry losslessly › Chunk end inside a character
    // @covers: team-tasks › task_journal_read returns any entry losslessly › Entry with an embedded NUL
    test('R1, R2, R7, R8: chunks of at most 8,192 bytes follow the next offset to the exact stored bytes', async () => {
      const task = await newTask()
      const cases = [bytes('x'.repeat(20000)), bytes('a'.repeat(8190), '€', 'tail'), bytes('head\u0000', 'SUFFIX'.repeat(2000)), bytes('﻿bom')]
      for (const stored of cases) {
        const id = rawNote(db, task.id, stored, at(1))
        const chunks: Buffer[] = []
        let next: number | null = 0
        while (next !== null) {
          const chunk: any = (await call('dev', 'task_journal_read', { task_id: task.id, entry_id: id, ...(next ? { offset_bytes: next } : {}) })).value
          const raw = Buffer.from(chunk.dataBase64, 'base64')
          expect(raw.equals(stored.subarray(next, next + chunk.returnedBytes))).toBe(true)
          expect(chunk.returnedBytes).toBeLessThanOrEqual(8192)
          expect(chunk.totalBytes).toBe(stored.length)
          if (chunk.text !== null) expect(Buffer.from(chunk.text, 'utf8').equals(raw)).toBe(true)
          chunks.push(raw)
          next = chunk.nextOffsetBytes
        }
        expect(Buffer.concat(chunks).equals(stored)).toBe(true)
      }
      const euro = rawNote(db, task.id, bytes('a'.repeat(8190), '€', 'tail'), at(2))
      expect((await call('dev', 'task_journal_read', { task_id: task.id, entry_id: euro })).value).toMatchObject({ returnedBytes: 8190, nextOffsetBytes: 8190 })
      const bom = rawNote(db, task.id, bytes('﻿bom'), at(3))
      expect((await call('dev', 'task_journal_read', { task_id: task.id, entry_id: bom })).value.text).toBe('﻿bom')
    })

    // @covers: team-tasks › task_journal_read returns any entry losslessly › Offset at or past the end
    // @covers: team-tasks › task_journal_read returns any entry losslessly › Offset inside a character or invalid bytes
    test('R3–R5, R9: the end, beyond the end, schema refusals, and raw bytes with null text', async () => {
      const task = await newTask()
      const id = rawNote(db, task.id, bytes('€uro'), at(1))
      const emptyEntry = rawNote(db, task.id, bytes(), at(2))
      const end = { returnedBytes: 0, dataBase64: '', text: '', nextOffsetBytes: null }
      expect((await call('dev', 'task_journal_read', { task_id: task.id, entry_id: id, offset_bytes: 6 })).value).toMatchObject({ ...end, totalBytes: 6 })
      expect((await call('dev', 'task_journal_read', { task_id: task.id, entry_id: emptyEntry })).value).toMatchObject({ ...end, totalBytes: 0 })
      expect((await call('dev', 'task_journal_read', { task_id: task.id, entry_id: id, offset_bytes: 7 })).error).toContain('offset_bytes 7 is beyond the entry\'s 6 bytes')
      for (const offset of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '0']) {
        const { error, value } = await call('dev', 'task_journal_read', { task_id: task.id, entry_id: id, offset_bytes: offset })
        expect(value).toBeNull()
        expect(error).toContain('offset_bytes must be a safe non-negative integer')
      }
      const inside = (await call('dev', 'task_journal_read', { task_id: task.id, entry_id: id, offset_bytes: 1 })).value
      expect(inside).toMatchObject({ text: null, returnedBytes: 5, dataBase64: bytes('€uro').subarray(1).toString('base64') })
    })

    // @covers: team-tasks › task_journal_read returns any entry losslessly › Entry of another task or team
    test('R6, R10: another task\'s entry, an unknown entry, another team, and an unknown session are refused', async () => {
      const task = await newTask()
      const other = await newTask()
      const note = (await tasks.note(agent('lead'), task.id, 'hello')).id
      const foreign = (await tasks.note(agent('lead'), other.id, 'elsewhere')).id
      for (const entry of [foreign, 'note-unknown']) {
        expect((await call('dev', 'task_journal_read', { task_id: task.id, entry_id: entry })).error).toContain(`Unknown journal entry for this task: ${entry}`)
      }
      const refusal = `Task not found in this team: ${task.id}`
      expect((await call('stranger', 'task_get', { task_id: task.id })).error).toContain(refusal)
      expect((await call('stranger', 'task_journal_read', { task_id: task.id, entry_id: note })).error).toContain(refusal)
      expect((await call('ghost', 'task_journal_read', { task_id: task.id, entry_id: note })).error).toContain('Unknown calling session: ghost')
      // A forged caller, session, or team in the input is stripped: the call is the calling session's.
      const forged = { session_id: 'lead', sessionId: 'lead', caller: { kind: 'human' }, team_id: team.teamId }
      expect((await call('stranger', 'task_get', { task_id: task.id, ...forged })).error).toContain(refusal)
      expect((await call('stranger', 'task_journal_read', { task_id: task.id, entry_id: note, ...forged })).error).toContain(refusal)
      expect((await call('dev', 'task_journal_read', { task_id: task.id, entry_id: note, ...forged })).value.text).toBe('hello')
    })
  })

  describe(`the seal on the bounded task_get through the ${runtime} adapter (T14, T15)`, () => {
    // @covers: team-tasks › task_get bounds its growing lists › Results and revisions stay whole
    // @covers: team-tasks › task_get bounds its growing lists › Human detail stays complete
    test('T14: a held reviewer reads coverage withheld with every result, revision, and bound; the human detail stays whole and unsealed', async () => {
      const task = await newTask()
      for (let i = 2; i <= 55; i++) await tasks.amend(agent('lead'), task.id, { direction: `v${i}` })
      const coverage = [{ clause: 'A clean export downloads', tests: ['`src/export.test.ts` › `downloads a csv`'] }]
      let last = ''
      for (let i = 0; i < 52; i++) {
        last = (await results.submit(agent('dev'), task.id, { summary: `r${i}`, commit: `c${i}`, coverage, tests: [{ description: 'bun run test', outcome: 'pass' }] })).id
      }
      await results.handoff(agent('lead'), task.id, { kind: 'review', resultId: last, target: { kind: 'session', id: 'reviewer' }, instructions: 'Review', expectedResponse: null })
      const written = notes(task.id, 60)
      const sealed = (await call('reviewer', 'task_get', { task_id: task.id, session_id: 'dev' })).value
      expect(sealed.revisions).toHaveLength(55)
      expect(sealed.results).toHaveLength(52)
      expect(sealed.results.every((result: { coverage: unknown }) => JSON.stringify(result.coverage) === JSON.stringify({ withheld: true, clauses: 1 }))).toBe(true)
      expect(sealed.bounds.journal).toMatchObject({ returned: 50, olderRemaining: true })
      expect(ids(sealed.journal)).toEqual(ids(tasks.store.detail(task.id)!.journal).slice(-50))
      const submitter = (await call('dev', 'task_get', { task_id: task.id })).value
      expect(submitter.results[0].coverage).toEqual(coverage)
      const human = tasks.store.humanDetail(task.id)!
      expect('bounds' in human).toBe(false)
      expect(ids(human.journal)).toEqual(ids(tasks.store.detail(task.id)!.journal))
      expect(human.journal.length).toBeGreaterThanOrEqual(written.length)
      expect(human.results!.every(result => JSON.stringify(result.coverage) === JSON.stringify(coverage))).toBe(true)
    })
  })
}

describe('system callers and the shared catalogue', () => {
  test('the bounded reads keep task_get\'s system rule: an execution may read, an override or promotion may not', async () => {
    const task = await newTask()
    const note = (await tasks.note(agent('lead'), task.id, 'hello')).id
    const reads = new TaskJournalReads(tasks)
    const execution: TaskCaller = { kind: 'system', team, origin: { kind: 'execution', executionId: 'exec-1' } }
    expect((await reads.agentGet(execution, task.id)).journal.map(entry => entry.text)).toEqual(['hello'])
    expect((await reads.journalRead(execution, task.id, note)).text).toBe('hello')
    for (const origin of [{ kind: 'override' as const, decisionId: 'd-1' }, { kind: 'promotion' as const, promotionId: 'p-1' }]) {
      const caller: TaskCaller = { kind: 'system', team, origin }
      const expected = await tasks.get(caller, task.id).then(() => 'allowed', (error: Error) => error.message)
      expect(expected).not.toBe('allowed')
      await expect(reads.agentGet(caller, task.id)).rejects.toThrow(expected)
      await expect(reads.journalRead(caller, task.id, note)).rejects.toThrow(expected)
    }
  })

  test('both runtimes register task_get and task_journal_read from one catalogue, allowed without cards', async () => {
    expect(TASK_TOOL_NAMES).toContain('task_journal_read')
    expect(TEAM_ALLOWED_TOOLS).toContain('mcp__kawai-team__task_journal_read')
    const table = teamToolTable(mailbox, 'dev', services())
    const spec = teamNamespaceSpec(table)
    const codexTools = spec.type === 'namespace' ? spec.tools : []
    const server = await createMailboxServer(mailbox, 'dev', services())
    servers.push(server as unknown as { instance: { close: () => Promise<void> } })
    const claudeNames = Object.keys((server.instance as unknown as { _registeredTools: Registered })._registeredTools)
    const taskNames = (names: string[]) => names.filter(name => name.startsWith('task_')).sort()
    expect(taskNames(claudeNames)).toEqual([...TASK_TOOL_NAMES].sort())
    expect(taskNames(codexTools.map(tool => tool.name))).toEqual([...TASK_TOOL_NAMES].sort())
    const shape = (name: string) => Object.keys(table.find(tool => tool.name === name)!.schema.shape).sort()
    expect(shape('task_get')).toEqual(['journal_before', 'journal_limit', 'task_id'])
    expect(shape('task_journal_read')).toEqual(['entry_id', 'offset_bytes', 'task_id'])
    const limit = (z.toJSONSchema(table.find(tool => tool.name === 'task_get')!.schema) as { properties: Record<string, Record<string, unknown>> }).properties.journal_limit!
    expect(limit).toMatchObject({ type: 'integer', minimum: 1, maximum: 200 })
  })

  test('the descriptions name the paging and the lossless reader and promise no full journal', () => {
    const table = teamToolTable(mailbox, 'dev', services())
    const text = (name: string) => table.find(tool => tool.name === name)!.description
    for (const term of ['journal_before', 'journal_limit', 'task_journal_read', '2,000 stored bytes', 'totalBytes', 'resumeOffsetBytes']) {
      expect(text('task_get')).toContain(term)
    }
    expect(text('task_journal_read')).toContain('8,192 stored bytes')
    for (const name of ['task_get', 'task_journal_read']) expect(text(name)).not.toMatch(/whole journal|full journal|in full/)
  })
})
