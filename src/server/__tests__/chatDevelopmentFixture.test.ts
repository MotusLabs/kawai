import { describe, expect, test } from 'bun:test'
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ChatWireDirection } from '../../shared/chat'
import { fixtureQueryFactory } from '../chat/developmentFixture'
import { TurnQueue } from '../chat/TurnQueue'

function userMessage(text: string): SDKUserMessage {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null } as SDKUserMessage
}

describe('development fixture wire frames', () => {
  test('an approval turn records prompt, permission request/response, SDK messages, and lifecycle', async () => {
    const frames: Array<{ dir: ChatWireDirection; value: Record<string, unknown> }> = []
    const queue = new TurnQueue()
    const query = fixtureQueryFactory({
      prompt: queue,
      options: { cwd: '/tmp/project', canUseTool: async () => ({ behavior: 'allow', updatedInput: {} }) },
      wire: { record: (dir, raw) => frames.push({ dir, value: JSON.parse(raw) }) },
    })
    queue.push(userMessage('Show an approval'))
    const received: SDKMessage[] = []
    for await (const message of query) {
      received.push(message)
      if (message.type === 'result') break
    }
    await query.interrupt()
    query.close()

    const summary = frames.map(({ dir, value }) => {
      const request = value.request as { subtype?: string } | undefined
      return `${dir}:${String(value.event ?? value.type)}${request?.subtype ? `/${request.subtype}` : ''}`
    })
    expect(summary[0]).toBe('lifecycle:spawn')
    expect(summary[1]).toBe('out:user')
    const requestIndex = summary.indexOf('in:control_request/can_use_tool')
    const responseIndex = summary.indexOf('out:control_response')
    expect(requestIndex).toBeGreaterThan(1)
    expect(responseIndex).toBeGreaterThan(requestIndex)
    const request = frames[requestIndex]!.value as { request_id: string }
    expect(frames[responseIndex]!.value).toMatchObject({
      response: { subtype: 'success', request_id: request.request_id, response: { behavior: 'allow' } },
    })
    expect(summary).toContain('in:result')
    expect(summary.at(-2)).toBe('out:control_request/interrupt')
    expect(summary.at(-1)).toBe('lifecycle:exit')
    // Every emitted SDK message is mirrored as an inbound frame.
    const inbound = frames.filter(frame => frame.dir === 'in' && frame.value.uuid).map(frame => frame.value.uuid)
    expect(inbound).toEqual(received.map(message => message.uuid))
  })

  test('without a recorder the fixture still runs', async () => {
    const queue = new TurnQueue()
    const query = fixtureQueryFactory({ prompt: queue, options: {} })
    queue.push(userMessage('hello'))
    for await (const message of query) {
      if (message.type === 'result') break
    }
    query.close()
  })

  test('a markdown prompt replies with a markdown showcase', async () => {
    const queue = new TurnQueue()
    const query = fixtureQueryFactory({ prompt: queue, options: {} })
    queue.push(userMessage('show me markdown'))
    const texts: string[] = []
    for await (const message of query) {
      if (message.type === 'assistant') {
        for (const block of message.message.content) {
          if (block.type === 'text') texts.push(block.text)
        }
      }
      if (message.type === 'result') break
    }
    query.close()
    const showcase = texts.find(text => text.includes('# Markdown showcase'))
    expect(showcase).toBeDefined()
    for (const marker of [
      '## Lists', // headings
      '- bullet one', // unordered list
      '1. first', // ordered list
      '- [ ] unchecked task', // task list
      '---', // horizontal rule
      '| Element | Rendered |', // table
      '`inline code`', // inline code
      '```ts', // fenced code
      '> A blockquote', // blockquote
      '[a link](https://example.com)', // link
      '~~struck through~~', // strikethrough
    ]) {
      expect(showcase).toContain(marker)
    }
  })
})
