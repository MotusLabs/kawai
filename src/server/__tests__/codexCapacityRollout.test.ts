// codex-capacity-retry W5 and P5 (design "Acceptance oracles", task 3.2):
// replay of a Codex rollout that holds a capacity recovery. Codex writes each
// attempt as its own task in the rollout, the continuation's input as a user
// row; codexRollout.ts must show the original human or peer input once, each
// continuation input as a `capacity_recovery` notice (never human or peer
// input), keep the completed tool results, and the receipt reader must find
// no mail in a continuation row. P5 drives the real package session (its
// request payloads) and replays the rollout Codex would write for them.
import { afterEach, describe, expect, test } from 'bun:test'
import type { ChatEvent, ChatPeerMessage } from '../../shared/chat'
import { CODEX_CAPACITY_CONTINUATION } from '@motuslabs/agent-runtime/codex'
import { CONTINUATION_NOTICE, parseCodexRollout } from '../chat/codex/codexRollout'
import { codexReceiptMessageId } from '../team/receipt'
import { formatEnvelope, parseEnvelope } from '../team/envelope'
import { propertyCases } from './helpers/propertyCases'
import { frames, type Scripted } from '../../../packages/agent-runtime/__tests__/helpers/scriptedCodex'
import { scripted, stopScripted } from '../../../packages/agent-runtime/__tests__/helpers/capacitySteps'

afterEach(stopScripted)

export const W5_ROW = ['W5', 'Rollout with original input and internal continuation inputs', 'Original input appears once; recovery inputs are notices, not human/peer input; no new receipt; completed tools retained'] as const

const ENVELOPE: ChatPeerMessage = {
  messageId: 'msg-capacity-1', senderSession: 'chat-lead', senderKind: 'agent', senderGroup: 'lead', priority: 'normal',
  originPath: '/project', tags: [], threadId: 'msg-capacity-1', body: 'Fix the failing build', possibleDuplicate: false,
}

let clock = 0
const at = () => new Date(Date.UTC(2026, 10, 18, 12, 0, clock++)).toISOString()
const row = (type: string, payload: Record<string, unknown>) => JSON.stringify({ timestamp: at(), type, payload })
const userRow = (text: string) => row('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] })
const taskStarted = () => row('event_msg', { type: 'task_started' })
const toolRows = (callId: string) => [
  row('response_item', { type: 'function_call', call_id: callId, name: 'shell', arguments: JSON.stringify({ command: ['npm', 'test'] }) }),
  row('response_item', { type: 'function_call_output', call_id: callId, output: 'tests passed' }),
]
const capacityError = () => [row('event_msg', { type: 'error', message: 'model at capacity' }), row('event_msg', { type: 'task_complete', last_agent_message: null })]
const success = (text: string) => [
  row('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }),
  row('event_msg', { type: 'task_complete', last_agent_message: text }),
]

const of = (events: ChatEvent[], type: ChatEvent['type']) => events.filter((event) => event.type === type)

describe('codex-capacity-retry rollout replay', () => {
  test('the W5 row is committed verbatim', () => {
    expect(W5_ROW[0]).toBe('W5')
  })

  // @covers: codex-chat-sessions › Capacity recovery preserves conversation and work › Replay recovery history
  test('W5: a rollout with original input and continuation inputs replays the input once, recovery as notices, tools retained and no new receipt', () => {
    for (const original of ['Please fix the failing build', formatEnvelope(ENVELOPE)]) {
      const lines = [
        row('session_meta', { id: 'thread-0001' }),
        taskStarted(), userRow(original), ...toolRows('call-1'), ...capacityError(),
        taskStarted(), userRow(CODEX_CAPACITY_CONTINUATION), ...capacityError(),
        taskStarted(), userRow(CODEX_CAPACITY_CONTINUATION), ...toolRows('call-2'), ...success('fixed'),
      ]
      const events = parseCodexRollout(lines.join('\n'))
      const inputs = [...of(events, 'user_message'), ...of(events, 'peer_message')]
      expect(inputs).toHaveLength(1)
      const peer = original !== 'Please fix the failing build'
      expect(inputs[0]).toMatchObject(peer ? { type: 'peer_message', body: 'Fix the failing build' } : { type: 'user_message', text: original })
      expect(of(events, 'notice')).toEqual([
        expect.objectContaining({ type: 'notice', kind: 'capacity_recovery', text: CONTINUATION_NOTICE }),
        expect.objectContaining({ type: 'notice', kind: 'capacity_recovery', text: CONTINUATION_NOTICE }),
      ])
      expect(JSON.stringify(events)).not.toContain('agent-runtime-capacity-recovery')
      expect(of(events, 'tool_result').map((event) => (event as { toolCallId: string }).toolCallId)).toEqual(['call-1', 'call-2'])
      // The receipt reader finds the original envelope only; a continuation row names no mail.
      expect(lines.map(codexReceiptMessageId).filter(Boolean)).toEqual(peer ? ['msg-capacity-1'] : [])
    }
  })

  test('W5: text that only resembles the continuation (edited, prefixed or a different version) stays ordinary input', () => {
    const variants = [
      CODEX_CAPACITY_CONTINUATION.replace('version="1"', 'version="2"'),
      `Note: ${CODEX_CAPACITY_CONTINUATION}`,
      CODEX_CAPACITY_CONTINUATION.replace('Continue the existing request', 'Start a new request'),
    ]
    for (const text of variants) {
      const events = parseCodexRollout([taskStarted(), userRow(text)].join('\n'))
      expect(of(events, 'notice')).toEqual([])
      expect(of(events, 'user_message')).toHaveLength(1)
    }
  })

  test('W5: an image turn and its continuation replay the images with the input once and recovery as a notice', () => {
    const id = `${'c'.repeat(64)}.png`
    const imageRow = row('response_item', { type: 'message', role: 'user', content: [
      { type: 'input_text', text: 'what is on screen' },
      { type: 'input_text', text: `<image name=[Image #1] path="/assets/${id}">` },
      { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
      { type: 'input_text', text: '</image>' },
    ] })
    const lines = [taskStarted(), imageRow, ...capacityError(), taskStarted(), userRow(CODEX_CAPACITY_CONTINUATION), ...success('a login form')]
    const events = parseCodexRollout(lines.join('\n'))
    const users = of(events, 'user_message') as Array<Extract<ChatEvent, { type: 'user_message' }>>
    expect(users).toHaveLength(1)
    expect(users[0]!.text).toBe('what is on screen')
    expect(users[0]!.images?.map((image) => image.id)).toEqual([id])
    expect(of(events, 'notice')).toEqual([expect.objectContaining({ type: 'notice', kind: 'capacity_recovery', text: CONTINUATION_NOTICE })])
  })
})

// ---- P5 -------------------------------------------------------------------

const CASES = 1000

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const inputText = (request: { params: Record<string, any> }) => (request.params.input as Array<{ text?: string }>).map((block) => block.text ?? '').join('\n')

/** One chain: human or peer input, a completed tool, then capacity failures until success or the window closes; returns the rollout lines Codex would write. */
async function chain(s: Scripted, random: () => number): Promise<{ original: string; lines: string[]; tools: string[] }> {
  const original = random() < 0.5 ? `Task ${Math.floor(random() * 1e6)}` : formatEnvelope({ ...ENVELOPE, messageId: `msg-${Math.floor(random() * 1e6)}`, threadId: 'thr' })
  await s.driver.start()
  await s.driver.send(original)
  await s.flush()
  const lines: string[] = []
  const tools: string[] = []
  const failures = Math.floor(random() * 6)
  for (let attempt = 0; ; attempt++) {
    const request = s.turnStarts().at(-1)!
    const id = `a${attempt + 1}`
    s.reply(request.id, { turn: { id } })
    s.notify(...frames.started(id))
    lines.push(taskStarted(), userRow(inputText(request)))
    if (attempt === 0 || random() < 0.3) {
      const callId = `call-${attempt}`
      tools.push(callId)
      s.notify('item/completed', { turnId: id, item: { type: 'commandExecution', id: callId, command: 'npm test', cwd: '/', status: 'completed', aggregatedOutput: 'ok', exitCode: 0 } })
      lines.push(...toolRows(callId))
    }
    await s.flush()
    if (attempt >= failures) {
      s.notify(...frames.completed(id, [{ type: 'agentMessage', id: `m-${id}`, text: 'done' }]))
      lines.push(...success('done'))
      await s.flush()
      return { original, lines, tools }
    }
    s.clock.randoms.splice(0, s.clock.randoms.length, random())
    s.notify(...frames.failed(id, 'serverOverloaded'))
    lines.push(...capacityError())
    await s.flush()
    const before = s.turnStarts().length
    s.clock.advance(70_000)
    await s.flush()
    if (s.turnStarts().length === before) return { original, lines, tools }
  }
}

test('P5: automatic continuation never duplicates the original input (seed 0xCA9AC21, 1,000 cases)', async () => {
  for (let index = 0; index < propertyCases(CASES); index++) {
    const random = mulberry32(0xca9ac21 + index * 0x9e3779b1)
    const s = scripted('bounded')
    const { original, lines, tools } = await chain(s, random)
    const starts = s.turnStarts()
    // Request payloads: the original is sent once; every later start carries only the continuation.
    expect(starts.filter((request) => inputText(request) === original)).toHaveLength(1)
    expect(starts.slice(1).every((request) => inputText(request) === CODEX_CAPACITY_CONTINUATION)).toBe(true)
    // Replay: the original input once, one notice per continuation, every completed tool once, no new receipt.
    const events = parseCodexRollout(lines.join('\n'))
    expect([...of(events, 'user_message'), ...of(events, 'peer_message')]).toHaveLength(1)
    expect(of(events, 'notice').filter((event) => (event as { kind?: string }).kind === 'capacity_recovery')).toHaveLength(starts.length - 1)
    expect(of(events, 'tool_result').map((event) => (event as { toolCallId: string }).toolCallId)).toEqual(tools)
    expect(lines.map(codexReceiptMessageId).filter(Boolean)).toHaveLength(parseEnvelope(original) ? 1 : 0)
    await stopScripted()
  }
}, 600_000)
