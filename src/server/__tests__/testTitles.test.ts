// testTitles.test.ts - The literal test-title extractor (independent-
// verification 1.3, D3/D5): what the recovery matrix resolves its citations
// against and what a coverage citation must name. Pure — it reads no
// repository file.
import { describe, expect, test } from 'bun:test'
import { testTitles } from '../checks/testTitles'

describe('testTitles', () => {
  test('modifier forms of every callee are included', () => {
    const source = [
      "test.only('only test', () => {})",
      "test.skip('skipped test', () => {})",
      "test.todo('todo test')",
      "it.skip('skipped it', () => {})",
      "describe.only('only describe', () => {})",
      "test.each([[1], [2]])('each test %i', (n) => {})",
      "describe.each(['a'])('each describe %s', (x) => {})",
      "test.skip.each`0 | 1`('each template test $1', () => {})",
    ].join('\n')
    expect([...testTitles(source)].sort()).toEqual(
      [
        'only describe',
        'only test',
        'skipped it',
        'skipped test',
        'todo test',
        'each describe %s',
        'each test %i',
        'each template test $1',
      ].sort()
    )
  })

  test('escaped quotes are unescaped', () => {
    const source = "test('it\\'s here', () => {})\nit(\"double \\\"quoted\\\"\", () => {})"
    expect([...testTitles(source)].sort()).toEqual(["it's here", 'double "quoted"'].sort())
  })

  test('describe titles are dropped with the option and kept without it', () => {
    const source = "describe('outer', () => {})\ntest('inner test', () => {})\nit('inner it', () => {})"
    expect([...testTitles(source, { testsOnly: true })].sort()).toEqual(['inner it', 'inner test'].sort())
    expect([...testTitles(source)].sort()).toEqual(['inner it', 'inner test', 'outer'].sort())
  })

  test('template titles with substitutions are skipped, substitution-free ones count', () => {
    const source = "test(`made ${'x'}`, () => {})\nit(`plain`, () => {})"
    expect([...testTitles(source)]).toEqual(['plain'])
  })

  test('a title inside a describe is still a test title to the option', () => {
    const source = "describe('outer', () => {\n  describe.skip.each([[1]])('nested each describe %i', (n) => {})\n  test.skip('nested test', () => {})\n})"
    expect([...testTitles(source, { testsOnly: true })]).toEqual(['nested test'])
  })
})
