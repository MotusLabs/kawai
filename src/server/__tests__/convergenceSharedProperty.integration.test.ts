// Property P4 of review convergence (task 9.2, design "Properties", seed
// 0x5161A1, 300 ledgers; invariant I3): the signals are pure and shared.
// Seeded ledgers — findings raised on two clauses and an excluded one,
// resolved, kept open, regressed, and re-raised, passes, and sometimes a
// closed diagnosis anchoring the window — are written through the real
// TaskFindingService, with each review's round row recording the blocking
// ids it left. Then `executionView`'s counts equal the `openAfter` values of
// `convergenceWindow(reviewSnapshots(...))`, and the executor's signals
// (`roundSignals`) equal `convergenceSignals`, on the same store reads.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { blocking, foldLedger } from '../../shared/findingsLedger'
import { convergenceSignals, convergenceWindow, reviewSnapshots } from '../../shared/reviewConvergence'
import { mulberry32 } from '../../shared/__tests__/contractFixtures'
import { initDatabase, type SessionDatabase } from '../db'
import { roundSignals } from '../plans/execution/diagnosisOpen'
import { DiagnosisStore } from '../plans/execution/diagnosisStore'
import type { ChangeRow, RoundRow } from '../plans/execution/executionRows'
import { changeConvergence } from '../plans/execution/executionView'
import { AssignmentStore } from '../team/assignmentStore'
import { MailboxStore } from '../team/mailboxStore'
import { TaskFindingService } from '../team/TaskFindingService'
import { TaskStore } from '../team/taskStore'
import { CONTRACT, nextReview, pick } from './convergenceGenerator'
import { propertyCases } from './helpers/propertyCases'

const SEED = 0x5161A1
const CASES = 300

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-convergence-p4-'))
let db: SessionDatabase
let store: TaskStore
let service: TaskFindingService
beforeAll(() => {
  db = initDatabase({ path: path.join(root, 'p4.db') })
  const mail = new MailboxStore(db.db)
  store = new TaskStore(db.db, mail, new AssignmentStore(db.db, mail))
  // Every task here is a plan change's (owned): the manual notice stays out of the way.
  service = new TaskFindingService(store, { ownedByExecution: () => true })
})
afterAll(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }) })

const reviewer = { kind: 'agent' as const, sessionId: 'rev' }
test('P4: the view\'s counts and the executor\'s signals equal the shared module\'s on the same ledger (seed 0x5161A1, 300 ledgers)', () => {
  const reached = new Map<string, number>()
  const tally = (key: string) => reached.set(key, (reached.get(key) ?? 0) + 1)
  const diagnoses = new DiagnosisStore(db.db)
  for (let index = 0; index < propertyCases(CASES); index++) {
    const rng = mulberry32(SEED + index)
    const task = store.create({ teamId: 'team', title: `P4 ${index}`, direction: 'Build', creator: { kind: 'human', sessionId: null }, contract: CONTRACT })
    const executionId = `exec-${index}`
    const reviews = 1 + Math.floor(rng() * 9)
    let newestResult: string | null = null
    const submissionIds: string[] = []
    for (let n = 0; n < reviews; n++) {
      const result = store.results.insert({ teamId: 'team', taskId: task.id, summary: `r${n}`, commit: `c${n}`, diff: null, worktree: null, tests: [], limitations: null, taskRevision: 1, submittedBy: { kind: 'agent', sessionId: 'dev' } })
      try {
        const outcome = service.submit({ teamId: 'team', task: store.get(task.id)!, result, author: reviewer, handoffId: null, counted: true, submission: { kind: 'review', ...nextReview(rng, service.ledger(task.id), n) } })
        submissionIds.push(outcome.findings.id)
        newestResult = result.id
        // The round's own record of what it left blocking (the I3 mutant reads these).
        db.db.prepare(`INSERT INTO plan_execution_rounds (id, execution_id, change, attempt_id, number, result_id, commit_sha, fix_round, blocking_ids, outcome)
          VALUES (?, ?, 'c', 'a', ?, ?, 'sha', 1, ?, ?)`).run(`round-${index}-${n}`, executionId, n + 1, result.id, JSON.stringify(blocking(service.ledger(task.id)).map(row => row.id)), outcome.verdict)
        tally(outcome.verdict)
      } catch (error) {
        if (!String(error).includes('nothing was written') && !String(error).includes('Nothing was written')) throw error
        tally('refused')
      }
    }
    let anchor: string | null = null
    if (submissionIds.length > 1 && rng() < 0.35) {
      anchor = pick(rng, submissionIds.slice(0, -1))
      const row = diagnoses.insert({ executionId, change: 'c', roundId: `anchor-${index}`, reviewSubmissionId: anchor, signals: [], cardId: 'card', messageId: null })
      diagnoses.close(row.id, { reason: 'decision', outcome: 'fix', decisionId: 'd' })
      tally('anchored')
    }
    const submissions = store.findings.countedSubmissions(task.id)
    const events = store.findings.events(task.id)
    const window = convergenceWindow(reviewSnapshots(submissions, events), anchor)
    const signals = convergenceSignals(window, foldLedger(submissions, events))
    for (const signal of signals) tally(signal.kind)
    if (window.length < submissions.length) tally('window-trimmed')
    const view = changeConvergence(db.db, executionId, 'c', task.id)
    expect({ index, counts: view?.counts ?? null }).toEqual({ index, counts: submissions.length === 0 ? null : window.map(review => review.openAfter) })
    if (newestResult === null) continue
    const change = { executionId, change: 'c', taskId: task.id } as ChangeRow
    const round = { resultId: newestResult, blockingIds: [] } as unknown as RoundRow
    expect({ index, signals: roundSignals({ tasks: store }, diagnoses, change, round).signals }).toEqual({ index, signals })
  }
  // The generator reaches every signal, passes, refusals, anchored and trimmed
  // windows over its declared 300 ledgers; a reduced local run's first 75 do
  // not reach S1, so only the full profile (CI, --full-properties) asserts it.
  if (propertyCases(CASES) === CASES) for (const key of ['S1', 'S2', 'S3', 'S4', 'S5', 'pass', 'fail', 'anchored', 'window-trimmed']) expect({ key, reached: (reached.get(key) ?? 0) > 0 }).toEqual({ key, reached: true })
// 300 cases write a few thousand ledger rows: about 30 s alone, longer under the full suite's load.
}, 240_000)
