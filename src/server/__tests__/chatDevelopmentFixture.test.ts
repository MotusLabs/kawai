import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ChatEvent, ChatWireDirection, ChatWorker } from '../../shared/chat'
import { ChatSessionDriver } from '../chat/ChatSessionDriver'
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

describe('development fixture activity turns', () => {
  /** Collapse the human-scale phase holds to near-zero. */
  beforeEach(() => {
    process.env.AGENTBOARD_CHAT_FIXTURE_HOLD_MS = '1'
  })
  afterEach(() => {
    delete process.env.AGENTBOARD_CHAT_FIXTURE_HOLD_MS
  })

  async function runFixtureTurn(text: string): Promise<SDKMessage[]> {
    const queue = new TurnQueue()
    const query = fixtureQueryFactory({ prompt: queue, options: {} })
    queue.push(userMessage(text))
    const received: SDKMessage[] = []
    for await (const message of query) {
      received.push(message)
      if (message.type === 'result') break
    }
    query.close()
    return received
  }

  /** (frame kind, system subtype or block type) per received message. */
  function shapeOf(messages: SDKMessage[]): string[] {
    return messages.map((message) => {
      if (message.type === 'system') return `system/${String(message.subtype)}`
      if (message.type === 'stream_event') {
        const event = (message as { event: { type: string; content_block?: { type: string } } }).event
        return `stream_event/${event.type}${event.content_block ? `:${event.content_block.type}` : ''}`
      }
      return message.type
    })
  }

  test('a thinking prompt requests, streams a thinking block, then answers', async () => {
    const shapes = shapeOf(await runFixtureTurn('show thinking'))
    expect(shapes).toContain('system/status')
    const start = shapes.indexOf('stream_event/content_block_start:thinking')
    expect(start).toBeGreaterThanOrEqual(0)
    const stop = shapes.indexOf('stream_event/content_block_stop')
    expect(stop).toBeGreaterThan(start)
    expect(shapes.at(-1)).toBe('result')
  })

  test('a tool prompt prepares, runs, and resolves a Bash tool use', async () => {
    const messages = await runFixtureTurn('run a tool')
    const shapes = shapeOf(messages)
    const preparing = shapes.indexOf('stream_event/content_block_start:tool_use')
    const call = messages.findIndex(
      message =>
        message.type === 'assistant' &&
        message.message.content.some(block => block.type === 'tool_use' && block.name === 'Bash')
    )
    const resolved = messages.findIndex(
      message =>
        message.type === 'user' &&
        Array.isArray(message.message.content) &&
        message.message.content.some(block => block.type === 'tool_result')
    )
    expect(preparing).toBeGreaterThanOrEqual(0)
    expect(call).toBeGreaterThan(preparing)
    expect(resolved).toBeGreaterThan(call)
  })

  test('a retry prompt reports two API retries then recovers', async () => {
    const messages = await runFixtureTurn('simulate a retry')
    const retries = messages.filter(
      (message): message is Extract<SDKMessage, { type: 'system' }> =>
        message.type === 'system' && (message as { subtype?: string }).subtype === 'api_retry'
    )
    expect(retries.map(retry => (retry as { attempt: number }).attempt)).toEqual([1, 2])
    const shapes = shapeOf(messages)
    expect(shapes.filter(shape => shape === 'system/status')).toHaveLength(2)
    expect(shapes.at(-1)).toBe('result')
  })
})

describe('development fixture worker turn', () => {
  beforeEach(() => {
    process.env.AGENTBOARD_CHAT_FIXTURE_HOLD_MS = '1'
  })
  afterEach(() => {
    delete process.env.AGENTBOARD_CHAT_FIXTURE_HOLD_MS
  })

  test('the real driver keeps spawn anchors, drops worker tools, and settles from the notification', async () => {
    const events: ChatEvent[] = []
    const rosters: ChatWorker[][] = []
    const statuses: string[] = []
    const driver = new ChatSessionDriver({
      sessionId: 'chat-fixture-workers',
      projectPath: '/tmp/project',
      queryFactory: fixtureQueryFactory,
      onEvent: (event) => events.push(event),
      onStatus: (status) => statuses.push(status),
      onWorkers: (workers) => rosters.push(workers),
    })
    driver.send('spawn a worker')
    const deadline = Date.now() + 3_000
    while (!events.some((event) => event.type === 'turn_completed') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }

    const toolCalls = events.flatMap((event) => (event.type === 'tool_call' ? [event] : []))
    // Both spawns anchor rows; the worker's own Grep never reaches the parent.
    expect(toolCalls.map((call) => call.tool)).toEqual(['Agent', 'Agent'])
    expect(toolCalls.some((call) => call.tool === 'Grep')).toBe(false)

    // Mid-run the top-level worker was live with its last tool.
    expect(rosters.some((roster) =>
      roster.some((worker) => worker.live && worker.lastTool === 'Grep'))).toBe(true)

    // The gap itself is background-governed: the level dropped the task
    // before its notification, so the row sat not-live with no outcome yet.
    expect(rosters.some((roster) =>
      roster.some((worker) => worker.workerId === toolCalls[0]!.toolCallId &&
        worker.status === 'running' && worker.live === false))).toBe(true)

    const final = rosters.at(-1)!
    const [top, nested] = toolCalls.map((call) =>
      final.find((worker) => worker.workerId === call.toolCallId)!)
    // The level dropped the task before its bookend: the outcome is still the
    // notification's, not the stopped fallback.
    expect(top).toMatchObject({ status: 'completed', live: false, agentType: 'Explore' })
    expect(top!.summary).toBe('Found three packages: client, server, shared.')
    expect(nested).toMatchObject({ status: 'completed', depth: 2 })
    expect(statuses.at(-1)).toBe('waiting')
    driver.kill()
  })
})
