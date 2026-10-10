import { afterEach, describe, expect, test } from 'bun:test'
import {
  generateSessionName,
  generateUniqueSessionName,
  isGeneratorSessionName,
} from '../nameGenerator'

const originalRandom = Math.random

afterEach(() => {
  Math.random = originalRandom
})

describe('generateSessionName', () => {
  test('uses adjective and noun with hyphen', () => {
    Math.random = () => 0
    expect(generateSessionName()).toBe('bold-arch')
  })

  test('picks last entries when random is near 1', () => {
    Math.random = () => 0.999999
    expect(generateSessionName()).toBe('fresh-zone')
  })
})

describe('generateUniqueSessionName', () => {
  test('returns first name if it does not exist', () => {
    Math.random = () => 0
    const exists = () => false
    expect(generateUniqueSessionName(exists)).toBe('bold-arch')
  })

  test('retries when name already exists', () => {
    const usedNames = new Set(['bold-arch'])
    let callCount = 0
    Math.random = () => {
      callCount++
      return callCount === 1 ? 0 : 0.5
    }
    const exists = (name: string) => usedNames.has(name)
    const result = generateUniqueSessionName(exists)
    expect(result).not.toBe('bold-arch')
    expect(usedNames.has(result)).toBe(false)
  })

  test('falls back to timestamp suffix after max retries', () => {
    const exists = () => true // All names exist
    const result = generateUniqueSessionName(exists)
    expect(result).toMatch(/^[a-z]+-[a-z]+-[a-z0-9]+$/)
  })
})

describe('isGeneratorSessionName', () => {
  test('accepts a pair the generator can emit', () => {
    expect(isGeneratorSessionName('bold-arch')).toBe(true)
    expect(isGeneratorSessionName('sure-mark')).toBe(true)
    expect(isGeneratorSessionName('calm-raven')).toBe(true)
  })

  test('rejects a user-supplied name the generator could not produce', () => {
    expect(isGeneratorSessionName('show-chat-rate-limits')).toBe(false)
    expect(isGeneratorSessionName('docs-chat-session-naming')).toBe(false)
    expect(isGeneratorSessionName('rename')).toBe(false)
  })

  test('rejects a real word paired with a word outside its list', () => {
    expect(isGeneratorSessionName('sure-table')).toBe(false)
    expect(isGeneratorSessionName('blazing-arch')).toBe(false)
  })

  test('rejects the suffixed unique-name fallback and case variants', () => {
    expect(isGeneratorSessionName('bold-arch-k3x9')).toBe(false)
    expect(isGeneratorSessionName('Sure-Mark')).toBe(false)
    expect(isGeneratorSessionName('')).toBe(false)
  })

  test('every name the generator emits is recognized', () => {
    Math.random = () => 0
    expect(isGeneratorSessionName(generateSessionName())).toBe(true)
    Math.random = () => 0.999999
    expect(isGeneratorSessionName(generateSessionName())).toBe(true)
  })
})
