import { describe, expect, test } from 'bun:test'
import type { ChatWireFrame } from '@shared/chat'
import { frameLabel, frameTime, groupFrames, prettyFrame, type FrameEntry } from '../utils/chatWireFrames'

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

describe('groupFrames', () => {
  const delta = (seq: number, dir: ChatWireFrame['dir'] = 'in'): ChatWireFrame =>
    ({ ...frame({ type: 'stream_event', event: { type: 'content_block_delta' } }, dir), seq })
  const thinking = (seq: number): ChatWireFrame =>
    ({ ...frame({ type: 'system', subtype: 'thinking_tokens' }), seq })
  const stop = (seq: number): ChatWireFrame =>
    ({ ...frame({ type: 'stream_event', event: { type: 'content_block_stop' } }), seq })
  const result = (seq: number): ChatWireFrame =>
    ({ ...frame({ type: 'result', subtype: 'success' }), seq })
  const seqs = (entries: FrameEntry[]): number[] =>
    entries.flatMap(entry => entry.kind === 'frame' ? [entry.frame.seq] : entry.frames.map(member => member.seq))

  test('a run of 20 deltas becomes one group', () => {
    const entries = groupFrames(Array.from({ length: 20 }, (_, i) => delta(i + 1)))
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: 'group', label: 'stream_event · content_block_delta', dir: 'in', absorbed: 0 })
    expect(entries[0]!.kind === 'group' && entries[0].frames).toHaveLength(20)
  })

  test('a lone frame stays a single entry, not a group of one', () => {
    expect(groupFrames([delta(1), result(2)])).toEqual([
      { kind: 'frame', frame: delta(1) },
      { kind: 'frame', frame: result(2) },
    ])
  })

  test('the same label with a different direction does not group', () => {
    const entries = groupFrames([delta(1), delta(2, 'out')])
    expect(entries).toEqual([
      { kind: 'frame', frame: delta(1) },
      { kind: 'frame', frame: delta(2, 'out') },
    ])
  })

  test('thinking_tokens alternating with deltas joins one delta group as absorbed', () => {
    const entries = groupFrames([delta(1), thinking(2), delta(3), thinking(4), delta(5)])
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: 'group', label: 'stream_event · content_block_delta', dir: 'in', absorbed: 2 })
    expect(entries[0]!.kind === 'group' && seqs(entries)).toEqual([1, 2, 3, 4, 5])
  })

  test('a trailing thinking_tokens stays in the run before content_block_stop', () => {
    const entries = groupFrames([delta(1), delta(2), thinking(3), stop(4)])
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ kind: 'group', absorbed: 1 })
    expect(entries[1]).toMatchObject({ kind: 'frame', frame: stop(4) })
    expect(seqs(entries)).toEqual([1, 2, 3, 4])
  })

  test('a thinking_tokens frame with no open run starts its own group', () => {
    const entries = groupFrames([thinking(1), thinking(2), delta(3)])
    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ kind: 'group', label: 'system · thinking_tokens', dir: 'in', absorbed: 0 })
    expect(entries[1]).toMatchObject({ kind: 'frame', frame: delta(3) })
  })

  test('a different label closes the run; later same-label frames start a new group', () => {
    const entries = groupFrames([delta(1), delta(2), result(3), delta(4), delta(5)])
    expect(entries).toHaveLength(3)
    expect(entries[0]).toMatchObject({ kind: 'group', label: 'stream_event · content_block_delta' })
    expect(entries[1]).toMatchObject({ kind: 'frame', frame: result(3) })
    expect(entries[2]!.kind === 'group' && entries[2].frames.map(member => member.seq)).toEqual([4, 5])
  })

  test('non-JSON stderr lines group as text', () => {
    const lines = ['Error: boom', '    at f (x.ts:1)', 'Error: again']
    const entries = groupFrames(lines.map((line, i) => ({ ...frame(line, 'stderr'), seq: i + 1 })))
    expect(entries).toEqual([{
      kind: 'group', label: 'text', dir: 'stderr',
      frames: lines.map((line, i) => ({ ...frame(line, 'stderr'), seq: i + 1 })), absorbed: 0,
    }])
  })

  test('grouping then flattening members reproduces the input exactly', () => {
    const input: ChatWireFrame[] = [
      delta(1), thinking(2), delta(3), stop(4),
      delta(5, 'out'), delta(6, 'out'),
      { ...frame('Error: boom', 'stderr'), seq: 7 }, { ...frame('Error: again', 'stderr'), seq: 8 },
      result(9), delta(10), delta(11),
    ]
    expect(seqs(groupFrames(input))).toEqual(input.map(frameItem => frameItem.seq))
    expect(groupFrames(input).flatMap(entry => entry.kind === 'frame' ? [entry.frame] : entry.frames)).toEqual(input)
  })
})
