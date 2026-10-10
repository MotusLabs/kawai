import { describe, expect, test } from 'bun:test'
import { baseOf, isNewerBase } from '../updates/updateVersions'

describe('baseOf', () => {
  test('strips tag prefix and prerelease suffixes', () => {
    expect(baseOf('1.0.0')).toBe('1.0.0')
    expect(baseOf('v1.1.0-12')).toBe('1.1.0')
    expect(baseOf('1.0.0-321')).toBe('1.0.0')
    expect(baseOf('1.0.0-dev')).toBe('1.0.0')
    expect(baseOf(' 1.2.3 ')).toBe('1.2.3')
  })

  test('non-versions do not parse', () => {
    expect(baseOf('')).toBeNull()
    expect(baseOf('latest')).toBeNull()
    expect(baseOf('1.0')).toBeNull()
    expect(baseOf('1.0.0.0')).toBeNull()
    expect(baseOf('v1.x.0')).toBeNull()
  })
})

describe('isNewerBase', () => {
  test('a base bump is an update', () => {
    expect(isNewerBase('v1.1.0-12', '1.0.0-321')).toBe(true)
    expect(isNewerBase('v2.0.0', '1.9.9-400')).toBe(true)
    // Numeric segments, not string order.
    expect(isNewerBase('v1.10.0', '1.9.0-1')).toBe(true)
  })

  test('a newer PR build of the same base is not an update', () => {
    expect(isNewerBase('v1.0.0-400', '1.0.0-321')).toBe(false)
    expect(isNewerBase('v1.0.0', '1.0.0-321')).toBe(false)
  })

  test('a running build at or ahead of the latest is not an update', () => {
    expect(isNewerBase('v1.0.0-400', '1.1.0-3')).toBe(false)
    expect(isNewerBase('v1.0.0-400', '1.0.0-400')).toBe(false)
  })

  test('-dev builds compare against their base', () => {
    expect(isNewerBase('v1.2.0-1', '1.1.0-dev')).toBe(true)
    expect(isNewerBase('v1.1.0-9', '1.1.0-dev')).toBe(false)
    expect(isNewerBase('v1.0.9-9', '1.1.0-dev')).toBe(false)
  })

  test('unparseable versions fail silent: no update', () => {
    expect(isNewerBase('not-a-tag', '1.0.0')).toBe(false)
    expect(isNewerBase('v1.1.0-1', 'garbage')).toBe(false)
    expect(isNewerBase('', '')).toBe(false)
  })
})
