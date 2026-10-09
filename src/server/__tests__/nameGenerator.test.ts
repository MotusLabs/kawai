import { afterEach, describe, expect, test } from 'bun:test'
import {
  generateSessionName,
  generateUniqueSessionName,
  isGeneratedSessionName,
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

describe('isGeneratedSessionName', () => {
  test('accepts words from both closed lists', () => {
    expect(isGeneratedSessionName('sure-mark')).toBe(true)
    expect(isGeneratedSessionName('calm-raven')).toBe(true)
    expect(isGeneratedSessionName('bold-arch')).toBe(true)
  })

  test('rejects names outside the word lists', () => {
    // Real pre-existing names the generator could not have produced.
    expect(isGeneratedSessionName('show-chat-rate-limits')).toBe(false)
    expect(isGeneratedSessionName('docs-chat-session-naming')).toBe(false)
    expect(isGeneratedSessionName('openspec-apply')).toBe(false)
  })

  test('rejects shapes the generator never emits', () => {
    expect(isGeneratedSessionName('sure-mark-k7x1')).toBe(false) // suffixed fallback
    expect(isGeneratedSessionName('Sure-Mark')).toBe(false) // case
    expect(isGeneratedSessionName('sure')).toBe(false) // one word
    expect(isGeneratedSessionName('')).toBe(false)
    expect(isGeneratedSessionName('sure mark')).toBe(false)
    expect(isGeneratedSessionName('bold-unnoun')).toBe(false) // unknown noun
  })
})
