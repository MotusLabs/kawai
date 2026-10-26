// testTitles.ts - Literal test titles of a test source (recovery matrix;
// independent-verification D3, D5). The matrix resolves each citation's
// title, and the coverage check (D5) resolves each coverage citation, by
// looking the exact title up in this extractor's answer: a title must be a
// literal string or a substitution-free template, so `` test(`x ${y}`) ``
// never matches, and a modifier chain (`test.skip`, `describe.each`, …)
// still counts as the call it decorates.

/** Options for {@link testTitles}. */
export interface TestTitlesOptions {
  /** Keep only `test`/`it` titles; `describe` titles are dropped (D5: a
   * coverage citation names a test, never a suite). */
  testsOnly?: boolean
}

// The plain form: `test('title', …)` behind any modifier chain. Escaped
// quotes are captured raw and unescaped below; the quote kind is
// back-parenthesized in the pattern.
const PLAIN_CALL = /\b(?:test|it|describe)(?:\.\w+)*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g

// The each forms: the table — a parenthesized or template literal — sits
// between the modifier chain and the title call, `test.each([[1]])(…)` and
// `` test.skip.each`…`(…) ``. Requiring the table keeps this strictly
// additive to the plain form: it can only add matches, and a title's own
// parentheses are never read as a table.
const EACH_CALL =
  /\b(?:test|it|describe)(?:\.\w+)*(?:\((?:[^()\\]|\\.)*\)|`(?:\\.|[^`\\])*`)\s*\(\s*(['"`])((?:\\.|(?!\1)[^\\])*)\1/g

/** Every literal title of a `test`, `it`, or `describe` call (modifiers such as `.skip` included), unescaped. */
export function testTitles(source: string, options: TestTitlesOptions = {}): Set<string> {
  const titles = new Set<string>()
  for (const call of [PLAIN_CALL, EACH_CALL]) {
    for (const match of source.matchAll(call)) {
      if (options.testsOnly && /^describe\b/.test(match[0])) continue
      if (match[1] === '`' && match[2]!.includes('${')) continue
      titles.add(match[2]!.replace(/\\(.)/g, '$1'))
    }
  }
  return titles
}
