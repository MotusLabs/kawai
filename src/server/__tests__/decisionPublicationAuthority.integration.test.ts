import { expect, test } from 'bun:test'
import { mulberry32 } from '../../shared/__tests__/contractFixtures'
import { ExecutionStore } from '../plans/execution/executionStore'
import { PauseStore } from '../plans/revisionControl/pauseStore'
import { HUMAN, PREPARED } from './helpers/decisionPublicationBench'
import { bind, prepare } from './helpers/decisionPublicationCommands'
import { publicationRuntime } from './helpers/decisionPublicationRuntime'
import { propertyCases } from './helpers/propertyCases'

const PARTITIONS = [
  'manual', 'execution', 'focus', 'team', 'plan', 'card', 'agent', 'handed id', 'binding hash',
  'base direction', 'base acceptance', 'approval', 'ownership', 'attempt', 'generation', 'pause',
] as const
const CASES = 160

async function runAuthority(from: number, to: number) {
  const end = Math.min(to, propertyCases(CASES))
  if (from >= end) return
  const runtime = await publicationRuntime()
  const random = mulberry32(0xDEC10001)
  const seen = new Set<string>()
  const { manager, task, team, db, plan, execution, attempt, routed, teamPath } = runtime
  try {
    db.db.prepare("UPDATE plan_execution_changes SET owns = 0 WHERE execution_id = ? AND change = 'ui'").run(execution.id)
    for (let index = 0; index < end; index++) {
      const mode = index < PARTITIONS.length ? PARTITIONS[index]! : PARTITIONS[Math.floor(random() * PARTITIONS.length)]!
      const focus = mode === 'focus' ? (['unlinked', 'sibling', 'other-plan'] as const)[Math.floor(random() * 3)]! : null
      if (index < from) continue
      seen.add(mode)
      const target = mode === 'manual' ? manager.tasks.store.create({
        title: `Manual export ${index}`, direction: 'Write rows', creator: HUMAN, teamId: team.teamId, planId: plan.planId, planChange: 'ui',
      }) : manager.tasks.store.get(task.id)!
      const handoff = await prepare(runtime, target.id, target.revision, `property-${index}`)
      const { approve, review } = await bind(runtime, handoff)
      const input = { ...approve, commandId: `property-approval-${index}`, rationale: `Owner review ${index}` }
      expect(review).toMatchObject({ taskTitle: target.title, before: { direction: target.direction, acceptance: target.acceptance },
        execution: mode === 'manual' ? null : { id: execution.id }, link: { taskId: target.id, baseRevision: target.revision } })
      if (focus) await runtime.sendFocus(focus)
      let restore = () => {}
      if (mode === 'team') input.teamPath = `${teamPath}/unknown-team`
      if (mode === 'plan') input.planId = `plan-${crypto.randomUUID()}`
      if (mode === 'card') input.cardId = `card-${crypto.randomUUID()}`
      if (mode === 'handed id') input.expectedHandoffId = `handoff-${crypto.randomUUID()}`
      if (mode === 'binding hash') input.expectedBindingHash = '0'.repeat(64)
      if (mode === 'base direction' || mode === 'base acceptance') {
        const column = mode === 'base direction' ? 'direction' : 'acceptance'
        const write = db.db.prepare(`UPDATE team_task_revisions SET ${column} = ? WHERE task_id = ? AND revision = ?`)
        write.run(`Changed ${column} after observing`, target.id, target.revision)
        restore = () => { write.run(target[column], target.id, target.revision) }
      }
      if (mode === 'approval') runtime.advanceApproval()
      if (mode === 'ownership' || mode === 'generation') {
        const column = mode === 'ownership' ? 'owns' : 'generation'
        const write = db.db.prepare(`UPDATE plan_execution_changes SET ${column} = ? WHERE execution_id = ? AND change = 'api'`)
        const value = db.db.query<{ value: number }, [string]>(
          `SELECT ${column} AS value FROM plan_execution_changes WHERE execution_id = ? AND change = 'api'`,
        ).get(execution.id)!.value
        write.run(mode === 'ownership' ? 0 : value + 1, execution.id)
        restore = () => { write.run(value, execution.id) }
      }
      if (mode === 'attempt') {
        const newAttempt = new ExecutionStore(db.db).insertAttempt({ executionId: execution.id, change: 'api', kind: 'fix',
          assignmentId: null, manifest: attempt.manifest, manifestHash: attempt.manifestHash })
        restore = () => { db.db.prepare('DELETE FROM plan_execution_attempts WHERE id = ?').run(newAttempt.id) }
      }
      if (mode === 'pause') {
        const paused = new PauseStore(db.db).insert({ teamId: team.teamId, planId: plan.planId, executionId: execution.id,
          holdId: 'seeded-hold', deadline: new Date(Date.now() + 60_000).toISOString(), note: null, commandId: `property-pause-${index}` },
        [{ change: 'api', stage: 'attempt', attemptId: attempt.id, assignmentId: attempt.assignmentId!, holderSession: runtime.holder }])
        restore = () => {
          db.db.prepare('DELETE FROM plan_pause_targets WHERE pause_id = ?').run(paused.id)
          db.db.prepare('DELETE FROM plan_pauses WHERE id = ?').run(paused.id)
        }
      }
      try {
        await runtime.settleDelivery()
        const before = runtime.snapshot()
        if (mode === 'agent') {
          await expect(manager.decisions!.approvePublication({ kind: 'agent', sessionId: runtime.lead }, input)).rejects.toMatchObject({ reason: 'forbidden' })
          expect(runtime.snapshot()).toEqual(before)
          continue
        }
        const reply = await routed('team-plan-result', input)
        if (mode === 'manual' || mode === 'execution' || mode === 'focus') {
          expect(reply.publication).toMatchObject({ baseRevision: target.revision, publishedRevision: target.revision + 1,
            handoffId: handoff.id, taskId: target.id, payloadHash: handoff.payloadHash })
          expect(manager.tasks.store.revisions(target.id).at(-1)).toMatchObject({ revision: target.revision + 1,
            direction: PREPARED.direction, acceptance: PREPARED.acceptance, rationale: PREPARED.rationale, author: { kind: 'human' } })
          const after = runtime.snapshot()
          expect(after.team_task_revisions!.length).toBe(before.team_task_revisions!.length + 1)
          expect(after.plan_decisions!.length).toBe(before.plan_decisions!.length + 1)
        } else {
          expect([mode, reply.reason]).toEqual([mode, ['team', 'plan', 'card'].includes(mode) ? 'not-found' : 'stale'])
          expect(reply.publication).toBeUndefined()
          expect(runtime.snapshot()).toEqual(before)
        }
      } finally { restore() }
    }
    if (from === 0) expect([...seen].sort()).toEqual([...PARTITIONS].sort())
  } finally { await runtime.teardown() }
}

// @covers: plan-decisions › Fresh approval publishes only the reviewed handoff › An unauthorized or malformed approval writes nothing
test('I1 seed 0xDEC10001 — cases 1–40 require an exact eligible human approval', () => runAuthority(0, 40))
test('I1 seed 0xDEC10001 — cases 41–80 require an exact eligible human approval', () => runAuthority(40, 80))
test('I1 seed 0xDEC10001 — cases 81–120 require an exact eligible human approval', () => runAuthority(80, 120))
test('I1 seed 0xDEC10001 — cases 121–160 require an exact eligible human approval', () => runAuthority(120, 160))
