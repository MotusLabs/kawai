// @reads: packages/agent-runtime/__tests__/fixtures/**
// Claude permission oracles (task 3.2, P05/P06/P08/I4). The pure policy, its
// merge into SDK options, and the restricted profile through the real SDK
// hook composition: the session runs in bypass mode against the fake CLI,
// which calls the registered PreToolUse hooks before applying
// --disallowedTools and leaves a sentinel file for every tool it executes.
// Control M-policy (no deny hook) must let the unknown tool execute.
import { describe, expect, test } from 'bun:test'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk'
import { ClaudeSession } from '../src/claude/session.js'
import { RESTRICTED_CLAUDE_PERMISSIONS, RESTRICTED_DENIED_TOOLS, composeClaudePermissions, withPermissions } from '../src/claude/permissions.js'
import { AgentRuntimeError } from '../src/errors.js'
import type { ClaudePermissions } from '../src/options.js'
import { fakeClaudeHome } from './helpers/fakeClaudeHome.js'

const UNKNOWN_TOOL = 'mcp__external__run'

function configurationFailure(build: () => unknown): AgentRuntimeError {
  try {
    build()
  } catch (error) {
    expect(error).toBeInstanceOf(AgentRuntimeError)
    expect((error as AgentRuntimeError).category).toBe('configuration')
    return error as AgentRuntimeError
  }
  throw new Error('expected a configuration error')
}

describe('Claude permission policy (pure)', () => {
  test('P05/P06: the restricted profile allows its read set and denies the named tools, Bash and anything unlisted', () => {
    const { decide, options } = composeClaudePermissions(RESTRICTED_CLAUDE_PERMISSIONS)
    expect(['Read', 'Glob', 'Grep'].map(decide)).toEqual([null, null, null])
    for (const tool of [...RESTRICTED_DENIED_TOOLS, UNKNOWN_TOOL, 'WebFetch', 'Task']) expect(decide(tool)).not.toBeNull()
    expect([...RESTRICTED_DENIED_TOOLS]).toEqual(['AskUserQuestion', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'])
    expect(options).toEqual({
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      disallowedTools: ['AskUserQuestion', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash'],
    })
  })

  test('the hook answers a permitted tool with no decision, never allow', async () => {
    const { preToolUse } = composeClaudePermissions({ mode: 'default', enabledTools: 'all', disallowedTools: ['Bash'] })
    const hook = preToolUse.hooks[0]!
    const call = (tool: string) =>
      hook({ hook_event_name: 'PreToolUse', tool_name: tool, tool_input: {}, tool_use_id: 't', session_id: 's', transcript_path: '', cwd: '/' } as never, 't', { signal: new AbortController().signal })
    expect(await call('Write')).toEqual({})
    expect(await call('Bash')).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } })
  })

  test('policy fields override caller SDK options and the policy hook runs first', () => {
    const callerHook: HookCallbackMatcher = { hooks: [async () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } })] }
    const composition = composeClaudePermissions({ mode: 'default', enabledTools: ['Read'], disallowedTools: [] })
    const merged = withPermissions({ permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, disallowedTools: [], hooks: { PreToolUse: [callerHook] }, model: 'm' }, composition)
    expect(merged.permissionMode).toBe('default')
    expect(merged.allowDangerouslySkipPermissions).toBe(false)
    expect(merged.model).toBe('m')
    expect(merged.hooks!.PreToolUse).toEqual([composition.preToolUse, callerHook])
  })

  test('P08: an unenforceable or malformed restriction is refused before anything starts', () => {
    const bad: Array<Partial<ClaudePermissions>> = [
      { mode: 'yolo' as never, enabledTools: 'all', disallowedTools: [] },
      { mode: 'default', enabledTools: ['Bash(git:*)'], disallowedTools: [] },
      { mode: 'default', enabledTools: ['mcp__*'], disallowedTools: [] },
      { mode: 'default', enabledTools: 'all', disallowedTools: ['Bash(rm:*)'] },
      { mode: 'default', enabledTools: 'all', disallowedTools: 'Bash' as never },
    ]
    for (const permissions of bad) configurationFailure(() => composeClaudePermissions(permissions as ClaudePermissions))
    const home = fakeClaudeHome()
    configurationFailure(() => new ClaudeSession({ launch: home.launch(), callbacks: { onEvent: () => {} }, permissions: bad[1] as ClaudePermissions }))
    expect(home.argv()).toEqual([])
  })
})

describe('restricted Claude through the real SDK hook composition', () => {
  // @covers: agent-runtime-policy › Restricted Claude sessions deny unlisted tools › Attempted write or shell execution
  // @covers: agent-runtime-policy › Restricted Claude sessions deny unlisted tools › Allowed read
  test('P05/P06/I4: bypass mode denies writes, Bash and unknown tools without executing; the read runs; respawn reapplies it', async () => {
    const home = fakeClaudeHome()
    const launch = home.launch()
    const readable = join(launch.cwd, 'notes.txt')
    writeFileSync(readable, 'readable content')
    // An observation hook that tries to allow everything cannot re-grant a denied tool.
    const permissive: HookCallbackMatcher = { hooks: [async () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow' } })] }
    const s = new ClaudeSession({
      launch,
      callbacks: { onEvent: () => {} },
      permissions: RESTRICTED_CLAUDE_PERMISSIONS,
      sdkOptions: { hooks: { PreToolUse: [permissive] } },
      terminate: { graceMs: 300, killMs: 3000 },
    })
    const attempt = async (tool: string, target?: string) => (await (await s.send(`tool ${tool}${target ? ` ${target}` : ''}`)).result).finalText
    const executed = (tool: string) => existsSync(join(launch.cwd, `executed-${tool}`))
    try {
      await s.start()
      for (const tool of [...RESTRICTED_DENIED_TOOLS, UNKNOWN_TOOL]) {
        expect(await attempt(tool, join(launch.cwd, 'target'))).toStartWith(`denied ${tool} (hook:`)
        expect(executed(tool)).toBe(false)
      }
      expect(await attempt('Read', readable)).toBe('executed Read: readable content')
      expect(s.state).toBe('idle')
      await (await s.send('crash')).result
      await s.start()
      expect(await attempt('Write', join(launch.cwd, 'target'))).toStartWith('denied Write (hook:')
      expect(await attempt(UNKNOWN_TOOL)).toStartWith(`denied ${UNKNOWN_TOOL} (hook:`)
      expect(executed('Write') || executed(UNKNOWN_TOOL)).toBe(false)
      for (const args of home.argv()) {
        expect(args).toContain('--allow-dangerously-skip-permissions')
        expect(args[args.indexOf('--permission-mode') + 1]).toBe('bypassPermissions')
        expect(args[args.indexOf('--disallowedTools') + 1]!.split(',')).toEqual([...RESTRICTED_DENIED_TOOLS])
      }
      expect(home.argv()).toHaveLength(2)
    } finally {
      await s.kill().catch(() => {})
    }
  })
})
