// The driver factory (codex-chat-sessions 2.3, 5.6): a claude record builds
// the concrete Claude driver, a codex record the Codex driver; a runtime
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
  test('the claude runtime builds a ChatSessionDriver', () => {
    const driver = createChatDriver({ runtime: 'claude', options: deps })
    expect(driver).toBeInstanceOf(ChatSessionDriver)
    // A fresh driver starts its command state at loading, before any start().
    expect(driver.getCommandState().status).toBe('loading')
  })

  test('the codex runtime builds a CodexSessionDriver without spawning', () => {
    const driver = createChatDriver({
      runtime: 'codex',
      options: { ...deps, executable: '/nonexistent/codex', codexHome: '/tmp/kawai-codex-home', network: true, wire: { record: () => {} }, withheldCredentials: () => new Set() },
    })
    expect(driver).toBeInstanceOf(CodexSessionDriver)
    // Codex has no slash commands (design D7): unavailable from the start.
    expect(driver.getCommandState()).toEqual({ status: 'unavailable', commands: [] })
    expect(driver.isDead).toBe(false)
  })

  test('a runtime with no wired driver throws, naming it', () => {
    // Anything else is a stored value no build of kawai ever wrote.
    expect(() => createChatDriver({ runtime: 'mystery', options: deps } as never)).toThrow(/mystery/)
  })
})
