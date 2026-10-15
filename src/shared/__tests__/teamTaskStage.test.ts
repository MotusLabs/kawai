// D4's Phase 1 ladder (team-workspace 3.1): every stage it can produce, the
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

describe('teamTaskStage (Phase 1 ladder)', () => {
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
