// The per-message workspace context store (plan-workspace 1.2, design D7,
// invariant I4): one immutable accepted envelope per user message, keyed
// (session_id, message_uuid), the turn id grouping only; an identical
// re-insert is a no-op, a different context for the same key is refused with
// the first row standing; several user messages share one active turn; rows
// carry the team and plan columns and are never pruned. Schema tests run
// through schemaDb() (the versioned runner).
import { beforeEach, describe, expect, test } from 'bun:test'
import type { Database } from 'bun:sqlite'
import type { WorkspaceMessageContext } from '../../shared/planWorkspace'
import { PlanWorkspaceContext } from '../plans/workspace/workspaceContext'
import { schemaDb } from './schemaDb'

let db: Database
let context: PlanWorkspaceContext
beforeEach(() => {
  db = schemaDb()
  context = new PlanWorkspaceContext(db)
})

const envelope = (over: Partial<WorkspaceMessageContext> = {}): WorkspaceMessageContext => ({
  teamId: 'team-1', planId: 'p1', planTitle: 'Wave C',
  version: { kind: 'revision', revision: 2, contentHash: 'hash-2' },
  executionId: null, changeName: null, documentRefId: null, ...over,
})
const record = (sessionId: string, messageUuid: string, turnId: string | null, ctx: WorkspaceMessageContext = envelope()) =>
  context.record({ sessionId, messageUuid, turnId, context: ctx })

describe('recording contexts (I4)', () => {
  test('one accepted envelope is stored whole and reads back with its columns', () => {
    expect(record('s1', 'm1', 'turn-1')).toMatchObject({ ok: true, recorded: true })
    const stored = context.contextOf('s1', 'm1')!
    expect(stored).toMatchObject({ sessionId: 's1', messageUuid: 'm1', turnId: 'turn-1', recordedAt: expect.any(String) })
    expect(stored.context).toEqual(envelope())
    // The team and plan columns ride the row for scoped reads (design D7).
    const columns = db.prepare('SELECT team_id, plan_id FROM chat_workspace_turn_context WHERE session_id = ? AND message_uuid = ?').get('s1', 'm1') as { team_id: string; plan_id: string }
    expect(columns).toEqual({ team_id: 'team-1', plan_id: 'p1' })
  })

  test('an identical re-insert is a no-op; a different context for the same key is refused with the first row standing', () => {
    expect(record('s1', 'm1', 'turn-1')).toMatchObject({ ok: true, recorded: true })
    expect(record('s1', 'm1', 'turn-1')).toMatchObject({ ok: true, recorded: false })
    const refused = record('s1', 'm1', 'turn-2', envelope({ planId: 'p2' }))
    expect(refused).toMatchObject({ ok: false, reason: 'conflict', message: expect.stringContaining('m1') })
    // The first row stands: no OR IGNORE, no overwrite (I4).
    expect(context.contextOf('s1', 'm1')!.context).toEqual(envelope())
    expect(context.contextOf('s1', 'm1')!.turnId).toBe('turn-1')
  })

  test('a same-content resend in a different key order replays instead of conflicting (F4)', () => {
    expect(record('s1', 'm1', 'turn-1')).toMatchObject({ ok: true, recorded: true })
    // The stored JSON kept insertion order; the resend reverses it at the top
    // level and inside the version object. Same content, so it is the same
    // context: a replay, never a conflict.
    const reordered = {
      documentRefId: null, changeName: null, executionId: null,
      version: { contentHash: 'hash-2', revision: 2, kind: 'revision' } as const,
      planTitle: 'Wave C', planId: 'p1', teamId: 'team-1',
    } as unknown as WorkspaceMessageContext
    expect(record('s1', 'm1', 'turn-1', reordered)).toMatchObject({ ok: true, recorded: false })
    expect(context.contextOf('s1', 'm1')!.context).toEqual(envelope())
    // A real content difference under any key order still conflicts.
    expect(record('s1', 'm1', 'turn-1', envelope({ planId: 'p2' }))).toMatchObject({ ok: false, reason: 'conflict' })
  })

  test('another message uuid is a different key, even within one session', () => {
    expect(record('s1', 'm1', 'turn-1')).toMatchObject({ ok: true, recorded: true })
    expect(record('s1', 'm2', 'turn-1', envelope({ planId: 'p2' }))).toMatchObject({ ok: true, recorded: true })
    expect(context.contextOf('s1', 'm2')!.context.planId).toBe('p2')
  })

  test('a missing session or message uuid is refused before any write', () => {
    expect(record('', 'm1', null)).toMatchObject({ ok: false, reason: 'invalid' })
    expect(record('s1', '  ', null)).toMatchObject({ ok: false, reason: 'invalid' })
    expect(context.contextOf('s1', 'm1')).toBeNull()
  })

  test('a missing message reads as null', () => {
    expect(context.contextOf('s1', 'gone')).toBeNull()
  })
})

describe('several messages within one turn', () => {
  test('the turn groups them in insertion order and never keys them', () => {
    record('s1', 'm1', 'turn-1', envelope({ planId: 'p1' }))
    record('s1', 'm2', 'turn-1', envelope({ planId: 'p1', changeName: 'alpha' }))
    record('s1', 'm3', 'turn-2')
    const turn = context.contextsOfTurn('s1', 'turn-1')
    expect(turn.map(row => row.messageUuid)).toEqual(['m1', 'm2'])
    expect(turn.map(row => row.context.changeName)).toEqual([null, 'alpha'])
    expect(context.contextsOfTurn('s1', 'turn-2').map(row => row.messageUuid)).toEqual(['m3'])
    expect(context.contextsOfTurn('s1', 'gone')).toEqual([])
    expect(context.contextsOfTurn('other', 'turn-1')).toEqual([])
  })
})
