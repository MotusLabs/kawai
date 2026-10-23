// The workspace's runtime projection (plan-workspace 3.1): the E/V identity
// cases (LC1), the no-execution holders rule (LC4), the state ladder's
// rows, holders that never select a row, and history that stays history
// (R6). Each CP1 decision-table row is one test.each row.
import { describe, expect, test } from 'bun:test'
import { normalizePlanContent, planChangeModified, type PlanContent } from '../plans'
import type { ChangeSupervision, SupervisionStage } from '../planSupervision'
import {
  workspaceChangeState,
  workspaceRuntime,
  workspaceTaskHolders,
  type WorkspaceExecutionRelation,
  type WorkspaceLinkedTaskInput,
  type WorkspaceRuntimeState,
} from '../planWorkspaceRuntime'

const supervision = (over: Partial<ChangeSupervision>): ChangeSupervision => ({
  change: 'api', outcome: 'running', cause: { kind: 'stage', stage: 'implement', step: null }, alsoApplying: [], stage: 'implement',
  holder: { session: 'dev', group: 'middle-devs', profile: 'default' }, progress: null, activity: null, stall: null, landing: null, lastRound: null,
  ...over,
})

const content = (changes: Array<{ change: string; dependsOn?: string[]; guidance?: string }>): PlanContent =>
  normalizePlanContent({ goal: 'g', successCriteria: ['s'], changes: changes.map(c => ({ change: c.change, dependsOn: c.dependsOn ?? [], guidance: c.guidance ?? '' })) })

const baseInput: WorkspaceLinkedTaskInput = {
  id: 'task-1', title: 'api task', status: 'active', planChange: 'api',
  assignment: null, result: null, priorClaimants: [], waitingReason: null,
}

describe('E/V identity cases', () => {
  const E = content([{ change: 'api', guidance: 'build it' }, { change: 'web', guidance: 'render it' }])
  const execution = { executionId: 'ex-1', revision: 2, content: E }

  test.each<[string, string, PlanContent, { relation: WorkspaceExecutionRelation; modified: boolean; state: WorkspaceRuntimeState['kind'] }]>([
    ['case 1: in both, unchanged — overlays its state labelled with E', 'api', E,
      { relation: 'overlay', modified: false, state: 'implementing' }],
    ['case 2: in both, modified in V — state labelled per revision E, not V\'s definition', 'api', content([{ change: 'api', guidance: 'rebuilt' }]),
      { relation: 'overlay-modified', modified: true, state: 'implementing' }],
    ['case 3: new in V — no runtime state', 'fresh', content([{ change: 'fresh', guidance: '' }]),
      { relation: 'new-in-version', modified: false, state: 'not-overlaid' }],
  ])('%s', (_name, displayed_change, displayedContent, expected) => {
    const view = workspaceRuntime({
      displayed: displayedContent, execution,
      supervision: new Map([['api', supervision({})], ['web', supervision({ change: 'web' })]]),
      tasks: [],
    })
    const row = view.changes.find(change => change.change === displayed_change)!
    expect(row.relation).toBe(expected.relation)
    expect(row.executionRevision).toBe(2)
    expect(row.modifiedSinceExecution).toBe(expected.modified)
    expect(row.state.kind).toBe(expected.state)
  })

  test('case 4: in E but not in V — the outside section, with its state', () => {
    const view = workspaceRuntime({
      displayed: content([{ change: 'api' }]), execution,
      supervision: new Map([['api', supervision({})], ['web', supervision({ change: 'web', outcome: 'landed', cause: { kind: 'landed', treeVerified: true }, landing: { landedAt: 't', treeVerified: true, mergeSha: 'm', postCi: null } })]]),
      tasks: [],
    })
    expect(view.outside.changes).toEqual([
      { change: 'web', executionRevision: 2, state: { kind: 'landed', landedAt: 't', treeVerified: true } },
    ])
  })

  test('case 5: V is E — plain overlay on every change', () => {
    const view = workspaceRuntime({
      displayed: E, execution: { executionId: 'ex-1', revision: 2, content: E },
      supervision: new Map([['api', supervision({})], ['web', supervision({ change: 'web' })]]),
      tasks: [],
    })
    expect(view.changes.map(change => change.relation)).toEqual(['overlay', 'overlay'])
  })
})

describe('no execution selected', () => {
  test.each<{ name: string; claimedBy: string | null; waitingReason: string | null; session: string | null }>([
    { name: 'case 1a: a claimed assignment still shows its holder', claimedBy: 'dev', waitingReason: null, session: 'dev' },
    { name: 'case 1b: an unclaimed group shows the group and the waiting reason', claimedBy: null, waitingReason: 'group at cap', session: null },
  ])('$name', ({ claimedBy, waitingReason, session }) => {
    const view = workspaceRuntime({
      displayed: content([{ change: 'api' }]), execution: null,
      supervision: new Map(),
      tasks: [{ ...baseInput, assignment: { targetKind: 'group', targetId: 'middle-devs', claimedBy, handoffKind: null, state: claimedBy === null ? 'queued' : 'delivered' }, waitingReason }],
    })
    const row = view.changes[0]!
    expect(row.state).toEqual({ kind: 'no-execution' })
    expect(row.executionRevision).toBeNull()
    expect(row.holders).toHaveLength(1)
    if (session !== null) {
      expect(row.holders[0]!.holder).toMatchObject({ kind: 'session', sessionId: 'dev' })
      expect(row.holders[0]!.waitingReason).toBeNull()
    } else {
      expect(row.holders[0]!.holder).toEqual({ kind: 'group-unclaimed', groupId: 'middle-devs' })
      expect(row.holders[0]!.waitingReason).toBe('group at cap')
    }
  })
})

describe('the state ladder', () => {
  test.each<[string, ChangeSupervision, WorkspaceRuntimeState]>([
    ['row 5: landed', supervision({ outcome: 'landed', cause: { kind: 'landed', treeVerified: true }, landing: { landedAt: 't', treeVerified: true, mergeSha: 'm', postCi: null } }), { kind: 'landed', landedAt: 't', treeVerified: true }],
    ['row 6: stopped', supervision({ outcome: 'stopped', cause: { kind: 'stopped', reason: 'round-limit', detail: null } }), { kind: 'stopped', reason: 'round-limit' }],
    ['row 7: cancelled', supervision({ outcome: 'cancelled', cause: { kind: 'cancelled' } }), { kind: 'cancelled' }],
    ['row 8: not started', supervision({ outcome: 'not-started', cause: { kind: 'not-started' }, holder: null, stage: null }), { kind: 'not-started' }],
    ['row 9: stalled', supervision({ outcome: 'stalled', cause: { kind: 'stall', stall: 'repeating-failure' }, stall: { kind: 'repeating-failure', episodeKey: 'e', signature: 's', rounds: ['a', 'b'] } }), { kind: 'stalled', stall: 'repeating-failure' }],
    ['row 13: waiting, staffing cause with its blocker', supervision({ outcome: 'waiting', cause: { kind: 'staffing', blocker: 'group at cap' }, stage: null }), { kind: 'waiting', cause: 'Waiting for staffing: group at cap' }],
    ['row 14: implementing names its stage', supervision({}), { kind: 'implementing', stage: 'implement' }],
  ])('%s', (_name, s, expected) => {
    expect(workspaceChangeState({ supervision: s, handoff: null, reviewClaimant: null, failingFindings: false })).toEqual(expected)
  })

  test.each<[string, { stage: SupervisionStage; handoff: 'review' | null; reviewClaimant: string | null }, string | null]>([
    ['row 10: the review stage names the instruction holder', { stage: 'review', handoff: null, reviewClaimant: null }, 'implementer'],
    ['row 10: an outstanding review handoff names its claimant', { stage: 'implement', handoff: 'review', reviewClaimant: 'dev' }, 'dev'],
    // Divergent fixture (B1): the implementer still holds the instruction;
    // the reviewer is the review handoff's claimant, never the holder.
    ['row 10: keyed on the handoff, it names the review claimant, not the instruction holder', { stage: 'implement', handoff: 'review', reviewClaimant: 'reviewer' }, 'reviewer'],
  ])('%s', (_name, facts, reviewer) => {
    const state = workspaceChangeState({ supervision: supervision({ stage: facts.stage, holder: { session: 'implementer', group: 'middle-devs', profile: 'default' } }), handoff: facts.handoff, reviewClaimant: facts.reviewClaimant, failingFindings: false })
    expect(state).toEqual({ kind: 'in-review', reviewer })
  })

  test('row 11: a qa handoff reads Ready for QA', () => {
    expect(workspaceChangeState({ supervision: supervision({}), handoff: 'qa', reviewClaimant: null, failingFindings: false }))
      .toEqual({ kind: 'ready-for-qa' })
  })

  test.each([
    ['row 12: a fix handoff reads Fixes requested', { handoff: 'fix' as const, failing: false }],
    ['row 12: failing findings read Fixes requested', { handoff: null, failing: true }],
  ])('%s', (_name, facts) => {
    expect(workspaceChangeState({ supervision: supervision({}), handoff: facts.handoff, reviewClaimant: null, failingFindings: facts.failing }))
      .toEqual({ kind: 'fixes-requested' })
  })

  test('12/12 checked sits beside In review and never labels the change landed', () => {
    const view = workspaceRuntime({
      displayed: content([{ change: 'api' }]),
      execution: { executionId: 'ex-1', revision: 1, content: content([{ change: 'api' }]) },
      supervision: new Map([['api', supervision({ stage: 'review' })]]),
      tasks: [],
      checklistTotals: () => ({ total: 12, checked: 12 }),
    })
    const row = view.changes[0]!
    expect(row.state).toEqual({ kind: 'in-review', reviewer: 'dev' })
    expect(row.checklist).toEqual({ total: 12, checked: 12 })
  })
})

describe('holders and history', () => {
  test('holders never select the state row: the same holders read implementing until a handoff stands', () => {
    const tasks: WorkspaceLinkedTaskInput[] = [
      { ...baseInput, assignment: { targetKind: 'group', targetId: 'middle-devs', claimedBy: 'dev', handoffKind: null, state: 'delivered' } },
      { ...baseInput, id: 'task-2', planChange: 'web', assignment: { targetKind: 'group', targetId: 'middle-devs', claimedBy: 'dev2', handoffKind: null, state: 'delivered' } },
    ]
    const implementing = workspaceRuntime({
      displayed: content([{ change: 'api' }, { change: 'web' }]),
      execution: { executionId: 'ex', revision: 1, content: content([{ change: 'api' }, { change: 'web' }]) },
      supervision: new Map([['api', supervision({})], ['web', supervision({ change: 'web' })]]),
      tasks,
    })
    expect(implementing.changes.map(change => change.state.kind)).toEqual(['implementing', 'implementing'])
    const reviewing = workspaceRuntime({
      displayed: content([{ change: 'api' }]),
      execution: { executionId: 'ex', revision: 1, content: content([{ change: 'api' }]) },
      supervision: new Map([['api', supervision({})]]),
      tasks: [tasks[0]!],
    })
    // Only the handoff moves the row, never the holders themselves.
    expect(reviewing.changes[0]!.state.kind).toBe('implementing')
    expect(workspaceChangeState({ supervision: supervision({}), handoff: 'review', reviewClaimant: 'reviewer', failingFindings: false }).kind).toBe('in-review')
  })

  test('parallel holders stay distinguishable: every holder of every linked task is listed', () => {
    const view = workspaceRuntime({
      displayed: content([{ change: 'api' }]),
      execution: null, supervision: new Map(),
      tasks: [
        { ...baseInput, id: 'task-1', assignment: { targetKind: 'group', targetId: 'middle-devs', claimedBy: 'dev', handoffKind: null, state: 'delivered' } },
        { ...baseInput, id: 'task-2', assignment: { targetKind: 'session', targetId: 'dev2', claimedBy: null, handoffKind: null, state: 'delivered' } },
      ],
    })
    expect(view.changes[0]!.holders.map(holder => holder.holder)).toEqual([
      { kind: 'session', sessionId: 'dev', name: null },
      { kind: 'session-unclaimed', sessionId: 'dev2', name: null },
    ])
  })

  test('a superseded assignment\'s holder is history, not current', () => {
    const shaped = workspaceTaskHolders({
      ...baseInput,
      assignment: { targetKind: 'group', targetId: 'middle-devs', claimedBy: 'dev', handoffKind: null, state: 'delivered' },
      priorClaimants: [{ sessionId: 'old-dev', handoffKind: null }],
    })
    expect(shaped.holder!.holder).toEqual({ kind: 'session', sessionId: 'dev', name: null })
    expect(shaped.history).toEqual([{ sessionId: 'old-dev', name: null, stage: 'implementing', source: 'former-claimant' }])
  })

  test('a prior claimant and the result submitter appear as history with identity and stage, carrying no readings', () => {
    const shaped = workspaceTaskHolders({
      ...baseInput,
      assignment: { targetKind: 'group', targetId: 'middle-devs', claimedBy: 'reviewer', handoffKind: 'review', state: 'delivered' },
      result: { submitter: 'builder', accepted: false, reviewVerdict: 'fail' },
      priorClaimants: [{ sessionId: 'builder', handoffKind: null }],
    })
    // History carries identity and stage only — the shape has no reading fields at all.
    expect(shaped.history).toEqual([
      { sessionId: 'builder', name: null, stage: 'implementing', source: 'former-claimant' },
      { sessionId: 'builder', name: null, stage: 'fixes-requested', source: 'result-submitter' },
    ])
    expect(shaped.history.some(entry => 'context' in entry || 'quota' in entry)).toBe(false)
    expect(shaped.holder!.holder).toEqual({ kind: 'session', sessionId: 'reviewer', name: null })
  })
})

describe('planChangeModified', () => {
  test.each([
    ['an unchanged entry reads false', [{ change: 'api', guidance: 'a' }], [{ change: 'api', guidance: 'a' }], 'api', false],
    ['a changed entry reads true', [{ change: 'api', guidance: 'a' }], [{ change: 'api', guidance: 'b' }], 'api', true],
    ['an added change is not modified', [], [{ change: 'api', guidance: '' }], 'api', false],
    ['a removed change is not modified', [{ change: 'api', guidance: '' }], [], 'api', false],
  ])('%s', (_name, baseChanges, nextChanges, change, expected) => {
    expect(planChangeModified(content(baseChanges), content(nextChanges), change)).toBe(expected)
  })
})

describe('outside linked work', () => {
  test('orphan plan_change tasks render in the outside section, never overlaid onto a version row', () => {
    const view = workspaceRuntime({
      displayed: content([{ change: 'api' }]),
      execution: { executionId: 'ex', revision: 1, content: content([{ change: 'api' }]) },
      supervision: new Map([['api', supervision({})]]),
      tasks: [{ ...baseInput, id: 'task-9', title: 'old task', planChange: 'removed' }],
    })
    expect(view.outside.tasks).toEqual([
      { taskId: 'task-9', title: 'old task', planChange: 'removed', holders: [] },
    ])
    expect(view.changes).toHaveLength(1)
  })

  test('two orphan tasks of one plan_change keep their own holders apart (N5)', () => {
    const view = workspaceRuntime({
      displayed: content([{ change: 'api' }]),
      execution: { executionId: 'ex', revision: 1, content: content([{ change: 'api' }]) },
      supervision: new Map([['api', supervision({})]]),
      tasks: [
        { ...baseInput, id: 'task-9', title: 'old task', planChange: 'removed' },
        { ...baseInput, id: 'task-10', title: 'claimed orphan', planChange: 'removed', assignment: { targetKind: 'session', targetId: 'dev', claimedBy: 'dev', handoffKind: null, state: 'delivered' } },
      ],
    })
    expect(view.outside.tasks.map(task => [task.taskId, task.holders])).toEqual([
      ['task-9', []],
      ['task-10', [{ taskId: 'task-10', holder: { kind: 'session', sessionId: 'dev', name: null }, stage: 'implementing', waitingReason: null }]],
    ])
  })
})
