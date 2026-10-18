// The driver factory (codex-chat-sessions 2.3): a claude record builds the
// concrete Claude driver; a runtime with no wired driver throws instead of
// starting as something else.
import { describe, expect, test } from 'bun:test'
import type { Query } from '@anthropic-ai/claude-agent-sdk'
import { ChatSessionDriver } from '../chat/ChatSessionDriver'
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
    const driver = createChatDriver('claude', deps)
    expect(driver).toBeInstanceOf(ChatSessionDriver)
    // A fresh driver starts its command state at loading, before any start().
    expect(driver.getCommandState().status).toBe('loading')
  })

  test('a runtime with no wired driver throws, naming it', () => {
    // `codex` is a known runtime whose wiring change has not landed.
    expect(() => createChatDriver('codex', deps)).toThrow(/codex/)
    // Anything else is a stored value no build of kawai ever wrote.
    expect(() => createChatDriver('mystery' as never, deps)).toThrow(/mystery/)
  })
})
