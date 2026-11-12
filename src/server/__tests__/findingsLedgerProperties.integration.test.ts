// Properties P1, P3, and P4 of the findings ledger (review-findings-ledger
// 5.5, design "Properties"; seed 0xF1ED6E5, 300 cases) over seeded command
// sequences through the production services: results, structured and text
// reviews, disputes, the creator's decisions on manual tasks, the Lead's card
// decisions on plan tasks (the real DecisionService, wired by
// connectFindingCards), and contract publications that re-map. A crash is
// injected at the ledger's transaction boundaries — the submission and event
// inserts, and the card hook after its decision committed — and the command is
// then re-run (or, for the hook, the startup replay runs).
// - P1: after every command, task_get's ledger, the human detail's ledger (the
//   client's rendering input), the task summary's review verdict and stage,
//   and the delivered header's findings line all come from one fold.
// - P3: replaying every Kawai-written event (the startup card replay and every
//   card decision again after every command; the re-map after its
//   publication) writes nothing.
// - P4: a finding leaves the blocking set only by resolved, rejected,
//   superseded, or disputed; enters it only by accepted, still-open, reopened,
//   or upheld; and upheld restores exactly the state before the dispute.
// The executor's side (decideVerdict's outcome, the re-gate's one round per
// failed round across crashes) runs in executionFindingsRounds and
// executionRegate, whose seam is the executor tick.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import fs from 'node:fs'
import { blocking, deriveVerdict, foldLedger, pendingDisputes, type LedgerRow } from '../../shared/findingsLedger'
import { isBlocking } from '../../shared/reviewFindings'
import { teamTaskStage } from '../../shared/teamTaskStage'
import { mulberry32 } from '../../shared/__tests__/contractFixtures'
import { connectFindingCards } from '../plans/decisions/findingCards'
import { remapFindings } from '../team/findingRemap'
import { buildTaskContext } from '../team/taskContext'
import { TaskResultService } from '../team/TaskResultService'
import { taskHandlers } from '../team/taskTools'
import { createDecisionBench, type DecisionBench } from './decisionHarness'
import { createPlanWorld, type PlanWorld } from './planHarness'

let world: PlanWorld
let bench: DecisionBench
let results: TaskResultService
let crashArmed = false

beforeAll(async () => { world = await createPlanWorld('kawai-ledger-properties-') })
afterAll(() => { bench?.db.close(); fs.rmSync(world.root, { recursive: true, force: true }) })

const CONTRACT_AB = ['## Implementation contract', '### Acceptance', '- A1: Exports rows', '- A2: Pins revisions', '### Invariants', '- I1: Never twice',
  '### Scope', '- `src/**`', '### Verification', '- V1: check passes', '### Excluded', '- X1: No metrics'].join('\n')
const CONTRACT_A = CONTRACT_AB.replace('- A2: Pins revisions\n', '')
const BLOCKING_EXITS = new Set(['resolved', 'rejected', 'superseded', 'disputed'])
const BLOCKING_ENTRIES = new Set(['accepted', 'still-open', 'reopened', 'upheld'])

const dev = { kind: 'agent' as const, sessionId: 'dev' }
const lead = { kind: 'agent' as const, sessionId: 'lead' }
const tools = (session: string) => taskHandlers(bench.taskService, session, results) as Record<string, (input: unknown) => Promise<any>>
const fold = (taskId: string) => foldLedger(bench.tasks.findings.countedSubmissions(taskId), bench.tasks.findings.events(taskId))
const journalSize = (taskId: string) => bench.tasks.journal(taskId).length
const replayCards = () => results.findingsLedger.disputes.replay(link => bench.decisions.decisionsOfCard(world.team.teamId, link.cardId))
const cardOf = (taskId: string, findingId: string) => (bench.db.db.prepare(
  'SELECT card_id FROM team_task_finding_cards WHERE task_id = ? AND finding_id = ? ORDER BY rowid DESC LIMIT 1').get(taskId, findingId) as { card_id: string } | null)?.card_id

/** Arm a crash: the next submission or event insert throws inside its transaction. */
function installCrashes() {
  const findings = bench.tasks.findings
  for (const name of ['insertSubmission', 'insertEvent'] as const) {
    const original = findings[name].bind(findings) as (...args: unknown[]) => unknown
    ;(findings as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
      if (crashArmed) { crashArmed = false; throw new Error('simulated crash at the transaction boundary') }
      return original(...args)
    }
  }
}

/** P1: every reader's view comes from the one fold. */
async function checkReaders(taskId: string, ledger: LedgerRow[]) {
  const read = await tools('lead').task_get({ task_id: taskId })
  expect(read.findingsLedger).toEqual([...ledger].reverse().slice(0, 100))
  expect(bench.tasks.humanDetail(taskId)!.findingsLedger).toEqual(ledger)
  const summary = bench.tasks.summary(bench.tasks.get(taskId)!)
  const outstanding = bench.tasks.results.outstanding(taskId)
  const newest = outstanding ? bench.tasks.results.findingsFor(outstanding.id).filter(row => !row.structured || (row.counted && row.replacedBy === null)).at(-1) : undefined
  const verdict = newest === undefined ? null : newest.structured ? deriveVerdict(ledger) : newest.verdict
  expect(summary.outstandingResult?.reviewVerdict ?? null).toBe(outstanding ? verdict : null)
  expect(teamTaskStage(summary, summary.assignment, summary.outstandingResult))
    .toBe(teamTaskStage(summary, summary.assignment, outstanding ? { accepted: outstanding.acceptedAt !== null, reviewVerdict: verdict } : null))
  const header = buildTaskContext(bench.tasks, taskId)!.findings
  if (ledger.length === 0) expect(header).toBeUndefined()
  else expect(header).toEqual({ blocking: blocking(ledger).map(row => row.id), disputed: pendingDisputes(ledger).map(row => row.id) })
}

/**
 * P3: replaying every Kawai-written event writes nothing and changes no row.
 * The re-map is replayed right after its publication — the only point a
 * crash could re-run it; later reviews on an older-revision result keep their
 * pinned citations, which a fresh pass would judge anew.
 */
function checkReplay(taskId: string, ledger: LedgerRow[], published: boolean) {
  expect(replayCards()).toBe(0)
  for (const link of bench.tasks.findings.allCardLinks()) {
    for (const decision of bench.decisions.decisionsOfCard(world.team.teamId, link.cardId)) {
      expect(results.findingsLedger.disputes.applyCardDecision(link.cardId, decision)).toBe(false)
    }
  }
  if (published) expect(remapFindings(bench.tasks, taskId, bench.tasks.revisions(taskId).at(-1)!)).toBe(0)
  expect(fold(taskId)).toEqual(ledger)
}

/** P4: blocking moves only through the allowed transitions; upheld restores the state before the dispute. */
function checkMonotone(before: LedgerRow[], after: LedgerRow[], preDispute: Map<string, LedgerRow['state']>) {
  const prior = new Map(before.map(row => [row.id, row]))
  for (const row of after) {
    const old = prior.get(row.id)
    const was = old ? isBlocking(old.level, old.state) : false
    const now = isBlocking(row.level, row.state)
    const added = row.transitions.slice(old?.transitions.length ?? 0)
    const last = added.at(-1)
    if (was && !now) expect(BLOCKING_EXITS.has(row.state)).toBe(true)
    if (!was && now) expect(last !== undefined && BLOCKING_ENTRIES.has(last.kind)).toBe(true)
    if (added.some(entry => entry.kind === 'disputed') && old) preDispute.set(row.id, old.state)
    if (last?.kind === 'upheld') expect(row.state).toBe(preDispute.get(row.id)!)
  }
}

// @covers: review-findings › Each task has a findings ledger › The ledger shows a finding's history
test('P1/P3/P4 over 300 seeded command sequences with crashes at the transaction boundaries', async () => {
  bench = createDecisionBench(world)
  results = new TaskResultService(bench.taskService, { getSession: id => bench.records.get(id) })
  connectFindingCards({
    findings: results.findingsLedger, decisions: bench.decide, decisionStore: bench.decisions, taskStore: bench.tasks, mailbox: bench.mail,
    identityOf: () => world.team,
  })
  installCrashes()
  const planId = await bench.approvedPlan()
  const rand = mulberry32(0xf1ed6e5)
  const pick = <T>(values: readonly T[]): T => values[Math.floor(rand() * values.length)]!
  const tally = { commands: 0, crashes: 0, hookCrashes: 0, upheld: 0, rejected: 0, remaps: 0, refused: 0 }

  for (let index = 0; index < 300; index++) {
    const plan = index % 2 === 1
    const taskId = plan ? await bench.onTask('dev', planId)
      : bench.tasks.create({ teamId: world.team.teamId, title: `Manual ${index}`, direction: 'Build', creator: { kind: 'agent', sessionId: 'lead' } }).id
    const preDispute = new Map<string, LedgerRow['state']>()
    await results.submit(dev, taskId, { summary: 'r0', commit: `c${index}-0` })
    for (let step = 0; step < 8; step++) {
      const task = bench.tasks.get(taskId)!
      const before = fold(taskId)
      const open = before.filter(row => isBlocking(row.level, row.state))
      const disputed = pendingDisputes(before)
      // Bias toward the paths the properties watch: decide an open dispute, dispute an open blocker.
      const roll = disputed.length > 0 && rand() < 0.5 ? 0.8 : open.length > 0 && rand() < 0.3 ? 0.6 : rand()
      // One command, re-runnable after a crash: it reads the ledger afresh.
      let hookDecision: { cardId: string } | null = null
      const command = async () => {
        if (roll < 0.12) {
          await results.submit(dev, taskId, { summary: `r${step + 1}`, commit: `c${index}-${step + 1}` })
        } else if (roll < 0.5) {
          const result = bench.tasks.results.outstanding(taskId)!
          // Mostly a citation the pinned revision accepts; sometimes one it does not.
          const valid = bench.tasks.revisions(taskId).at(-1)!.contract ? ['A1', 'A1', 'A2'] : [task.identity, task.identity]
          const clauses = [...valid, ...valid, bench.tasks.revisions(taskId).at(-1)!.contract ? task.identity : 'A1', 'Z9']
          const items = Array.from({ length: Math.floor(rand() * 3) }, () => ({
            level: pick(['P0', 'P1', 'P1', 'P2'] as const), clause: pick(clauses), evidence: `src/f${Math.floor(rand() * 4)}.ts:${1 + Math.floor(rand() * 3)}`, impact: 'x',
          }))
          const dispositions = open.filter(() => rand() < 0.4)
            .map(row => ({ id: row.id, disposition: pick(['resolved', 'resolved', 'still-open', 'regressed'] as const), evidence: 'checked' }))
          await results.findingsLedger.submit({
            teamId: world.team.teamId, task, result, author: { kind: 'agent', sessionId: 'lead2' }, handoffId: null, counted: true,
            submission: { kind: 'review', findings: items as never, dispositions: dispositions as never },
          })
        } else if (roll < 0.56 && !plan) {
          const result = bench.tasks.results.outstanding(taskId)!
          await results.submitFindings({ kind: 'agent', sessionId: 'lead2' }, taskId, { resultId: result.id, kind: 'review', verdict: pick(['pass', 'fail'] as const), findings: 'text review' })
        } else if (roll < 0.74) {
          if (open.length === 0) throw new Error('nothing to dispute')
          await tools('dev').task_dispute_findings({ task_id: taskId, disputes: [{ id: pick(open).id, counter_evidence: 'src/f0.ts:1 is intended' }] })
        } else if (roll < 0.92) {
          if (disputed.length === 0) throw new Error('nothing to decide')
          const row = pick(disputed)
          const choice = rand() < 0.5 ? 'uphold' : 'reject'
          if (plan) {
            const cardId = cardOf(taskId, row.id)!
            hookDecision = { cardId }
            await bench.decide.record(lead, { plan_id: planId, card_id: cardId, choice: `${choice === 'uphold' ? 'Uphold' : 'Reject'} ${row.id}`, rationale: 'decided' })
          } else {
            await tools('lead').task_decide_dispute({ task_id: taskId, finding_id: row.id, decision: choice, rationale: 'decided' })
          }
        } else {
          await bench.taskService.amend(bench.human, taskId, { contract: rand() < 0.5 ? CONTRACT_AB : CONTRACT_A })
          tally.remaps++
        }
      }
      const crash = rand() < 0.15
      const journal = journalSize(taskId)
      crashArmed = crash
      let refused = false
      try { await command() } catch (error) {
        if (!(error instanceof Error) || !error.message.includes('simulated crash')) refused = true
      }
      const crashed = crash && !crashArmed
      crashArmed = false
      if (crashed && hookDecision === null) {
        // The crash rolled the whole transaction back: nothing of the command is left; re-run it.
        expect(fold(taskId)).toEqual(before)
        expect(journalSize(taskId)).toBe(journal)
        tally.crashes++
        refused = false
        try { await command() } catch { refused = true }
      } else if (crashed) {
        // The card's decision committed, its hook crashed: the startup replay applies it once.
        expect(fold(taskId)).toEqual(before)
        expect(replayCards()).toBe(1)
        tally.hookCrashes++
      }
      if (refused) { tally.refused++; continue }
      tally.commands++
      const after = fold(taskId)
      if (after.some((row, k) => row.transitions.at(-1)?.kind === 'upheld' && row.transitions.length !== before[k]?.transitions.length)) tally.upheld++
      if (after.some((row, k) => row.state === 'rejected' && before[k]?.state === 'disputed')) tally.rejected++
      checkMonotone(before, after, preDispute)
      await checkReaders(taskId, after)
      checkReplay(taskId, after, roll >= 0.92)
    }
  }
  // The sequences reach every path the properties are about.
  expect(tally.crashes).toBeGreaterThan(20)
  expect(tally.hookCrashes).toBeGreaterThan(0)
  expect(tally.upheld).toBeGreaterThan(20)
  expect(tally.rejected).toBeGreaterThan(20)
  expect(tally.remaps).toBeGreaterThan(20)
}, 180_000)
