import { describe, expect, test } from 'bun:test'
import type { ChatEvent } from '../../shared/chat'
import { HISTORY_WINDOW_MS, historyWindow } from '../chat/historyWindow'

// Fixtures use the two real transcript shapes: replayed turns open with
// their user_message (a fresh turnId, no turn_started event), live turns
// open with a turn_started. Anchors are pinned with `endAt` so the tests
// never depend on the wall clock.
const NOW = '2026-10-17T12:00:00.000Z'
const ago = (hours: number): string =>
  new Date(Date.parse(NOW) - hours * 3_600_000).toISOString()

let nextId = 0
const userMessage = (turnId: string, at: string): ChatEvent => {
  nextId += 1
  return { type: 'user_message', id: `u${nextId}`, sequence: 0, at, turnId, text: `msg ${turnId}` }
}
const assistantText = (turnId: string, at: string): ChatEvent => {
  nextId += 1
  return { type: 'assistant_text', id: `a${nextId}`, sequence: 0, at, turnId, messageId: `m-${turnId}`, text: `reply ${turnId}` }
}
const turnStarted = (turnId: string, at: string): ChatEvent => {
  nextId += 1
  return { type: 'turn_started', id: `t${nextId}`, sequence: 0, at, turnId }
}
const toolCall = (turnId: string, at: string, toolCallId: string): ChatEvent => {
  nextId += 1
  return { type: 'tool_call', id: `c${nextId}`, sequence: 0, at, turnId, toolCallId, tool: 'Bash', input: { command: 'echo' } }
}
const toolResult = (turnId: string, at: string, toolCallId: string): ChatEvent => {
  nextId += 1
  return { type: 'tool_result', id: `r${nextId}`, sequence: 0, at, turnId, toolCallId, output: 'ok' }
}
const notice = (at: string, text = 'Context compacted'): ChatEvent => {
  nextId += 1
  return { type: 'notice', id: `n${nextId}`, sequence: 0, at, text }
}
/** A replayed turn: its user message opens the turn. */
const turn = (turnId: string, at: string, ...rest: ChatEvent[]): ChatEvent[] => [userMessage(turnId, at), ...rest]
/** A turn the source recorded no time for. */
const undatedTurn = (turnId: string, ...rest: ChatEvent[]): ChatEvent[] => [userMessage(turnId, ''), ...rest]

describe('historyWindow', () => {
  test('a five-day history attaches with only its last 24 hours', () => {
    const events = [
      ...turn('turn-1', ago(120)),
      ...turn('turn-2', ago(96)),
      ...turn('turn-3', ago(72)),
      ...turn('turn-4', ago(48)),
      ...turn('turn-5', ago(20)),
      ...turn('turn-6', ago(5)),
      ...turn('turn-7', ago(1)),
    ]
    const window = historyWindow(events, { endAt: NOW })
    expect(window.hasOlder).toBe(true)
    expect(window.startId).toBe(events[4]!.id) // turn-5's opener (20 h old)
    expect(window.events.map(event => ('turnId' in event ? event.turnId : undefined))).toEqual(['turn-5', 'turn-6', 'turn-7'])
    expect(window.events).toHaveLength(3)
  })

  test('HISTORY_WINDOW_MS is 24 hours', () => {
    expect(HISTORY_WINDOW_MS).toBe(24 * 60 * 60 * 1000)
  })

  test('an idle chat anchors on its newest event, not the wall clock', () => {
    const events = [
      ...turn('turn-1', ago(95)),
      ...turn('turn-2', ago(70)),
      ...turn('turn-3', ago(67)),
    ]
    // No endAt: the anchor is the newest event, 67 hours old. The window is
    // the day before that event, not an empty "last 24 hours of now".
    const window = historyWindow(events)
    expect(window.events.map(event => ('turnId' in event ? event.turnId : undefined))).toEqual(['turn-2', 'turn-3'])
    expect(window.hasOlder).toBe(true)
  })

  test('a turn that began before the window is left whole to older history', () => {
    const straddling = [
      ...turn('turn-1', ago(25), toolCall('turn-1', ago(24.5), 'call-1')),
      toolResult('turn-1', ago(23), 'call-1'),
      ...turn('turn-2', ago(20)),
      ...turn('turn-3', ago(1)),
    ]
    const window = historyWindow(straddling, { endAt: NOW })
    expect(window.events.map(event => ('turnId' in event ? event.turnId : undefined))).toEqual(['turn-2', 'turn-3'])
    // Neither the tool call nor its late result leaks in without the other.
    expect(window.events.some(event => event.type === 'tool_call' || event.type === 'tool_result')).toBe(false)
  })

  test('a turn just inside the cutoff is kept whole including its tool pair', () => {
    const events = [
      ...turn('turn-1', ago(23), toolCall('turn-1', ago(22.5), 'call-1')),
      toolResult('turn-1', ago(22), 'call-1'),
      ...turn('turn-2', ago(1)),
    ]
    const window = historyWindow(events, { endAt: NOW })
    expect(window.events.map(event => ('turnId' in event ? event.turnId : undefined))).toEqual(['turn-1', 'turn-1', 'turn-1', 'turn-2'])
    expect(window.events.some(event => event.type === 'tool_call')).toBe(true)
    expect(window.events.some(event => event.type === 'tool_result')).toBe(true)
    expect(window.hasOlder).toBe(false)
  })

  test('a short conversation keeps everything with hasOlder false', () => {
    const events = [...turn('turn-1', ago(3)), ...turn('turn-2', ago(1))]
    const window = historyWindow(events, { endAt: NOW })
    expect(window.events).toEqual(events)
    expect(window.hasOlder).toBe(false)
    expect(window.startId).toBe(events[0]!.id)
  })

  test('a page across an empty gap still returns at least one turn', () => {
    const events = [
      ...turn('turn-1', ago(100)),
      ...turn('turn-2', ago(60)),
      ...turn('turn-3', ago(10)),
    ]
    // The 24 hours before turn-3 hold no turns; one use still loads turn-2.
    const page = historyWindow(events, { beforeId: events[2]!.id })
    expect(page.stale).toBeUndefined()
    expect(page.events.map(event => ('turnId' in event ? event.turnId : undefined))).toEqual(['turn-2'])
    expect(page.hasOlder).toBe(true)
  })

  test('a page ends before the unit holding beforeId and everything after it', () => {
    const events = [
      ...turn('turn-1', ago(40)),
      ...turn('turn-2', ago(10)),
      ...turn('turn-3', ago(5)),
      ...turn('turn-4', ago(2)),
    ]
    // The 24 hours before turn-3 take turn-2 only; turn-3 and turn-4 stay
    // out — the client already holds them — and turn-1 predates the page.
    const page = historyWindow(events, { beforeId: events[2]!.id })
    expect(page.events.map(event => ('turnId' in event ? event.turnId : undefined))).toEqual(['turn-2'])
    expect(page.hasOlder).toBe(true)
  })

  test('undated units inherit the nearest earlier dated unit time', () => {
    const events = [
      ...turn('turn-1', ago(30)),
      ...undatedTurn('turn-2', assistantText('turn-2', '')),
      ...turn('turn-3', ago(28)),
      ...turn('turn-4', ago(5)),
    ]
    // turn-2 inherits turn-1's 30 h time, so it stays outside the window
    // with the older units; turn-3 (28 h) is also outside. Only turn-4 is in.
    const window = historyWindow(events, { endAt: NOW })
    expect(window.events.map(event => ('turnId' in event ? event.turnId : undefined))).toEqual(['turn-4'])
  })

  test('a page anchored on an undated unit inherits the previous dated unit time', () => {
    const events = [
      ...turn('turn-1', ago(100)),
      ...turn('turn-2', ago(90)),
      ...turn('turn-3', ago(80)),
      ...turn('turn-4', ago(75)),
      ...undatedTurn('turn-5'),
      ...turn('turn-6', ago(2)),
      ...turn('turn-7', ago(1)),
    ]
    // The page anchor is turn-5's INHERITED 75 h time: the 24 hours before
    // it take turn-2, turn-3, turn-4. Without inheritance the anchor falls
    // back to the newest event of the whole list and the page would shrink
    // to turn-4 alone.
    const page = historyWindow(events, { beforeId: events[4]!.id })
    expect(page.events.map(event => ('turnId' in event ? event.turnId : undefined))).toEqual(['turn-2', 'turn-3', 'turn-4'])
    expect(page.hasOlder).toBe(true)
  })

  test('an undated unit inside the window rides along', () => {
    const events = [
      ...turn('turn-1', ago(20)),
      ...undatedTurn('turn-2', notice('')),
      ...turn('turn-3', ago(18)),
    ]
    const window = historyWindow(events, { endAt: NOW })
    expect(window.events.map(event => ('turnId' in event ? event.turnId : undefined))).toEqual(['turn-1', 'turn-2', undefined, 'turn-3'])
    expect(window.hasOlder).toBe(false)
  })

  test('a notice without a turn belongs to the unit it sits in', () => {
    const events = [...turn('turn-1', ago(20), notice('')), assistantText('turn-1', ago(19))]
    const window = historyWindow(events, { endAt: NOW })
    expect(window.events).toEqual(events)
    expect(window.hasOlder).toBe(false)
  })

  test('no dated events keeps the whole list', () => {
    const events = [userMessage('turn-1', ''), userMessage('turn-2', '')]
    // No endAt either: there is nothing to measure against.
    const window = historyWindow(events)
    expect(window.events).toEqual(events)
    expect(window.hasOlder).toBe(false)
    expect(window.startId).toBe(events[0]!.id)
  })

  test('a pinned anchor over undated events keeps at least the newest turn', () => {
    const events = [userMessage('turn-1', ''), userMessage('turn-2', '')]
    const window = historyWindow(events, { endAt: NOW })
    expect(window.events.map(event => event.id)).toEqual([events[1]!.id])
    expect(window.hasOlder).toBe(true)
  })

  test('every unit older than the cutoff still keeps the newest turn', () => {
    const events = [...turn('turn-1', ago(100)), ...turn('turn-2', ago(50))]
    const window = historyWindow(events, { endAt: NOW })
    expect(window.events.map(event => ('turnId' in event ? event.turnId : undefined))).toEqual(['turn-2'])
    expect(window.hasOlder).toBe(true)
  })

  test('fromId widens a reconnect window to that event unit', () => {
    const events = [
      ...turn('turn-1', ago(120)),
      ...turn('turn-2', ago(48)),
      ...turn('turn-3', ago(20)),
      ...turn('turn-4', ago(1)),
    ]
    const defaultWindow = historyWindow(events, { endAt: NOW })
    expect(defaultWindow.events.map(event => ('turnId' in event ? event.turnId : undefined))).toEqual(['turn-3', 'turn-4'])
    // The client holds turn-2's opener: the window starts there instead.
    const widened = historyWindow(events, { endAt: NOW, fromId: events[1]!.id })
    expect(widened.events.map(event => ('turnId' in event ? event.turnId : undefined))).toEqual(['turn-2', 'turn-3', 'turn-4'])
    expect(widened.hasOlder).toBe(true)
  })

  test('fromId newer than the default start changes nothing', () => {
    const events = [...turn('turn-1', ago(48)), ...turn('turn-2', ago(20)), ...turn('turn-3', ago(1))]
    const base = historyWindow(events, { endAt: NOW })
    const window = historyWindow(events, { endAt: NOW, fromId: base.events.at(-1)!.id })
    expect(window).toEqual(base)
  })

  test('an unknown fromId falls back to the default window', () => {
    const events = [...turn('turn-1', ago(48)), ...turn('turn-2', ago(1))]
    const base = historyWindow(events, { endAt: NOW })
    expect(historyWindow(events, { endAt: NOW, fromId: 'hist-gone' })).toEqual(base)
  })

  test('throughId extends a page back to the revealed entry unit', () => {
    const events = [
      ...turn('turn-1', ago(100)),
      ...turn('turn-2', ago(60)),
      ...turn('turn-3', ago(10)),
    ]
    // A page that would return only turn-2 is widened to include turn-1.
    const page = historyWindow(events, { beforeId: events[2]!.id, throughId: events[0]!.id })
    expect(page.events.map(event => ('turnId' in event ? event.turnId : undefined))).toEqual(['turn-1', 'turn-2'])
    // Widened back to the very first unit: nothing older remains.
    expect(page.hasOlder).toBe(false)
  })

  test('throughId resolves a tool:<callId> anchor to its event unit', () => {
    const events = [
      ...turn('turn-1', ago(100)),
      ...turn('turn-2', ago(60), toolCall('turn-2', ago(59), 'call-old')),
      toolResult('turn-2', ago(59), 'call-old'),
      ...turn('turn-3', ago(10)),
    ]
    const byEvent = historyWindow(events, { beforeId: events[4]!.id, throughId: 'call-old' })
    const byAnchor = historyWindow(events, { beforeId: events[4]!.id, throughId: 'tool:call-old' })
    expect(byEvent.events.map(event => ('turnId' in event ? event.turnId : undefined))).toEqual(['turn-2', 'turn-2', 'turn-2'])
    expect(byAnchor).toEqual(byEvent)
    expect(byEvent.hasOlder).toBe(true)
  })

  test('a throughId with no match is ignored, not stale', () => {
    const events = [...turn('turn-1', ago(60)), ...turn('turn-2', ago(10))]
    const page = historyWindow(events, { beforeId: events[1]!.id, throughId: 'tool:missing' })
    expect(page.stale).toBeUndefined()
    expect(page.events.map(event => ('turnId' in event ? event.turnId : undefined))).toEqual(['turn-1'])
  })

  test('an unknown beforeId is stale with no events', () => {
    const events = [...turn('turn-1', ago(60)), ...turn('turn-2', ago(1))]
    const page = historyWindow(events, { beforeId: 'hist-drifted' })
    expect(page.stale).toBe(true)
    expect(page.events).toEqual([])
    expect(page.startId).toBeNull()
    expect(page.hasOlder).toBe(false)
  })

  test('live-shaped turns cut on turn_started and never split a tool pair', () => {
    const events = [
      turnStarted('turn-1', ago(30)),
      userMessage('turn-1', ago(30)),
      toolCall('turn-1', ago(29.5), 'call-1'),
      toolResult('turn-1', ago(29.4), 'call-1'),
      turnStarted('turn-2', ago(5)),
      userMessage('turn-2', ago(5)),
    ]
    const window = historyWindow(events, { endAt: NOW })
    expect(window.events.map(event => ('turnId' in event ? event.turnId : undefined))).toEqual(['turn-2', 'turn-2'])
    expect(window.hasOlder).toBe(true)
  })

  test('an empty event list yields an empty window', () => {
    const window = historyWindow([])
    expect(window.events).toEqual([])
    expect(window.startId).toBeNull()
    expect(window.hasOlder).toBe(false)
  })

  test('a beforeId in the first unit returns an empty, exhausted page', () => {
    const events = [...turn('turn-1', ago(3)), ...turn('turn-2', ago(1))]
    const page = historyWindow(events, { beforeId: events[0]!.id })
    expect(page.events).toEqual([])
    expect(page.hasOlder).toBe(false)
    expect(page.stale).toBeUndefined()
  })

  test('a turnId reappearing after another turn stays in the unit it sits in', () => {
    // unitsOf opens a unit at a turnId's FIRST appearance only, so turn-1's
    // id returning after turn-2 has opened cuts nothing: the returning event
    // belongs to turn-2's unit, and the page ending before turn-3 starts
    // there. Slicing on a change from the previous turn-carrying event (the
    // H6 mutant) would open a unit at the returning event and leave
    // turn-2's opener out of the page.
    const events = [
      ...turn('turn-1', ago(50)),
      ...turn('turn-2', ago(30)),
      assistantText('turn-1', ago(20)),
      ...turn('turn-3', ago(2)),
    ]
    const page = historyWindow(events, { beforeId: events[3]!.id })
    expect(page.stale).toBeUndefined()
    expect(page.events.map(event => ('turnId' in event ? event.turnId : undefined))).toEqual(['turn-2', 'turn-1'])
    expect(page.startId).toBe(events[1]!.id)
    expect(page.hasOlder).toBe(true)
  })
})
