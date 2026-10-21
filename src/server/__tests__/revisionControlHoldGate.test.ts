// The pure hold gate (revision-control 1.3, design D5): a change is held by
// a whole-plan hold, by a changes-scoped hold naming it, and by an undecided
// pause target; a released hold row and a decided target no longer hold.
import { describe, expect, test } from 'bun:test'
import { holdGate, type OpenPauseTarget } from '../plans/revisionControl/holdGate'
import type { ActiveHold } from '../../shared/planRevisionControl'

const planHold = (id: string): ActiveHold => ({ id, scope: 'plan', changes: [] })
const changesHold = (id: string, ...changes: string[]): ActiveHold => ({ id, scope: 'changes', changes })
const target = (pauseId: string, change: string, decision: string | null = null): OpenPauseTarget =>
  ({ pauseId, change, decision })

describe('holdGate', () => {
  test('a whole-plan hold covers every change with scope plan', () => {
    expect(holdGate([planHold('hold-a')], [], 'alpha')).toEqual({
      holdIds: ['hold-a'], scope: 'plan', pauseId: null,
    })
  })

  test('a changes hold covers only its named changes', () => {
    const holds = [changesHold('hold-b', 'alpha', 'gamma')]
    expect(holdGate(holds, [], 'alpha')?.holdIds).toEqual(['hold-b'])
    expect(holdGate(holds, [], 'beta')).toBeNull()
  })

  test('a change is no longer held once its row is released', () => {
    // The caller passes active holds only: after the release the narrowed
    // list is what the store hands over, and the gate reads it as such.
    const before = [changesHold('hold-b', 'alpha', 'gamma')]
    expect(holdGate(before, [], 'alpha')).not.toBeNull()
    const afterRelease = [changesHold('hold-b', 'gamma')]
    expect(holdGate(afterRelease, [], 'alpha')).toBeNull()
  })

  test('holdIds are sorted and a plan hold decides the scope beside a changes hold', () => {
    const holds = [changesHold('hold-c', 'alpha'), planHold('hold-a'), changesHold('hold-b', 'alpha')]
    expect(holdGate(holds, [], 'alpha')).toEqual({
      holdIds: ['hold-a', 'hold-b', 'hold-c'], scope: 'plan', pauseId: null,
    })
    const withoutPlan = holds.filter(hold => hold.scope !== 'plan')
    expect(holdGate(withoutPlan, [], 'alpha')?.scope).toBe('changes')
  })

  test('an undecided pause target closes the gate and names its pause', () => {
    expect(holdGate([], [target('pause-1', 'alpha')], 'alpha')).toEqual({
      holdIds: [], scope: 'changes', pauseId: 'pause-1',
    })
    expect(holdGate([], [target('pause-1', 'alpha')], 'beta')).toBeNull()
  })

  test('a decided pause target no longer closes the gate', () => {
    expect(holdGate([], [target('pause-1', 'alpha', 'restart')], 'alpha')).toBeNull()
  })

  test('holds and an open pause close together, the pause named beside the holds', () => {
    const gate = holdGate([changesHold('hold-b', 'alpha')], [target('pause-1', 'alpha')], 'alpha')
    expect(gate).toEqual({ holdIds: ['hold-b'], scope: 'changes', pauseId: 'pause-1' })
  })

  test('nothing holds an unknown change', () => {
    expect(holdGate([], [], 'anything')).toBeNull()
  })
})
