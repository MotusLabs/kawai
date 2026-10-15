import { describe, expect, test } from 'bun:test'
import { relativeMatchTime, splitByRanges, worktreeNameFor } from '../utils/searchResultLabels'

describe('worktreeNameFor', () => {
  const roots = ['/repo', '/repo/.worktrees/fix-login', '/repo/.worktrees/fix']

  test('names the worktree itself', () => {
    expect(worktreeNameFor('/repo/.worktrees/fix-login', roots)).toBe('fix-login')
  })

  test('a subdirectory resolves to its enclosing worktree, the deepest one', () => {
    expect(worktreeNameFor('/repo/.worktrees/fix-login/src/client', roots)).toBe('fix-login')
    expect(worktreeNameFor('/repo/src', roots)).toBe('repo')
  })

  test('a sibling sharing a name prefix is not enclosed', () => {
    expect(worktreeNameFor('/repo/.worktrees/fix-login-2', roots)).toBe('repo')
    expect(worktreeNameFor('/other/fix-login', ['/other/fix'])).toBe('fix-login')
  })

  test('a root with a trailing slash still encloses', () => {
    expect(worktreeNameFor('/repo/a', ['/repo/'])).toBe('repo')
  })

  test('falls back to the path leaf outside any worktree, and to the path itself when it has none', () => {
    expect(worktreeNameFor('/tmp/proj', roots)).toBe('proj')
    expect(worktreeNameFor('/', [])).toBe('/')
    expect(worktreeNameFor('/tmp/proj', [])).toBe('proj')
  })
})

describe('relativeMatchTime', () => {
  const now = Date.parse('2026-10-15T10:00:00.000Z')
  test('formats minutes, hours, and days with "ago"', () => {
    expect(relativeMatchTime('2026-10-15T09:50:00.000Z', now)).toBe('10m ago')
    expect(relativeMatchTime('2026-10-15T07:00:00.000Z', now)).toBe('3h ago')
    expect(relativeMatchTime('2026-10-12T10:00:00.000Z', now)).toBe('3d ago')
  })
  test('says now under a minute and nothing for an unparseable time', () => {
    expect(relativeMatchTime('2026-10-15T09:59:40.000Z', now)).toBe('now')
    expect(relativeMatchTime('garbage', now)).toBe('')
  })
})

describe('splitByRanges', () => {
  test('splits around each range', () => {
    expect(splitByRanges('see #147 and #147', [{ start: 4, end: 8 }, { start: 13, end: 17 }])).toEqual([
      { text: 'see ', match: false }, { text: '#147', match: true },
      { text: ' and ', match: false }, { text: '#147', match: true },
    ])
  })

  test('a range at the very start or end leaves no empty segment', () => {
    expect(splitByRanges('#147', [{ start: 0, end: 4 }])).toEqual([{ text: '#147', match: true }])
  })

  test('no ranges is one plain segment; empty text is none', () => {
    expect(splitByRanges('plain', [])).toEqual([{ text: 'plain', match: false }])
    expect(splitByRanges('', [])).toEqual([])
  })

  test('clips ranges past the text and skips empty or overlapping ones', () => {
    expect(splitByRanges('abcd', [{ start: 2, end: 99 }])).toEqual([
      { text: 'ab', match: false }, { text: 'cd', match: true },
    ])
    expect(splitByRanges('abcd', [{ start: 1, end: 3 }, { start: 2, end: 4 }])).toEqual([
      { text: 'a', match: false }, { text: 'bc', match: true }, { text: 'd', match: true },
    ])
    expect(splitByRanges('abcd', [{ start: 2, end: 2 }, { start: 9, end: 12 }])).toEqual([{ text: 'abcd', match: false }])
  })
})
