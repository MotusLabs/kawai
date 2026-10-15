// Every transcript row a chat search can point at carries a stable
// `data-anchor-id` (chat-session-search D5): the event id, or `tool:<callId>`
// for tool rows — including the task and worker variants of a tool call.
import { afterEach, describe, expect, test } from 'bun:test'
import TestRenderer, { act } from 'react-test-renderer'
import type { ChatBackgroundTask, ChatEvent, ChatWorker } from '@shared/chat'
import ChatMessages from '../components/chat/ChatMessages'
import { useChatStore } from '../stores/chatStore'

const base = { sequence: 0, at: '2026-10-15T09:00:00.000Z', turnId: 't1' }
const SESSION = 'chat-anchors'

function anchors(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAll(node => typeof node.type === 'string' && node.props['data-anchor-id'] !== undefined)
    .map(node => node.props['data-anchor-id'] as string)
}

describe('transcript anchors', () => {
  afterEach(() => useChatStore.setState({ sessions: {}, workerBodies: {}, taskOutputs: {}, closedAccountNotices: {} }))

  test('plain rows are anchored by event id', () => {
    const events: ChatEvent[] = [
      { ...base, id: 'u1', type: 'user_message', text: 'hi' },
      { ...base, id: 'a1', type: 'assistant_text', messageId: 'm', text: 'hello' },
      {
        ...base, id: 'p1', type: 'peer_message', messageId: 'mid', senderSession: 's2', senderGroup: 'lead',
        priority: 'normal', originPath: '/r', tags: [], threadId: 'th', body: 'mail', possibleDuplicate: false,
      },
      { ...base, id: 'c1', type: 'command_output', text: 'ctx' },
      { ...base, id: 'n1', type: 'notice', text: 'note' },
      { ...base, id: 'e1', type: 'error', message: 'boom' },
    ]
    const renderer = TestRenderer.create(<ChatMessages events={events} />)
    expect(anchors(renderer)).toEqual(['u1', 'a1', 'p1', 'c1', 'n1', 'e1'])
    renderer.unmount()
  })

  test('a tool call and its paired result share one tool anchor', () => {
    const renderer = TestRenderer.create(<ChatMessages events={[
      { ...base, id: 'tc', type: 'tool_call', toolCallId: 'call_1', tool: 'Read', input: {} },
      { ...base, id: 'tr', type: 'tool_result', toolCallId: 'call_1', output: 'out' },
    ]} />)
    expect(anchors(renderer)).toEqual(['tool:call_1'])
    renderer.unmount()
  })

  test('a result without its call is anchored by its tool call id too', () => {
    const renderer = TestRenderer.create(<ChatMessages events={[
      { ...base, id: 'tr', type: 'tool_result', toolCallId: 'orphan', output: 'out' },
    ]} />)
    expect(anchors(renderer)).toEqual(['tool:orphan'])
    renderer.unmount()
  })

  test('a background task row and a worker row keep the tool anchor', () => {
    const task: ChatBackgroundTask = {
      taskId: 'b1', toolCallId: 'call_b', kind: 'shell', description: 'Wait for CI',
      status: 'running', live: true, startedAtMs: Date.now() - 5_000, elapsedMs: 5_000,
    }
    const worker: ChatWorker = {
      workerId: 'toolu_w', taskId: 'task-w', agentType: 'Explore', description: 'Map', depth: 1,
      status: 'running', live: true, lastTool: 'Grep', elapsedMs: 1_000,
    }
    act(() => {
      useChatStore.getState().snapshot({
        type: 'chat-snapshot', sessionId: SESSION, profileId: 'default', events: [], pendingRequests: [],
        status: 'waiting', throughSequence: 0, commands: { status: 'unavailable', commands: [] }, activity: null,
        contextUsage: null, usage: null, workers: [worker], backgroundTasks: [task], notifications: [], model: null,
      })
    })
    let renderer!: TestRenderer.ReactTestRenderer
    act(() => {
      renderer = TestRenderer.create(<ChatMessages sessionId={SESSION} events={[
        { ...base, id: 'tb', type: 'tool_call', toolCallId: 'call_b', tool: 'Bash', input: { command: 'sleep 20', run_in_background: true } },
        { ...base, id: 'tw', type: 'tool_call', toolCallId: 'toolu_w', tool: 'Agent', input: {} },
      ]} />)
    })
    expect(renderer.root.findByProps({ 'data-testid': 'chat-task-row' }).props['data-anchor-id']).toBe('tool:call_b')
    expect(renderer.root.findByProps({ 'data-testid': 'chat-worker-row' }).props['data-anchor-id']).toBe('tool:toolu_w')
    act(() => renderer.unmount())
  })
})
