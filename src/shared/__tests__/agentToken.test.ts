// agentToken.test.ts - resolveAgentToken walks commands the way exact agent
// matching does — skipping runners, env assignments, and flags — and the
// prefix rule maps resolved tokens onto the first-prompt selector's agents.
import { describe, expect, test } from 'bun:test'
import {
  autoStartAgentFromToken,
  resolveAgentToken,
} from '../agentToken'

describe('resolveAgentToken', () => {
  test('skips package runners and resolves the agent basename', () => {
    expect(resolveAgentToken('npx claude')).toBe('claude')
    expect(resolveAgentToken('bunx codex')).toBe('codex')
    expect(resolveAgentToken('pnpm claude --model opus')).toBe('claude')
    expect(resolveAgentToken('yarn claude')).toBe('claude')
    // The design's motivating case: a naive startsWith would miss this.
    expect(resolveAgentToken('env FOO=1 npx claude-glm --yolo')).toBe('claude-glm')
  })

  test('skips environment variable assignments', () => {
    expect(resolveAgentToken('FOO=bar claude')).toBe('claude')
    expect(resolveAgentToken('ANTHROPIC_MODEL=x CLAUDE_CODE_NO_FLICKER=1 codex')).toBe('codex')
  })

  test('skips leading flags', () => {
    expect(resolveAgentToken('--foo claude')).toBe('claude')
    expect(resolveAgentToken('-x --yolo codex --search')).toBe('codex')
  })

  test('takes the basename of absolute paths', () => {
    expect(resolveAgentToken('/usr/local/bin/claude --model opus')).toBe('claude')
    expect(resolveAgentToken('/opt/agents/bin/codex')).toBe('codex')
    // Runner skipping matches the raw token, not the basename — an absolute
    // env path resolves to 'env' itself (pre-existing inferAgentType behavior).
    expect(resolveAgentToken('/usr/bin/env claude')).toBe('env')
  })

  test('unwraps bash -lc wrappers', () => {
    expect(resolveAgentToken("bash -lc 'claude --model opus'")).toBe('claude')
    expect(resolveAgentToken('bash -lic "codex --search"')).toBe('codex')
  })

  test('unwraps quoted commands', () => {
    expect(resolveAgentToken('"codex --search"')).toBe('codex')
    expect(resolveAgentToken("'claude --help'")).toBe('claude')
  })

  test('returns the first non-skippable token even when unrecognized', () => {
    expect(resolveAgentToken('vim .')).toBe('vim')
  })

  test('returns undefined for empty or all-skippable commands', () => {
    expect(resolveAgentToken('')).toBeUndefined()
    expect(resolveAgentToken('   ')).toBeUndefined()
    expect(resolveAgentToken('npx --yes')).toBeUndefined()
    expect(resolveAgentToken('FOO=bar')).toBeUndefined()
  })
})

describe('autoStartAgentFromToken', () => {
  test('maps claude* and codex* prefixes onto the selector agents', () => {
    expect(autoStartAgentFromToken('claude')).toBe('claude')
    expect(autoStartAgentFromToken('claude-glm')).toBe('claude')
    expect(autoStartAgentFromToken('claude-glm-flash')).toBe('claude')
    expect(autoStartAgentFromToken('codex')).toBe('codex')
    expect(autoStartAgentFromToken('codex-foo')).toBe('codex')
  })

  test('maps everything else, including pi, to none', () => {
    expect(autoStartAgentFromToken('pi')).toBeNull()
    expect(autoStartAgentFromToken('vim')).toBeNull()
    expect(autoStartAgentFromToken('npx')).toBeNull()
    expect(autoStartAgentFromToken(undefined)).toBeNull()
  })
})
