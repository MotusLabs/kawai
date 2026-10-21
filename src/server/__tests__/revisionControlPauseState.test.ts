// The pure pause target state (revision-control 1.3, design D8): Paused
// only from `paused_at`, decided from a recorded decision or the execution's
// finish, and Pausing with every D8 cause that applies, in D8's order —
// `holder-killed` only for a killed holder whose work never reached `origin`.
import { describe, expect, test } from 'bun:test'
import { pauseTargetState, workOnOrigin, type PauseTargetFacts, type PauseTargetRecord } from '../plans/revisionControl/pauseState'

const record = (over: Partial<PauseTargetRecord> = {}): PauseTargetRecord => ({
  stage: 'attempt',
  holderSession: 'session-1',
  withdrawn: false,
  pausedAt: null,
  decision: null,
  checkpointKind: null,
  pushEffectState: null,
  ...over,
})

const facts = (over: Partial<PauseTargetFacts> = {}): PauseTargetFacts => ({
  executionFinished: false,
  messageDelivered: true,
  spawnUnclaimed: false,
  pendingRequest: false,
  busy: false,
  providerLimit: null,
  holder: 'live',
  readiness: { ready: true, reasons: [] },
  deadlinePassed: false,
  ...over,
})

const kinds = (state: ReturnType<typeof pauseTargetState>): string[] =>
  state.state === 'pausing' ? state.causes.map(cause => cause.kind) : []

describe('pauseTargetState', () => {
  test('Paused only from paused_at: fully eligible facts still read Pausing without it', () => {
    // Work on origin, holder ready, mail delivered — the executor records
    // Paused; the pure state never derives it from readiness.
    const target = record({ checkpointKind: 'commit', pushEffectState: 'done' })
    expect(pauseTargetState(target, facts())).toEqual({ state: 'pausing', causes: [], ownerRequired: false })
    expect(pauseTargetState(record({ pausedAt: '2026-10-20T10:00:00Z' }), facts())).toEqual({ state: 'paused' })
  })

  test('a recorded decision wins over paused_at, and a finished execution reads cancelled', () => {
    expect(pauseTargetState(record({ decision: 'restart', pausedAt: '2026-10-20T10:00:00Z' }), facts()))
      .toEqual({ state: 'decided', decision: 'restart' })
    expect(pauseTargetState(record(), facts({ executionFinished: true })))
      .toEqual({ state: 'decided', decision: 'cancelled' })
  })

  test('a withdrawn target carries no causes until Paused is recorded', () => {
    expect(pauseTargetState(record({ withdrawn: true, holderSession: null }), facts()))
      .toEqual({ state: 'pausing', causes: [], ownerRequired: false })
  })

  test('every D8 cause, in D8 order', () => {
    const state = pauseTargetState(record(), facts({
      messageDelivered: false,
      spawnUnclaimed: true,
      pendingRequest: true,
      busy: true,
      providerLimit: { profile: 'glm', resetAt: '2026-10-20T20:00:00Z' },
      readiness: { ready: false, reasons: ['busy on another task'] },
    }))
    expect(kinds(state)).toEqual([
      'awaiting-delivery', 'starting', 'request', 'busy', 'provider-limit', 'no-checkpoint', 'readiness',
    ])
    if (state.state !== 'pausing') throw new Error('expected pausing')
    expect(state.causes.find(cause => cause.kind === 'provider-limit')).toEqual({
      kind: 'provider-limit', profile: 'glm', resetAt: '2026-10-20T20:00:00Z',
    })
    expect(state.causes.find(cause => cause.kind === 'readiness')).toEqual({
      kind: 'readiness', reason: 'busy on another task',
    })
  })

  test('checkpoint causes: none recorded, pushing, and failed', () => {
    expect(kinds(pauseTargetState(record(), facts()))).toEqual(['no-checkpoint'])
    expect(kinds(pauseTargetState(record({ checkpointKind: 'commit', pushEffectState: 'running' }), facts())))
      .toEqual(['checkpoint-pushing'])
    expect(kinds(pauseTargetState(record({ checkpointKind: 'commit', pushEffectState: 'pending' }), facts())))
      .toEqual(['checkpoint-pushing'])
    expect(kinds(pauseTargetState(record({ checkpointKind: 'commit', pushEffectState: 'failed' }), facts())))
      .toEqual(['checkpoint-push-failed'])
    // An unsettled (unknown) or cancelled push reads as failed: recording
    // again is the way out of either.
    expect(kinds(pauseTargetState(record({ checkpointKind: 'commit', pushEffectState: 'unknown' }), facts())))
      .toEqual(['checkpoint-push-failed'])
    expect(kinds(pauseTargetState(record({ checkpointKind: 'commit', pushEffectState: 'cancelled' }), facts())))
      .toEqual(['checkpoint-push-failed'])
    expect(kinds(pauseTargetState(record({ checkpointKind: 'commit', pushEffectState: 'done' }), facts())))
      .toEqual([])
  })

  test('holder-killed only for a killed holder with nothing pushed', () => {
    const killed = facts({ holder: 'killed' })
    expect(kinds(pauseTargetState(record(), killed))).toEqual(['no-checkpoint', 'holder-killed'])
    const killedPushed = facts({ holder: 'killed' })
    expect(kinds(pauseTargetState(record({ checkpointKind: 'commit', pushEffectState: 'done' }), killedPushed)))
      .toEqual([])
    // A killed holder counts as ready once its work is on origin; readiness
    // reasons would only name a live holder's facts.
  })

  test('a review target has no checkpoint causes, and its work counts as on origin', () => {
    expect(kinds(pauseTargetState(record({ stage: 'review' }), facts()))).toEqual([])
    // A killed review holder's work is on origin by the recording rule, so it
    // reads ready rather than holder-killed.
    expect(kinds(pauseTargetState(record({ stage: 'review' }), facts({ holder: 'killed' })))).toEqual([])
    expect(kinds(pauseTargetState(record({ stage: 'review' }), facts({ readiness: { ready: false, reasons: ['holding mail'] } }))))
      .toEqual(['readiness'])
  })

  test('owner-required causes: holder-killed, checkpoint-push-failed, or any cause past the deadline', () => {
    const read = (state: ReturnType<typeof pauseTargetState>): boolean =>
      state.state === 'pausing' ? state.ownerRequired : false
    expect(read(pauseTargetState(record(), facts({ holder: 'killed' })))).toBe(true)
    expect(read(pauseTargetState(record({ checkpointKind: 'commit', pushEffectState: 'failed' }), facts()))).toBe(true)
    // Busy at the deadline cannot clear without the owner; before it, it is not owner-required.
    expect(read(pauseTargetState(record(), facts({ busy: true })))).toBe(false)
    expect(read(pauseTargetState(record(), facts({ busy: true, deadlinePassed: true })))).toBe(true)
    // No causes even past the deadline: a fully pushed, ready target is not owner-required.
    const settled = record({ checkpointKind: 'commit', pushEffectState: 'done' })
    expect(read(pauseTargetState(settled, facts({ deadlinePassed: true })))).toBe(false)
  })

  test('workOnOrigin: a review, a result checkpoint, or a pushed commit', () => {
    expect(workOnOrigin(record({ stage: 'review' }))).toBe(true)
    expect(workOnOrigin(record({ checkpointKind: 'result' }))).toBe(true)
    expect(workOnOrigin(record({ checkpointKind: 'commit', pushEffectState: 'done' }))).toBe(true)
    expect(workOnOrigin(record({ checkpointKind: 'commit', pushEffectState: 'running' }))).toBe(false)
    expect(workOnOrigin(record({ checkpointKind: 'notes' }))).toBe(false)
    expect(workOnOrigin(record())).toBe(false)
  })
})
