import { describe, expect, test } from 'bun:test'
import type { ChatWireFrame } from '@shared/chat'
import { frameLabel, frameTime, prettyFrame } from '../utils/chatWireFrames'

const frame = (raw: unknown, dir: ChatWireFrame['dir'] = 'in'): ChatWireFrame => ({
  seq: 1, at: '2026-10-05T12:03:07.215Z', dir, raw: typeof raw === 'string' ? raw : JSON.stringify(raw),
})

describe('chat wire frame helpers', () => {
  test('labels each stream-json shape by its most specific kind', () => {
    expect(frameLabel(frame({ type: 'system', subtype: 'init' }))).toBe('system · init')
    expect(frameLabel(frame({ type: 'assistant', message: {} }))).toBe('assistant')
    expect(frameLabel(frame({ type: 'user', message: {} }, 'out'))).toBe('user')
    expect(frameLabel(frame({ type: 'stream_event', event: { type: 'content_block_delta' } }))).toBe('stream_event · content_block_delta')
    expect(frameLabel(frame({ type: 'result', subtype: 'success' }))).toBe('result · success')
    expect(frameLabel(frame({ type: 'control_request', request: { subtype: 'can_use_tool' } }))).toBe('control_request · can_use_tool')
    expect(frameLabel(frame({ type: 'control_response', response: { subtype: 'success' } }, 'out'))).toBe('control_response · success')
    expect(frameLabel(frame({ event: 'spawn', command: 'claude' }, 'lifecycle'))).toBe('spawn')
    expect(frameLabel(frame({ code: 0 }, 'lifecycle'))).toBe('lifecycle')
  })

  test('falls back for non-JSON, non-object, and untyped frames', () => {
    expect(frameLabel(frame('Error: something broke', 'stderr'))).toBe('text')
    expect(frameLabel(frame('[1,2]'))).toBe('text')
    expect(frameLabel(frame({ hello: 'world' }))).toBe('json')
  })

  test('pretty-prints JSON and leaves raw text untouched', () => {
    expect(prettyFrame(frame('{"a":{"b":1}}'))).toBe('{\n  "a": {\n    "b": 1\n  }\n}')
    expect(prettyFrame(frame('plain text'))).toBe('plain text')
  })

  test('formats local time with milliseconds', () => {
    const at = new Date('2026-10-05T12:03:07.215Z')
    const expected = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}:07.215`
    expect(frameTime(frame({}))).toBe(expected)
    expect(frameTime({ ...frame({}), at: 'garbage' })).toBe('garbage')
  })
})
