// The workspace's shared contracts (plan-workspace 1.1): defensive selector
// parsers, draft/revision discrimination, the relative-path rule, and
// optional-field compatibility — a message without the newer fields still
// means the default selection.
import { describe, expect, test } from 'bun:test'
import {
  isRelativeWorkspacePath, parseExecutionSelector, parseVersionSelector, parseWorkspaceRole,
  type WorkspaceSnapshot,
} from '../planWorkspace'

describe('version selectors', () => {
  test('malformed shapes are refused and absent means the default', () => {
    expect(parseVersionSelector(undefined)).toBeNull()
    expect(parseVersionSelector(null)).toBeNull()
    expect(parseVersionSelector('revision')).toBeNull()
    expect(parseVersionSelector({})).toBeNull()
    expect(parseVersionSelector({ kind: 'revision' })).toBeNull()
    expect(parseVersionSelector({ kind: 'revision', revision: 1.5 })).toBeNull()
    expect(parseVersionSelector({ kind: 'revision', revision: 0 })).toBeNull()
    expect(parseVersionSelector({ kind: 'revision', revision: -2 })).toBeNull()
    expect(parseVersionSelector({ kind: 'draft', draftId: '  ' })).toBeNull()
    expect(parseVersionSelector({ kind: 'draft' })).toBeNull()
    expect(parseVersionSelector({ kind: 'commit', commit: 'abc' })).toBeNull()
    // Draft/revision discrimination: the kinds stay distinct, extra fields drop.
    expect(parseVersionSelector({ kind: 'revision', revision: 3 })).toEqual({ kind: 'revision', revision: 3 })
    expect(parseVersionSelector({ kind: 'draft', draftId: 'explorer' })).toEqual({ kind: 'draft', draftId: 'explorer' })
    expect(parseVersionSelector({ kind: 'draft', draftId: 'explorer', revision: 3 })).toEqual({ kind: 'draft', draftId: 'explorer' })
  })

  test('execution selectors parse separately and never reshape the version selector', () => {
    expect(parseExecutionSelector(undefined)).toBeNull()
    expect(parseExecutionSelector({})).toBeNull()
    expect(parseExecutionSelector({ executionId: '  ' })).toBeNull()
    expect(parseExecutionSelector({ executionId: 7 })).toBeNull()
    expect(parseExecutionSelector({ executionId: 'exec-1' })).toEqual({ executionId: 'exec-1' })
    // A version selector is not an execution selector.
    expect(parseExecutionSelector({ kind: 'revision', revision: 1 })).toBeNull()
    expect(parseVersionSelector({ executionId: 'exec-1' })).toBeNull()
  })

  test('roles parse to their union', () => {
    expect(parseWorkspaceRole('architect')).toBe('architect')
    expect(parseWorkspaceRole('lead')).toBe('lead')
    expect(parseWorkspaceRole('boss')).toBeNull()
    expect(parseWorkspaceRole(42)).toBeNull()
  })
})

describe('relative workspace paths', () => {
  test('repository-relative normalized paths pass', () => {
    expect(isRelativeWorkspacePath('a.md')).toBe(true)
    expect(isRelativeWorkspacePath('docs/design.md')).toBe(true)
    expect(isRelativeWorkspacePath('openspec/changes/x/specs/y/spec.md')).toBe(true)
  })

  test('escapes, absolutes, and network paths fail', () => {
    expect(isRelativeWorkspacePath('')).toBe(false)
    expect(isRelativeWorkspacePath('/etc/passwd')).toBe(false)
    expect(isRelativeWorkspacePath('C:\\temp\\x.md')).toBe(false)
    expect(isRelativeWorkspacePath('a/../b.md')).toBe(false)
    expect(isRelativeWorkspacePath('../secret')).toBe(false)
    expect(isRelativeWorkspacePath('a/./b.md')).toBe(false)
    expect(isRelativeWorkspacePath('a//b.md')).toBe(false)
    expect(isRelativeWorkspacePath('dir/')).toBe(false)
    expect(isRelativeWorkspacePath('//server/share/x.md')).toBe(false)
    expect(isRelativeWorkspacePath('a\u0000b')).toBe(false)
    expect(isRelativeWorkspacePath('a\\b.md')).toBe(false)
  })
})

describe('optional-field compatibility', () => {
  test('a snapshot without the newer additive fields is a valid WorkspaceSnapshot', () => {
    // Older senders never name an execution; receivers read it as absent.
    const snapshot: WorkspaceSnapshot = {
      plan: { id: 'p', title: 'T', lifecycle: 'open' },
      displayedVersion: null,
      bindings: [],
      references: [],
    }
    expect('execution' in snapshot).toBe(false)
  })
})
