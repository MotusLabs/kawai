import { expect, test } from 'bun:test'
import fs from 'node:fs'
import { mulberry32 } from '../../shared/__tests__/contractFixtures'
import { HoldStore } from '../plans/revisionControl/holdStore'
import { PauseStore } from '../plans/revisionControl/pauseStore'
import { createPlanWorld, sessionRow } from './planHarness'
import { bindManual, HUMAN, PREPARED, publicationBench } from './helpers/decisionPublicationBench'
import { propertyCases } from './helpers/propertyCases'

const HOLDERS = ['original', 'unclaimed', 'forwarded', 'killed', 'archived'] as const
const DELIVERY = ['delivered', 'dead', 'uncertain'] as const
const GATES = ['hold', 'sibling pause'] as const
const CASES = 160

// @covers: task-revision-publication › An approved handoff publishes as the human with its original notices › Delivery and acknowledgement remain distinct
test('I3 seed 0xDEC10003, 160 cases — current notice recipients and explicit ACK preserve older work and gates', async () => {
  const world = await createPlanWorld('kawai-decision-notice-model-')
  const random = mulberry32(0xDEC10003)
  const seen = new Set<string>()
  try {
    for (let index = 0; index < propertyCases(CASES); index++) {
      const grid = HOLDERS.length * DELIVERY.length * GATES.length
      const pick = index < grid ? index : Math.floor(random() * grid)
      const holder = HOLDERS[pick % HOLDERS.length]!
      const delivery = DELIVERY[Math.floor(pick / HOLDERS.length) % DELIVERY.length]!
      const gate = GATES[Math.floor(pick / (HOLDERS.length * DELIVERY.length))]!
      seen.add(`${holder}/${delivery}/${gate}`)
      const bench = publicationBench(world)
      try {
        const { task, planId, handoff, approval } = await bindManual(bench)
        const { tasks, mail, assignmentStore, records } = bench
        const original = 'dev'
        const forwarded = 'dev-successor'
        const oldRecord = records.get(original)!
        records.set(forwarded, sessionRow(forwarded, 'middle-devs', world.feature))
        const { assignment } = assignmentStore.insert({
          teamId: task.teamId, taskId: task.id, targetKind: 'group', targetId: 'middle-devs',
          requestKey: 'assign', role: 'middle-devs', instruction: 'Inspect the original revision', creator: HUMAN,
        })
        const instruction = mail.enqueue({ teamId: task.teamId, toKind: 'group', toId: 'middle-devs', fromKind: 'human',
          fromSession: null, fromGroup: null, originPath: world.repo, body: 'Original pinned instruction', taskId: task.id })
        assignmentStore.setMessage(assignment.id, instruction.id)
        const deliver = (id: string, to: string, revision: number) => {
          expect(mail.claim(id, to)).toBe(true)
          expect(mail.markPushed(id, undefined, revision)).toBe(true)
          expect(mail.markDelivered(id)).toBe(true)
        }
        if (holder !== 'unclaimed') deliver(instruction.id, original, 1)
        if (holder === 'killed') records.delete(original)
        if (holder === 'archived') records.set(original, { ...oldRecord, archivedAt: '2026-01-01' })
        if (holder === 'forwarded') {
          const successor = mail.enqueue({ teamId: task.teamId, toKind: 'group', toId: 'middle-devs', fromKind: 'agent',
            fromSession: original, fromGroup: 'middle-devs', originPath: world.feature, body: 'Forward unchanged', taskId: task.id,
            inReplyTo: mail.get(instruction.id)!, handoff: { fromSession: original, fromProfile: 'default', claimCommit: null,
              lastError: 'capacity', progress: { toolCalls: 0, tools: [], filesTouched: [] } } })
          expect(mail.markForwarded(instruction.id, successor.id)).toBe(true)
          deliver(successor.id, forwarded, 1)
        }
        const priorResult = tasks.results.insert({ teamId: task.teamId, taskId: task.id, summary: 'Original result',
          submittedBy: { kind: 'agent', sessionId: original }, taskRevision: 1, diff: 'prior', commit: null,
          tests: [], limitations: null, worktree: world.feature })
        const deadline = new Date(Date.now() + 60_000).toISOString()
        const holds = new HoldStore(bench.db.db)
        const hold = holds.insert({ teamId: task.teamId, planId, scope: 'changes', changes: [gate === 'hold' ? 'api' : 'ui'],
          rationale: 'Review before dispatch', deadline, cites: null, commandId: 'held-scope' })
        if (gate === 'sibling pause') new PauseStore(bench.db.db).insert({
          teamId: task.teamId, planId, executionId: 'prior-execution', holdId: hold.id, deadline, note: null, commandId: 'paused-sibling',
        }, [{ change: 'ui', stage: 'attempt', attemptId: null, assignmentId: 'sibling-work', holderSession: null }])
        const gateRows = () => ['plan_holds', 'plan_hold_changes', 'plan_pauses', 'plan_pause_targets', 'plan_execution_changes', 'team_task_assignments']
          .map(table => bench.db.db.query(`SELECT * FROM ${table} ORDER BY rowid`).all())
        const before = gateRows()
        const actor = holder === 'unclaimed' ? null : holder === 'forwarded' ? forwarded : original
        const approved = await bench.wire(approval)
        expect(approved.error).toBeUndefined()
        const receipt = approved.publication!
        expect(receipt).toMatchObject({ taskId: task.id, handoffId: handoff.id, publishedRevision: 2, baseRevision: 1 })
        expect(bench.mail.get(receipt.wakeupMessageId!)).toMatchObject({ taskId: null, toId: 'lead', tags: ['publication-handoff', 'handoff-published'] })
        expect(gateRows()).toEqual(before)
        const actual = mail.forTask(task.id).filter(row => row.tags.includes('task-revision'))
        expect(actual.map(row => row.toId)).toEqual(actor ? [actor] : [])
        expect(actual.map(row => row.id)).toEqual(receipt.noticeMessageIds)
        if (actor) {
          const notice = actual[0]!
          expect(notice).toMatchObject({ toKind: 'session', body: expect.stringContaining(PREPARED.rationale),
            revisionNotice: { revision: 2, previousRevision: 1, assignmentId: assignment.id } })
          if (holder === 'killed') expect(notice).toMatchObject({ state: 'dead', reason: 'killed-recipient' })
          else if (delivery === 'delivered') deliver(notice.id, actor, 2)
          else if (delivery === 'dead') expect(mail.deadLetter(notice.id, 'fixture-failure')).toBe(true)
          else {
            expect(mail.claim(notice.id, actor)).toBe(true)
            expect(mail.markPushed(notice.id, undefined, 2)).toBe(true)
            expect(mail.holdUncertain(notice.id, 'transcript-unreadable')).toBe(true)
          }
          expect(tasks.acknowledgements.highest(task.id, actor)).toBeNull()
          if (holder !== 'killed' && random() > 0.4) {
            await bench.taskService.acknowledge(bench.agent(actor), task.id, 2)
            expect(tasks.acknowledgements.highest(task.id, actor)).toBe(2)
          }
        }
        expect(tasks.results.get(priorResult.id)?.taskRevision).toBe(1)
        expect(mail.get(instruction.id)?.taskRevision).toBe(holder === 'unclaimed' ? null : 1)
        expect(tasks.revisions(task.id).map(revision => [revision.revision, revision.author.kind])).toEqual([[1, 'human'], [2, 'human']])
        expect(await bench.wire({ ...approval, requestId: 'again' })).toMatchObject({ publication: receipt, replayed: true })
      } finally { bench.db.close() }
    }
    expect(seen.size).toBe(HOLDERS.length * DELIVERY.length * GATES.length)
  } finally { fs.rmSync(world.root, { recursive: true, force: true }) }
})
