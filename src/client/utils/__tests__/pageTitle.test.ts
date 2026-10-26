import { describe, expect, test } from 'bun:test'
import { pageTitle } from '../pageTitle'

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
    test(`${oracle}: workspace title is ${expected}`, () => {
      expect(pageTitle({ defaultProjectDir, cwd })).toBe(expected)
    })
  }

  test('T6: missing server information uses Kawai', () => {
    expect(pageTitle()).toBe('Kawai')
    expect(pageTitle(null)).toBe('Kawai')
  })
})
