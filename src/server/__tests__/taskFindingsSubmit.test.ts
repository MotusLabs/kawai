// Structured findings through the production path (review-findings-ledger
// 2.2, D4–D5): the task_submit_findings handler over TaskResultService and
// TaskFindingService against a real store — the gate against the pinned
// contract, the derived verdict, refusals that write nothing (I3), what
// counts, replacement and finality, and ids that are never reused (P2).
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanGitEnv } from '../git/gitCommand'
import { initDatabase, type ChatSessionRecord, type SessionDatabase } from '../db'
import { AssignmentStore } from '../team/assignmentStore'
import { MailboxStore } from '../team/mailboxStore'
import { TaskStore } from '../team/taskStore'
import { TaskService, type TaskCaller } from '../team/TaskService'
import { TaskResultService } from '../team/TaskResultService'
import { taskHandlers } from '../team/taskTools'
import { clearTeamCache, resolveTeam, type TeamIdentity } from '../team/teamIdentity'
import { mulberry32 } from '../../shared/__tests__/contractFixtures'

function git(args: string[], cwd?: string) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: cleanGitEnv() })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
}

let root: string
let repo: string
let team: TeamIdentity
let db: SessionDatabase
let records: Map<string, ChatSessionRecord>
let tasks: TaskService
let results: TaskResultService
const agent = (sessionId: string): TaskCaller => ({ kind: 'agent', sessionId })
const row = (sessionId: string, groupId: string | null): ChatSessionRecord => ({
  sessionId, groupId, projectPath: repo, name: sessionId, sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '',
})
const CONTRACT = ['## Implementation contract', '### Acceptance', '- A1: Lists tasks', '- A2: Pins revisions', '### Invariants', '- I1: Never twice',
  '### Scope', '- `src/server/team/**`', '### Verification', '- V1: check passes', '### Excluded', '- X1: No metrics'].join('\n')

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-findings-submit-')))
  repo = path.join(root, 'repo')
  git(['init', '-q', repo])
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'], repo)
  fs.mkdirSync(path.join(repo, '.kawai', 'groups'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'leads.md'), '---\ncanCreateTasks: true\n---\nLead.')
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'devs.md'), 'Build.')
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'reviewers.md'), 'Review.')
  clearTeamCache()
  team = await resolveTeam(repo)
})
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

beforeEach(() => {
  records = new Map([['lead', row('lead', 'leads')], ['dev', row('dev', 'devs')], ['reviewer', row('reviewer', 'reviewers')], ['other', row('other', 'reviewers')]])
  db?.close()
  db = initDatabase({ path: path.join(fs.mkdtempSync(path.join(root, 'db-')), 'tasks.db') })
  const mail = new MailboxStore(db.db)
  const store = new TaskStore(db.db, mail, new AssignmentStore(db.db, mail))
  tasks = new TaskService(store, { getSession: id => records.get(id) })
  results = new TaskResultService(tasks, { getSession: id => records.get(id) })
})

const handlers = (sessionId: string) => taskHandlers(tasks, sessionId, results) as Record<string, (input: unknown) => Promise<any>>
const submitted = (taskId: string) => tasks.store.results.listByTask(taskId).flatMap(result => result.findings)
async function manualTask() {
  const task = await tasks.create(agent('lead'), { title: 'Export', direction: 'v1', contract: CONTRACT })
  const result = await results.submit(agent('dev'), task.id, { summary: 'r1', commit: 'abc' })
  return { task, result }
}
const p1 = (clause: string, file: string) => ({ level: 'P1', clause, evidence: `${file}:10`, impact: 'wrong rows' })

test('a structured submission through the tool derives its verdict and lists every class', async () => {
  const { task, result } = await manualTask()
  const reply = await handlers('reviewer').task_submit_findings({
    task_id: task.id, result_id: result.id, kind: 'review',
    items: [p1('A1', 'src/server/team/taskStore.ts'), { level: 'P2', clause: 'A2', evidence: 'x', impact: 'y' }, p1('X1', 'src/server/team/a.ts'), { level: 'P0', clause: 'I1', impact: 'z' }],
  })
  expect(reply.verdict).toBe('fail')
  expect(reply.structured).toBe(true)
  expect(reply.gate.items.map((item: { id: string; class: string }) => `${item.id}:${item.class}`)).toEqual(['F1:accepted', 'F2:advisory', 'F3:out-of-contract', 'F4:unsupported'])
  expect(reply.items[0].clause).toBe(`${task.identity} › A1`)
  expect(results.findingsLedger.ledger(task.id).map(entry => entry.state)).toEqual(['accepted', 'advisory', 'out-of-contract', 'unsupported'])
})

// @covers: review-findings › The verdict is derived from the ledger › A contradicting verdict is refused
test('a contradicting verdict is refused and nothing is written', async () => {
  const { task, result } = await manualTask()
  const journal = tasks.store.journal(task.id).length
  await expect(handlers('reviewer').task_submit_findings({ task_id: task.id, result_id: result.id, kind: 'review', verdict: 'pass', items: [p1('A1', 'src/server/team/a.ts')] }))
    .rejects.toThrow('differs from the derived verdict fail')
  expect(submitted(task.id)).toEqual([])
  expect(db.db.prepare('SELECT count(*) AS n FROM team_task_finding_items').get()).toEqual({ n: 0 })
  expect(tasks.store.journal(task.id)).toHaveLength(journal)
})

// @covers: task-results › Findings are bound to the result examined › Structured findings carry a derived verdict
test('structured findings without a verdict attach to the result with the derived verdict', async () => {
  const { task, result } = await manualTask()
  await handlers('reviewer').task_submit_findings({ task_id: task.id, result_id: result.id, kind: 'review', items: [p1('A1', 'src/server/team/a.ts')] })
  const [stored] = tasks.store.results.get(result.id)!.findings
  expect(stored).toMatchObject({ verdict: 'fail', structured: true, counted: true, author: { kind: 'agent', sessionId: 'reviewer' } })
  expect(stored!.items.map(item => [item.findingId, item.class])).toEqual([['F1', 'accepted']])
})

// @covers: task-results › Findings are bound to the result examined › Text findings outside plan execution
test('text findings on a manual task keep their verdict and stay unstructured', async () => {
  const { task, result } = await manualTask()
  await handlers('reviewer').task_submit_findings({ task_id: task.id, result_id: result.id, kind: 'review', verdict: 'fail', findings: 'Header missing' })
  expect(submitted(task.id).map(entry => [entry.structured, entry.verdict, entry.findings])).toEqual([[false, 'fail', 'Header missing']])
  expect(results.findingsLedger.ledger(task.id)).toEqual([])
  await expect(handlers('reviewer').task_submit_findings({ task_id: task.id, result_id: result.id, kind: 'review', findings: 'no verdict' }))
    .rejects.toThrow('needs a verdict')
})

// @covers: review-findings › One review per result counts, and it becomes final › A corrected review replaces the first
test('a corrected review on the same result replaces the first', async () => {
  const { task, result } = await manualTask()
  const first = await handlers('reviewer').task_submit_findings({ task_id: task.id, result_id: result.id, kind: 'review', items: [p1('A1', 'src/server/team/a.ts')] })
  const second = await handlers('reviewer').task_submit_findings({ task_id: task.id, result_id: result.id, kind: 'review', items: [] })
  expect(second.gate.replaced).toBe(first.id)
  expect(results.findingsLedger.ledger(task.id)).toEqual([])
  expect(submitted(task.id).map(entry => [entry.id, entry.counted, entry.replacedBy])).toEqual([[first.id, false, second.id], [second.id, true, null]])
})

// @covers: review-findings › One review per result counts, and it becomes final › Findings on a result become final
test('a disputed finding makes its review final', async () => {
  const { task, result } = await manualTask()
  await handlers('reviewer').task_submit_findings({ task_id: task.id, result_id: result.id, kind: 'review', items: [p1('A1', 'src/server/team/a.ts')] })
  tasks.store.findings.insertEvent({ taskId: task.id, findingId: 'F1', kind: 'disputed', resultId: result.id, actor: { kind: 'agent', sessionId: 'dev' }, sourceKey: 'dispute:test' })
  await expect(handlers('reviewer').task_submit_findings({ task_id: task.id, result_id: result.id, kind: 'review', items: [] }))
    .rejects.toThrow('F1 was disputed after that review')
  expect(results.findingsLedger.ledger(task.id).map(entry => entry.state)).toEqual(['disputed'])
})

test('a review of an older result is final once a newer result\'s review counts, and a verify round disposes', async () => {
  const { task, result } = await manualTask()
  await handlers('reviewer').task_submit_findings({ task_id: task.id, result_id: result.id, kind: 'review', items: [p1('A1', 'src/server/team/a.ts')] })
  const r2 = await results.submit(agent('dev'), task.id, { summary: 'r2', commit: 'def' })
  await expect(handlers('reviewer').task_submit_findings({ task_id: task.id, result_id: r2.id, kind: 'review', items: [] })).rejects.toThrow('missing F1')
  const verify = await handlers('reviewer').task_submit_findings({ task_id: task.id, result_id: r2.id, kind: 'review', items: [], dispositions: [{ id: 'F1', disposition: 'resolved' }] })
  expect(verify.verdict).toBe('pass')
  await expect(handlers('reviewer').task_submit_findings({ task_id: task.id, result_id: result.id, kind: 'review', items: [] }))
    .rejects.toThrow('a review of a newer result already counts')
})

// @covers: review-findings › One review per result counts, and it becomes final › A non-claimant's findings do not count
test('on a plan change\'s task, a non-claimant\'s findings are recorded but do not count, and ids are never reused', async () => {
  const store = tasks.store
  const task = store.create({ teamId: team.teamId, title: 'Change', direction: 'go', creator: { kind: 'human', sessionId: null }, planId: 'plan-1', planChange: 'alpha' })
  const result = await results.submit(agent('dev'), task.id, { summary: 'r1', commit: 'abc' })
  const reply = await handlers('other').task_submit_findings({ task_id: task.id, result_id: result.id, kind: 'review', items: [{ level: 'P1', clause: task.identity, evidence: 'a.ts:1', impact: 'x' }] })
  expect([reply.counted, reply.gate.items[0].class]).toEqual([false, 'accepted'])
  expect(results.findingsLedger.ledger(task.id)).toEqual([])
  const next = await handlers('reviewer').task_submit_findings({ task_id: task.id, result_id: result.id, kind: 'review', items: [{ level: 'P2', clause: task.identity, evidence: 'b', impact: 'y' }] })
  expect(next.gate.items.map((item: { id: string }) => item.id)).toEqual(['F2'])
})

// P2 (seed 0xF1ED6E5, 300 cases): across seeded sequences of counted,
// replaced, and refused submissions, ids are unique per task, strictly
// increasing in allocation order, and never reused.
test('P2 finding ids are unique, increasing, and never reused', async () => {
  const rand = mulberry32(0xf1ed6e5)
  let cases = 0
  while (cases < 300) {
    const { task } = await manualTask()
    let result = tasks.store.results.outstanding(task.id)!
    const allocated: string[] = []
    for (let step = 0; step < 6 && cases < 300; step++, cases++) {
      const roll = rand()
      if (roll < 0.25) { result = await results.submit(agent('dev'), task.id, { summary: `r${step}`, commit: `c${step}` }); continue }
      const open = results.findingsLedger.ledger(task.id).filter(entry => ['accepted', 'still-open', 'reopened'].includes(entry.state))
      const count = 1 + Math.floor(rand() * 3)
      const items = Array.from({ length: count }, (_, k) => ({ level: rand() < 0.5 ? 'P2' : 'P1', clause: 'A1', evidence: `src/server/team/f${step}-${k}-${Math.floor(rand() * 1e6)}.ts:1`, impact: 'x' }))
      const dispositions = rand() < 0.8 ? open.map(entry => ({ id: entry.id, disposition: 'resolved' })) : []
      try {
        const reply = await handlers(rand() < 0.5 ? 'reviewer' : 'other').task_submit_findings({ task_id: task.id, result_id: result.id, kind: 'review', items, dispositions })
        for (const item of reply.gate.items) if (item.kind === 'finding' && !allocated.includes(item.id)) allocated.push(item.id)
      } catch { /* a refused submission allocates nothing */ }
    }
    const numbers = allocated.map(id => Number(id.slice(1)))
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b))
    expect(new Set(numbers).size).toBe(numbers.length)
    const stored = db.db.prepare("SELECT DISTINCT finding_id FROM team_task_finding_items WHERE task_id = ? AND item_kind = 'finding'").all(task.id) as Array<{ finding_id: string }>
    expect(stored.map(entry => entry.finding_id).sort()).toEqual([...allocated].sort())
  }
}, 60_000)

// Re-map on publication (D9, table RM) through task_amend and the human path.
const CONTRACT_A1 = CONTRACT.replace('- A2: Pins revisions\n', '').replace('- A1: Lists tasks', '- A1: Lists every task')
async function twoOpen() {
  const { task, result } = await manualTask()
  await handlers('reviewer').task_submit_findings({ task_id: task.id, result_id: result.id, kind: 'review',
    items: [p1('A1', 'src/server/team/a.ts'), p1('A2', 'src/server/team/b.ts')] })
  return task
}
const ledgerOf = (taskId: string) => results.findingsLedger.ledger(taskId).map(entry => [entry.id, entry.state, entry.clause])

test('RM1/RM2 task_amend with a new contract re-maps A1 by id and supersedes A2, journaling each, once', async () => {
  const task = await twoOpen()
  const amended = await handlers('lead').task_amend({ task_id: task.id, contract: CONTRACT_A1 })
  const identity = tasks.store.revisions(task.id).at(-1)!.identity!
  expect(identity).not.toBe(task.identity)
  expect(ledgerOf(task.id)).toEqual([['F1', 'accepted', `${identity} › A1`], ['F2', 'superseded', `${task.identity} › A2`]])
  const journal = tasks.store.journal(task.id).map(entry => entry.text)
  expect(journal.filter(text => text.startsWith('Re-mapped F1') || text.startsWith('Superseded F2'))).toHaveLength(2)
  expect(amended).toBeDefined()
  const { remapFindings } = await import('../team/findingRemap')
  expect(remapFindings(tasks.store, task.id, tasks.store.revisions(task.id).at(-1)!)).toBe(0)
  expect(tasks.store.findings.events(task.id)).toHaveLength(2)
})

test('RM6 an amendment that keeps the contract writes no event', async () => {
  const task = await twoOpen()
  await handlers('lead').task_amend({ task_id: task.id, direction: 'v2' })
  expect(tasks.store.findings.events(task.id)).toEqual([])
  expect(ledgerOf(task.id).map(entry => entry[1])).toEqual(['accepted', 'accepted'])
})

test('RM2 through the human path: a replacement contract supersedes both; a replayed publication writes nothing new', async () => {
  const task = await twoOpen()
  const human: TaskCaller = { kind: 'human', team }
  const other = CONTRACT.replace('- A1: Lists tasks\n- A2: Pins revisions', '- A3: Exports rows')
  await tasks.publish(human, task.id, { contract: other, requestKey: 'replace-1' })
  expect(ledgerOf(task.id).map(entry => entry[1])).toEqual(['superseded', 'superseded'])
  const replay = await tasks.publish(human, task.id, { contract: other, requestKey: 'replace-1' })
  expect(replay.replay).toBe(true)
  expect(tasks.store.findings.events(task.id)).toHaveLength(2)
  expect(results.findingsLedger.effectiveVerdict(submitted(task.id).at(-1)!)).toBe('pass')
})

test('RM3 a revision citation on a task without a contract re-maps to the new text identity', async () => {
  const task = await tasks.create(agent('lead'), { title: 'Plain', direction: 'v1' })
  const result = await results.submit(agent('dev'), task.id, { summary: 'r1', commit: 'abc' })
  await handlers('reviewer').task_submit_findings({ task_id: task.id, result_id: result.id, kind: 'review', items: [p1(task.identity!, 'src/a.ts')] })
  await handlers('lead').task_amend({ task_id: task.id, direction: 'v2' })
  const identity = tasks.store.revisions(task.id).at(-1)!.identity!
  expect(ledgerOf(task.id)).toEqual([['F1', 'accepted', identity]])
})
