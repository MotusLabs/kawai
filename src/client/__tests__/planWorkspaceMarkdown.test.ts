// The reader's scoped Markdown resolvers (plan-workspace 5.3, design D4):
// relative targets resolve against the displayed document's directory and
// never leave the worktree; external https opens separately; every other
// scheme, escape, and empty target is refused without exposure.
import { describe, expect, test } from 'bun:test'
import {
  readerAssetUrl, refusedReasonLabel, resolveReaderImage, resolveReaderLink,
  type RefusedLink, type ResolvedImage, type ResolvedLink,
} from '../utils/planWorkspaceMarkdown'

/** Narrow to a refusal so the reason is readable without a cast. */
const refused = (resolved: ResolvedLink | ResolvedImage): RefusedLink['reason'] => {
  if (resolved.kind !== 'refused') throw new Error(`expected a refusal, got ${resolved.kind}`)
  return resolved.reason
}

const doc = {
  worktreeId: '/repo/.worktrees/plan-workspace',
  relativePath: 'openspec/changes/plan-workspace/proposal.md',
  teamPath: '/repo',
}

describe('resolveReaderLink', () => {
  test('a sibling artifact resolves against the document directory', () => {
    expect(resolveReaderLink(doc, 'design.md')).toEqual({
      kind: 'document', relativePath: 'openspec/changes/plan-workspace/design.md',
    })
  })

  test('.. climbs only while the final path stays inside the worktree', () => {
    expect(resolveReaderLink(doc, '../tasks.md')).toEqual({
      kind: 'document', relativePath: 'openspec/changes/tasks.md',
    })
    expect(resolveReaderLink(doc, '../../../docs/architecture.md')).toEqual({
      kind: 'document', relativePath: 'docs/architecture.md',
    })
    expect(refused(resolveReaderLink(doc, '../../../../../etc/passwd'))).toBe('escape')
  })

  test('https opens separately; every other scheme and fragment is refused', () => {
    expect(resolveReaderLink(doc, 'https://example.internal/spec')).toEqual({
      kind: 'external', href: 'https://example.internal/spec',
    })
    expect(resolveReaderLink(doc, 'http://example.internal/spec').kind).toBe('refused')
    expect(resolveReaderLink(doc, 'javascript:alert(1)')).toEqual({
      kind: 'refused', reason: 'scheme', href: 'javascript:alert(1)',
    })
    expect(resolveReaderLink(doc, 'file:///etc/passwd').kind).toBe('refused')
    expect(resolveReaderLink(doc, '//example.internal/x').kind).toBe('refused')
    expect(refused(resolveReaderLink(doc, '#section'))).toBe('anchor')
    expect(refused(resolveReaderLink(doc, ''))).toBe('empty')
    // A target that resolves to the document's directory names no file; a
    // backslash smuggles no separator past the containment check.
    expect(refused(resolveReaderLink(doc, '.'))).toBe('empty')
    expect(refused(resolveReaderLink(doc, './'))).toBe('empty')
    expect(refused(resolveReaderLink(doc, '..\\..\\passwd'))).toBe('escape')
  })

  test('a root-absolute path is read from the worktree root, still contained', () => {
    expect(resolveReaderLink(doc, '/docs/architecture.md')).toEqual({
      kind: 'document', relativePath: 'docs/architecture.md',
    })
  })
})

describe('resolveReaderImage', () => {
  test('a permitted relative image renders through the scoped asset route', () => {
    const resolved = resolveReaderImage(doc, 'mockup.png')
    expect(resolved.kind).toBe('image')
    if (resolved.kind !== 'image') return
    expect(resolved.relativePath).toBe('openspec/changes/plan-workspace/mockup.png')
    const url = new URL(resolved.src, 'http://localhost')
    expect(url.pathname).toBe('/api/plan-workspace/asset')
    expect(url.searchParams.get('teamPath')).toBe('/repo')
    expect(url.searchParams.get('worktree')).toBe('/repo/.worktrees/plan-workspace')
    expect(url.searchParams.get('path')).toBe('openspec/changes/plan-workspace/mockup.png')
  })

  test('remote and data images are never fetched: refused with a reason', () => {
    expect(resolveReaderImage(doc, 'https://example.internal/picture.png')).toEqual({
      kind: 'refused', reason: 'external', href: 'https://example.internal/picture.png',
    })
    expect(resolveReaderImage(doc, 'data:image/png;base64,AAAA').kind).toBe('refused')
    // Two levels up stays inside; four climbs past the worktree root.
    expect(resolveReaderImage(doc, '../../outside.png').kind).toBe('image')
    expect(refused(resolveReaderImage(doc, '../../../../outside.png'))).toBe('escape')
  })
})

describe('readerAssetUrl and labels', () => {
  test('the asset URL names team, worktree, and path for the scoped route', () => {
    const url = new URL(readerAssetUrl(doc, 'docs/architecture.svg'), 'http://localhost')
    expect(url.pathname).toBe('/api/plan-workspace/asset')
    expect(url.searchParams.get('path')).toBe('docs/architecture.svg')
  })

  test('every refusal reason has a text label (the reader renders it inert)', () => {
    for (const reason of ['external', 'scheme', 'escape', 'empty', 'anchor'] as const) {
      expect(refusedReasonLabel(reason).length).toBeGreaterThan(0)
    }
  })
})
