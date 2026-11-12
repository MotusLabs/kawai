// The driver factory (codex-chat-sessions 2.3, 5.6; extract-agent-runtime
// 6.1): a claude or codex record builds Kawai's adapter over the package's
// public factory for that runtime; a runtime
// with no wired driver throws instead of starting as something else. The
// in-tree Codex class is gone (task-5906f19c); the codex case shows the
// package's own construction instead.
import { describe, expect, test } from 'bun:test'
import type { Query } from '@anthropic-ai/claude-agent-sdk'
import { ChatSessionDriver } from '../chat/ChatSessionDriver'
import { AgentRuntimeError } from '@motuslabs/agent-runtime'
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

  test('the codex runtime builds the package-backed Codex adapter without spawning', async () => {
    const driver = createChatDriver({
      runtime: 'codex',
      options: { ...deps, executable: '/nonexistent/codex', codexHome: '/tmp/kawai-codex-home', network: true, wire: { record: () => {} }, withheldCredentials: () => new Set() },
    }) as ReturnType<typeof createChatDriver> & { settled(): Promise<void> }
    // The adapter owns its package promises.
    expect(typeof driver.settled).toBe('function')
    // Codex has no slash commands (design D7): unavailable from the start.
    expect(driver.getCommandState()).toEqual({ status: 'unavailable', commands: [] })
    expect(driver.isDead).toBe(false)
    // Its start is the package's own (task-5906f19c A5, in place of the
    // deleted in-tree class's negative instanceof): the package core resolves
    // the launch and refuses the missing executable with its own typed error.
    driver.start()
    const refusal = await driver.settled().then(() => null, (error: unknown) => error)
    expect(refusal).toBeInstanceOf(AgentRuntimeError)
    expect({ category: (refusal as AgentRuntimeError).category, message: (refusal as Error).message })
      .toEqual({ category: 'dependency', message: 'executable not found: /nonexistent/codex' })
    // The kill joins the same failed start: reported once, as that object.
    driver.kill()
    const stopped = await driver.settled().then(() => null, (error: unknown) => error) as { causes?: unknown[] } | null
    expect(stopped?.causes?.filter(cause => cause === refusal)).toHaveLength(1)
  })

  test('a runtime with no wired driver throws, naming it', () => {
    // Anything else is a stored value no build of kawai ever wrote.
    expect(() => createChatDriver({ runtime: 'mystery', options: deps } as never)).toThrow(/mystery/)
  })
})
