// pushCheck.test.ts — the pre-push hook's pure decisions (per-result-suite
// task 3.2, D4, I2): stdin parsing, deletions, the per-ref verdicts and their
// wording, the hidden-entry refusal, Q1's aggregation, and the fallback's
// exact-key settlement. The real composition (a temporary repository, a bare
// remote, real git push, the real check) is prePush.integration.test.ts.
import { describe, expect, test } from 'bun:test'
import { decidePush, isZeroSha, parsePushInput, settleFallback, type RefFacts } from '../lib/pushCheck'

const A = 'a'.repeat(40)
const B = 'b'.repeat(40)
const T = 'c'.repeat(40)
const ZERO40 = '0'.repeat(40)
const ZERO64 = '0'.repeat(64)

function commit(overrides: Partial<Extract<RefFacts, { kind: 'commit' }>> = {}): RefFacts {
  return { kind: 'commit', ref: 'refs/heads/main', commit: A, tree: T, recorded: false, head: A, dirtyPaths: [], ...overrides }
}

describe('parsePushInput', () => {
  test('reads every line, skipping blank ones', () => {
    const parsed = parsePushInput(`refs/heads/main ${A} refs/heads/main ${ZERO40}\n\nrefs/tags/v1 ${B} refs/tags/v1 ${B}\n`)
    expect(parsed).toEqual({
      ok: true,
      lines: [
        { localRef: 'refs/heads/main', localSha: A, remoteRef: 'refs/heads/main', remoteSha: ZERO40 },
        { localRef: 'refs/tags/v1', localSha: B, remoteRef: 'refs/tags/v1', remoteSha: B },
      ],
    })
  })

  test('empty input reads as no refs', () => {
    expect(parsePushInput('')).toEqual({ ok: true, lines: [] })
  })

  test.each([
    ['three fields', `refs/heads/main ${A} refs/heads/main`],
    ['five fields', `refs/heads/main ${A} refs/heads/main ${A} extra`],
    ['a short sha', `refs/heads/main abc refs/heads/main ${A}`],
    ['an uppercase sha', `refs/heads/main ${A.toUpperCase()} refs/heads/main ${A}`],
    ['a doubled space', `refs/heads/main  ${A} refs/heads/main ${A}`],
  ])('a malformed line (%s) refuses the whole input', (_name, line) => {
    const parsed = parsePushInput(`refs/heads/ok ${A} refs/heads/ok ${A}\n${line}\n`)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain('unreadable pre-push input')
  })

  test('zero shas of both lengths are deletions; a sha with one nonzero digit is not', () => {
    expect(isZeroSha(ZERO40)).toBe(true)
    expect(isZeroSha(ZERO64)).toBe(true)
    expect(isZeroSha(`${'0'.repeat(39)}1`)).toBe(false)
    expect(isZeroSha('0'.repeat(41))).toBe(false)
  })
})

describe('decidePush', () => {
  test('a recorded ref passes without a check', () => {
    expect(decidePush([commit({ recorded: true, head: B, dirtyPaths: ['x'] })], []).kind).toBe('pass')
  })

  test('a deletion-only push passes without a check, even with hidden entries', () => {
    const verdict = decidePush([{ kind: 'deletion', ref: 'refs/heads/old' }], [{ path: 'hidden.ts', skipWorktree: true, assumeUnchanged: false }])
    expect(verdict.kind).toBe('pass')
    expect(verdict.lines).toEqual(['pre-push: refs/heads/old: deletion, no check'])
  })

  test('an unrecorded clean HEAD is the one fallback', () => {
    expect(decidePush([commit()], [])).toMatchObject({ kind: 'fallback', tree: T, commit: A, refs: ['refs/heads/main'] })
  })

  test('two refs of the clean HEAD share one fallback', () => {
    const verdict = decidePush([commit(), commit({ ref: 'refs/tags/v1' })], [])
    expect(verdict).toMatchObject({ kind: 'fallback', refs: ['refs/heads/main', 'refs/tags/v1'] })
  })

  test('an unrecorded commit that is not HEAD is refused, naming the commit, HEAD, and the command', () => {
    const verdict = decidePush([commit({ head: B })], [])
    expect(verdict.kind).toBe('refuse')
    expect(verdict.lines[0]).toBe(
      `pre-push: refs/heads/main ${A}: no full-check pass for tree ${T}; not checked out (HEAD is ${B}): ` +
        `check out ${A}, run \`bun run check\` on the clean tree, then push`
    )
  })

  test('an unrecorded HEAD with a dirty tree is refused, naming the paths', () => {
    const verdict = decidePush([commit({ dirtyPaths: ['src/a.ts', 'notes.md'] })], [])
    expect(verdict.kind).toBe('refuse')
    expect(verdict.lines[0]).toContain('checked out but the working tree is dirty: src/a.ts, notes.md; commit or stash them, run `bun run check`')
  })

  test('a long dirty list is cut at ten with the total', () => {
    const paths = Array.from({ length: 12 }, (_, index) => `f${index}`)
    const verdict = decidePush([commit({ dirtyPaths: paths })], [])
    expect(verdict.lines[0]).toContain('f9, … (12 in all)')
    expect(verdict.lines[0]).not.toContain('f10')
  })

  test('a non-commit ref is refused as unsupported', () => {
    const verdict = decidePush([{ kind: 'unsupported', ref: 'refs/tags/blob', sha: B }], [])
    expect(verdict).toEqual({ kind: 'refuse', lines: [`pre-push: unsupported ref refs/tags/blob: ${B} is not a commit`] })
  })

  test('hidden index entries refuse every non-deletion ref, recorded ones included (F1)', () => {
    const verdict = decidePush([commit({ recorded: true }), commit({ ref: 'refs/tags/v1' })], [{ path: 'src/hidden.ts', skipWorktree: true, assumeUnchanged: false }])
    expect(verdict.kind).toBe('refuse')
    expect(verdict.lines).toHaveLength(2)
    for (const line of verdict.lines) {
      expect(line).toContain('the index hides edits from the check. skip-worktree: src/hidden.ts')
      expect(line).toContain('`git update-index --no-skip-worktree -- src/hidden.ts`')
      expect(line).toContain('`git sparse-checkout disable`')
    }
  })

  test('with any ref refused, the eligible HEAD is not checked and is listed (Q1)', () => {
    const verdict = decidePush([commit(), commit({ ref: 'refs/heads/other', commit: B, head: A })], [])
    expect(verdict.kind).toBe('refuse')
    expect(verdict.lines).toEqual([
      expect.stringContaining(`pre-push: refs/heads/other ${B}: no full-check pass`),
      `pre-push: refs/heads/main ${A}: not checked: push refused anyway; push refs/heads/main separately to run its check`,
    ])
  })
})

describe('settleFallback (I2)', () => {
  const verdict = { kind: 'fallback' as const, tree: T, commit: A, refs: ['refs/heads/main'], lines: [] }

  test('a passing check that recorded the exact key passes', () => {
    expect(settleFallback(verdict, 0, true, []).code).toBe(0)
  })

  test('a failing check refuses with its exit code named', () => {
    expect(settleFallback(verdict, 3, true, [])).toEqual({
      code: 1,
      line: `pre-push: ${A}: the full check failed (exit 3); push refused`,
    })
  })

  test('a passing check without the exact key refuses, naming what changed', () => {
    const settled = settleFallback(verdict, 0, false, ['stray.txt'])
    expect(settled.code).toBe(1)
    expect(settled.line).toContain(`recorded no pass for tree ${T} (the tree changed during the check: stray.txt)`)
  })
})
