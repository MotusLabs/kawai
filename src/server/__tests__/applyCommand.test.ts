// applyCommand.test.ts - The agent-type apply command map (moved from
// pendingAutoStart.test.ts) and the launch-argument composition that appends
// the mapped prompt to a start command as a single-quoted argv positional —
// which must survive the sh -c expansion that tmux applies.
import { describe, expect, test } from 'bun:test'
import { applyCommandFor, composeAutoStartCommand } from '../applyCommand'

describe('applyCommandFor mapping', () => {
  test('maps claude variants and codex; unrecognized agents get nothing', () => {
    expect(applyCommandFor('claude', 'add-auth')).toBe('/opsx:apply add-auth')
    expect(applyCommandFor('claude-rp', 'add-auth')).toBe('/opsx:apply add-auth')
    expect(applyCommandFor('codex', 'add-auth')).toBe('$openspec-apply-change add-auth')
    expect(applyCommandFor('pi', 'add-auth')).toBeNull()
    expect(applyCommandFor('cursor', 'add-auth')).toBeNull()
    expect(applyCommandFor(null, 'add-auth')).toBeNull()
    expect(applyCommandFor(undefined, 'add-auth')).toBeNull()
  })
})

describe('composeAutoStartCommand', () => {
  test('appends the quoted Claude prompt to the command', () => {
    expect(composeAutoStartCommand('claude --dangerously-skip-permissions', 'claude', 'add-auth'))
      .toBe(`claude --dangerously-skip-permissions '/opsx:apply add-auth'`)
  })

  test('appends the quoted Codex prompt to the command', () => {
    expect(composeAutoStartCommand('codex', 'codex', 'add-auth'))
      .toBe(`codex '$openspec-apply-change add-auth'`)
  })

  test('falls back to the agent itself when the base command is blank', () => {
    expect(composeAutoStartCommand(undefined, 'claude', 'add-auth'))
      .toBe(`claude '/opsx:apply add-auth'`)
    expect(composeAutoStartCommand('   ', 'codex', 'add-auth'))
      .toBe(`codex '$openspec-apply-change add-auth'`)
  })

  test('returns the command unchanged without an agent, for an unrecognized agent, or for an invalid change name', () => {
    expect(composeAutoStartCommand('claude', undefined, 'add-auth')).toBe('claude')
    expect(composeAutoStartCommand('claude', undefined, undefined)).toBe('claude')
    expect(composeAutoStartCommand('claude', 'claude', undefined)).toBe('claude')
    // Invalid change names (path separators, flags) compose nothing.
    expect(composeAutoStartCommand('claude', 'claude', 'a/b')).toBe('claude')
    expect(composeAutoStartCommand('claude', 'claude', '--force')).toBe('claude')
  })
})

describe('composed command survives sh -c', () => {
  test("the Codex prompt reaches the process argv with $openspec unexpanded", () => {
    // tmux runs the start command through `sh -c`. Replay that here: the
    // single-quoted positional must arrive as the literal
    // `$openspec-apply-change add-auth`, not expand to ` add-auth`.
    const composed = composeAutoStartCommand('codex', 'codex', 'add-auth')!
    const result = Bun.spawnSync(['sh', '-c', `printf %s ${composed}`], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toBe(`codex$openspec-apply-change add-auth`)

    // A double-quoted form corrupts the prompt — `$openspec` expands to
    // nothing and the variable name ends at the first `-`, leaving a
    // mangled command. That corruption is what single-quoting prevents.
    const expanded = Bun.spawnSync(['sh', '-c', 'printf %s codex "$openspec-apply-change add-auth"'], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(expanded.stdout.toString()).toBe('codex-apply-change add-auth')
  })
})
