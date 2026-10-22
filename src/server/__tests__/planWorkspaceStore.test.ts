// The workspace bindings store and its keyed-command ledger (plan-workspace
// 1.2, design D6, invariants I2/I3): CAS binds with a version that only
// grows, distinct roles, replay and different-payload refusals, constraint
// errors mapped, and a refusal that succeeds when resent after the state
// changes. Schema tests run through schemaDb() (the versioned runner).
import { beforeEach, describe, expect, test } from 'bun:test'
import { PlanWorkspaceStore, mapConstraint } from '../plans/workspace/workspaceStore'
import { schemaDb } from './schemaDb'

let store: PlanWorkspaceStore
let db: ReturnType<typeof schemaDb>
beforeEach(() => {
  db = schemaDb()
  store = new PlanWorkspaceStore(db)
})

const bind = (commandId: string, role: 'architect' | 'lead', sessionId: string, expectedVersion: number | null) =>
  store.bind('team-1', commandId, { role, sessionId, expectedVersion })

describe('bindings', () => {
  test('distinct roles hold distinct sessions; every accepted bind bumps the version', () => {
    expect(bind('b1', 'lead', 's1', null)).toMatchObject({ ok: true, replayed: false, role: 'lead', sessionId: 's1', version: 1 })
    expect(bind('b2', 'architect', 's2', null)).toMatchObject({ ok: true, version: 1 })
    // Rebinding the same session to the same role still writes and bumps.
    expect(bind('b3', 'lead', 's1', 1)).toMatchObject({ ok: true, version: 2 })
    expect(store.bindings('team-1')).toHaveLength(2)
    expect(store.binding('team-1', 'lead')).toMatchObject({ sessionId: 's1', version: 2 })
    expect(store.binding('team-1', 'architect')).toMatchObject({ sessionId: 's2', version: 1 })
    expect(store.binding('team-2', 'lead')).toBeNull()
  })

  test('the version only grows across a replace and a replace back (no unbind, no DELETE)', () => {
    bind('b1', 'lead', 's1', null)
    expect(bind('b2', 'lead', 's2', 1)).toMatchObject({ ok: true, version: 2 })
    expect(bind('b3', 'lead', 's1', 2)).toMatchObject({ ok: true, version: 3 })
    expect(store.binding('team-1', 'lead')).toMatchObject({ sessionId: 's1', version: 3 })
  })

  test('a stale expectedVersion refuses and writes nothing', () => {
    bind('b1', 'lead', 's1', null)
    const refused = bind('b2', 'lead', 's2', 99)
    expect(refused).toMatchObject({ ok: false, reason: 'stale', field: 'expectedVersion' })
    expect(refused.ok === false && refused.message).toContain('99')
    // No ledger row, no binding change (I3: a refusal writes nothing).
    expect(store.binding('team-1', 'lead')).toMatchObject({ sessionId: 's1', version: 1 })
  })

  test('a stale expectedVersion on an unbound role refuses and writes nothing', () => {
    expect(bind('b1', 'lead', 's1', 1)).toMatchObject({ ok: false, reason: 'stale', field: 'expectedVersion' })
    expect(store.binding('team-1', 'lead')).toBeNull()
  })

  test('one session cannot hold both roles; the duplicate bind is refused naming the session', () => {
    bind('b1', 'lead', 's1', null)
    const refused = bind('b2', 'architect', 's1', null)
    expect(refused).toMatchObject({ ok: false, reason: 'session', field: 'sessionId' })
    expect(store.binding('team-1', 'architect')).toBeNull()
    expect(store.binding('team-1', 'lead')).toMatchObject({ sessionId: 's1', version: 1 })
  })

  test('malformed payloads are refused: a bad role, an empty session, a non-version CAS, a missing command id', () => {
    expect(store.bind('team-1', 'b1', { role: 'boss' as 'lead', sessionId: 's1', expectedVersion: null })).toMatchObject({ ok: false, reason: 'invalid', field: 'payload' })
    expect(bind('b1', 'lead', '  ', null)).toMatchObject({ ok: false, reason: 'invalid' })
    expect(store.bind('team-1', 'b1', { role: 'lead', sessionId: 's1', expectedVersion: 'zero' as unknown as null })).toMatchObject({ ok: false, reason: 'invalid' })
    expect(store.bind('team-1', '  ', { role: 'lead', sessionId: 's1', expectedVersion: null })).toMatchObject({ ok: false, reason: 'invalid', field: 'commandId' })
    expect(store.bindings('team-1')).toEqual([])
  })
})

describe('the command ledger', () => {
  test('the same command id and payload replays the prior outcome without a second write', () => {
    const first = bind('b1', 'lead', 's1', null)
    expect(first).toMatchObject({ ok: true, replayed: false, version: 1 })
    const boundAt = store.binding('team-1', 'lead')!.boundAt
    const replay = bind('b1', 'lead', 's1', null)
    expect(replay).toMatchObject({ ok: true, replayed: true, role: 'lead', sessionId: 's1', version: 1 })
    expect(store.binding('team-1', 'lead')).toMatchObject({ version: 1, boundAt })
    const ledger = db.prepare("SELECT COUNT(*) AS n FROM plan_workspace_commands WHERE team_id = 'team-1'").get() as { n: number }
    expect(ledger.n).toBe(1)
  })

  test('a different payload under the same command id is refused naming the field', () => {
    bind('b1', 'lead', 's1', null)
    expect(bind('b1', 'lead', 's2', null)).toMatchObject({ ok: false, reason: 'payload', field: 'sessionId' })
    expect(bind('b1', 'lead', 's1', 1)).toMatchObject({ ok: false, reason: 'payload', field: 'expectedVersion' })
    expect(bind('b1', 'architect', 's1', null)).toMatchObject({ ok: false, reason: 'payload', field: 'role' })
    // The recorded outcome stands; nothing moved.
    expect(store.binding('team-1', 'lead')).toMatchObject({ sessionId: 's1', version: 1 })
  })

  test('a refused bind writes nothing, so the same command id succeeds when resent after the state changes', () => {
    // Stale CAS: the role is unbound but the binder saw version 1.
    expect(bind('b1', 'lead', 's1', 1)).toMatchObject({ ok: false, reason: 'stale' })
    expect(store.binding('team-1', 'lead')).toBeNull()
    // The state changes through a different command id.
    expect(bind('b2', 'lead', 's1', null)).toMatchObject({ ok: true, version: 1 })
    // The first command id was never recorded (refusals write nothing), so
    // the resend with the now-correct CAS is evaluated afresh — and succeeds.
    expect(bind('b1', 'lead', 's1', 1)).toMatchObject({ ok: true, replayed: false, version: 2 })
  })

  test('a command id is scoped to its team', () => {
    bind('b1', 'lead', 's1', null)
    expect(store.bind('team-2', 'b1', { role: 'lead', sessionId: 's1', expectedVersion: null })).toMatchObject({ ok: true, replayed: false, version: 1 })
  })
})

describe('constraint mapping', () => {
  test('a role-key conflict maps to the stale refusal, a session-key conflict to the session refusal, and nothing raw escapes', () => {
    expect(mapConstraint(new Error('UNIQUE constraint failed: plan_workspace_chats.team_id, plan_workspace_chats.role')))
      .toMatchObject({ reason: 'stale', field: 'expectedVersion' })
    expect(mapConstraint(new Error('UNIQUE constraint failed: plan_workspace_chats.team_id, plan_workspace_chats.session_id')))
      .toMatchObject({ reason: 'session', field: 'sessionId' })
    expect(mapConstraint(new Error('no constraint here'))).toBeNull()
    expect(mapConstraint('not an error')).toBeNull()
  })
})
