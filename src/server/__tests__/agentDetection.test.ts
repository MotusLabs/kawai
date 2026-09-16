// agentDetection.test.ts - inferAgentType stays exact-match on the resolved
// agent token: wrapper names (claude-glm & friends) resolve to undefined here
// even though the session form's prefix rule guesses them visibly, because a
// wrong command-based guess would be silent, sticky, and would suppress the
// accurate log-family backfill.
import { describe, expect, test } from 'bun:test'
import { agentFamily, inferAgentType } from '../agentDetection'

describe('inferAgentType', () => {
  test('matches exact agent basenames across invocation forms', () => {
    expect(inferAgentType('claude')).toBe('claude')
    expect(inferAgentType('claude --dangerously-skip-permissions')).toBe('claude')
    expect(inferAgentType('/usr/local/bin/claude --model opus')).toBe('claude')
    expect(inferAgentType('npx codex')).toBe('codex')
    expect(inferAgentType('"codex --search"')).toBe('codex')
    expect(inferAgentType('pi')).toBe('pi')
  })

  test('returns undefined for wrapper names and unrecognized commands', () => {
    // Wrappers are backfilled from the log family once JSONL is discovered.
    expect(inferAgentType('claude-glm')).toBeUndefined()
    expect(inferAgentType('claude-glm-flash')).toBeUndefined()
    expect(inferAgentType('codex-foo')).toBeUndefined()
    expect(inferAgentType('vim .')).toBeUndefined()
    expect(inferAgentType('')).toBeUndefined()
  })
})

describe('agentFamily', () => {
  test('collapses claude-rp onto claude', () => {
    expect(agentFamily('claude')).toBe('claude')
    expect(agentFamily('claude-rp')).toBe('claude')
    expect(agentFamily('codex')).toBe('codex')
    expect(agentFamily('pi')).toBe('pi')
    expect(agentFamily(null)).toBeNull()
    expect(agentFamily(undefined)).toBeNull()
  })
})
