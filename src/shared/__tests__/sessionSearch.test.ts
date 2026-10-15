import { describe, expect, test } from 'bun:test'
import { normalizeSearchQuery, snippetLabel } from '../sessionSearch'

describe('normalizeSearchQuery', () => {
  test('trims and returns a searchable query', () => {
    expect(normalizeSearchQuery('  #147  ')).toBe('#147')
  })

  test('rejects one character, empty, and whitespace-only queries', () => {
    expect(normalizeSearchQuery('a')).toBeNull()
    expect(normalizeSearchQuery('')).toBeNull()
    expect(normalizeSearchQuery('   ')).toBeNull()
    expect(normalizeSearchQuery(' a ')).toBeNull()
  })

  test('accepts the bounds and rejects past the maximum', () => {
    expect(normalizeSearchQuery('ab')).toBe('ab')
    expect(normalizeSearchQuery('x'.repeat(200))).toBe('x'.repeat(200))
    expect(normalizeSearchQuery('x'.repeat(201))).toBeNull()
  })
})

describe('snippetLabel', () => {
  test('labels every plain kind', () => {
    expect(snippetLabel('user')).toBe('You')
    expect(snippetLabel('assistant')).toBe('Assistant')
    expect(snippetLabel('peer')).toBe('Team message')
    expect(snippetLabel('command_output')).toBe('Command output')
    expect(snippetLabel('notice')).toBe('Notice')
    expect(snippetLabel('error')).toBe('Error')
  })

  test('adds the tool name to tool kinds', () => {
    expect(snippetLabel('tool_input', 'Bash')).toBe('Tool input · Bash')
    expect(snippetLabel('tool_result', 'Bash')).toBe('Tool result · Bash')
    expect(snippetLabel('approval', 'Bash')).toBe('Approval · Bash')
  })

  test('omits the separator when the tool is unknown', () => {
    expect(snippetLabel('tool_result')).toBe('Tool result')
  })
})
