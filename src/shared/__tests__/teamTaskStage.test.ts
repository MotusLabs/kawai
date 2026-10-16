// D4's ladder (team-workspace 3.1, 11.1): every stage it can produce, the
// order that a closed task outranks its assignment history, and the rule that
// a finished turn never yields a stage of done.
import { describe, expect, test } from 'bun:test'
import { teamTaskStage } from '../teamTaskStage'
import type { TeamTaskAssignment, TaskStatus } from '../teamTasks'

const assignment = (state: TeamTaskAssignment['state']): TeamTaskAssignment => ({
  id: 'as-1', taskId: 'task-1', requestKey: 'k', targetKind: 'group', targetId: 'devs', role: 'devs',
  instruction: 'go', createdBy: { kind: 'human', sessionId: null }, messageId: 'm-1',
  claimedBy: null, claimedAt: null, supersededBy: null, state, reason: null,
  createdAt: '2026-10-14T00:00:00Z', updatedAt: '2026-10-14T00:00:00Z',
})

const OPEN: TaskStatus[] = ['open', 'active', 'blocked']

describe('teamTaskStage ladder', () => {
  test('a closed task shows no stage whatever its assignment says', () => {
    for (const status of ['done', 'cancelled'] as const) {
      expect(teamTaskStage({ status }, assignment('delivered'))).toBeNull()
      expect(teamTaskStage({ status }, assignment('claimed'))).toBeNull()
      expect(teamTaskStage({ status }, null)).toBeNull()
    }
  })

  test('a working assignment is Implementing, a queued or missing one Unstarted', () => {
    for (const status of OPEN) {
      for (const state of ['claimed', 'delivered', 'parked', 'forwarded', 'uncertain'] as const) {
        expect(teamTaskStage({ status }, assignment(state))).toBe('implementing')
      }
      expect(teamTaskStage({ status }, assignment('queued'))).toBe('unstarted')
      expect(teamTaskStage({ status }, null)).toBe('unstarted')
    }
  })

  test('a finished turn never yields done: the ladder has no done stage', () => {
    // The projection takes no turn facts at all — a finished turn cannot
    // move it. The strongest assignment state still reads Implementing.
    expect(teamTaskStage({ status: 'active' }, assignment('delivered'))).toBe('implementing')
    expect(teamTaskStage({ status: 'active' }, null)).not.toBe('done')
  })

  test('a failed or superseded assignment is not outstanding, so the task is Unstarted', () => {
    expect(teamTaskStage({ status: 'open' }, assignment('failed'))).toBe('unstarted')
    expect(teamTaskStage({ status: 'open' }, assignment('superseded'))).toBe('unstarted')
  })
})

describe('teamTaskStage handoff and result orders (11.1)', () => {
  const handoff = (kind: 'review' | 'qa' | 'fix', state: TeamTaskAssignment['state'] = 'queued'): TeamTaskAssignment => ({
    ...assignment(state), handoffKind: kind, resultId: 'result-1', expectedResponse: 'findings',
  })

  test('each outstanding handoff kind names its stage, even while still queued', () => {
    expect(teamTaskStage({ status: 'active' }, handoff('review'))).toBe('in-review')
    expect(teamTaskStage({ status: 'active' }, handoff('qa', 'delivered'))).toBe('ready-for-qa')
    expect(teamTaskStage({ status: 'active' }, handoff('fix', 'claimed'))).toBe('fixes-requested')
  })

  test('a queued review handoff beats Awaiting acceptance', () => {
    expect(teamTaskStage({ status: 'active' }, handoff('review'), { accepted: false })).toBe('in-review')
  })

  test('an unaccepted outstanding result is Awaiting acceptance, over the assignment state', () => {
    expect(teamTaskStage({ status: 'active' }, assignment('delivered'), { accepted: false })).toBe('awaiting-acceptance')
    expect(teamTaskStage({ status: 'open' }, null, { accepted: false })).toBe('awaiting-acceptance')
  })

  test('an unaccepted result whose newest findings fail is Fixes requested', () => {
    const failing = { accepted: false, reviewVerdict: 'fail' as const }
    expect(teamTaskStage({ status: 'active' }, assignment('delivered'), failing)).toBe('fixes-requested')
    expect(teamTaskStage({ status: 'open' }, null, failing)).toBe('fixes-requested')
  })

  test('passing findings or none leave the result Awaiting acceptance', () => {
    expect(teamTaskStage({ status: 'active' }, null, { accepted: false, reviewVerdict: 'pass' })).toBe('awaiting-acceptance')
    expect(teamTaskStage({ status: 'active' }, null, { accepted: false, reviewVerdict: null })).toBe('awaiting-acceptance')
  })

  test('an outstanding handoff outranks failing findings, and an accepted or closed result ignores them', () => {
    const failing = { accepted: false, reviewVerdict: 'fail' as const }
    expect(teamTaskStage({ status: 'active' }, handoff('review'), failing)).toBe('in-review')
    expect(teamTaskStage({ status: 'active' }, handoff('qa'), failing)).toBe('ready-for-qa')
    expect(teamTaskStage({ status: 'active' }, assignment('delivered'), { accepted: true, reviewVerdict: 'fail' })).toBe('implementing')
    expect(teamTaskStage({ status: 'done' }, null, failing)).toBeNull()
  })

  test('an accepted result falls through to the assignment stage', () => {
    expect(teamTaskStage({ status: 'active' }, assignment('delivered'), { accepted: true })).toBe('implementing')
  })

  test('a closed task shows no stage even with a handoff or an unaccepted result', () => {
    expect(teamTaskStage({ status: 'done' }, handoff('review'), { accepted: false })).toBeNull()
  })
})
