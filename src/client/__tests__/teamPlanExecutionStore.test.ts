// teamPlanStore's execution wiring (plan-execution §15.3): the detail's
// `executions` ride the view (`detailExecutions`), replacing whole on every
// push; the Start/Stop/Retry actions join the armed-command vocabulary; and
// every applying method has a dispatch caller in the protocol layer (the
// grep test — a store method nothing dispatches is dead wiring).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import type { PlanDetail } from '@shared/plans'
import { useTeamPlanStore } from '../stores/teamPlanStore'

const teamKey = '/repo'

beforeEach(() => {
  useTeamPlanStore.getState().close(teamKey)
  useTeamPlanStore.getState().open(teamKey)
})
afterEach(() => useTeamPlanStore.getState().close(teamKey))

const executionSummary = (id: string) => ({ id, planId: 'plan-1', revision: 1, contentHash: 'h', reportId: 'r', inputHash: 'i', landingMode: 'direct' as const, baseBranch: 'master', baseCommit: 'abc', floor: { version: 1, map: { lint: ['ci'], typecheck: ['ci'], 'unit-tests': ['ci'], 'ci-e2e': ['e2e'] } }, maxParallel: 2, mergeMethod: 'merge' as const, state: 'running' as const, outcome: null, stopReason: null, startedAt: '', finishedAt: null, changes: [] })

const detail = (executions: PlanDetail['executions']): PlanDetail => ({
  plan: { id: 'plan-1', teamId: 't', title: 'P', lifecycle: 'open' as const, createdAt: '', updatedAt: '', state: 'in-progress' as const, creator: { kind: 'human' as const, sessionId: null }, currentApprovedRevision: 1, pin: null, linkedTaskCount: 0 },
  revisions: [], drafts: [], events: [], linkedTasks: [], progress: null,
  ...(executions === undefined ? {} : { executions }),
})

describe('teamPlanStore executions (§15.3)', () => {
  test('the detail push carries executions; a push without them keeps the old shape', () => {
    const store = useTeamPlanStore.getState()
    store.select(teamKey, 'plan-1')
    store.applyDetail({ type: 'team-plan-detail', teamPath: teamKey, teamId: 't', detail: detail([executionSummary('exec-1')]) })
    expect(useTeamPlanStore.getState().views[teamKey]?.detailExecutions).toEqual([executionSummary('exec-1')])
    store.applyDetail({ type: 'team-plan-detail', teamPath: teamKey, teamId: 't', detail: detail(undefined) })
    expect(useTeamPlanStore.getState().views[teamKey]?.detailExecutions).toBeUndefined()
  })

  test('the execution actions arm, reuse, and retire like every plan command', () => {
    const store = useTeamPlanStore.getState()
    store.arm(teamKey, 'start:plan-1:1')
    const first = store.command(teamKey, 'start:plan-1:1', JSON.stringify({ revision: 1, contentHash: 'h' }), 'q1')
    const reused = store.command(teamKey, 'start:plan-1:1', JSON.stringify({ revision: 1, contentHash: 'h' }), 'q2')
    expect(reused).toBe(first)
    const reminted = store.command(teamKey, 'start:plan-1:1', JSON.stringify({ revision: 2, contentHash: 'h' }), 'q3')
    expect(reminted).not.toBe(first)
    store.begin(teamKey, 'q3', 'start')
    expect(useTeamPlanStore.getState().views[teamKey]?.pending.q3).toBe('start')
    store.applyResult({ type: 'team-plan-result', teamPath: teamKey, requestId: 'q3', execution: { id: 'exec-1', state: 'running', outcome: null } } as never)
    expect(useTeamPlanStore.getState().views[teamKey]?.pending.q3).toBeUndefined()
    expect(useTeamPlanStore.getState().views[teamKey]?.commands['start:plan-1:1']).toBeUndefined()
  })

  test('every applying method has a dispatch caller in the protocol layer', () => {
    const storeFile = fs.readFileSync(path.join(process.cwd(), 'src/client/stores/teamPlanStore.ts'), 'utf8')
    const protocolFile = fs.readFileSync(path.join(process.cwd(), 'src/client/protocol/teamMessages.ts'), 'utf8')
    const applying = [...storeFile.matchAll(/^  (apply\w+):/gm)].map(match => match[1]!)
    expect(applying.length).toBeGreaterThanOrEqual(3)
    for (const method of applying) {
      expect(protocolFile).toContain(`plans.${method}`)
    }
  })
})
