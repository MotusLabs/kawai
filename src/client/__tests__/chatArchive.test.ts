// chatArchive.test.ts - The shared archive entry point used by the chat view
// header and the navigator row menu: idle chats archive without asking,
// in-flight turns (working or permission) ask first, and declining sends
// nothing.
import { describe, expect, test } from 'bun:test'
import type { ClientMessage, Session } from '@shared/types'
import { chatArchiveNeedsConfirmation, requestChatArchive } from '../utils/chatArchive'

function chat(status: Session['status']) {
  return { id: 'chat-1', name: 'demo', status }
}

function run(status: Session['status'], answer: boolean) {
  const sent: ClientMessage[] = []
  const asked: string[] = []
  const result = requestChatArchive(chat(status), (message) => { sent.push(message) }, (message) => {
    asked.push(message)
    return answer
  })
  return { sent, asked, result }
}

describe('requestChatArchive', () => {
  test('an idle chat archives without asking', () => {
    for (const status of ['waiting', 'unknown'] as const) {
      const { sent, asked, result } = run(status, false)
      expect(asked).toEqual([])
      expect(result).toBe(true)
      expect(sent).toEqual([{ type: 'chat-archive', sessionId: 'chat-1' }])
    }
  })

  test('a turn in flight asks first and archives on confirmation', () => {
    for (const status of ['working', 'permission'] as const) {
      const { sent, asked, result } = run(status, true)
      expect(asked).toHaveLength(1)
      expect(asked[0]).toContain('"demo"')
      expect(result).toBe(true)
      expect(sent).toEqual([{ type: 'chat-archive', sessionId: 'chat-1' }])
    }
  })

  test('declining the confirmation sends nothing', () => {
    for (const status of ['working', 'permission'] as const) {
      const { sent, asked, result } = run(status, false)
      expect(asked).toHaveLength(1)
      expect(result).toBe(false)
      expect(sent).toEqual([])
    }
  })

  test('only working and permission need confirmation', () => {
    expect(chatArchiveNeedsConfirmation({ status: 'working' })).toBe(true)
    expect(chatArchiveNeedsConfirmation({ status: 'permission' })).toBe(true)
    expect(chatArchiveNeedsConfirmation({ status: 'waiting' })).toBe(false)
    expect(chatArchiveNeedsConfirmation({ status: 'unknown' })).toBe(false)
  })
})
