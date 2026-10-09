import { describe, expect, test } from 'bun:test'
import type { ClientMessage, ServerMessage } from '../types'
import type { ChatEvent } from '../chat'

/**
 * Every chat-related ClientMessage/ServerMessage variant must survive a
 * JSON.stringify → JSON.parse round trip with its discriminated union intact,
 * because both ends of the WebSocket only ever see serialized text.
 */
describe('chat wire messages', () => {
  const clientMessages: ClientMessage[] = [
    { type: 'session-create', projectPath: '/tmp/proj', kind: 'chat' },
    { type: 'session-create', projectPath: '/tmp/proj' }, // absent kind = terminal
    { type: 'chat-attach', sessionId: 'chat-1' },
    { type: 'chat-detach', sessionId: 'chat-1' },
    { type: 'chat-send', sessionId: 'chat-1', text: 'hello agent' },
    { type: 'chat-interrupt', sessionId: 'chat-1' },
    { type: 'chat-approval', sessionId: 'chat-1', requestId: 'req-1', decision: 'allow' },
    { type: 'chat-approval', sessionId: 'chat-1', requestId: 'req-2', decision: 'deny' },
    {
      type: 'chat-answer',
      sessionId: 'chat-1',
      requestId: 'req-3',
      answers: {
        'Which library?': { options: ['date-fns'] },
        'Why?': { text: 'tree-shakeable' },
      },
    },
  ]

  test.each(clientMessages.map((message) => [message.type, message] as const))(
    'client message %s round-trips through JSON',
    (_type, message) => {
      const parsed = JSON.parse(JSON.stringify(message)) as ClientMessage
      expect(parsed).toEqual(message)
    }
  )

  test('chat-events carries a JSON-safe event batch', () => {
    const events: ChatEvent[] = [
      { type: 'turn_started', id: 'e1', sequence: 1, at: '2026-01-01T00:00:00.000Z', turnId: 't1' },
      {
        type: 'user_message',
        id: 'e2',
        sequence: 2,
        at: '2026-01-01T00:00:00.000Z',
        turnId: 't1',
        text: 'run the tests',
      },
      {
        type: 'assistant_delta',
        id: 'e3',
        sequence: 3,
        at: '2026-01-01T00:00:00.000Z',
        turnId: 't1',
        messageId: 'msg_1',
        delta: 'run',
      },
      {
        type: 'assistant_text',
        id: 'e4',
        sequence: 4,
        at: '2026-01-01T00:00:00.000Z',
        turnId: 't1',
        messageId: 'msg_1',
        text: 'running them now',
      },
      {
        type: 'tool_call',
        id: 'e5',
        sequence: 5,
        at: '2026-01-01T00:00:00.000Z',
        turnId: 't1',
        toolCallId: 'toolu_1',
        tool: 'Bash',
        input: { command: 'bun test' },
      },
      {
        type: 'approval_request',
        id: 'e6',
        sequence: 6,
        at: '2026-01-01T00:00:00.000Z',
        turnId: 't1',
        requestId: 'req-1',
        tool: 'Bash',
        input: { command: 'rm -rf /tmp/x' },
      },
      {
        type: 'request_resolved',
        id: 'e7',
        sequence: 7,
        at: '2026-01-01T00:00:00.000Z',
        requestId: 'req-1',
        outcome: 'allowed',
      },
      {
        type: 'tool_result',
        id: 'e8',
        sequence: 8,
        at: '2026-01-01T00:00:00.000Z',
        turnId: 't1',
        toolCallId: 'toolu_1',
        output: '12 pass',
      },
      {
        type: 'question_request',
        id: 'e9',
        sequence: 9,
        at: '2026-01-01T00:00:00.000Z',
        turnId: 't1',
        requestId: 'req-3',
        questions: [
          {
            question: 'Which library?',
            header: 'Library',
            multiSelect: false,
            options: [
              { label: 'date-fns', description: 'modern' },
              { label: 'dayjs', description: 'small' },
            ],
          },
        ],
      },
      {
        type: 'turn_completed',
        id: 'e10',
        sequence: 10,
        at: '2026-01-01T00:00:00.000Z',
        turnId: 't1',
        subtype: 'success',
        totalCostUsd: 0.42,
        numTurns: 3,
        finalText: 'done',
      },
      {
        type: 'turn_interrupted',
        id: 'e11',
        sequence: 11,
        at: '2026-01-01T00:00:00.000Z',
        turnId: 't1',
      },
      { type: 'notice', id: 'e12', sequence: 12, at: '2026-01-01T00:00:00.000Z', text: 'context compacted' },
      { type: 'error', id: 'e13', sequence: 13, at: '2026-01-01T00:00:00.000Z', message: 'boom' },
    ]

    const message: ServerMessage = { type: 'chat-events', sessionId: 'chat-1', events }
    const parsed = JSON.parse(JSON.stringify(message)) as ServerMessage
    expect(parsed).toEqual(message)
    if (parsed.type !== 'chat-events') throw new Error('unexpected message type')
    expect(parsed.events.map((event) => event.type)).toEqual(events.map((event) => event.type))
  })

  test('chat-snapshot round-trips with pending requests and status', () => {
    const message: ServerMessage = {
      type: 'chat-snapshot',
      sessionId: 'chat-1',
      events: [
        { type: 'notice', id: 'e1', sequence: 1, at: '2026-01-01T00:00:00.000Z', text: 'hi' },
      ],
      pendingRequests: [
        {
          kind: 'approval',
          requestId: 'req-1',
          tool: 'Bash',
          input: { command: 'ls' },
          at: '2026-01-01T00:00:00.000Z',
        },
        {
          kind: 'question',
          requestId: 'req-2',
          questions: [
            {
              question: 'Proceed?',
              header: 'Confirm',
              multiSelect: false,
              options: [
                { label: 'Yes' },
                { label: 'No' },
              ],
            },
          ],
          at: '2026-01-01T00:00:00.000Z',
        },
      ],
      status: 'permission',
      throughSequence: 1,
      commands: {
        status: 'ready',
        commands: [
          {
            name: 'clear',
            description: 'Start a new session',
            argumentHint: '[name]',
            aliases: ['reset', 'new'],
            source: 'builtin',
          },
        ],
      },
      activity: { phase: 'thinking', elapsedMs: 4_000 },
      profileId: 'default',
      usage: {
        status: 'warning',
        windows: [
          { key: 'five_hour', label: '5-hour window', percentUsed: 22.4, resetsAt: '2026-10-07T18:00:00.000Z' },
          { key: 'seven_day', label: '7-day window', percentUsed: 17, resetsAt: null },
          { key: 'model_scoped:Fable', label: 'Fable weekly', percentUsed: 3.2, resetsAt: '2026-10-12T09:00:00.000Z' },
        ],
        receivedAt: '2026-10-07T13:00:00.000Z',
      },
    }

    const parsed = JSON.parse(JSON.stringify(message)) as ServerMessage
    expect(parsed).toEqual(message)
  })

  test('chat-usage round-trips with a per-profile report or null', () => {
    const messages: ServerMessage[] = [
      {
        type: 'chat-usage',
        profileId: 'default',
        report: {
          status: 'limited',
          windows: [
            { key: 'five_hour', label: '5-hour window', percentUsed: 100, resetsAt: '2026-10-07T18:00:00.000Z' },
          ],
          receivedAt: '2026-10-07T13:00:00.000Z',
        },
      },
      { type: 'chat-usage', profileId: 'glm', report: null },
    ]
    for (const message of messages) {
      const parsed = JSON.parse(JSON.stringify(message)) as ServerMessage
      expect(parsed).toEqual(message)
    }
  })
})
