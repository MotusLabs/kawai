// The document-references store and its keyed commands (plan-workspace 1.2,
// design D4, invariant I3): insert-time validation against resolved plan,
// change-name, and worktree facts; replay without re-validation; refusals
// that write nothing, so a resend is evaluated afresh; team-scoped removal.
// Schema tests run through schemaDb() (the versioned runner).
import { beforeEach, describe, expect, test } from 'bun:test'
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
    worktreeId: '/repo', relativePath: 'docs/design.md', ...overrides,
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
      ref: { planId: 'p1', changeName: null, label: 'Architecture', kind: 'local', worktreeId: '/repo', relativePath: 'docs/design.md', url: null },
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
