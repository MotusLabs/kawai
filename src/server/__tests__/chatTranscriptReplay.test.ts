import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ChatEvent } from '../../shared/chat'
import {
  findTranscriptPath,
  parseTranscriptContent,
  replayTranscriptFile,
  withCancelledRequests,
} from '../chat/transcriptReplay'

/**
 * A miniature SDK transcript: one user turn, an assistant reply, a tool that
 * completed, and (later tests) tools that never got a result.
 */
const FIXTURE_TRANSCRIPT = [
  JSON.stringify({
    type: 'user',
    uuid: 'u1',
    timestamp: '2026-10-04T10:00:00.000Z',
    message: { role: 'user', content: 'hello' },
  }),
  JSON.stringify({
    type: 'system',
    subtype: 'cost-state',
    uuid: 'sys1',
    timestamp: '2026-10-04T10:00:00.500Z',
  }),
  JSON.stringify({
    type: 'assistant',
    uuid: 'a1',
    timestamp: '2026-10-04T10:00:01.000Z',
    message: {
      id: 'msg_1',
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'Hi there' },
      ],
    },
  }),
  JSON.stringify({
    type: 'assistant',
    uuid: 'a2',
    timestamp: '2026-10-04T10:00:02.000Z',
    message: {
      id: 'msg_2',
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'ls' } },
      ],
    },
  }),
  JSON.stringify({
    type: 'user',
    uuid: 'u2',
    timestamp: '2026-10-04T10:00:03.000Z',
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'call_1',
          content: 'file.txt',
          is_error: false,
        },
      ],
    },
  }),
  JSON.stringify({
    type: 'system',
    subtype: 'compact_boundary',
    uuid: 'sys2',
    timestamp: '2026-10-04T10:00:03.500Z',
  }),
  JSON.stringify({
    type: 'assistant',
    uuid: 'a3',
    timestamp: '2026-10-04T10:00:04.000Z',
    message: {
      id: 'msg_3',
      role: 'assistant',
      content: [{ type: 'text', text: 'It works' }],
    },
  }),
  JSON.stringify({
    type: 'user',
    uuid: 'u3',
    timestamp: '2026-10-04T10:00:05.000Z',
    message: { role: 'user', content: 'and again' },
  }),
].join('\n')

function typesOf(events: ChatEvent[]): string[] {
  return events.map((event) => event.type)
}

describe('parseTranscriptContent', () => {
  test('maps a fixture transcript into read-only history events', () => {
    const parsed = parseTranscriptContent(FIXTURE_TRANSCRIPT)

    expect(typesOf(parsed.events)).toEqual([
      'user_message',
      'assistant_text',
      'tool_call',
      'tool_result',
      'notice',
      'assistant_text',
      'user_message',
    ])
    expect(parsed.unmatchedToolCallIds).toEqual([])
    expect(parsed.invalidLines).toBe(0)

    // History events are read-only replay: sequence 0, stable ids.
    for (const event of parsed.events) {
      expect(event.sequence).toBe(0)
      expect(event.id.startsWith('hist-')).toBe(true)
    }

    expect(parsed.events[0]).toMatchObject({
      type: 'user_message',
      turnId: 'hist-turn-1',
      text: 'hello',
      at: '2026-10-04T10:00:00.000Z',
    })
    expect(parsed.events[1]).toMatchObject({
      type: 'assistant_text',
      turnId: 'hist-turn-1',
      messageId: 'msg_1',
      text: 'Hi there',
    })
    expect(parsed.events[2]).toMatchObject({
      type: 'tool_call',
      turnId: 'hist-turn-1',
      toolCallId: 'call_1',
      tool: 'Bash',
      input: { command: 'ls' },
    })
    expect(parsed.events[3]).toMatchObject({
      type: 'tool_result',
      turnId: 'hist-turn-1',
      toolCallId: 'call_1',
      output: 'file.txt',
    })
    expect(parsed.events[4]).toMatchObject({
      type: 'notice',
      text: 'Context compacted',
    })
    // The second user message opens a new turn.
    expect(parsed.events[6]).toMatchObject({
      type: 'user_message',
      turnId: 'hist-turn-2',
      text: 'and again',
    })
  })

  test('skips unknown lines, meta, sidechains and a truncated tail', () => {
    const content = [
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        isMeta: true,
        message: { role: 'user', content: '<local-command-caveat>skip me' },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        isSidechain: true,
        message: {
          id: 'msg_side',
          content: [{ type: 'text', text: 'subagent noise' }],
        },
      }),
      JSON.stringify({
        type: 'file-history-snapshot',
        uuid: 'fh1',
        message: {},
      }),
      JSON.stringify({
        type: 'user',
        uuid: 'u2',
        timestamp: '2026-10-04T11:00:00.000Z',
        message: { role: 'user', content: 'only this survives' },
      }),
      '{"type":"assistant","uuid":"a2","message":{"id":"msg_2","content":[{"type":"te',
    ].join('\n')

    const parsed = parseTranscriptContent(content)
    expect(typesOf(parsed.events)).toEqual(['user_message'])
    expect(parsed.events[0]).toMatchObject({ text: 'only this survives' })
    expect(parsed.invalidLines).toBe(1)
    expect(parsed.unmatchedToolCallIds).toEqual([])
  })

  test('restored history marks dead pending requests cancelled', () => {
    const content = [
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-10-04T12:00:00.000Z',
        message: {
          id: 'msg_1',
          content: [
            {
              type: 'tool_use',
              id: 'call_dead',
              name: 'Bash',
              input: { command: 'rm x' },
            },
          ],
        },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'a2',
        timestamp: '2026-10-04T12:00:01.000Z',
        message: {
          id: 'msg_2',
          content: [
            {
              type: 'tool_use',
              id: 'call_ask',
              name: 'AskUserQuestion',
              input: {
                questions: [
                  {
                    question: 'Pick one',
                    header: 'Pick',
                    multiSelect: false,
                    options: [
                      { label: 'A', description: 'first' },
                      { label: 'B' },
                    ],
                  },
                ],
              },
            },
          ],
        },
      }),
    ].join('\n')

    const parsed = parseTranscriptContent(content)
    expect(parsed.unmatchedToolCallIds).toEqual(['call_dead', 'call_ask'])
    const events = withCancelledRequests(
      parsed.events,
      parsed.unmatchedToolCallIds
    )

    expect(typesOf(events)).toEqual([
      'tool_call',
      'approval_request',
      'request_resolved',
      'tool_call',
      'question_request',
      'request_resolved',
    ])
    // The request id is the tool use id, and a request produced on resume
    // gets a fresh id — history never claims these are still pending.
    expect(events[1]).toMatchObject({
      type: 'approval_request',
      requestId: 'call_dead',
      turnId: 'hist-turn-0',
      tool: 'Bash',
      input: { command: 'rm x' },
    })
    expect(events[2]).toMatchObject({
      type: 'request_resolved',
      requestId: 'call_dead',
      outcome: 'cancelled',
    })
    expect(events[4]).toMatchObject({
      type: 'question_request',
      requestId: 'call_ask',
    })
    if (events[4].type === 'question_request') {
      expect(events[4].questions[0]).toMatchObject({
        question: 'Pick one',
        header: 'Pick',
        multiSelect: false,
      })
    }
    expect(events[5]).toMatchObject({
      requestId: 'call_ask',
      outcome: 'cancelled',
    })
  })

  test('a live driver\'s in-flight tools are not marked cancelled', () => {
    const parsed = parseTranscriptContent(
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        message: {
          id: 'msg_1',
          content: [
            { type: 'tool_use', id: 'call_live', name: 'Bash', input: {} },
          ],
        },
      })
    )
    const events = withCancelledRequests(
      parsed.events,
      parsed.unmatchedToolCallIds,
      { excludeToolCallIds: new Set(['call_live']) }
    )
    expect(typesOf(events)).toEqual(['tool_call'])
  })
})

describe('replayTranscriptFile', () => {
  let tempDir: string
  const originalConfigDir = process.env.CLAUDE_CONFIG_DIR

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentboard-replay-'))
    process.env.CLAUDE_CONFIG_DIR = path.join(tempDir, 'claude-config')
  })

  afterEach(() => {
    if (originalConfigDir !== undefined) {
      process.env.CLAUDE_CONFIG_DIR = originalConfigDir
    } else {
      delete process.env.CLAUDE_CONFIG_DIR
    }
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  function writeTranscript(sdkSessionId: string, content: string): string {
    const dir = path.join(
      process.env.CLAUDE_CONFIG_DIR!,
      'projects',
      '-tmp-proj'
    )
    fs.mkdirSync(dir, { recursive: true })
    const filePath = path.join(dir, `${sdkSessionId}.jsonl`)
    fs.writeFileSync(filePath, content)
    return filePath
  }

  test('finds a transcript by SDK session id regardless of path encoding', () => {
    const filePath = writeTranscript('sdk-find-me', FIXTURE_TRANSCRIPT)
    expect(findTranscriptPath('sdk-find-me')).toBe(filePath)
    expect(findTranscriptPath('sdk-nope')).toBeNull()
  })

  test('a missing transcript falls back to the history-unavailable notice', () => {
    const replay = replayTranscriptFile(null)
    expect(replay.status).toBe('missing')
    expect(typesOf(replay.events)).toEqual(['notice'])
    expect(replay.events[0]).toMatchObject({ type: 'notice' })
    if (replay.events[0].type === 'notice') {
      expect(replay.events[0].text).toContain('History unavailable')
    }

    const viaPath = replayTranscriptFile(
      path.join(tempDir, 'gone.jsonl')
    )
    expect(viaPath.status).toBe('missing')
  })

  test('parser failure on an existing transcript is unparseable but not missing', () => {
    const filePath = writeTranscript('sdk-broken', 'not json at all\n{also broken')
    const replay = replayTranscriptFile(filePath)
    expect(replay.status).toBe('unparseable')
    expect(typesOf(replay.events)).toEqual(['notice'])
    if (replay.events[0].type === 'notice') {
      expect(replay.events[0].text).toContain('History unavailable')
    }

    // A bookkeeping-only or empty file is valid history, not a parse failure.
    expect(replayTranscriptFile(writeTranscript('sdk-empty', '')).status).toBe(
      'ok'
    )
  })

  test('a fixture transcript replays with cancelled dead requests', () => {
    const filePath = writeTranscript('sdk-hist', FIXTURE_TRANSCRIPT)
    const replay = replayTranscriptFile(filePath)
    expect(replay.status).toBe('ok')
    expect(typesOf(replay.events)).toEqual([
      'user_message',
      'assistant_text',
      'tool_call',
      'tool_result',
      'notice',
      'assistant_text',
      'user_message',
    ])
  })
})
