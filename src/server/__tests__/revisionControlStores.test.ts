// The four revision-control stores (revision-control 2.2, design D2): the
// guarded Paused and decision updates write once; the execution-revision
// primary key maps a concurrent Apply's collision to
// `execution-revision-unchanged`; superseding a checkpoint keeps the earlier
// one readable. Each store is the only SQL writer of its tables.
import { describe, expect, test } from 'bun:test'
import { schemaDb } from './schemaDb'
import { CheckpointStore } from '../plans/revisionControl/checkpointStore'
import { ExecutionRevisionConflict, ExecutionRevisionStore } from '../plans/revisionControl/executionRevisionStore'
import { HoldStore } from '../plans/revisionControl/holdStore'
import { PauseStore } from '../plans/revisionControl/pauseStore'

const clock = { now: new Date('2026-10-20T12:00:00Z') }
const at = () => clock.now

describe('HoldStore', () => {
  test('a plan hold and a changes hold insert with their rows; active reads skip released', () => {
    const db = schemaDb()
    const store = new HoldStore(db, at)
    const plan = store.insert({ teamId: 't', planId: 'p', scope: 'plan', rationale: 'wrong direction', deadline: '2026-10-25T00:00:00Z', cites: null, commandId: 'cmd-1', changes: [] })
    expect(plan.id).toMatch(/^hold-/)
    const scoped = store.insert({ teamId: 't', planId: 'p', scope: 'changes', rationale: 'rework alpha', deadline: '2026-10-26T00:00:00Z', cites: { kind: 'decision-card', id: 'card-1' }, commandId: 'cmd-2', changes: ['alpha', 'beta'] })
    expect(scoped.changes).toEqual(['alpha', 'beta'])
    expect(scoped.cites).toEqual({ kind: 'decision-card', id: 'card-1' })
    expect(store.active('t', 'p')).toHaveLength(2)

    store.release({ teamId: 't', holdId: scoped.id, changes: ['alpha'], reason: 'narrowing', commandId: 'cmd-3' })
    expect(store.get('t', scoped.id)!.changes).toEqual(['beta'])
    expect(store.get('t', scoped.id)!.releasedAt).toBeNull()
    store.release({ teamId: 't', holdId: scoped.id, changes: ['beta'], reason: 'done', commandId: 'cmd-4' })
    expect(store.get('t', scoped.id)!.releasedAt).not.toBeNull()
    expect(store.active('t', 'p').map(hold => hold.id)).toEqual([plan.id])
  })

  test('a whole release is guarded: writing twice writes once', () => {
    const db = schemaDb()
    const store = new HoldStore(db, at)
    const hold = store.insert({ teamId: 't', planId: 'p', scope: 'plan', rationale: 'r', deadline: '2026-10-25T00:00:00Z', cites: null, commandId: 'cmd-1', changes: [] })
    expect(store.release({ teamId: 't', holdId: hold.id, changes: [], reason: 'a', commandId: 'cmd-2' }).written).toBe(true)
    const second = store.release({ teamId: 't', holdId: hold.id, changes: [], reason: 'b', commandId: 'cmd-3' })
    expect(second.written).toBe(false)
    expect(store.get('t', hold.id)!.releaseReason).toBe('a')
  })

  test('forPlan lists active holds before released ones, oldest first within each group', () => {
    // Invariant: `forPlan` orders active first — a released hold never hides
    // an active one behind its earlier creation.
    const db = schemaDb()
    let tick = 0
    const store = new HoldStore(db, () => new Date(Date.UTC(2026, 9, 20, 12, 0, tick++)))
    const first = store.insert({ teamId: 't', planId: 'p', scope: 'plan', rationale: 'r1', deadline: '2026-10-25T00:00:00Z', cites: null, commandId: 'cmd-1', changes: [] })
    const second = store.insert({ teamId: 't', planId: 'p', scope: 'plan', rationale: 'r2', deadline: '2026-10-25T00:00:00Z', cites: null, commandId: 'cmd-2', changes: [] })
    const third = store.insert({ teamId: 't', planId: 'p', scope: 'plan', rationale: 'r3', deadline: '2026-10-25T00:00:00Z', cites: null, commandId: 'cmd-3', changes: [] })
    store.release({ teamId: 't', holdId: second.id, changes: [], reason: 'done', commandId: 'cmd-4' })
    expect(store.forPlan('t', 'p').map(hold => hold.id)).toEqual([first.id, third.id, second.id])
    expect(store.forPlan('t', 'p').map(hold => hold.releasedAt === null)).toEqual([true, true, false])
  })

  test('a whole release stamps the hold\'s change rows released too', () => {
    // Invariant (D2): a released hold never lists a change as held — the
    // whole-release branch releases its `plan_hold_changes` rows as well.
    const db = schemaDb()
    const store = new HoldStore(db, at)
    const hold = store.insert({ teamId: 't', planId: 'p', scope: 'changes', rationale: 'r', deadline: '2026-10-25T00:00:00Z', cites: null, commandId: 'cmd-1', changes: ['alpha', 'beta'] })
    const released = store.release({ teamId: 't', holdId: hold.id, changes: [], reason: 'done', commandId: 'cmd-2' })
    expect(released.written).toBe(true)
    expect(released.hold!.releasedAt).not.toBeNull()
    expect(released.hold!.changes).toEqual([])
    expect(store.get('t', hold.id)!.changes).toEqual([])
    expect(store.active('t', 'p')).toHaveLength(0)
  })

  test('extend sets a later deadline only while the hold is active', () => {
    const db = schemaDb()
    const store = new HoldStore(db, at)
    const hold = store.insert({ teamId: 't', planId: 'p', scope: 'plan', rationale: 'r', deadline: '2026-10-25T00:00:00Z', cites: null, commandId: 'cmd-1', changes: [] })
    expect(store.extend({ teamId: 't', holdId: hold.id, deadline: '2026-11-10T00:00:00Z' })).toBe(true)
    expect(store.get('t', hold.id)!.deadline).toBe('2026-11-10T00:00:00Z')
    store.release({ teamId: 't', holdId: hold.id, changes: [], reason: 'done', commandId: 'cmd-2' })
    expect(store.extend({ teamId: 't', holdId: hold.id, deadline: '2026-12-01T00:00:00Z' })).toBe(false)
    expect(store.get('t', hold.id)!.deadline).toBe('2026-11-10T00:00:00Z')
  })
})

describe('PauseStore', () => {
  const insertPause = (store: PauseStore) => store.insert(
    { teamId: 't', planId: 'p', executionId: 'e', holdId: 'hold-1', deadline: '2026-10-21T00:00:00Z', note: null, commandId: 'cmd-1' },
    [{ change: 'alpha', stage: 'attempt', attemptId: 'att-1', assignmentId: 'asg-1', holderSession: 'session-1' }],
  )

  test('the guarded Paused update writes once', () => {
    const store = new PauseStore(schemaDb(), at)
    const pause = insertPause(store)
    const first = store.recordPaused(pause.id, 'alpha', 'checkpoint-1')
    expect(first.written).toBe(true)
    expect(first.target!.pausedAt).not.toBeNull()
    expect(first.target!.checkpointId).toBe('checkpoint-1')
    const second = store.recordPaused(pause.id, 'alpha', 'checkpoint-2')
    expect(second.written).toBe(false)
    expect(second.target!.checkpointId).toBe('checkpoint-1')
  })

  test('the guarded decision update writes once', () => {
    const store = new PauseStore(schemaDb(), at)
    const pause = insertPause(store)
    const first = store.recordDecision({ pauseId: pause.id, change: 'alpha', decision: 'restart', detail: { checkpoint: 'c1' }, commandId: 'dec-1' })
    expect(first.written).toBe(true)
    expect(first.target!.decision).toBe('restart')
    const second = store.recordDecision({ pauseId: pause.id, change: 'alpha', decision: 'continue', detail: {}, commandId: 'dec-2' })
    expect(second.written).toBe(false)
    expect(second.target!.decision).toBe('restart')
    expect(second.target!.decisionCommandId).toBe('dec-1')
  })

  test('closeIfDecided closes once every target is decided, and only once', () => {
    const store = new PauseStore(schemaDb(), at)
    const pause = store.insert(
      { teamId: 't', planId: 'p', executionId: 'e', holdId: 'hold-1', deadline: '2026-10-21T00:00:00Z', note: null, commandId: 'cmd-1' },
      [
        { change: 'alpha', stage: 'attempt', attemptId: null, assignmentId: 'asg-1', holderSession: 's1' },
        { change: 'beta', stage: 'review', attemptId: null, assignmentId: 'asg-2', holderSession: 's2' },
      ],
    )
    expect(store.closeIfDecided(pause.id)).toBe(false)
    store.recordDecision({ pauseId: pause.id, change: 'alpha', decision: 'continue', detail: {}, commandId: 'd1' })
    expect(store.closeIfDecided(pause.id)).toBe(false)
    store.recordDecision({ pauseId: pause.id, change: 'beta', decision: 'cancelled', detail: {}, commandId: 'd2' })
    expect(store.closeIfDecided(pause.id)).toBe(true)
    expect(store.closeIfDecided(pause.id)).toBe(false)
    expect(store.get('t', pause.id)!.closedAt).not.toBeNull()
  })

  test('the mail, holder, and checkpoint setters update the target', () => {
    const store = new PauseStore(schemaDb(), at)
    const pause = insertPause(store)
    store.setMail(pause.id, 'alpha', 'msg-1')
    store.setHolder(pause.id, 'alpha', 'session-2')
    store.setCheckpoint(pause.id, 'alpha', 'checkpoint-9')
    const target = store.target(pause.id, 'alpha')!
    expect(target.messageId).toBe('msg-1')
    expect(target.holderSession).toBe('session-2')
    expect(target.checkpointId).toBe('checkpoint-9')
  })
})

describe('CheckpointStore', () => {
  const insert = (store: CheckpointStore, summary: string) => store.insert({
    executionId: 'e', change: 'alpha', pauseId: 'pause-1', attemptId: 'att-1', sessionId: 'session-1',
    kind: 'commit', commitSha: `sha-${summary}`, baselineCommit: 'base', manifestHash: 'manifest',
    resultId: null, summary, unfinished: null, errorsTests: null, nextSteps: 'wait', effectId: null,
  })

  test('superseding a checkpoint keeps the earlier one readable', () => {
    const store = new CheckpointStore(schemaDb(), at)
    const first = insert(store, 'first')
    const second = insert(store, 'second')
    expect(store.get(first.id)!.supersededBy).toBe(second.id)
    // The earlier one stays readable whole.
    expect(store.get(first.id)!.summary).toBe('first')
    expect(store.get(first.id)!.commitSha).toBe('sha-first')
    expect(store.newest('pause-1', 'alpha')!.id).toBe(second.id)
    expect(store.forTarget('pause-1', 'alpha').map(checkpoint => checkpoint.id)).toEqual([second.id, first.id])
  })

  test('setEffect records the push effect on the committing checkpoint', () => {
    const store = new CheckpointStore(schemaDb(), at)
    const checkpoint = insert(store, 'first')
    store.setEffect(checkpoint.id, 'effect-7')
    expect(store.get(checkpoint.id)!.effectId).toBe('effect-7')
  })
})

describe('ExecutionRevisionStore', () => {
  const revision = (over: Partial<Parameters<ExecutionRevisionStore['record']>[0]> = {}) => ({
    executionId: 'e', revision: 3, contentHash: 'hash-3', reportId: 'report-3', inputHash: 'input-3',
    rationale: 'apply', commandId: 'apply-1', payload: { choices: {} }, appliedAt: '2026-10-20T12:00:00Z',
    ...over,
  })

  test('records appends seq 2 after the backfilled seq 1, with its publication rows', () => {
    const db = schemaDb()
    db.prepare(`INSERT INTO plan_executions (id, team_id, plan_id, revision, content_hash, report_id, input_hash,
      landing_mode, base_branch, base_commit, floor_json, max_parallel, merge_method, state, started_at)
      VALUES ('e', 't', 'p', 2, 'hash-2', 'report-2', 'input-2', 'direct', 'master', 'base', '{}', 2, 'merge', 'running', '2026-10-01T00:00:00Z')`).run()
    db.prepare(`INSERT INTO plan_execution_revisions (execution_id, seq, revision, content_hash, report_id, input_hash, applied_at)
      VALUES ('e', 1, 2, 'hash-2', 'report-2', 'input-2', '2026-10-01T00:00:00Z')`).run()
    const store = new ExecutionRevisionStore(db, at)
    const { seq, record } = store.record(revision(), [
      { change: 'alpha', class: 'changed', choice: 'adapt', fields: ['guidance'], taskId: 'task-1', taskRevision: 4 },
      { change: 'beta', class: 'unchanged', choice: null, fields: [], taskId: null, taskRevision: null },
    ])
    expect(seq).toBe(2)
    expect(record.revision).toBe(3)
    expect(store.newest('e')!.seq).toBe(2)
    const publications = store.publications('e', 2)
    expect(publications.map(row => row.change)).toEqual(['alpha', 'beta'])
    expect(publications[0].fields).toEqual(['guidance'])
    expect(publications[1].fields).toEqual([])
  })

  test('a colliding seq maps to execution-revision-unchanged', () => {
    const db = schemaDb()
    db.prepare(`INSERT INTO plan_execution_revisions (execution_id, seq, revision, content_hash, report_id, input_hash, applied_at)
      VALUES ('e', 1, 2, 'hash-2', 'r', 'i', '2026-10-01T00:00:00Z')`).run()
    const store = new ExecutionRevisionStore(db, at)
    // Two applies race on one base: both reach for seq 2, the winner commits,
    // and the loser's insert hits the primary key.
    const first = store.recordAt(2, revision({ commandId: 'apply-1' }), [])
    expect(first.seq).toBe(2)
    let conflict: ExecutionRevisionConflict | null = null
    try {
      store.recordAt(2, revision({ revision: 3, contentHash: 'hash-3b', commandId: 'apply-2' }), [])
    } catch (error) {
      conflict = error as ExecutionRevisionConflict
    }
    expect(conflict).not.toBeNull()
    expect(conflict!.kind).toBe('execution-revision-unchanged')
    expect(conflict!.name).toBe('ExecutionRevisionConflict')
    // The winner's row stands untouched.
    expect(store.newest('e')!.commandId).toBe('apply-1')
  })
})
