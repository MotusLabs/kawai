// Property P2 of review convergence (task 9.1, design "Properties", seed
// 0xC0FE1D, 300 cases; invariant I1): a signal never decides a finding. At
// the service seam, seeded commands run through the real services on tasks
// no execution owns — counted reviews (TaskResultService, so the manual-task
// notice computes the signals after every one), disputes and the creator's
// uphold or reject, and a diagnosis's Reject decision, written as the
// diagnosis stage writes it (`rejected` naming the decision). Then:
// - a notice changes no finding: the fold right after a review's own
//   submission equals the fold after its notice;
// - every `rejected` event names a diagnosis decision the generator recorded,
//   or answers a creator's reject the generator issued; the store's fold
//   without the diagnosis-named events equals the fold of the generator's
//   own commands, so the states differ only by those events.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { blocking, foldLedger, type LedgerRow } from '../../shared/findingsLedger'
import { mulberry32 } from '../../shared/__tests__/contractFixtures'
import { cleanGitEnv } from '../git/gitCommand'
import { initDatabase, type ChatSessionRecord, type SessionDatabase } from '../db'
import { AssignmentStore } from '../team/assignmentStore'
import { MailboxStore } from '../team/mailboxStore'
import { TaskStore } from '../team/taskStore'
import { TaskService, type TaskCaller } from '../team/TaskService'
import { TaskResultService } from '../team/TaskResultService'
import { clearTeamCache, resolveTeam } from '../team/teamIdentity'
import { CONTRACT_MARKDOWN, nextReview, pick } from './convergenceGenerator'

const SEED = 0xC0FE1D
const CASES = 300

let root: string
let db: SessionDatabase
let store: TaskStore
let tasks: TaskService
let results: TaskResultService
const records = new Map<string, ChatSessionRecord>()
const agent = (sessionId: string): TaskCaller => ({ kind: 'agent', sessionId })

beforeAll(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-convergence-p2-')))
  const repo = path.join(root, 'repo')
  const git = (args: string[]) => spawnSync('git', args, { cwd: repo, env: cleanGitEnv() })
  fs.mkdirSync(repo)
  git(['init', '-q'])
  git(['-c', 'user.email=t@e', '-c', 'user.name=T', 'commit', '-q', '--allow-empty', '-m', 'init'])
  fs.mkdirSync(path.join(repo, '.kawai', 'groups'), { recursive: true })
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'leads.md'), '---\ncanCreateTasks: true\n---\nLead.')
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'devs.md'), 'Build.')
  fs.writeFileSync(path.join(repo, '.kawai', 'groups', 'reviewers.md'), 'Review.')
  clearTeamCache()
  await resolveTeam(repo)
  const row = (sessionId: string, groupId: string): ChatSessionRecord => ({
    sessionId, groupId, projectPath: repo, name: sessionId, sdkSessionId: null, status: 'waiting', createdAt: '', lastActivityAt: '',
  })
  for (const [id, group] of [['lead', 'leads'], ['dev', 'devs'], ['reviewer', 'reviewers']] as const) records.set(id, row(id, group))
  db = initDatabase({ path: path.join(root, 'p2.db') })
  const mail = new MailboxStore(db.db)
  store = new TaskStore(db.db, mail, new AssignmentStore(db.db, mail))
  tasks = new TaskService(store, { getSession: id => records.get(id) })
  results = new TaskResultService(tasks, { getSession: id => records.get(id) })
})
afterAll(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }) })

const states = (rows: readonly LedgerRow[]): string[][] => rows.map(row => [row.id, row.state])

test('P2: no signal decides a finding; only a recorded diagnosis decision writes rejected, naming it (seed 0xC0FE1D, 300 cases)', async () => {
  const reached = new Map<string, number>()
  const tally = (key: string) => reached.set(key, (reached.get(key) ?? 0) + 1)
  for (let index = 0; index < CASES; index++) {
    const rng = mulberry32(SEED + index)
    const task = await tasks.create(agent('lead'), { title: `P2 ${index}`, direction: 'Build', contract: CONTRACT_MARKDOWN })
    const diagnosisDecisions = new Set<string>()
    let creatorRejects = 0
    const steps = 2 + Math.floor(rng() * 8)
    for (let n = 0; n < steps; n++) {
      const roll = rng()
      const open = blocking(results.findingsLedger.ledger(task.id))
      if (roll < 0.15 && open.length > 0) {
        // A diagnosis's Reject decision: the stage's write, naming the decision.
        const decisionId = `decision-${index}-${n}`
        diagnosisDecisions.add(decisionId)
        for (const finding of open.filter(() => rng() < 0.6)) {
          store.findings.insertEvent({ taskId: task.id, findingId: finding.id, kind: 'rejected', cardId: `card-${index}`, decisionId, actor: { kind: 'agent', sessionId: 'lead' }, text: 'not a defect', sourceKey: `diagnosis:${decisionId}:${finding.id}` })
        }
        tally('diagnosis-reject')
        continue
      }
      if (roll < 0.3 && open.length > 0) {
        const finding = pick(rng, open)
        await results.disputeFindings(agent('dev'), task.id, [{ id: finding.id, counterEvidence: `src/${finding.id}.ts:1 handles it` }]).then(() => {
          const reject = rng() < 0.5
          results.findingsLedger.disputes.decide({ task: store.get(task.id)!, actor: { kind: 'agent', sessionId: 'lead' }, findingId: finding.id, decision: reject ? 'reject' : 'uphold', rationale: 'judged' })
          if (reject) creatorRejects++
          tally(reject ? 'dispute-reject' : 'dispute-uphold')
        }, () => tally('dispute-refused'))
        continue
      }
      const result = await results.submit(agent('dev'), task.id, { summary: `round ${n}`, commit: `c0ffee${n}`, tests: [] })
      const notices = () => (db.db.prepare('SELECT COUNT(*) AS n FROM team_task_convergence_notices WHERE task_id = ?').get(task.id) as { n: number }).n
      const before = notices()
      // Fold right after the submission, before its notice: the service's write without the notice.
      const review = nextReview(rng, results.findingsLedger.ledger(task.id), n)
      let afterSubmission: string[][] | null = null
      const original = results.findingsLedger.noticeAfterReview.bind(results.findingsLedger)
      results.findingsLedger.noticeAfterReview = input => { afterSubmission = states(results.findingsLedger.ledger(task.id)); return original(input) }
      try {
        await results.submitFindings(agent('reviewer'), task.id, { resultId: result.id, kind: 'review', items: review.findings, dispositions: review.dispositions })
        expect({ index, n, states: states(results.findingsLedger.ledger(task.id)) as string[][] | null }).toEqual({ index, n, states: afterSubmission })
        tally(notices() > before ? 'noticed' : 'reviewed')
      } catch (error) {
        if (!/nothing was written/i.test(String(error))) throw error
        tally('refused')
      } finally {
        results.findingsLedger.noticeAfterReview = original
      }
    }
    const submissions = store.findings.countedSubmissions(task.id)
    const events = store.findings.events(task.id)
    const rejected = events.filter(event => event.kind === 'rejected')
    // Every rejected event is a recorded diagnosis decision's or a creator's reject.
    expect({ index, stray: rejected.filter(event => event.decisionId !== null && !diagnosisDecisions.has(event.decisionId)) }).toEqual({ index, stray: [] })
    expect({ index, creatorRejects: rejected.filter(event => event.decisionId === null).length }).toEqual({ index, creatorRejects })
    // Without the diagnosis-named events, the fold is the commands' own: a finding differs only where such an event names it.
    const named = new Set(rejected.filter(event => event.decisionId !== null).map(event => event.findingId))
    const without = foldLedger(submissions, events.filter(event => !(event.kind === 'rejected' && event.decisionId !== null)))
    const actual = foldLedger(submissions, events)
    const differing = actual.filter(row => without.find(other => other.id === row.id)?.state !== row.state).map(row => row.id)
    expect({ index, unexplained: differing.filter(id => !named.has(id)) }).toEqual({ index, unexplained: [] })
    if (differing.length > 0) tally('states-differ-by-diagnosis')
  }
  for (const key of ['noticed', 'reviewed', 'diagnosis-reject', 'dispute-reject', 'dispute-uphold', 'states-differ-by-diagnosis']) {
    expect({ key, reached: (reached.get(key) ?? 0) > 0 }).toEqual({ key, reached: true })
  }
})
