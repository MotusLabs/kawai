// The plans query's meaning (plan-workspace 7.1, design D8): the parameter
// grammar (`rev:`/`draft:`), the state-to-query direction the user acts
// write, and the loaded-data validation table — loading is pending (no
// notice, no apply), an unknown selector falls back with exactly one
// explanatory notice and no patch, and a valid field patches only where it
// differs from the current selection.
import { describe, expect, test } from 'bun:test'
import {
  applyPlansQuery, plansQueryOfState, versionParamOf, versionSelectorFromParam,
} from '../components/team/planWorkspaceLocation'

const loaded = (extra: Partial<{
  revisions: number[] | null; draftIds: string[] | null; executionIds: string[] | null
  changeNames: string[] | null; worktreePaths: string[] | null
}> = {}) => ({
  revisions: [1, 2], draftIds: ['d-1'], executionIds: ['e1', 'e2'],
  changeNames: ['api', 'web'], worktreePaths: ['/repo', '/repo/.worktrees/impl-x'],
  ...extra,
})

const current = (extra: Partial<Parameters<typeof applyPlansQuery>[2]> = {}) => ({
  version: null, executionId: null, selectedChange: null, selectedDocument: null,
  role: 'architect' as const,
  ...extra,
})

describe('version parameter grammar', () => {
  test('rev and draft round-trip; everything else is malformed (null)', () => {
    expect(versionParamOf({ kind: 'revision', revision: 3 })).toBe('rev:3')
    expect(versionParamOf({ kind: 'draft', draftId: 'd-abc' })).toBe('draft:d-abc')
    expect(versionSelectorFromParam('rev:3')).toEqual({ kind: 'revision', revision: 3 })
    expect(versionSelectorFromParam('draft:d-abc')).toEqual({ kind: 'draft', draftId: 'd-abc' })
    expect(versionSelectorFromParam('rev:0')).toBeNull()
    expect(versionSelectorFromParam('rev:-1')).toBeNull()
    expect(versionSelectorFromParam('rev:x')).toBeNull()
    expect(versionSelectorFromParam('draft:')).toBeNull()
    expect(versionSelectorFromParam('3')).toBeNull()
    expect(versionSelectorFromParam('rev:3x')).toBeNull()
  })

  test('the state query omits defaults and the architect role; the lead role is named', () => {
    expect(plansQueryOfState({
      version: null, executionId: null, selectedChange: null, selectedDocument: null, role: 'architect',
    })).toBeUndefined()
    expect(plansQueryOfState({
      version: { kind: 'revision', revision: 2 }, executionId: 'e2', selectedChange: 'api',
      selectedDocument: { worktreeId: '/repo', relativePath: 'docs/a.md' }, role: 'lead',
    })).toEqual({
      version: 'rev:2', execution: 'e2', change: 'api',
      document: { worktreeId: '/repo', relativePath: 'docs/a.md' }, role: 'lead',
    })
    // A patch merges over the state: a pick from a fallback state rewrites
    // the whole query from store truth.
    expect(plansQueryOfState({
      version: { kind: 'revision', revision: 1 }, executionId: null, selectedChange: null,
      selectedDocument: null, role: 'architect',
    }, { version: null, selectedChange: 'web' })).toEqual({ change: 'web' })
  })
})

describe('loaded-data validation', () => {
  test('a field whose list has not loaded is skipped whole — pending, never invalid', () => {
    const pending = applyPlansQuery(
      { version: 'rev:2', execution: 'e2', change: 'api', document: { worktreeId: '/repo', relativePath: 'a.md' } },
      loaded({ revisions: null, changeNames: null, worktreePaths: null }),
      current(),
    )
    expect(pending.patch.version).toBeUndefined()
    expect(pending.patch.selectedChange).toBeUndefined()
    expect(pending.patch.selectedDocument).toBeUndefined()
    expect(pending.patch.executionId).toBe('e2')
    expect(pending.notices).toEqual([])
  })

  test('an unknown revision, draft, or malformed version falls back with its notice and no patch', () => {
    const unknownRevision = applyPlansQuery({ version: 'rev:9' }, loaded(), current())
    expect(unknownRevision.patch.version).toBeUndefined()
    expect(unknownRevision.notices).toHaveLength(1)
    expect(unknownRevision.notices[0]).toContain('revision 9')

    const unknownDraft = applyPlansQuery({ version: 'draft:gone' }, loaded(), current())
    expect(unknownDraft.patch.version).toBeUndefined()
    expect(unknownDraft.notices[0]).toContain('draft')

    const malformed = applyPlansQuery({ version: 'banana' }, loaded(), current())
    expect(malformed.patch.version).toBeUndefined()
    expect(malformed.notices[0]).toContain('neither a revision nor a draft')
  })

  test('an unknown execution or change, or an undiscovered document worktree, each explain the fallback', () => {
    const execution = applyPlansQuery({ execution: 'e9' }, loaded(), current())
    expect(execution.patch.executionId).toBeUndefined()
    expect(execution.notices[0]).toContain('execution')

    const change = applyPlansQuery({ change: 'nope' }, loaded(), current())
    expect(change.patch.selectedChange).toBeUndefined()
    expect(change.notices[0]).toContain('change')

    const worktree = applyPlansQuery(
      { document: { worktreeId: '/elsewhere', relativePath: 'a.md' } }, loaded(), current())
    expect(worktree.patch.selectedDocument).toBeUndefined()
    expect(worktree.notices[0]).toContain('not discovered')

    const empty = applyPlansQuery({ document: { worktreeId: '', relativePath: 'a.md' } }, loaded(), current())
    expect(empty.patch.selectedDocument).toBeUndefined()
    expect(empty.notices[0]).toContain('without a worktree or path')
  })

  test('an unknown role falls back to Architect with its notice', () => {
    const role = applyPlansQuery({ role: 'chef' }, loaded(), current())
    expect(role.patch.role).toBeUndefined()
    expect(role.notices[0]).toContain('chef')
    expect(role.notices[0]).toContain('showing Architect')
    const lead = applyPlansQuery({ role: 'lead' }, loaded(), current({ role: 'architect' }))
    expect(lead.patch.role).toBe('lead')
    expect(lead.notices).toEqual([])
  })

  test('a fallback notice names the selection actually kept, not always the default', () => {
    // After a Back to a stale selector the retained selection stays shown.
    const stale = applyPlansQuery({ version: 'rev:9' }, loaded(),
      current({ version: { kind: 'revision', revision: 2 } }))
    expect(stale.notices[0]).toContain('showing revision 2')
    expect(stale.patch.version).toBeUndefined()
    // A retained change selection reads the same way.
    const kept = applyPlansQuery({ change: 'ghost' }, loaded(), current({ selectedChange: 'api' }))
    expect(kept.notices[0]).toContain('keeps “api” selected')
  })

  test('a valid field patches only where it differs; equal fields write nothing', () => {
    const { patch, notices } = applyPlansQuery(
      { version: 'rev:2', change: 'api', execution: 'e1' },
      loaded(),
      current({ version: { kind: 'revision', revision: 2 }, selectedChange: 'api' }),
    )
    expect(patch).toEqual({ executionId: 'e1' })
    expect(notices).toEqual([])
  })

  test('valid and invalid fields compose: the valid patch applies beside the invalid notice', () => {
    const mixed = applyPlansQuery({ version: 'rev:2', change: 'ghost', role: 'lead' }, loaded(), current())
    expect(mixed.patch.version).toEqual({ kind: 'revision', revision: 2 })
    expect(mixed.patch.role).toBe('lead')
    expect(mixed.patch.selectedChange).toBeUndefined()
    expect(mixed.notices).toHaveLength(1)
    expect(mixed.notices[0]).toContain('ghost')
  })

  test('a document link needs both its worktree and its path; a discovered one patches', () => {
    const ok = applyPlansQuery(
      { document: { worktreeId: '/repo/.worktrees/impl-x', relativePath: 'openspec/p.md' } },
      loaded(), current(),
    )
    expect(ok.patch.selectedDocument).toEqual({ worktreeId: '/repo/.worktrees/impl-x', relativePath: 'openspec/p.md' })
    const same = applyPlansQuery(
      { document: { worktreeId: '/repo/.worktrees/impl-x', relativePath: 'openspec/p.md' } },
      loaded(),
      current({ selectedDocument: { worktreeId: '/repo/.worktrees/impl-x', relativePath: 'openspec/p.md' } }),
    )
    expect(same.patch.selectedDocument).toBeUndefined()
  })
})
