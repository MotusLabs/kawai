// CLI turn identity across interrupts (docs/claude-cli-contract.md): no frame
// or result of an interrupted turn may complete or feed a later turn, in any
// order. Test names mark GUARD (its turn outcome fails on the named base) or
// NIT (the base already had that outcome; the logging it asserts is new).
import { afterEach, beforeEach, describe, expect, spyOn, test, type Mock } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ChatEvent } from '../../shared/chat'
import { logger } from '../logger'
import { assistantText, cleanupHarnesses, createHarness, flush, result, type Harness } from './fixtures/chatDriverHarness'

const CAPS = ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1']
const PEER = { messageId: 'mail-urgent', senderSession: 'lead', senderGroup: null, priority: 'urgent' as const, originPath: '/repo', tags: [], threadId: 'mail-urgent', body: 'Stop and do this', possibleDuplicate: false }
const init = (capabilities: string[] = CAPS) => ({ type: 'system', subtype: 'init', session_id: 'sdk-1', capabilities }) as unknown as SDKMessage
/** A result echoing the prompts it answers (none: an agent-started turn's). */
const answer = (prompts: Array<SDKUserMessage | null>, subtype: string, inputTokens: number, extra: Record<string, unknown> = {}) => {
  const uuids = prompts.map(prompt => prompt!.uuid!)
  return result(subtype, {
    usage: { input_tokens: inputTokens, output_tokens: 1 },
    ...(uuids.length ? { user_message_uuid: uuids.at(-1), user_message_uuids: uuids } : {}),
    ...extra,
  })
}
const aborted = (...prompts: Array<SDKUserMessage | null>) => answer(prompts, 'error_during_execution', 900)
const own = (...prompts: Array<SDKUserMessage | null>) => answer(prompts, 'success', 5)
const completed = (h: Harness) => h.events
  .filter((event): event is Extract<ChatEvent, { type: 'turn_completed' }> => event.type === 'turn_completed')
  .map(event => ({ turnId: event.turnId, subtype: event.subtype, input: event.usage?.inputTokens }))
/** The delivered mail's turn, named by the caller's envelope. */
const DELIVERED: Anchor = { peer: PEER.messageId }
const ownTurnTwo = (r: Roles) => [{ turnId: r.two, subtype: 'success', input: 5 }]

/**
 * Scenario roles (task-602c71e9 R2, A8). The retired harness injected
 * createTurnId → turn-1, turn-2…; the package mints opaque turn ids, so each
 * case names its turns by roles it declares before it drives anything, each
 * tied to an anchor independent of the driver's output order: the prompt the
 * package wrote for a caller send (that prompt's uuid on its user_message
 * event), the caller's delivered envelope (its messageId on the peer_message
 * event), or — for the one agent-started or queued turn a case opens — the
 * single turn_started that no prompt or envelope names.
 * Roles resolve when asserted; distinct roles must bind distinct turn ids, and
 * the full turn_started sequences the cases assert admit no other id. Lost on
 * purpose: the literal injected labels and any proof about mints the old
 * class made but never showed.
 */
type Anchor = { prompt: () => SDKUserMessage | null | undefined } | { peer: string } | 'unnamed'
type Roles = Record<'one' | 'two', string>
function roles<R extends string>(h: Harness, anchors: Record<R, Anchor>): Record<R, string> {
  const prompted = (uuid: string | undefined) => h.events.filter(event => event.type === 'user_message' && event.messageUuid === uuid)
  const ids = Object.fromEntries(Object.entries<Anchor>(anchors).map(([role, anchor]) => {
    if (anchor === 'unnamed') {
      const named = new Set(h.events.flatMap(event => event.type === 'user_message' || event.type === 'peer_message' ? [event.turnId] : []))
      const unnamed = h.events.filter(event => event.type === 'turn_started' && !named.has(event.turnId))
      expect(unnamed).toHaveLength(1)
      return [role, (unnamed[0] as { turnId: string }).turnId]
    }
    if ('peer' in anchor) {
      const shown = h.events.filter(event => event.type === 'peer_message' && event.messageId === anchor.peer)
      expect(shown).toHaveLength(1)
      return [role, (shown[0] as { turnId: string }).turnId]
    }
    const uuid = anchor.prompt()?.uuid
    expect(typeof uuid).toBe('string')
    const shown = prompted(uuid)
    expect(shown).toHaveLength(1)
    return [role, (shown[0] as { turnId: string }).turnId]
  })) as Record<R, string>
  expect(new Set(Object.values(ids)).size).toBe(Object.keys(ids).length)
  return ids
}
const pulled = new WeakMap<Harness, number>()
/** The next prompt, once the package actually wrote it (its async boot precedes the write). */
async function pull(h: Harness, fake = 0): Promise<SDKUserMessage | null> {
  const count = (pulled.get(h) ?? 0) + 1
  pulled.set(h, count)
  await h.admitted(count)
  return h.fakes[fake]!.pullPrompt()
}

let warn: Mock<typeof logger.warn>
const warned = (event: string) => warn.mock.calls.filter(([name]) => name === event).map(([, data]) => (data as { reason?: string; uuid?: string }))
// The package logs the pinned contract's deviations under its own event
// names (packages/agent-runtime/src/claude/session.ts: claude_cli_contract_violation,
// claude_unknown_result_uuid); the retired class logged them as chat_*.
const VIOLATION = 'claude_cli_contract_violation'
const UNKNOWN_UUID = 'claude_unknown_result_uuid'
const violations = () => warned(VIOLATION).map(data => data.reason)
beforeEach(() => { warn = spyOn(logger, 'warn') })
afterEach(async () => {
  // Every harness's driver is killed and joined (settled()) before the spy is restored.
  try {
    await cleanupHarnesses()
  } finally {
    warn.mockRestore()
  }
})

/** A busy first turn the CLI is working on; returns its prompt. */
async function busy(h: Harness, capabilities: string[] = CAPS) {
  h.driver.send('long job')
  const prompt = await pull(h)
  h.fakes[0]!.push(init(capabilities))
  h.fakes[0]!.push(assistantText('working on it'))
  await flush()
  return prompt
}

/** The second turn runs on its own init, frames, and result. */
async function turnTwoRuns(h: Harness, prompt: SDKUserMessage | null, first: Anchor, second: Anchor, withInit = true) {
  if (withInit) h.fakes[0]!.push(init())
  h.fakes[0]!.push(assistantText('on it', 'msg_2'))
  h.fakes[0]!.push(own(prompt))
  await flush()
  const r = roles(h, { one: first, two: second })
  expect(completed(h)).toEqual(ownTurnTwo(r))
  expect(h.events.find(event => event.type === 'assistant_text' && event.turnId === r.two)).toMatchObject({ text: 'on it' })
  expect(h.events.some(event => event.type === 'assistant_text' && event.turnId !== r.two && event.text === 'on it')).toBe(false)
  expect(h.events.filter(event => event.type === 'turn_started').map(event => event.turnId)).toEqual([r.one, r.two])
  expect(h.statuses.at(-1)).toBe('waiting')
}

describe('ChatSessionDriver CLI turn identity across interrupts', () => {
  test('GUARD (2b1f56bf) every prompt carries a fresh client uuid', async () => {
    const h = createHarness()
    h.driver.send('first')
    h.driver.send('second')
    const a = await pull(h)
    const b = await pull(h)
    expect(a?.uuid).toBeString()
    expect(b?.uuid).toBeString()
    expect(a?.uuid).not.toBe(b?.uuid)
  })

  test('GUARD (2b1f56bf) ack → result → init: urgent mail delivered on the ack ends only on its own result', async () => {
    const h = createHarness()
    const a = await busy(h)
    await h.driver.interrupt()
    expect(h.events.at(-1)).toMatchObject({ type: 'turn_interrupted', turnId: roles(h, { one: { prompt: () => a } }).one })
    h.driver.deliver(PEER)
    const b = await pull(h)
    h.fakes[0]!.push(aborted(a))
    await turnTwoRuns(h, b, { prompt: () => a }, DELIVERED)
    expect(h.events.some(event => event.type === 'error')).toBe(false)
    expect(violations()).toEqual([])
  })

  test('GUARD (2b1f56bf, c04c8eee) ack → init → result (findings-970c7351): logged, and the tail never ends the delivered turn', async () => {
    const h = createHarness()
    const a = await busy(h)
    await h.driver.interrupt()
    h.driver.deliver(PEER)
    const b = await pull(h)
    h.fakes[0]!.push(init())
    h.fakes[0]!.push(aborted(a))
    await turnTwoRuns(h, b, { prompt: () => a }, DELIVERED, false)
    expect(violations()).toEqual(['init-before-owed-result'])
  })

  test('GUARD (2b1f56bf) an interrupted agent-started turn: its uuid-less tail never ends the delivered turn', async () => {
    const h = createHarness()
    h.driver.start()
    const fake = await h.spawned()
    fake.push(init())
    fake.push(assistantText('counting'))
    await flush()
    expect(h.events.find(event => event.type === 'turn_started')).toMatchObject({ turnId: roles(h, { one: 'unnamed' }).one, trigger: { kind: 'resumed' } })
    await h.driver.interrupt()
    h.driver.deliver(PEER)
    const b = await pull(h)
    h.fakes[0]!.push(aborted())
    await turnTwoRuns(h, b, 'unnamed', DELIVERED)
    expect(violations()).toEqual([])
  })

  test('GUARD (2b1f56bf) Stop, then a send: the send\'s turn ends on its own result', async () => {
    const h = createHarness()
    const a = await busy(h)
    await h.driver.interrupt()
    h.driver.send('do this instead')
    const b = await pull(h)
    expect(h.events.at(-1)).toMatchObject({ type: 'user_message', turnId: roles(h, { one: { prompt: () => a }, two: { prompt: () => b } }).two })
    h.fakes[0]!.push(aborted(a))
    await turnTwoRuns(h, b, { prompt: () => a }, { prompt: () => b })
  })

  test('GUARD (2b1f56bf) an interrupt during a pending approval: the delivered turn ends on its own result', async () => {
    const h = createHarness()
    const a = await busy(h)
    const decision = h.fakes[0]!.options.canUseTool!('Bash', { command: 'rm -rf /tmp/x' }, {
      signal: new AbortController().signal, toolUseID: 'toolu_1', requestId: 'sdk-req-1',
    })
    await flush()
    expect(h.statuses.at(-1)).toBe('permission')
    await h.driver.interrupt()
    expect(await decision).toMatchObject({ behavior: 'deny' })
    h.driver.deliver(PEER)
    const b = await pull(h)
    h.fakes[0]!.push(aborted(a))
    await turnTwoRuns(h, b, { prompt: () => a }, DELIVERED)
  })

  test('GUARD (2b1f56bf) an interrupt before the turn\'s init: pins the pre-init cancel_queued default; that init opens nothing, the next turn runs on its own', async () => {
    const h = createHarness()
    h.driver.send('long job')
    const a = await pull(h)
    await h.driver.interrupt()
    expect(h.fakes[0]!.interruptOptions).toEqual([{ cancelQueued: true }])
    h.driver.deliver(PEER)
    const b = await pull(h)
    h.fakes[0]!.push(init())
    h.fakes[0]!.push(aborted(a))
    await turnTwoRuns(h, b, { prompt: () => a }, DELIVERED)
    expect(violations()).toEqual([])
  })

  test('NIT no tail: the delivered turn runs; the missing result is logged', async () => {
    const h = createHarness()
    const a = await busy(h)
    await h.driver.interrupt()
    h.driver.deliver(PEER)
    const b = await pull(h)
    await turnTwoRuns(h, b, { prompt: () => a }, DELIVERED)
    expect(violations()).toEqual(['init-before-owed-result'])
  })

  test('GUARD (b02668de) (iii) an agent-started init with a result still owed (findings-8388b668): logged, and its turn ends on its own result', async () => {
    const h = createHarness()
    const a = await busy(h)
    await h.driver.interrupt()
    h.fakes[0]!.push(init())
    h.fakes[0]!.push(assistantText('a monitor fired', 'msg_2'))
    h.fakes[0]!.push(result('success', { usage: { input_tokens: 4, output_tokens: 1 } }))
    // The late tail names the first turn: dropped.
    h.fakes[0]!.push(aborted(a))
    await flush()
    const r = roles(h, { one: { prompt: () => a }, two: 'unnamed' })
    expect(completed(h)).toEqual([{ turnId: r.two, subtype: 'success', input: 4 }])
    expect(h.events.find(event => event.type === 'assistant_text' && event.turnId === r.two)).toMatchObject({ text: 'a monitor fired' })
    expect(violations()).toEqual(['init-before-owed-result'])
    expect(h.statuses.at(-1)).toBe('waiting')
  })

  test('GUARD (2b1f56bf) (i) a late or duplicate result naming a completed turn never closes the current one', async () => {
    const h = createHarness()
    h.driver.send('first')
    const a = await pull(h)
    h.fakes[0]!.push(init())
    h.fakes[0]!.push(answer([a], 'success', 3))
    await flush()
    h.driver.send('second')
    const b = await pull(h)
    h.fakes[0]!.push(init())
    h.fakes[0]!.push(answer([a], 'success', 3))
    await flush()
    expect(h.statuses.at(-1)).toBe('working')
    h.fakes[0]!.push(own(b))
    await flush()
    const r = roles(h, { one: { prompt: () => a }, two: { prompt: () => b } })
    expect(completed(h)).toEqual([{ turnId: r.one, subtype: 'success', input: 3 }, { turnId: r.two, subtype: 'success', input: 5 }])
  })

  test('GUARD (2b1f56bf) (ii) a never-sent uuid is logged and dropped', async () => {
    const h = createHarness()
    h.driver.send('first')
    const a = await pull(h)
    h.fakes[0]!.push(init())
    h.fakes[0]!.push(result('success', { user_message_uuid: 'never-sent', user_message_uuids: ['never-sent'] }))
    await flush()
    expect(completed(h)).toEqual([])
    expect(warned(UNKNOWN_UUID).map(data => data.uuid)).toEqual(['never-sent'])
    h.fakes[0]!.push(own(a))
    await flush()
    expect(completed(h)).toEqual([{ turnId: roles(h, { one: { prompt: () => a } }).one, subtype: 'success', input: 5 }])
  })

  test('NIT (iv) one result with two uuids closes the one joined turn', async () => {
    const h = createHarness()
    h.driver.send('first')
    h.driver.send('and also this')
    const a = await pull(h)
    const b = await pull(h)
    h.fakes[0]!.push(init())
    h.fakes[0]!.push(answer([a, b], 'success', 5))
    await flush()
    expect(completed(h)).toEqual([{ turnId: roles(h, { one: { prompt: () => a } }).one, subtype: 'success', input: 5 }])
    expect(h.events.filter(event => event.type === 'turn_started')).toHaveLength(1)
    expect(h.statuses.at(-1)).toBe('waiting')
  })

  test('NIT a joined send the CLI runs as its own turn ends the turn its init opens', async () => {
    const h = createHarness()
    h.driver.send('first')
    h.driver.send('and also this')
    const a = await pull(h)
    const b = await pull(h)
    h.fakes[0]!.push(init())
    h.fakes[0]!.push(answer([a], 'success', 3, { queued_turn_count: 1 }))
    h.fakes[0]!.push(init())
    h.fakes[0]!.push(own(b))
    await flush()
    // The queued send's own turn: shown under the active turn while queued
    // (queuedEchoes.ts), its prompt names no turn of its own.
    const r = roles(h, { one: { prompt: () => a }, two: 'unnamed' })
    expect(completed(h)).toEqual([{ turnId: r.one, subtype: 'success', input: 3 }, { turnId: r.two, subtype: 'success', input: 5 }])
    expect(h.statuses.at(-1)).toBe('waiting')
    expect(violations()).toEqual([])
  })

  test('GUARD (2b1f56bf) (v) Stop sends cancel_queued when the CLI advertises interrupt_cancel_queued_v1', async () => {
    const h = createHarness()
    await busy(h)
    await h.driver.interrupt()
    expect(h.fakes[0]!.interruptOptions).toEqual([{ cancelQueued: true }])
    expect(violations()).toEqual([])
  })

  test('NIT (v) without the capability Stop sends a plain interrupt and logs the violation', async () => {
    const h = createHarness()
    await busy(h, ['interrupt_receipt_v1'])
    await h.driver.interrupt()
    expect(h.fakes[0]!.interruptOptions).toEqual([undefined])
    expect(violations()).toEqual(['interrupt-cancel-queued-unsupported'])
  })

  test('NIT (v) a joined send Stop cancelled never runs or ends a turn', async () => {
    const h = createHarness()
    const a = await busy(h)
    h.driver.send('and also this')
    const b = await pull(h)
    h.fakes[0]!.interruptReceipt = { still_queued: [], cancelled: [b!.uuid!] }
    await h.driver.interrupt()
    h.fakes[0]!.push(aborted(a))
    await flush()
    h.driver.deliver(PEER)
    const c = await pull(h)
    await turnTwoRuns(h, c, { prompt: () => a }, DELIVERED)
    expect(violations()).toEqual([])
  })

  test('NIT an interrupt with no active turn interrupts nothing; the next turn runs', async () => {
    const h = createHarness()
    h.driver.send('first')
    const a = await pull(h)
    h.fakes[0]!.push(init())
    h.fakes[0]!.push(answer([a], 'success', 3))
    await flush()
    await h.driver.interrupt()
    expect(h.events.some(event => event.type === 'turn_interrupted')).toBe(false)
    h.driver.deliver(PEER)
    const b = await pull(h)
    h.fakes[0]!.push(init())
    h.fakes[0]!.push(own(b))
    await flush()
    const r = roles(h, { one: { prompt: () => a }, two: DELIVERED })
    expect(completed(h)).toEqual([{ turnId: r.one, subtype: 'success', input: 3 }, { turnId: r.two, subtype: 'success', input: 5 }])
    expect(violations()).toEqual([])
  })

  test('NIT (e) a setup failure\'s uuid-less result ends the prompted turn, logged', async () => {
    const h = createHarness()
    h.driver.send('first')
    const a = await pull(h)
    h.fakes[0]!.push(result('error_during_execution', { errors: ['startup failed'], total_cost_usd: 0 }))
    await flush()
    expect(completed(h)).toEqual([{ turnId: roles(h, { one: { prompt: () => a } }).one, subtype: 'error_during_execution', input: 1 }])
    expect(h.events.at(-1)).toMatchObject({ type: 'error', message: 'startup failed' })
    expect(violations()).toEqual(['prompted-result-without-uuid'])
    expect(h.statuses.at(-1)).toBe('waiting')
  })

  test('NIT process death after an interrupt: the respawned process runs the next turn', async () => {
    const h = createHarness()
    const a = await busy(h)
    await h.driver.interrupt()
    h.fakes[0]!.exit()
    await flush()
    expect(h.events.at(-1)).toMatchObject({ type: 'error' })
    h.driver.send('again')
    const b = await pull(h, 1)
    h.fakes[1]!.push(init())
    h.fakes[1]!.push(own(b))
    await flush()
    expect(completed(h)).toEqual(ownTurnTwo(roles(h, { one: { prompt: () => a }, two: { prompt: () => b } })))
    expect(h.statuses.at(-1)).toBe('waiting')
  })

  test('NIT a background task whose queued notification Stop cancels keeps its outcome in the roster', async () => {
    const h = createHarness()
    h.driver.send('start the server')
    const a = await pull(h)
    h.fakes[0]!.push(init())
    h.fakes[0]!.push({ type: 'system', subtype: 'task_started', task_id: 'bquick', tool_use_id: 'call_quick', task_type: 'local_bash', description: 'marker', is_backgrounded: true, uuid: 'u', session_id: 's' } as unknown as SDKMessage)
    h.fakes[0]!.push(answer([a], 'success', 3))
    // The task settles; its notification would start an agent turn, which
    // Stop cancels from the CLI's queue (no init follows).
    h.fakes[0]!.push({ type: 'system', subtype: 'task_notification', task_id: 'bquick', tool_use_id: 'call_quick', status: 'completed', summary: 'Background command "marker" completed (exit code 0)', uuid: 'u2', session_id: 's' } as unknown as SDKMessage)
    await flush()
    expect(h.backgroundTasks.at(-1)).toMatchObject([{ taskId: 'bquick', status: 'completed', live: false }])
    await h.driver.interrupt()
    await flush()
    expect(h.backgroundTasks.at(-1)).toMatchObject([{ taskId: 'bquick', status: 'completed', live: false }])
    expect(h.statuses.at(-1)).toBe('waiting')
  })
})

// The recorded-frame contract test: masked frames captured from Claude Code
// 2.1.289 (the floor) by the live probes in docs/claude-cli-contract.md,
// replayed through the driver. Rows with `action` are the probe's own steps.
describe('ChatSessionDriver recorded CLI contract (2.1.289 probes)', () => {
  type Row = Record<string, unknown> & { action?: string }
  const rows = (name: string): Row[] => fs.readFileSync(path.join(import.meta.dir, 'fixtures', 'cliContract', `${name}.jsonl`), 'utf8')
    .trim().split('\n').map(line => JSON.parse(line) as Row)

  /** The replayed harness and each probe prompt the package wrote, by its recorded label. */
  async function replay(name: string): Promise<{ h: Harness; sent: Map<string, SDKUserMessage | null> }> {
    const h = createHarness()
    const uuids = new Map<string, string>()
    const sent = new Map<string, SDKUserMessage | null>()
    const uuidOf = (label: unknown) => typeof label === 'string' ? uuids.get(label) ?? `unsent-${label}` : undefined
    let toolId = ''
    const recorded = rows(name)
    for (const [index, row] of recorded.entries()) {
      if (row.action === 'send') {
        h.driver.send(`prompt ${String(row.prompt)}`)
        const prompt = await pull(h)
        sent.set(String(row.prompt), prompt)
        uuids.set(String(row.prompt), prompt!.uuid!)
      } else if (row.action === 'interrupt') {
        const receipt = recorded.slice(index).find(next => next.action === 'receipt')
        h.fakes[0]!.interruptReceipt = receipt
          ? { still_queued: (receipt.still_queued as string[]).map(label => uuidOf(label)!), cancelled: (receipt.cancelled as string[]).map(label => uuidOf(label)!) }
          : undefined
        await h.driver.interrupt()
      } else if (!row.action) {
        const frame = toFrame(row, index, uuidOf, () => toolId, (id) => { toolId = id })
        if (frame) h.fakes[0]!.push(frame)
        await flush(2)
      }
    }
    await flush()
    return { h, sent }
  }

  function toFrame(row: Row, index: number, uuidOf: (label: unknown) => string | undefined, lastTool: () => string, setTool: (id: string) => void): SDKMessage | null {
    const base = { uuid: `frame-${index}`, session_id: 'sdk-1' }
    if (row.type === 'system') {
      // Task frames were masked to their subtype; the roster is not under test.
      return row.subtype === 'init' ? { ...base, type: 'system', subtype: 'init', capabilities: row.capabilities } as unknown as SDKMessage : null
    }
    if (row.type === 'rate_limit_event') return null
    if (row.type === 'command_lifecycle') return { ...base, type: 'command_lifecycle', command_uuid: uuidOf(row.command_uuid), state: row.state } as unknown as SDKMessage
    if (row.type === 'assistant') {
      const content = (row.content as string[]).map((kind) => {
        if (kind === 'text') return { type: 'text', text: `text ${index}` }
        if (kind === 'tool_use') { setTool(`toolu_${index}`); return { type: 'tool_use', id: lastTool(), name: 'Bash', input: { command: 'sleep 4' } } }
        return { type: 'thinking', thinking: 'thinking' }
      })
      return { ...base, type: 'assistant', parent_tool_use_id: null, message: { id: `msg_${index}`, role: 'assistant', content } } as unknown as SDKMessage
    }
    if (row.type === 'user') {
      const content = (row.content as string[]).map(kind => kind === 'tool_result' ? { type: 'tool_result', tool_use_id: lastTool(), content: 'ok' } : { type: 'text', text: kind })
      return { ...base, type: 'user', parent_tool_use_id: null, message: { role: 'user', content } } as unknown as SDKMessage
    }
    if (row.type === 'result') {
      const named = row.user_message_uuids as string[] | undefined
      return result(String(row.subtype), {
        is_error: row.is_error, terminal_reason: row.terminal_reason, result_index: row.result_index, queued_turn_count: row.queued_turn_count,
        ...(named ? { user_message_uuid: uuidOf(row.user_message_uuid), user_message_uuids: named.map(label => uuidOf(label)) } : {}),
      })
    }
    throw new Error(`unmapped recorded frame: ${JSON.stringify(row)}`)
  }

  /** Every turn ends exactly once: completed or interrupted. */
  function outcomes(h: Harness) {
    const started = h.events.filter(event => event.type === 'turn_started').map(event => event.turnId)
    const ended = h.events.flatMap(event => event.type === 'turn_completed' ? [[event.turnId, event.subtype]] : event.type === 'turn_interrupted' ? [[event.turnId, 'interrupted']] : [])
    expect(ended.map(([turnId]) => turnId).sort()).toEqual([...started].sort())
    expect(h.statuses.at(-1)).toBe('waiting')
    expect(violations()).toEqual([])
    return Object.fromEntries(ended)
  }

  test('GUARD (2b1f56bf) prompt probe: interrupt, then a send — the send runs on its own result', async () => {
    const { h, sent } = await replay('prompt')
    const r = roles(h, { one: { prompt: () => sent.get('A') }, two: { prompt: () => sent.get('B') } })
    expect(outcomes(h)).toEqual({ [r.one]: 'interrupted', [r.two]: 'success' })
    expect(h.fakes[0]!.interruptOptions).toEqual([{ cancelQueued: true }])
    expect(h.events.some(event => event.type === 'assistant_text' && event.turnId === r.two)).toBe(true)
  })

  test('GUARD (2b1f56bf) task probe: an interrupted agent-started turn, then a send', async () => {
    const { h, sent } = await replay('task')
    const r = roles(h, { one: { prompt: () => sent.get('A') }, two: 'unnamed', three: { prompt: () => sent.get('B') } })
    expect(outcomes(h)).toEqual({ [r.one]: 'success', [r.two]: 'interrupted', [r.three]: 'success' })
    expect(h.events.find(event => event.type === 'turn_started' && event.turnId === r.two)).toMatchObject({ trigger: { kind: 'resumed' } })
    expect(h.events.some(event => event.type === 'assistant_text' && event.turnId === r.three)).toBe(true)
  })

  test('NIT cancel probe: Stop cancels the joined send; the next send runs on its own result', async () => {
    const { h, sent } = await replay('cancel')
    const r = roles(h, { one: { prompt: () => sent.get('A') }, two: { prompt: () => sent.get('C') } })
    expect(outcomes(h)).toEqual({ [r.one]: 'interrupted', [r.two]: 'success' })
    expect(h.events.some(event => event.type === 'assistant_text' && event.turnId === r.two)).toBe(true)
  })
})
