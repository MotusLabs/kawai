// The driver factory (codex-chat-sessions 2.3, 5.6; extract-agent-runtime
// 6.1): a claude or codex record builds Kawai's adapter over the package's
// public factory for that runtime; a runtime
// with no wired driver throws instead of starting as something else.
import { describe, expect, test } from 'bun:test'
import type { Query } from '@anthropic-ai/claude-agent-sdk'
import { ChatSessionDriver } from '../chat/ChatSessionDriver'
import { CodexSessionDriver } from '../chat/codex/CodexSessionDriver'
import { createChatDriver } from '../chat/provider/createChatDriver'

const deps = {
  sessionId: 'chat-factory-test',
  projectPath: '/tmp/kawai-driver-factory',
  queryFactory: (() => ({}) as unknown as Query),
  onEvent: () => {},
  onStatus: () => {},
}

describe('createChatDriver', () => {
  test('the claude runtime builds the package-backed Claude adapter without spawning', () => {
    const driver = createChatDriver({ runtime: 'claude', options: deps })
    // Never the in-tree SDK driver (A1): the adapter owns its package promises.
    expect(driver).not.toBeInstanceOf(ChatSessionDriver)
    expect(typeof (driver as { settled?: unknown }).settled).toBe('function')
    // A fresh driver starts its command state at loading, before any start().
    expect(driver.getCommandState().status).toBe('loading')
  })

  test('the codex runtime builds the package-backed Codex adapter without spawning', () => {
    const driver = createChatDriver({
      runtime: 'codex',
      options: { ...deps, executable: '/nonexistent/codex', codexHome: '/tmp/kawai-codex-home', network: true, wire: { record: () => {} }, withheldCredentials: () => new Set() },
    })
    // Never the in-tree app-server driver: the adapter owns its package promises.
    expect(driver).not.toBeInstanceOf(CodexSessionDriver)
    expect(typeof (driver as { settled?: unknown }).settled).toBe('function')
    // Codex has no slash commands (design D7): unavailable from the start.
    expect(driver.getCommandState()).toEqual({ status: 'unavailable', commands: [] })
    expect(driver.isDead).toBe(false)
  })

  test('a runtime with no wired driver throws, naming it', () => {
    // Anything else is a stored value no build of kawai ever wrote.
    expect(() => createChatDriver({ runtime: 'mystery', options: deps } as never)).toThrow(/mystery/)
  })
})
