// pendingAutoStart.test.ts - Task 8.1-8.3 coverage: the agent-type command
// map, server-side holding that survives client reloads, discard with the
// session, first-idle injection through the terminal-input keystroke pair
// with double-trigger protection, and nothing sent when the option is off or
// the agent type is unrecognized.
import { describe, expect, test } from 'bun:test'
import type { Session } from '../../shared/types'
import {
  applyCommandFor,
  PendingAutoStartStore,
  type AutoStartInputSender,
} from '../pendingAutoStart'

function session(id: string, overrides: Partial<Session> = {}): Session {
  return {
    id,
    name: id,
    tmuxWindow: `agentboard:${id}`,
    projectPath: '/repo/.worktrees/add-auth',
    status: 'working',
    lastActivity: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    source: 'managed',
    remote: false,
    ...overrides,
  }
}

/** Recording sender: succeeds for listed targets, fails otherwise. */
function makeSender(failingTargets: Set<string> = new Set()) {
  const sent: Array<[string, string]> = []
  const sender: AutoStartInputSender = (target, text) => {
    sent.push([target, text])
    return !failingTargets.has(target)
  }
  return { sent, sender }
}

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

describe('PendingAutoStartStore holding', () => {
  test('holds the mapped command keyed to the session, inferred from the start command', () => {
    const store = new PendingAutoStartStore()
    expect(store.holdFromCommand('s1', 'claude', 'add-auth')).toBe(true)
    expect(store.get('s1')).toEqual({ change: 'add-auth', command: '/opsx:apply add-auth' })

    // Command forms inferAgentType understands: paths, flags, runners.
    expect(store.holdFromCommand('s2', '/usr/local/bin/claude --model opus', 'add-auth')).toBe(true)
    expect(store.get('s2')?.command).toBe('/opsx:apply add-auth')
    expect(store.holdFromCommand('s3', 'npx codex', 'add-auth')).toBe(true)
    expect(store.get('s3')?.command).toBe('$openspec-apply-change add-auth')
  })

  test('option off or agent unrecognized holds nothing (§8.3)', () => {
    const store = new PendingAutoStartStore()
    // Option off: holdFromCommand is simply never called; an unrecognized
    // agent or invalid change name also refuses to hold.
    expect(store.holdFromCommand('s1', 'pi', 'add-auth')).toBe(false)
    expect(store.holdFromCommand('s2', 'vim .', 'add-auth')).toBe(false)
    expect(store.holdFromCommand('s3', 'claude', 'a/b')).toBe(false)
    expect(store.holdFromCommand('s4', 'claude', '--force')).toBe(false)
    expect(store.size).toBe(0)

    const { sent, sender } = makeSender()
    expect(store.injectWaiting([session('s1', { status: 'waiting' })], sender)).toEqual([])
    expect(sent).toEqual([])
  })

  test('discards with the session and retains entries for live sessions', () => {
    const store = new PendingAutoStartStore()
    store.holdFromCommand('s1', 'claude', 'add-auth')
    store.holdFromCommand('s2', 'claude', 'add-auth')
    store.discard('s1')
    expect(store.get('s1')).toBeUndefined()
    expect(store.get('s2')).toBeDefined()

    // A session vanished from the registry (window closed outside kill).
    store.retainAll(new Set(['s2']))
    expect(store.size).toBe(1)
    expect(store.get('s2')).toBeDefined()
  })
})

describe('PendingAutoStartStore injection', () => {
  test('injects exactly once at the first idle report, even immediately after creation', () => {
    const store = new PendingAutoStartStore()
    store.holdFromCommand('s1', 'claude', 'add-auth')
    const { sent, sender } = makeSender()

    // Early idle: the very first refresh already reports waiting.
    const first = [session('s1', { status: 'waiting' })]
    expect(store.injectWaiting(first, sender)).toEqual(['s1'])
    expect(sent).toEqual([['agentboard:s1', '/opsx:apply add-auth']])

    // Double-trigger protection: a later refresh sends nothing again.
    expect(store.injectWaiting(first, sender)).toEqual([])
    expect(sent).toHaveLength(1)
  })

  test('never-idle sessions keep the prompt pending (client reload is irrelevant)', () => {
    const store = new PendingAutoStartStore()
    store.holdFromCommand('s1', 'codex', 'add-auth')
    const { sent, sender } = makeSender()

    // working, unknown, and permission are not idle; the prompt survives any
    // number of refreshes — the holding is server-side, so a client reload
    // in between changes nothing.
    for (const status of ['working', 'unknown', 'permission'] as const) {
      expect(store.injectWaiting([session('s1', { status })], sender)).toEqual([])
    }
    expect(sent).toEqual([])
    expect(store.get('s1')).toBeDefined()

    // The first waiting report then injects.
    expect(store.injectWaiting([session('s1', { status: 'waiting' })], sender)).toEqual(['s1'])
    expect(sent).toEqual([['agentboard:s1', '$openspec-apply-change add-auth']])
  })

  test('remote sessions are never injected', () => {
    const store = new PendingAutoStartStore()
    store.holdFromCommand('s1', 'claude', 'add-auth')
    const { sent, sender } = makeSender()
    const remote = session('s1', { status: 'waiting', remote: true, host: 'box' })
    expect(store.injectWaiting([remote], sender)).toEqual([])
    expect(sent).toEqual([])
  })

  test('a failed send keeps the entry for the next refresh', () => {
    const store = new PendingAutoStartStore()
    store.holdFromCommand('s1', 'claude', 'add-auth')
    const failing = makeSender(new Set(['agentboard:s1']))
    expect(store.injectWaiting([session('s1', { status: 'waiting' })], failing.sender)).toEqual([])
    expect(store.get('s1')).toBeDefined()

    const recovering = makeSender()
    expect(store.injectWaiting([session('s1', { status: 'waiting' })], recovering.sender)).toEqual(['s1'])
  })

  test('injects each pending session once, in snapshot order', () => {
    const store = new PendingAutoStartStore()
    store.holdFromCommand('s1', 'claude', 'add-auth')
    store.holdFromCommand('s2', 'codex', 'add-auth')
    store.holdFromCommand('s3', 'claude', 'add-dark-mode')
    const { sent, sender } = makeSender()

    const injected = store.injectWaiting(
      [
        session('s1', { status: 'waiting' }),
        session('s2', { status: 'working' }), // not idle yet
        session('s3', { status: 'waiting' }),
      ],
      sender
    )
    expect(injected).toEqual(['s1', 's3'])
    expect(sent).toEqual([
      ['agentboard:s1', '/opsx:apply add-auth'],
      ['agentboard:s3', '/opsx:apply add-dark-mode'],
    ])

    // s2 injects on its own later first-idle report.
    expect(store.injectWaiting([session('s2', { status: 'waiting' })], sender)).toEqual(['s2'])
  })
})
