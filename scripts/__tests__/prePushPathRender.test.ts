// prePushPathRender.test.ts — renderPath's marked escaped form (F1 fix
// round 2, binding ruling R1-R3). The escaped form carries a leading `//`
// no listed path can begin with, escapes every JS whitespace character and
// every Unicode control character (C0, DEL, C1 U+007F-009F), doubles
// literal backslashes, and leaves ordinary paths unchanged. P1 is a seeded
// property: renderings are classifier-safe, marked exactly when escaped,
// and decode back to their path. The tables pin the finding's C1 rows
// through both listed slots (dirty refusal, changed-during-the-check
// settlement), the finding's collision pair, the ordinary backslash path,
// and the git rule the marker leans on.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { classifyEffectFailure } from '../../src/server/plans/landing/effectOutcome'
import { propertyCases } from '../../src/server/__tests__/helpers/propertyCases'
import { decidePush, renderPath, settleFallback, type RefFacts } from '../lib/pushCheck'
import { dirtyPaths } from '../pre-push'
import { createHookRepo, type HookRepo } from './helpers/hookRepo'

const RUNNING = Bun.version
// A pin guaranteed to differ from the running Bun.
const PIN = Bun.version === '1.0.0' ? '1.0.1' : '1.0.0'
const A = 'a'.repeat(40)
const T = 'c'.repeat(40)

function commit(overrides: Partial<Extract<RefFacts, { kind: 'commit' }>> = {}): Extract<RefFacts, { kind: 'commit' }> {
  return { kind: 'commit', ref: 'refs/heads/main', commit: A, tree: T, bun: RUNNING, pin: null, recordedBun: null, head: A, dirtyPaths: [], ...overrides }
}

/** Kawai reads this stderr of a failed `git push` (exit 1) as permanent. */
const permanent = (stderr: string) => classifyEffectFailure({ argv: ['git', 'push'], exitCode: 1, stderr })

/** The inverse of the marked escaped form, test-only. It parses the tokens
 * instead of mirroring the encoder's loops, so `decode(render(p)) === p`
 * is evidence about the encoding itself, not a tautology. */
function decode(shown: string): string {
  if (!shown.startsWith('//')) return shown
  const body = shown.slice(2)
  let out = ''
  for (let i = 0; i < body.length; ) {
    const ch = body[i]!
    if (ch !== '\\') {
      out += ch
      i += 1
      continue
    }
    const next = body[i + 1]
    if (next === '\\') {
      out += '\\'
      i += 2
    } else if (next === 'x') {
      const hex = body.slice(i + 2, i + 4)
      if (!/^[0-9a-f]{2}$/.test(hex)) throw new Error(`bad \\x token at ${i}: ${JSON.stringify(body.slice(i, i + 6))}`)
      out += String.fromCharCode(parseInt(hex, 16))
      i += 4
    } else if (next === 'u') {
      const match = /^\{([0-9a-f]+)\}/.exec(body.slice(i + 2))
      if (match === null) throw new Error(`bad \\u token at ${i}: ${JSON.stringify(body.slice(i, i + 8))}`)
      out += String.fromCodePoint(parseInt(match[1]!, 16))
      i += 2 + match[0].length
    } else {
      throw new Error(`unknown escape at ${i}: \\${String(next)}`)
    }
  }
  return out
}

/** The character class that forces the escaped form, stated independently
 * of pushCheck: JS whitespace plus every Unicode control character. */
const hasSpecial = (path: string) => [...path].some((ch) => (ch.codePointAt(0)! < 0x20 || (ch.codePointAt(0)! >= 0x7f && ch.codePointAt(0)! <= 0x9f)) || /\s/u.test(ch))

// The alphabet the ruling names: ordinary letters and the hex digits the
// tokens themselves use, the path separators, backslash and quote, every
// JS whitespace kind, C0 controls, DEL, both C1 controls from the finding,
// a Zs space beyond Latin-1, and characters that are neither \s nor Cc
// (U+200B, U+00FC, U+4E2D) so ordinary identity is exercised too.
const ALPHABET = [
  'a', 'b', 'x', '0', '7', 'f',
  '.', '/', '\\', '"', "'",
  ' ', '\t', '\n', '\r', '\v', '\f',
  '\u00a0', '\u1680', '\u2000', '\u2028', '\u2029',
  '\x00', '\x01', '\x1f', '\x7f', '\x85', '\x9b',
  '\ufeff', '\u200b', '\u00fc', '\u4e2d',
]

const CASES = 200
const SEED = 0x5e1f1

function rng(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function sample(next: () => number, length: number): string {
  let out = ''
  for (let i = 0; i < length; i++) out += ALPHABET[Math.floor(next() * ALPHABET.length)]
  return out
}

describe('P1: the marked rendering property', () => {
  // @covers: dev-checks › Pushes require a full check of the pushed tree › Dirty and changed-during-check paths print escaped
  test('P1: over 200 seeded cases (seed 0x5e1f1) every rendering is classifier-safe, marked exactly when escaped, and decodes back to its path', () => {
    const next = rng(SEED)
    let escapedCases = 0
    let ordinaryCases = 0
    let unlistable = 0
    for (let c = 0; c < propertyCases(CASES); c++) {
      // Even cases are single characters, so ordinary strings — only
      // reachable from short lengths — keep coming in every reduced run.
      const path = sample(next, c % 2 === 0 ? 1 : 1 + Math.floor(next() * 12))
      const special = hasSpecial(path)
      if (!special && path.startsWith('//')) {
        // An ordinary path beginning `//` cannot be listed: porcelain paths
        // are repository-relative, so an identity rendering and a marked
        // one could never both appear in a list. The rule test below pins
        // that rule; this domain excludes the unlistable strings.
        unlistable += 1
        continue
      }
      const shown = renderPath(path)
      // R1: no rendering carries JS whitespace or a control character.
      for (const ch of shown) {
        const code = ch.codePointAt(0)!
        expect(code < 0x20 || (code >= 0x7f && code <= 0x9f) || /\s/u.test(ch)).toBe(false)
      }
      if (special) {
        escapedCases += 1
        expect(shown.startsWith('//')).toBe(true)
      } else {
        ordinaryCases += 1
        expect(shown).toBe(path)
      }
      expect(decode(shown)).toBe(path)
    }
    expect(unlistable).toBeGreaterThanOrEqual(0)
    expect(escapedCases).toBeGreaterThan(propertyCases(CASES) / 4)
    expect(ordinaryCases).toBeGreaterThan(propertyCases(CASES) / 10)
  })
})

describe('the finding rows: collision, ordinary backslash, marker', () => {
  // @covers: dev-checks › Pushes require a full check of the pushed tree › Dirty and changed-during-check paths print escaped
  test('the finding collision pair renders distinctly (before, both read a\\x20b\\x20c)', () => {
    // `a b c` holds two real spaces. Its neighbor holds the literal text
    // `\x20` where the first space would be, plus one real space. Both
    // rendered `a\x20b\x20c` before, because a backslash was never
    // escaped, so the literal text read exactly like an escaped space.
    // The marked form doubles the backslash.
    const spaces = 'a b c'
    const literal = 'a\\x20b c'
    expect(renderPath(spaces)).toBe('//a\\x20b\\x20c')
    expect(renderPath(literal)).toBe('//a\\\\x20b\\x20c')
    expect(renderPath(spaces)).not.toBe(renderPath(literal))
    expect(decode(renderPath(spaces))).toBe(spaces)
    expect(decode(renderPath(literal))).toBe(literal)
  })

  // @covers: dev-checks › Pushes require a full check of the pushed tree › Dirty and changed-during-check paths print escaped
  test('an ordinary literal-backslash path prints unchanged (A5)', () => {
    const path = 'src\\lib\\util.ts'
    expect(hasSpecial(path)).toBe(false)
    expect(renderPath(path)).toBe(path)
  })

  // @covers: dev-checks › Pushes require a full check of the pushed tree › Dirty and changed-during-check paths print escaped
  test('every escaped rendering is marked; every ordinary one is not', () => {
    for (const path of ['a b', 'a\tb', 'a\x01b', 'a\x7fb', 'a\x85b', 'a\x9bb', 'a b', 'a b', 'a﻿b', 'a"b c']) {
      const shown = renderPath(path)
      expect(shown.startsWith('//')).toBe(true)
      expect(decode(shown)).toBe(path)
    }
    for (const path of ['src/shared/lone.ts', 'a-b_c.d', 'über-file.md', 'src\\lib\\util.ts', 'a/b/c.ts']) {
      expect(renderPath(path)).toBe(path)
    }
  })
})

describe('the finding C1 rows through both listed slots', () => {
  const rows: [string, string, string][] = [
    ['NEL (U+0085)', 'a\x85b', '//a\\x85b'],
    ['CSI (U+009B)', 'a\x9bb', '//a\\x9bb'],
  ]

  // @covers: dev-checks › Pushes require a full check of the pushed tree › Dirty and changed-during-check paths print escaped
  test.each(rows)('a dirty C1 path (%s) escapes in the refusal and refuses permanently', (_name, path, shown) => {
    const verdict = decidePush([commit({ pin: PIN, dirtyPaths: [path] })], [])
    expect(verdict.kind).toBe('refuse')
    const stderr = verdict.lines.join('\n')
    expect(stderr).toContain(shown)
    expect(permanent(stderr)).toBe('permanent')
  })

  // @covers: dev-checks › Pushes require a full check of the pushed tree › Dirty and changed-during-check paths print escaped
  // A mismatch refuses before any check (A4), so the settlement line is
  // reached only from the fallback verdicts: no pin, or an equal pin.
  test.each(rows)('a C1 path (%s) that changed during the check escapes in the settlement line and refuses permanently', (_name, path, shown) => {
    const verdict = decidePush([commit({ pin: null })], [])
    expect(verdict.kind).toBe('fallback')
    const settled = settleFallback(verdict, 0, false, [path])
    expect(settled.code).toBe(1)
    expect(settled.line).toContain(shown)
    expect(permanent(settled.line)).toBe('permanent')
  })
})

describe('the git rule the marker leans on', () => {
  let fixture: HookRepo
  beforeEach(() => {
    fixture = createHookRepo()
  })
  afterEach(() => {
    fixture.remove()
  })

  // @covers: dev-checks › Pushes require a full check of the pushed tree › Dirty and changed-during-check paths print escaped
  test('porcelain -z never lists a path beginning with a slash, and every listed path renders and decodes intact', () => {
    // Adversarial real names: JS whitespace, both C1 controls from the
    // finding, a quote, a backslash, UTF-8, and a nested directory. Git
    // itself refuses the shapes that could forge the marker — `git
    // update-index --cacheinfo` rejects '/abs', 'a//b', and 'a/./b' as
    // Invalid path — so no index entry can begin with '/' either.
    fixture.write('a b.txt', 'x')
    fixture.write('a\tb.txt', 'x')
    fixture.write('a\x85b.txt', 'x')
    fixture.write('a\x9bb.txt', 'x')
    fixture.write('a b.txt', 'x')
    fixture.write('a\\b.txt', 'x')
    fixture.write('a"b.txt', 'x')
    fixture.write('über.txt', 'x')
    fixture.write('dir with space/nested file.txt', 'x')
    const listed = dirtyPaths(fixture.repo)
    expect(listed).not.toBeNull()
    for (const path of listed!) {
      expect(path.startsWith('/')).toBe(false)
      expect(decode(renderPath(path))).toBe(path)
    }
    expect(listed!.length).toBeGreaterThanOrEqual(9)
  })
})
