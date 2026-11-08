// Contract carry-forward (implementation-contract design D3, table C1–C7):
// the rows run verbatim through TaskService over a real SQLite store — the
// agent path (`task_create`/`task_amend` tool handlers) for C1–C5 and the
// human draft-and-publish path for C5–C7 — plus the payload diff naming
// `contract` and a draft's unparsed contract text across a restart.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import { initDatabase, type ChatSessionRecord, type SessionDatabase } from '../db'
import { MailboxStore } from '../team/mailboxStore'
import { TaskStore } from '../team/taskStore'
import { TaskService } from '../team/TaskService'
import { taskHandlers } from '../team/taskTools'
import { contractHash } from '../team/contractHash'
import { clearTeamCache, resolveTeam, type TeamIdentity } from '../team/teamIdentity'
import { parseContract, type ImplementationContract } from '../../shared/implementationContract'
import type { TeamTask } from '../../shared/teamTasks'

const contractText = (invariants: string[]) => ['## Implementation contract', '### Acceptance', '- A1: Lists tasks',
  '### Invariants', ...invariants.map((text, index) => `- I${index + 1}: ${text}`), '### Scope', '- `src/server/team/**`',
  '### Verification', '- V1: check passes', '### Excluded'].join('\n')
const A = contractText(['Never twice'])
const B = contractText(['Never twice', 'Never thrice'])
/** Two problems: a duplicate id and an empty Verification part. */
const BAD = A.replace('- I1: Never twice', '- I1: Never twice\n- I1: Again').replace('- V1: check passes', '')
const parsed = (text: string): ImplementationContract => {
  const result = parseContract(text)
  if (!result.contract) throw new Error(JSON.stringify(result.problems))
  return result.contract
}

let root: string
let repo: string
let team: TeamIdentity
let session: SessionDatabase
let store: TaskStore
let service: TaskService
const records = new Map<string, ChatSessionRecord>()
const human = () => ({ kind: 'human' as const, team })

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-contract-carry-')))
  repo = path.join(root, 'repo')
  for (const args of [['init', '-q', repo], ['-C', repo, '-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init']]) {
    const result = spawnSync('git', args, { encoding: 'utf8', env: cleanGitEnv() })
    if (result.status !== 0) throw new Error(result.stderr)
  }
  fs.mkdirSync(path.join(repo, '.kawai', 'groups'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'leads.md'), '---\ncanCreateTasks: true\n---\nLead.')
  records.set('lead', { sessionId: 'lead', groupId: 'leads', projectPath: repo, name: 'lead', sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '' })
  clearTeamCache()
  team = await resolveTeam(repo)
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

const dbPath = () => path.join(root, 'tasks.db')
const openService = () => {
  session = initDatabase({ path: dbPath() })
  store = new TaskStore(session.db, new MailboxStore(session.db))
  service = new TaskService(store, { getSession: id => records.get(id), homeDir: path.join(root, 'home') })
}
beforeEach(() => { fs.rmSync(dbPath(), { force: true }); openService() })
afterEach(() => session.close())

const lead = () => taskHandlers(service, 'lead')
const leadCreate = (contract?: string) => lead().task_create({ title: 'Export', direction: 'v1', ...(contract !== undefined ? { contract } : {}) }) as Promise<TeamTask>
const revisionsOf = (taskId: string) => store.revisions(taskId)
const hashes = (taskId: string) => revisionsOf(taskId).map(revision => revision.contractHash)
const hashOf = (text: string) => contractHash(parsed(text))

interface Row {
  id: string
  path: 'agent' | 'human'
  /** Revision 1's contract text, or none. */
  previous: string | null
  /** The amendment's contract: omitted (undefined) or text (blank = the human's clear). */
  input: string | undefined
  /** The new revision's contract hash, or the refusal it raises. */
  expect: { hash: string | null } | { refused: RegExp }
}
const ROWS: Row[] = [
  { id: 'C1', path: 'agent', previous: null, input: undefined, expect: { hash: null } },
  { id: 'C2', path: 'agent', previous: null, input: A, expect: { hash: hashOf(A) } },
  { id: 'C3', path: 'agent', previous: A, input: undefined, expect: { hash: hashOf(A) } },
  // The tools cannot express a clear: an agent's blank contract is omitted (D3).
  { id: 'C3', path: 'agent', previous: A, input: '', expect: { hash: hashOf(A) } },
  { id: 'C4', path: 'agent', previous: A, input: B, expect: { hash: hashOf(B) } },
  { id: 'C5', path: 'agent', previous: A, input: BAD, expect: { refused: /does not parse[\s\S]*line 6: [\s\S]*line \d+: Verification/ } },
  { id: 'C5', path: 'agent', previous: null, input: BAD, expect: { refused: /does not parse/ } },
  { id: 'C5', path: 'human', previous: A, input: BAD, expect: { refused: /does not parse/ } },
  { id: 'C6', path: 'human', previous: A, input: '', expect: { refused: /contract cannot be removed/ } },
  { id: 'C7', path: 'human', previous: null, input: '', expect: { hash: null } },
  // The human's form re-sending the same contract leaves the hash as it was.
  { id: 'C4', path: 'human', previous: A, input: A, expect: { hash: hashOf(A) } },
]

// @covers: team-tasks › Amendments carry the contract forward or replace it › Direction-only amendment
// @covers: team-tasks › Amendments carry the contract forward or replace it › Contract replaced
// @covers: team-tasks › Amendments carry the contract forward or replace it › Contract cannot be removed
// @covers: task-revision-publication › Publication records one immutable revision per intent › Malformed contract is refused
// @covers: task-revision-publication › Agent creators publish without drafts › Malformed agent contract
test('carry-forward rows C1–C7: omitted carries, a contract replaces, a malformed one or a clear is refused with nothing written', async () => {
  for (const row of ROWS) {
    const label = `${row.id} (${row.path}, previous ${row.previous === null ? 'none' : 'contract'}, input ${row.input === undefined ? 'omitted' : row.input === '' ? 'blank' : 'text'})`
    const task = await leadCreate(row.previous ?? undefined)
    const before = hashes(task.id)
    expect(before, label).toEqual([row.previous === null ? null : hashOf(row.previous)])
    const contract = row.input === undefined ? {} : { contract: row.input }
    const publish = row.path === 'agent'
      ? lead().task_amend({ task_id: task.id, direction: 'v2', ...contract })
      : (async () => {
        await service.saveDraft(human(), task.id, { direction: 'v2', rationale: 'r', ...contract })
        return service.publish(human(), task.id, { direction: 'v2', rationale: 'r', baseRevision: 1, requestKey: `k-${row.id}`, fromDraft: true, ...contract })
      })()
    if ('refused' in row.expect) {
      await expect(publish, label).rejects.toThrow(row.expect.refused)
      expect(hashes(task.id), label).toEqual(before)
      // A refused human publication keeps the draft (C5, C6).
      if (row.path === 'human') expect(store.drafts.get(task.id)?.contractText, label).toBe(row.input!)
    } else {
      await publish
      expect(hashes(task.id), label).toEqual([...before, row.expect.hash])
      const latest = revisionsOf(task.id)[1]!
      expect(latest.contract ? contractHash(latest.contract) : null, label).toBe(row.expect.hash)
    }
  }
})

// @covers: team-tasks › A task revision may carry a contract › Lead creates a task with a contract
test('task_create with a well-formed contract stores it in revision 1 with identity r1#<hash>', async () => {
  const task = await leadCreate(A)
  const hash = hashOf(A)
  expect(task).toMatchObject({ revision: 1, contractHash: hash, identity: `r1#${hash.slice(0, 12)}`, contract: parsed(A) })
  expect(revisionsOf(task.id)[0]).toMatchObject({ contractHash: hash, identity: `r1#${hash.slice(0, 12)}` })
})

// @covers: team-tasks › A task revision may carry a contract › Malformed contract refused
test('task_create with a contract lacking the Scope heading is refused with every problem and creates nothing', async () => {
  const noScope = A.replace('### Scope\n', '')
  await expect(leadCreate(noScope)).rejects.toThrow(/does not parse[\s\S]*line \d+: [\s\S]*Scope/)
  expect(store.list(team.teamId)).toEqual([])
})

// @covers: team-tasks › A task revision may carry a contract › Task without a contract
test('a human task without a contract has none in revision 1, and a text identity', async () => {
  const task = await service.create(human(), { title: 'Export', direction: 'v1', contract: '' })
  expect(task).toMatchObject({ contract: null, contractHash: null })
  expect(task.identity).toMatch(/^r1#[0-9a-f]{12}$/)
})

// @covers: task-revision-publication › Publication records one immutable revision per intent › Reused key with a different payload is refused
test('a reused key with a different contract is refused naming contract, on publication and on creation', async () => {
  const task = await leadCreate(A)
  const publish = (contract: string) => service.publish(human(), task.id, { direction: 'v2', rationale: 'r', baseRevision: 1, requestKey: 'same', contract })
  await publish(B)
  expect(await publish(B)).toMatchObject({ replay: true })
  await expect(publish(contractText(['Other']))).rejects.toThrow('Request key already used with a different contract')
  expect(revisionsOf(task.id)).toHaveLength(2)

  const create = (contract: string) => service.create(human(), { title: 'T', direction: 'd', requestKey: 'create-same', contract })
  const first = await create(A)
  expect((await create(A)).id).toBe(first.id)
  await expect(create(B)).rejects.toThrow('different contract')
})

// @covers: task-revision-publication › A draft never publishes › Draft contract survives restart unparsed
test('a draft keeps unparsed contract text across a restart and publishes nothing', async () => {
  const task = await leadCreate(A)
  await service.saveDraft(human(), task.id, { direction: 'v2', rationale: 'r', contract: BAD })
  session.close()
  openService()
  expect(store.drafts.get(task.id)).toMatchObject({ contractText: BAD, direction: 'v2' })
  expect(parseContract(store.drafts.get(task.id)!.contractText!).problems.length).toBeGreaterThan(0)
  expect(revisionsOf(task.id)).toHaveLength(1)
})
