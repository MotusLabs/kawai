import { describe, expect, test } from 'bun:test'
import { BASE_VERSION, BUILD_VERSION, resolveBuildVersion } from '../version'

describe('resolveBuildVersion', () => {
  test('uses the version CI injected at build time', () => {
    expect(resolveBuildVersion('1.0.0-321')).toBe('1.0.0-321')
  })

  test('trims whitespace the shell may have carried in', () => {
    expect(resolveBuildVersion(' 1.0.0-321\n')).toBe('1.0.0-321')
  })

  // A --define that fails to substitute leaves the expression undefined (or
  // empty) rather than throwing, so the fallback is what actually ships if the
  // release workflow's injection breaks — the boot test greps for the expected
  // version precisely to catch that.
  test('falls back to the package.json base marked -dev when nothing is injected', () => {
    expect(resolveBuildVersion(undefined)).toBe(`${BASE_VERSION}-dev`)
  })

  test('treats an empty or blank injection as absent', () => {
    expect(resolveBuildVersion('')).toBe(`${BASE_VERSION}-dev`)
    expect(resolveBuildVersion('   ')).toBe(`${BASE_VERSION}-dev`)
  })
})

describe('BASE_VERSION', () => {
  // CI appends `-<PR number>` to this base to build the release tag, and
  // refuses to tag if the base already carries a suffix of its own.
  test('is a plain MAJOR.MINOR.PATCH version', () => {
    expect(BASE_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })
})

describe('BUILD_VERSION', () => {
  test('resolves at import time without an injected version in tests', () => {
    expect(BUILD_VERSION).toBe(resolveBuildVersion(process.env.KAWAI_BUILD_VERSION))
  })
})
