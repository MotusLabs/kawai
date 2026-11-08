// The fix instruction's findings builder (review-findings-ledger D7) over a
// real store: the fold's blocking findings and the others' count, and the
// pre-upgrade fallback — a round decided on a text row keeps today's text.
import { afterAll, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase, type SessionDatabase } from '../db'
import { AssignmentStore } from '../team/assignmentStore'
import { MailboxStore } from '../team/mailboxStore'
import { TaskStore } from '../team/taskStore'
import { TaskFindingService } from '../team/TaskFindingService'
import { fixFindings } from '../plans/execution/fixFindings'
import { fixInstruction } from '../plans/execution/instructions'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-fix-findings-'))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))
let db: SessionDatabase
let store: TaskStore
beforeEach(() => {
  db?.close()
  db = initDatabase({ path: path.join(fs.mkdtempSync(path.join(root, 'db-')), 'tasks.db') })
  const mail = new MailboxStore(db.db)
  store = new TaskStore(db.db, mail, new AssignmentStore(db.db, mail))
})

const reviewer = { kind: 'agent' as const, sessionId: 'rev' }
function withResult() {
  const task = store.create({ teamId: 'team', title: 'T', direction: 'Build', creator: { kind: 'human', sessionId: null } })
  const result = store.results.insert({ teamId: 'team', taskId: task.id, summary: 's', commit: 'abc', diff: null, worktree: null, tests: [], limitations: null, taskRevision: 1, submittedBy: { kind: 'agent', sessionId: 'dev' } })
  return { task: store.get(task.id)!, result }
}
const base = {
  planTitle: 'P', revision: 1, change: 'c', worktree: '/w', branch: 'b', baseline: 'b0', head: 'h0', acceptance: [], extraChecks: [], guidance: '',
  taskId: 't', manifestHash: 'm', integrationBranch: null, failingChecks: [], fixRounds: 0, continueFrom: 'h0',
}

test('a round decided on a pre-upgrade text row keeps its text under Review findings', () => {
  const { task, result } = withResult()
  const text = store.results.insertFindings({ teamId: 'team', taskId: task.id, resultId: result.id, handoffId: null, kind: 'review', verdict: 'fail', findings: 'the e2e test fails', author: reviewer })
  const findings = fixFindings(store, task.id, { resultId: result.id, verdictFindingsId: text.id })
  expect(findings).toMatchObject({ blocking: [], others: 0, legacyTexts: ['the e2e test fails'] })
  expect(fixInstruction({ ...base, findings })).toContain('Review findings:\nthe e2e test fails')
})

test('a structured round lists the fold, never the stored notes', () => {
  const { task, result } = withResult()
  const service = new TaskFindingService(store)
  const outcome = service.submit({ teamId: 'team', task, result, author: reviewer, handoffId: null, counted: true, submission: { kind: 'review', notes: 'NOTES', findings: [
    { level: 'P1', clause: task.identity, evidence: 'src/a.ts:1 off by one', impact: 'wrong' },
    { level: 'P2', clause: task.identity, evidence: 'src/b.ts:1', impact: 'style' },
  ], dispositions: [] } })
  const findings = fixFindings(store, task.id, { resultId: result.id, verdictFindingsId: outcome.findings.id }, ['Kawai note'])
  expect(findings.blocking.map(row => row.id)).toEqual(['F1'])
  expect(findings.others).toBe(1)
  expect(findings.legacyTexts).toEqual(['Kawai note'])
  const text = fixInstruction({ ...base, findings })
  expect(text).toContain(`F1 (P1, ${task.identity}): src/a.ts:1 off by one`)
  expect(text).toContain('1 other finding is (advisory, unsupported, out of contract) in task_get; it is not required.')
  expect(text).not.toContain('NOTES')
})
