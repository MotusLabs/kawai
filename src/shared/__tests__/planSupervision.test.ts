// Supervision derivation (plan-supervision 1.3, 1.4): the outcome precedence,
// the ten named waits in order, progress apart from activity, both stalls and
// their episode keys, and labels that render unknown kinds verbatim.
import { describe, expect, test } from 'bun:test'
import type { CiCheck } from '../planExecution'
import {
  causeLabel,
  changeSupervision,
  failingChecks,
  failureSignature,
  stopReasonLabel,
  type HolderFacts,
  type SupervisionInput,
  type SupervisionRound,
} from '../planSupervision'

const NOW = new Date('2026-10-19T12:00:00.000Z')
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString()

const check = (name: string, conclusion: string, startedAt = ago(100)): CiCheck =>
  ({ name, source: 'actions', conclusion, link: `https://ci.example/${name}`, runId: 1, startedAt, completedAt: startedAt })

function holder(extra: Partial<HolderFacts> = {}): HolderFacts {
  return {
    session: 'dev-1', group: 'middle-devs', profile: 'glm', gone: false, turnRunning: true, pendingRequest: null,
    backgroundTasks: 0, workers: 0, dueDirectMail: false, parkedUntil: null, coolingUntil: null,
    lastTurnEndAt: null, lastTaskMailAt: null, ...extra,
  }
}

function round(number: number, extra: Partial<SupervisionRound> = {}): SupervisionRound {
  return {
    id: `round-${number}`, number, outcome: null, decidedAt: null, carriedFrom: null, ci: null,
    ciPassedAt: null, verdict: null, verdictAt: null, findingsSummary: null, ...extra,
  }
}

function input(extra: Partial<SupervisionInput> = {}): SupervisionInput {
  return {
    change: 'api', dependsOn: [], state: 'implementing', step: null, stopReason: null, stopDetail: null,
    landing: null, dependencies: [], parallelLimit: 3, attempt: { kind: 'implement', status: 'out' }, rounds: [], effects: [],
    instruction: { messageId: 'msg-1', state: 'delivered', deliveredAt: ago(30), blocker: null, holder: holder() },
    openCards: [], conditions: [], memberRelease: null, slotHolder: null, candidates: [], results: [], waitEndedAt: null,
    ...extra,
  }
}

const failed = (number: number, checks: CiCheck[], extra: Partial<SupervisionRound> = {}) =>
  round(number, { outcome: 'fail', decidedAt: ago(200 - number), ci: checks, ...extra })

describe('outcome precedence', () => {
  const stalled = { rounds: [failed(2, [check('unit', 'failure')]), failed(3, [check('unit', 'failure')])] }

  test('landed beats everything, flagged when the tree was not verified', () => {
    const view = changeSupervision(input({ ...stalled, state: 'stopped', landing: { landedAt: ago(5), treeVerified: false, mergeSha: 'm', postCi: [] } }), NOW)
    expect(view.outcome).toBe('landed')
    expect(causeLabel(view.cause)).toBe('Landed (tree not verified)')
  })

  test('cancelled, then stopped, beat a repeating failure', () => {
    expect(changeSupervision(input({ ...stalled, state: 'cancelled' }), NOW).outcome).toBe('cancelled')
    const stopped = changeSupervision(input({ ...stalled, state: 'stopped', stopReason: 'round-limit' }), NOW)
    expect(stopped.outcome).toBe('stopped')
    expect(causeLabel(stopped.cause)).toBe('Stopped: Failed 3 fix rounds')
  })

  test('waiting before provisioning beats a repeating failure', () => {
    const view = changeSupervision(input({ ...stalled, state: 'waiting', dependencies: [{ change: 'db', outcome: 'stopped' }] }), NOW)
    expect(view.cause).toEqual({ kind: 'dependency', changes: ['db'], stopped: ['db'] })
    expect(causeLabel(view.cause)).toBe('Blocked by stopped db')
    expect(view.stall).toBeNull()
  })

  test('a waiting change with every dependency landed waits on the parallel limit', () => {
    const view = changeSupervision(input({ state: 'waiting', dependencies: [{ change: 'db', outcome: 'landed' }] }), NOW)
    expect(view.cause).toEqual({ kind: 'parallel-limit', limit: 3 })
  })

  test('a change the execution lacks is not started', () => {
    expect(changeSupervision(input({ state: null }), NOW).outcome).toBe('not-started')
  })

  test('a repeating failure reads stalled during the fix round CI wait, the wait also applying', () => {
    const view = changeSupervision(input({ ...stalled, state: 'gating', step: 'awaiting-ci', rounds: [...stalled.rounds, round(4, { ci: [check('unit', 'in_progress')] })] }), NOW)
    expect(view.outcome).toBe('stalled')
    expect(view.stall).toEqual({ kind: 'repeating-failure', episodeKey: 'round-3', signature: 'unit', rounds: ['round-2', 'round-3'] })
    expect(view.alsoApplying).toEqual([{ kind: 'ci', pending: ['unit'] }])
  })
})

describe('failureSignature', () => {
  test('sorted failing checks then review:fail; flaky checks excluded', () => {
    expect(failureSignature({ ci: [check('unit', 'failure'), check('lint', 'failure'), check('e2e', 'success')], verdict: 'fail' })).toBe('lint,unit,review:fail')
    expect(failureSignature({ ci: [check('e2e', 'failure', ago(90)), check('e2e', 'success', ago(80)), check('unit', 'failure')], verdict: null })).toBe('unit')
    expect(failureSignature({ ci: [check('unit', 'success')], verdict: 'fail' })).toBe('review:fail')
  })
})

describe('failingChecks', () => {
  test("each name's newest run decides: fail then pass is flaky and passes, pass then fail fails", () => {
    const failing = failingChecks([
      check('e2e', 'failure', ago(90)), check('e2e', 'success', ago(80)),
      check('unit', 'success', ago(90)), check('unit', 'failure', ago(80)),
    ])
    expect(failing.map(run => [run.name, run.conclusion])).toEqual([['unit', 'failure']])
    expect(failingChecks(null)).toEqual([])
  })
})

describe('repeating-failure', () => {
  const view = (rounds: SupervisionRound[]) => changeSupervision(input({ state: 'implementing', attempt: { kind: 'fix', status: 'out' }, rounds }), NOW)

  test('different failures raise none', () => {
    expect(view([failed(2, [check('lint', 'failure')]), failed(3, [check('unit', 'failure')])]).stall).toBeNull()
  })

  test('a passing round between breaks the run', () => {
    expect(view([failed(1, [check('unit', 'failure')]), round(2, { outcome: 'pass', decidedAt: ago(150) }), failed(3, [check('unit', 'failure')])]).stall).toBeNull()
  })

  test('superseded rounds are skipped', () => {
    const stall = view([failed(2, [check('unit', 'failure')]), round(3, { outcome: 'superseded' }), failed(4, [check('unit', 'failure')])]).stall
    expect(stall).toMatchObject({ kind: 'repeating-failure', episodeKey: 'round-4' })
  })

  test('a carried round stands in for its source', () => {
    expect(view([failed(3, [check('unit', 'failure')]), failed(4, [check('unit', 'failure')], { carriedFrom: 'round-3' })]).stall).toBeNull()
  })

  test('a check flaky in one round does not join its signature', () => {
    const flaky = [check('e2e', 'failure', ago(90)), check('e2e', 'success', ago(80)), check('unit', 'failure')]
    expect(view([failed(2, flaky), failed(3, [check('unit', 'failure')])]).stall).toMatchObject({ signature: 'unit' })
  })
})

describe('the ten named waits, in order', () => {
  const allWaits = (): SupervisionInput => input({
    state: 'gating',
    step: 'awaiting-ci',
    effects: [{ kind: 'push', state: 'pending', tries: 1, nextAt: ago(-5) }],
    instruction: { messageId: 'msg-1', state: 'uncertain', deliveredAt: ago(30), blocker: null, holder: holder({ pendingRequest: 'approval', parkedUntil: ago(-60) }) },
    openCards: [{ cardId: 'card-1', addressedTo: 'lead', addressedGroup: 'lead' }],
    rounds: [round(1, { ci: [check('unit', 'queued')] })],
  })

  test('each wait leads once the ones before it clear, the rest listed as also applying', () => {
    const order: string[] = []
    let current = allWaits()
    const clear: Array<(entry: SupervisionInput) => SupervisionInput> = [
      entry => ({ ...entry, effects: [] }),
      entry => ({ ...entry, instruction: { ...entry.instruction!, state: 'queued', blocker: 'group cap 1/1' } }),
      entry => ({ ...entry, instruction: { ...entry.instruction!, state: 'delivered' } }),
      entry => ({ ...entry, instruction: { ...entry.instruction!, holder: holder({ pendingRequest: 'approval' }) } }),
      entry => ({ ...entry, instruction: { ...entry.instruction!, holder: holder() } }),
      entry => ({ ...entry, openCards: [] }),
      entry => ({ ...entry, step: 'releasing', memberRelease: { member: 'dev-2', reason: 'busy' } }),
      entry => ({ ...entry, step: 'conditions', conditions: ['docs reviewed'] }),
      entry => ({ ...entry, step: 'awaiting-slot', slotHolder: { kind: 'promotion', id: 'promotion-1' } }),
    ]
    for (const step of [...clear, null]) {
      const view = changeSupervision(current, NOW)
      expect(view.outcome).toBe('waiting')
      order.push(view.cause.kind)
      if (view.cause.kind === 'effect') expect(view.alsoApplying.map(wait => wait.kind)).toEqual(['uncertain-delivery', 'parked', 'request', 'decision-card', 'ci'])
      if (step) current = step(current)
    }
    expect(order).toEqual(['effect', 'uncertain-delivery', 'staffing', 'parked', 'request', 'decision-card', 'ci', 'member-release', 'condition', 'landing-slot'])
  })

  test('a cooling profile is the parked wait, and the slot names a promotion holder', () => {
    const cooling = changeSupervision(input({ instruction: { messageId: null, state: 'delivered', deliveredAt: ago(500), blocker: null, holder: holder({ coolingUntil: ago(-30), turnRunning: false }) } }), NOW)
    expect(cooling.cause).toMatchObject({ kind: 'parked', cooling: true })
    const slot = changeSupervision(input({ state: 'landing', step: 'awaiting-slot', slotHolder: { kind: 'promotion', id: 'promotion-1' } }), NOW)
    expect(causeLabel(slot.cause)).toBe('Waiting for the landing slot, held by promotion promotion-1')
  })

  test('a named wait never stalls, however long it lasts', () => {
    const view = changeSupervision(input({
      openCards: [{ cardId: 'card-1', addressedTo: 'owner', addressedGroup: null }],
      instruction: { messageId: 'msg-1', state: 'delivered', deliveredAt: ago(600), blocker: null, holder: holder({ turnRunning: false, lastTurnEndAt: ago(500) }) },
    }), NOW)
    expect(view.outcome).toBe('waiting')
    expect(view.stall).toBeNull()
    expect(causeLabel(view.cause)).toBe('Waiting on decision card card-1 (the owner)')
  })
})

describe('progress and activity', () => {
  test('progress is the newest of results, CI passes, verdicts, passed rounds, and passed candidates', () => {
    const view = changeSupervision(input({
      results: [{ createdAt: ago(300) }],
      rounds: [round(1, { ciPassedAt: ago(250), verdict: 'fail', verdictAt: ago(240), outcome: 'fail', decidedAt: ago(240) }), round(2, { outcome: 'pass', decidedAt: ago(100) })],
      candidates: [{ state: 'passed', createdAt: ago(90), decidedAt: ago(80) }, { state: 'failed', createdAt: ago(10), decidedAt: ago(5) }],
    }), NOW)
    expect(view.progress).toEqual({ kind: 'candidate-pass', at: ago(80) })
  })

  test('turns and mail are activity, never progress', () => {
    const view = changeSupervision(input({
      results: [{ createdAt: ago(180) }],
      instruction: { messageId: 'msg-1', state: 'delivered', deliveredAt: ago(200), blocker: null, holder: holder({ turnRunning: false, lastTurnEndAt: ago(2), lastTaskMailAt: ago(10) }) },
    }), NOW)
    expect(view.progress).toEqual({ kind: 'result', at: ago(180) })
    expect(view.activity).toEqual({ kind: 'turn', at: ago(2) })
    const live = changeSupervision(input(), NOW)
    expect(live.activity).toEqual({ kind: 'live-turn', at: NOW.toISOString() })
    expect(live.progress).toBeNull()
  })
})

describe('no-progress', () => {
  const busy = (deliveredMinutes: number, extra: Partial<SupervisionInput> = {}) =>
    input({ instruction: { messageId: 'msg-1', state: 'delivered', deliveredAt: ago(deliveredMinutes), blocker: null, holder: holder() }, ...extra })

  test('2 h for an attempt, counted from delivery', () => {
    expect(changeSupervision(busy(119), NOW).outcome).toBe('running')
    const view = changeSupervision(busy(121), NOW)
    expect(view.stall).toEqual({ kind: 'no-progress', episodeKey: ago(121), anchorAt: ago(121), deadlineAt: ago(1), idle: false })
  })

  test('1 h for a review', () => {
    const review = { state: 'gating' as const, step: 'reviewing' as const }
    expect(changeSupervision(busy(59, review), NOW).outcome).toBe('running')
    expect(changeSupervision(busy(61, review), NOW).stall?.kind).toBe('no-progress')
  })

  test('the deadline counts from the latest of delivery, progress, and waitEndedAt', () => {
    expect(changeSupervision(busy(300, { results: [{ createdAt: ago(100) }] }), NOW).outcome).toBe('running')
    expect(changeSupervision(busy(300, { results: [{ createdAt: ago(130) }] }), NOW).stall?.episodeKey).toBe(ago(130))
    // A 3 h wait on a cooling profile ended 30 minutes ago.
    expect(changeSupervision(busy(240, { waitEndedAt: ago(30) }), NOW).outcome).toBe('running')
  })

  test('15 minutes from the last turn end for an idle holder', () => {
    const idle = (lastTurn: number, extra: Partial<HolderFacts> = {}) =>
      input({ instruction: { messageId: 'msg-1', state: 'delivered', deliveredAt: ago(60), blocker: null, holder: holder({ turnRunning: false, lastTurnEndAt: ago(lastTurn), ...extra }) } })
    expect(changeSupervision(idle(14), NOW).outcome).toBe('running')
    expect(changeSupervision(idle(20), NOW).stall).toMatchObject({ kind: 'no-progress', idle: true, deadlineAt: ago(5) })
    expect(changeSupervision(idle(20, { backgroundTasks: 1 }), NOW).outcome).toBe('running')
    expect(changeSupervision(idle(20, { dueDirectMail: true }), NOW).outcome).toBe('running')
    expect(changeSupervision(idle(20, { gone: true, turnRunning: true }), NOW).stall?.kind).toBe('no-progress')
  })

  test('the episode key stays the same when only waitEndedAt moves', () => {
    const first = changeSupervision(busy(400, { waitEndedAt: ago(130) }), NOW).stall
    const second = changeSupervision(busy(400, { waitEndedAt: ago(125) }), NOW).stall
    expect(first?.episodeKey).toBe(ago(400))
    expect(second?.episodeKey).toBe(first?.episodeKey)
  })

  test('an undelivered instruction or a Kawai-held step never stalls', () => {
    expect(changeSupervision(input({ instruction: { messageId: 'm', state: 'claimed', deliveredAt: null, blocker: null, holder: holder() } }), NOW).outcome).toBe('running')
    expect(changeSupervision(busy(600, { state: 'gating', step: 'pushing' }), NOW).cause).toEqual({ kind: 'stage', stage: 'kawai', step: 'pushing' })
  })
})

describe('labels', () => {
  test('an unknown cause or stop reason renders verbatim', () => {
    expect(causeLabel({ kind: 'hold' })).toBe('hold')
    expect(stopReasonLabel('quota-exceeded')).toBe('quota-exceeded')
    expect(stopReasonLabel('round-limit')).toBe('Failed 3 fix rounds')
    expect(causeLabel({ kind: 'stopped', reason: 'quota-exceeded', detail: null })).toBe('Stopped: quota-exceeded')
  })
})
