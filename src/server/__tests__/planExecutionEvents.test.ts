// PlanService's execution events (plan-execution D3): `recordExecutionEvent`
// replays by (plan_id, command_id) over each kind's compared payload — Start
// `revision` and `contentHash`, Stop the trimmed `reason`, Retry `change` —
// with the execution's own writes (`within`) in the same transaction, never
// run again on a replay. `completeBySystem` completes the plan as the system
// under the deterministic command id `exec:<id>:complete`, so a repeated
// completion writes one event. The grep test holds the one-writer rule:
// `plan_events` is written only by PlanService's store.
import { describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { schemaDb } from './schemaDb'
import { normalizePlanContent } from '../../shared/plans'
import { StrategyStore } from '../strategy/strategyStore'
import { PlanStore } from '../plans/planStore'
import { PlanService } from '../plans/PlanService'

interface Bench {
  plans: PlanStore
  service: PlanService
  planId: string
  /** What `completeBySystem`'s currency check reads; fill per test. */
  executions: Record<string, { planId: string; revision: number }>
  /** Insert and approve the next revision; returns its number. */
  approveRevision: () => number
}

function bench(): Bench {
  const db = schemaDb()
  const plans = new PlanStore(db)
  const executions: Record<string, { planId: string; revision: number }> = {}
  const service = new PlanService(plans, {
    getSession: () => null,
    strategies: new StrategyStore(db),
    executionOf: id => executions[id] ?? null,
  })
  const planId = plans.insertPlan({ teamId: 'team', title: 'P', creator: { kind: 'human', sessionId: null } })
  const approveRevision = () => {
    const plan = plans.get(planId)!
    const revision = plans.insertRevision(planId, {
      content: normalizePlanContent({}), contentHash: `h${revisionOf(plan.currentApprovedRevision)}`,
      pin: null, author: { kind: 'human', sessionId: null },
    })
    if (plan.currentApprovedRevision !== null) plans.setRevisionStatus(planId, plan.currentApprovedRevision, 'superseded')
    plans.setRevisionStatus(planId, revision, 'approved')
    plans.setCurrentApproved(planId, revision)
    return revision
  }
  return { plans, service, planId, executions, approveRevision }
}

const revisionOf = (current: number | null): number => (current ?? 0) + 1

describe('recordExecutionEvent replay', () => {
  test('execution-started: the within writes and the event commit together; a resend replays without running within', () => {
    const { service, planId, plans } = bench()
    let runs = 0
    const first = service.recordExecutionEvent(planId,
      { kind: 'execution-started', commandId: 'cmd-1', revision: 1, contentHash: 'h1' },
      () => { runs += 1; return 'exec-1' })
    expect(first).toMatchObject({ ok: true, replayed: false, result: 'exec-1' })
    expect(runs).toBe(1)
    const replay = service.recordExecutionEvent(planId,
      { kind: 'execution-started', commandId: 'cmd-1', revision: 1, contentHash: 'h1' },
      () => { runs += 1; return 'never' })
    expect(replay).toMatchObject({ ok: true, replayed: true, result: undefined })
    expect(runs).toBe(1)
    const events = plans.events(planId)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ kind: 'execution-started', revision: 1, contentHash: 'h1', commandId: 'cmd-1', actor: { kind: 'human', sessionId: null } })
  })

  test('a different payload under the same command id is refused naming the field, and nothing is written', () => {
    const { service, planId, plans } = bench()
    service.recordExecutionEvent(planId, { kind: 'execution-started', commandId: 'cmd-1', revision: 1, contentHash: 'h1' }, () => 1)
    const refused = service.recordExecutionEvent(planId, { kind: 'execution-started', commandId: 'cmd-1', revision: 1, contentHash: 'h2' }, () => 2)
    expect(refused).toMatchObject({ ok: false, reason: 'payload' })
    if (!refused.ok) expect(refused.message).toContain('contentHash')
    expect(plans.events(planId)).toHaveLength(1)
  })

  test('execution-stopped compares the trimmed reason; the event records it trimmed', () => {
    const { service, planId, plans } = bench()
    const first = service.recordExecutionEvent(planId, { kind: 'execution-stopped', commandId: 'cmd-2', executionId: 'exec-1', reason: '  enough  ' }, () => 1)
    expect(first).toMatchObject({ ok: true, replayed: false })
    const replay = service.recordExecutionEvent(planId, { kind: 'execution-stopped', commandId: 'cmd-2', executionId: 'exec-1', reason: 'enough' }, () => 2)
    expect(replay).toMatchObject({ ok: true, replayed: true })
    const refused = service.recordExecutionEvent(planId, { kind: 'execution-stopped', commandId: 'cmd-2', executionId: 'exec-1', reason: 'other' }, () => 3)
    expect(refused).toMatchObject({ ok: false, reason: 'payload' })
    if (!refused.ok) expect(refused.message).toContain('reason')
    const [event] = plans.events(planId)
    expect(event).toMatchObject({ kind: 'execution-stopped', reason: 'enough', commandId: 'cmd-2' })
  })

  test('change-retried compares the execution and the change', () => {
    const { service, planId, plans } = bench()
    service.recordExecutionEvent(planId, { kind: 'change-retried', commandId: 'cmd-3', executionId: 'exec-1', change: 'api' }, () => 1)
    expect(service.recordExecutionEvent(planId, { kind: 'change-retried', commandId: 'cmd-3', executionId: 'exec-1', change: 'api' }, () => 2))
      .toMatchObject({ ok: true, replayed: true })
    const refused = service.recordExecutionEvent(planId, { kind: 'change-retried', commandId: 'cmd-3', executionId: 'exec-1', change: 'ui' }, () => 3)
    expect(refused).toMatchObject({ ok: false, reason: 'payload' })
    if (!refused.ok) expect(refused.message).toContain('change')
    expect(plans.events(planId)).toHaveLength(1)
  })

  test('a within that throws rolls the event back with it', () => {
    const { service, planId, plans } = bench()
    expect(() => service.recordExecutionEvent(planId,
      { kind: 'execution-started', commandId: 'cmd-4', revision: 1, contentHash: 'h1' },
      () => { throw new Error('one-execution') })).toThrow('one-execution')
    expect(plans.events(planId)).toHaveLength(0)
    expect(service.recordExecutionEvent(planId, { kind: 'execution-started', commandId: 'cmd-4', revision: 1, contentHash: 'h1' }, () => 'exec-1'))
      .toMatchObject({ ok: true, replayed: false })
  })

  test('an empty command id is refused invalid, and nothing runs', () => {
    const { service, planId, plans } = bench()
    let ran = false
    const refused = service.recordExecutionEvent(planId, { kind: 'execution-started', commandId: '  ', revision: 1, contentHash: 'h1' }, () => { ran = true; return 1 })
    expect(refused).toMatchObject({ ok: false, reason: 'invalid' })
    expect(ran).toBe(false)
    expect(plans.events(planId)).toHaveLength(0)
  })
})

describe('completeBySystem', () => {
  test('completes an open plan on its current revision as the system; a repeated completion writes one event', () => {
    const world = bench()
    const { service, planId, plans } = world
    world.approveRevision()
    world.executions['exec-9'] = { planId, revision: 1 }
    expect(service.completeBySystem(planId, 'exec-9')).toMatchObject({ ok: true, replayed: false })
    expect(plans.get(planId)).toMatchObject({ lifecycle: 'completed', currentApprovedRevision: 1 })
    expect(service.completeBySystem(planId, 'exec-9')).toMatchObject({ ok: true, replayed: true })
    const completed = plans.events(planId).filter(event => event.kind === 'completed')
    expect(completed).toHaveLength(1)
    expect(completed[0]).toMatchObject({ actor: { kind: 'system', sessionId: null }, commandId: 'exec:exec-9:complete' })
    expect(plans.eventByCommand(planId, 'exec:exec-9:complete')?.payload).toEqual({ command: 'complete-by-system', executionId: 'exec-9' })
  })

  test('a newer approved revision refuses and the plan stays open', () => {
    const world = bench()
    const { service, planId, plans } = world
    world.approveRevision()
    world.executions['exec-9'] = { planId, revision: 1 }
    world.approveRevision()
    const refused = service.completeBySystem(planId, 'exec-9')
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.message).toContain('revision')
    expect(plans.get(planId)).toMatchObject({ lifecycle: 'open', currentApprovedRevision: 2 })
    expect(plans.events(planId).filter(event => event.kind === 'completed')).toHaveLength(0)
  })

  test('refuses when the plan is not open, or the execution is missing or on another plan', () => {
    const world = bench()
    const { service, planId, plans } = world
    world.approveRevision()
    expect(service.completeBySystem(planId, 'exec-9').ok).toBe(false)
    world.executions['exec-9'] = { planId: 'plan-other', revision: 1 }
    expect(service.completeBySystem(planId, 'exec-9').ok).toBe(false)
    world.executions['exec-9'] = { planId, revision: 1 }
    plans.setLifecycle(planId, 'cancelled')
    expect(service.completeBySystem(planId, 'exec-9').ok).toBe(false)
    expect(plans.events(planId).filter(event => event.kind === 'completed')).toHaveLength(0)
  })
})

describe('the one-writer rule', () => {
  test('only PlanService\'s store writes plan_events', () => {
    const server = path.join(import.meta.dir, '..')
    const offenders: string[] = []
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name !== '__tests__') walk(full)
        } else if (entry.name.endsWith('.ts') && fs.readFileSync(full, 'utf8').includes('INSERT INTO plan_events')) {
          offenders.push(path.relative(server, full))
        }
      }
    }
    walk(server)
    expect(offenders).toEqual(['plans/planStore.ts'])
  })
})
