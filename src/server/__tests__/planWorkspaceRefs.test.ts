// The document-references store and its keyed commands (plan-workspace 1.2,
// design D4, invariant I3): insert-time validation against resolved plan,
// change-name, and worktree facts; replay without re-validation; refusals
// that write nothing, so a resend is evaluated afresh; team-scoped removal;
// associations surviving a close/reopen. Schema tests run through schemaDb()
// (the versioned runner); the restart test through a real file database.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initDatabase } from '../db'
import { MIGRATIONS } from '../dbSafety/migrations'
import { PlanWorkspaceRefs, type WorkspaceRefResolvers } from '../plans/workspace/workspaceRefs'
import { PlanWorkspaceStore } from '../plans/workspace/workspaceStore'
import { schemaDb } from './schemaDb'

let db: ReturnType<typeof schemaDb>
let refs: PlanWorkspaceRefs
let store: PlanWorkspaceStore
let planIds: Set<string>
let names: Set<string>
let worktrees: Set<string>

const resolvers = (): WorkspaceRefResolvers => ({
  planInTeam: id => planIds.has(id),
  changeNames: () => names,
  worktreeTarget: async id => worktrees.has(id),
})

const localAdd = (commandId: string, overrides: Record<string, unknown> = {}) =>
  refs.add('team-1', commandId, {
    planId: 'p1', label: 'Architecture', kind: 'local',
    worktreeId: '/repo', relativePath: 'notes/design.md', ...overrides,
  } as Parameters<PlanWorkspaceRefs['add']>[2], resolvers())

beforeEach(() => {
  db = schemaDb()
  refs = new PlanWorkspaceRefs(db)
  store = new PlanWorkspaceStore(db)
  planIds = new Set(['p1'])
  names = new Set(['alpha'])
  worktrees = new Set(['/repo'])
})

describe('adding references', () => {
  test('a local and an external reference are stored and read back at their scope', async () => {
    const local = await localAdd('r1')
    expect(local).toMatchObject({
      ok: true, replayed: false,
      ref: { planId: 'p1', changeName: null, label: 'Architecture', kind: 'local', worktreeId: '/repo', relativePath: 'notes/design.md', url: null },
    })
    expect(local.ok === true && local.ref.id).toMatch(/^ref-/)
    const external = await refs.add('team-1', 'r2', {
      planId: 'p1', label: 'Spec', kind: 'external', changeName: 'alpha', url: 'https://example.internal/design',
    }, resolvers())
    expect(external).toMatchObject({
      ok: true, ref: { kind: 'external', changeName: 'alpha', url: 'https://example.internal/design', worktreeId: null, relativePath: null },
    })
    expect(refs.refsOf('team-1', 'p1')).toHaveLength(2)
    expect(refs.refsOf('team-1', 'other')).toEqual([])
  })

  test('insert-time validation refuses with the offending field and writes nothing', async () => {
    expect(await refs.add('team-1', 'r1', { planId: '  ', label: 'x', kind: 'local', worktreeId: '/repo', relativePath: 'a.md' }, resolvers()))
      .toMatchObject({ ok: false, reason: 'invalid', field: 'planId' })
    expect(await refs.add('team-1', 'r1', { planId: 'p1', label: '', kind: 'local', worktreeId: '/repo', relativePath: 'a.md' }, resolvers()))
      .toMatchObject({ ok: false, field: 'label' })
    expect(await refs.add('team-1', 'r1', { planId: 'p1', label: 'x'.repeat(201), kind: 'local', worktreeId: '/repo', relativePath: 'a.md' }, resolvers()))
      .toMatchObject({ ok: false, field: 'label' })
    expect(await refs.add('team-1', 'r1', { planId: 'p1', label: 'x', kind: 'web' as 'local', worktreeId: '/repo', relativePath: 'a.md' }, resolvers()))
      .toMatchObject({ ok: false, field: 'kind' })
    // Another team's plan reads as not found (I1).
    expect(await refs.add('team-1', 'r1', { planId: 'elsewhere', label: 'x', kind: 'local', worktreeId: '/repo', relativePath: 'a.md' }, resolvers()))
      .toMatchObject({ ok: false, reason: 'not-found', field: 'planId', message: expect.stringContaining('Plan not found in this team') })
    expect(await localAdd('r1', { changeName: 'beta' }))
      .toMatchObject({ ok: false, field: 'changeName', message: expect.stringContaining('beta') })
    expect(await localAdd('r1', { worktreeId: '/unlisted' }))
      .toMatchObject({ ok: false, field: 'worktreeId', message: expect.stringContaining('/unlisted') })
    expect(await localAdd('r1', { relativePath: '../escape.md' }))
      .toMatchObject({ ok: false, field: 'relativePath' })
    expect(await localAdd('r1', { relativePath: '/etc/passwd' }))
      .toMatchObject({ ok: false, field: 'relativePath' })
    expect(await refs.add('team-1', 'r1', { planId: 'p1', label: 'x', kind: 'external', url: 'http://example.internal/a' }, resolvers()))
      .toMatchObject({ ok: false, field: 'url' })
    // A local reference carries a path, not a URL — and the other way round.
    expect(await localAdd('r1', { url: 'https://example.internal/a' })).toMatchObject({ ok: false, field: 'url' })
    expect(await refs.add('team-1', 'r1', { planId: 'p1', label: 'x', kind: 'external', url: 'https://example.internal/a', relativePath: 'a.md' }, resolvers()))
      .toMatchObject({ ok: false, field: 'worktreeId' })
    expect(refs.refsOf('team-1', 'p1')).toEqual([])
  })
})

describe('replays and refusals (I3)', () => {
  test('the same command id and payload replays the recorded reference without re-validating', async () => {
    const first = await localAdd('r1')
    expect(first).toMatchObject({ ok: true, replayed: false })
    // The resolver facts change after the insert: a replay never re-validates
    // (validation is at insert time only), so the reference still reads back.
    names.clear()
    planIds.clear()
    const replay = await localAdd('r1')
    expect(replay).toMatchObject({ ok: true, replayed: true, ref: first.ok === true ? first.ref : null })
    expect(refs.refsOf('team-1', 'p1')).toHaveLength(1)
  })

  test('a different payload or another kind under the same command id is refused naming the field', async () => {
    await localAdd('r1')
    expect(await localAdd('r1', { label: 'Other' })).toMatchObject({ ok: false, reason: 'payload', field: 'label' })
    expect(await localAdd('r1', { relativePath: 'notes/other.md' })).toMatchObject({ ok: false, reason: 'payload', field: 'relativePath' })
    // A bind row under the same command id refuses on the kind-first compare.
    db.prepare("INSERT INTO plan_workspace_commands (team_id, command_id, kind, payload, outcome, at) VALUES ('team-1', 'r2', 'bind', ?, ?, 't')")
      .run(JSON.stringify({ planId: 'p1', label: 'Architecture', kind: 'local', worktreeId: '/repo', relativePath: 'notes/design.md' }), JSON.stringify({ role: 'lead', sessionId: 's', version: 1 }))
    expect(await localAdd('r2')).toMatchObject({ ok: false, reason: 'payload', field: 'kind' })
    expect(refs.refsOf('team-1', 'p1')).toHaveLength(1)
  })

  test('a refused add writes nothing, so the same command id succeeds when resent after the state changes', async () => {
    // The change name is unknown: refused, and no ledger row.
    expect(await localAdd('r1', { changeName: 'beta' })).toMatchObject({ ok: false, field: 'changeName' })
    names.add('beta')
    // The resend under the same command id is evaluated afresh — and succeeds.
    expect(await localAdd('r1', { changeName: 'beta' })).toMatchObject({ ok: true, replayed: false, ref: { changeName: 'beta' } })
  })

  test('a missing or blank command id is refused before any lookup', async () => {
    expect(await localAdd('  ')).toMatchObject({ ok: false, reason: 'invalid', field: 'commandId' })
    expect(refs.refsOf('team-1', 'p1')).toEqual([])
  })
})

describe('removing references', () => {
  test('remove takes the row team-scoped and its replay returns the same outcome', async () => {
    const added = await localAdd('r1')
    const refId = added.ok === true ? added.ref.id : null
    const removed = refs.remove('team-1', 'x1', { refId: refId! })
    expect(removed).toMatchObject({ ok: true, replayed: false, removedRefId: refId, planId: 'p1' })
    expect(refs.refsOf('team-1', 'p1')).toEqual([])
    // The replay returns the same outcome and writes nothing (idempotent).
    const replay = refs.remove('team-1', 'x1', { refId: refId! })
    expect(replay).toMatchObject({ ok: true, replayed: true, removedRefId: refId })
    // Another team's id reads as not found, never removing across teams.
    expect(refs.remove('team-2', 'x2', { refId: refId! })).toMatchObject({ ok: false, reason: 'not-found' })
  })

  test('a gone or foreign reference, or a blank id, is refused with one not-found message and writes nothing', () => {
    expect(refs.remove('team-1', 'x1', { refId: 'ref-gone' })).toMatchObject({
      ok: false, reason: 'not-found', message: expect.stringContaining('Reference not found in this team'),
    })
    expect(refs.remove('team-1', 'x1', { refId: '  ' })).toMatchObject({ ok: false, reason: 'invalid', field: 'refId' })
    expect(refs.remove('team-1', '  ', { refId: 'ref-gone' })).toMatchObject({ ok: false, reason: 'invalid', field: 'commandId' })
  })

  test('a refused remove writes nothing, so the same command id succeeds when resent after the state changes', async () => {
    // The reference does not exist yet: refused, and no ledger row.
    expect(refs.remove('team-1', 'x1', { refId: 'ref-later' })).toMatchObject({ ok: false, reason: 'not-found' })
    // The state changes: a reference is added under another command id.
    const added = await localAdd('r1', { label: 'Later' })
    const refId = added.ok === true ? added.ref.id : null
    // The first command id was never recorded, so the resend under it is
    // evaluated afresh — and removes the reference that now exists.
    expect(refs.remove('team-1', 'x1', { refId: refId! })).toMatchObject({ ok: true, replayed: false, removedRefId: refId })
    expect(refs.refsOf('team-1', 'p1')).toEqual([])
  })
})

describe('restart retention', () => {
  test('references survive a close and reopen of the same database', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-workspace-refs-restart-'))
    try {
      const file = path.join(dir, 'agentboard.db')
      const first = initDatabase({ path: file, migrations: MIGRATIONS })
      const writer = new PlanWorkspaceRefs(first.db)
      const added = await writer.add('team-1', 'r1', {
        planId: 'p1', label: 'Architecture', kind: 'local', worktreeId: '/repo', relativePath: 'notes/design.md',
      }, { planInTeam: () => true, changeNames: () => new Set(), worktreeTarget: async () => true })
      expect(added).toMatchObject({ ok: true })
      if (!added.ok) throw new Error('the add must succeed to test retention')
      const stored = added.ref
      first.close()
      const reopened = initDatabase({ path: file, migrations: MIGRATIONS })
      try {
        const reader = new PlanWorkspaceRefs(reopened.db)
        expect(reader.refsOf('team-1', 'p1')).toEqual([stored])
      } finally { reopened.close() }
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
})
