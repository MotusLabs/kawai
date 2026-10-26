import { describe, expect, test } from 'bun:test'
import { pageTitle } from '../utils/pageTitle'

// The acceptance table from workspace-page-title/design.md, including absent variants.
const cases = [
  ['T1', '/projects/anime-studio', '/opt/kawai', 'anime-studio - Kawai'],
  ['T2 undefined', undefined, '/projects/anime-studio', 'anime-studio - Kawai'],
  ['T2 null', null, '/projects/anime-studio', 'anime-studio - Kawai'],
  ['T3', '', '/projects/anime-studio/', 'anime-studio - Kawai'],
  ['T4', '/', '/projects/anime-studio', 'anime-studio - Kawai'],
  ['T5', '/projects/Anime Studio 日本///', undefined, 'Anime Studio 日本 - Kawai'],
  ['T6 undefined', undefined, undefined, 'Kawai'],
  ['T6 null', null, null, 'Kawai'],
  ['T7', '/', '///', 'Kawai'],
] as const

describe('pageTitle', () => {
  for (const [oracle, defaultProjectDir, cwd, expected] of cases) {
    // T1 covers the first scenario, T2/T3/T4 the second, T5 the third,
    // T6 the fourth, T7 the fifth (workspace-page-title design table).
    // @covers: instance-identity › Workspace name leads the browser title › Configured project directory identifies the instance
    // @covers: instance-identity › Workspace name leads the browser title › Working directory supplies the name
    // @covers: instance-identity › Workspace name leads the browser title › Preserve a directory name literally
    // @covers: instance-identity › Title has a usable loading and missing-name fallback › Initial load has no server information
    // @covers: instance-identity › Title has a usable loading and missing-name fallback › Root directories have no workspace name
    test(`${oracle}: workspace title is ${expected}`, () => {
      expect(pageTitle({ defaultProjectDir, cwd })).toBe(expected)
    })
  }

  // @covers: instance-identity › Title has a usable loading and missing-name fallback › Initial load has no server information
  test('T6: missing server information uses Kawai', () => {
    expect(pageTitle()).toBe('Kawai')
    expect(pageTitle(null)).toBe('Kawai')
  })
})
