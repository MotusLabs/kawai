// codex-chat-sessions 6.1 (D6, decision 1 F7, decision 2 M4): the dispatch
// table — a good call on the session's thread (a subagent carrying its
// parent's thread id is served the same way), a child thread refused, a
// foreign namespace, an unknown tool, invalid arguments, null params, a
// thrown handler — every refusal answering `success: false` with text,
// never a JSON-RPC error and never an approval card — and the drift test
// holding the Codex namespace spec and the Claude MCP server to one
// teamToolTable.
//
// Since task-ce05430a R2 (G2) every case runs Kawai's production Codex
// composition (createChatDriver -> codexRuntime.ts -> the package) over the
// replaying fake app-server: the fake sends each scripted `item/tool/call`
// and the test reads the reply the driver wrote, and the namespace is the
// `dynamicTools` the driver's thread/start carried. Expected values come
// from this file's table. A18 D-T1: the package refuses invalid arguments as
// 'Refused: invalid arguments for <tool>: …' where the deleted root dispatch
// wrote 'Invalid arguments for <tool>: …'.
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { createMailboxServer, teamToolTable, type MailboxServerServices, type TeamToolSpec } from '../team/mailboxTools'
import { dispatchTeamToolCall } from '../chat/codex/codexTools'
import { ROLLOUT, Script, sentRequest, startHarness, THREAD_ID, until } from './codexDriverHarness'

const THREAD = THREAD_ID

const table: TeamToolSpec[] = [
  {
    name: 'send_message', description: 'send', schema: z.object({ to_kind: z.string(), to_id: z.string(), body: z.string() }),
    handler: async input => ({ id: 'msg-1', echoed: input }),
  },
  {
    name: 'team_ping', description: 'ping', schema: z.object({}),
    handler: () => ({ pong: true }),
  },
  {
    name: 'boom', description: 'throws', schema: z.object({}),
    handler: () => {
      throw new Error('handler failed')
    },
  },
]

type Answer = { success: boolean; contentItems: Array<{ type: string; text?: string }> }
type Call = Record<string, unknown> | null

/**
 * The replies Kawai's Codex driver wrote to scripted `item/tool/call`s:
 * `before` arrive while thread/start is still unanswered, `after` once the
 * thread is open. Ids are 900, 901, … in that order.
 */
async function serve(tools: readonly TeamToolSpec[], after: Call[], before: Call[] = []): Promise<Answer[]> {
  const script = new Script().request('initialize', { userAgent: 'fake' })
  script.lines.push({ dir: 'out', line: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'thread/start', params: {} }) })
  const ids = [...before, ...after].map((_, n) => 900 + n)
  const request = (id: number, params: Call) => script.lines.push({ dir: 'in', line: JSON.stringify({ method: 'item/tool/call', id, params }) })
  before.forEach((params, n) => request(ids[n]!, params))
  script.lines.push({ dir: 'in', line: JSON.stringify({ id: 2, result: { thread: { id: THREAD_ID, path: ROLLOUT }, model: 'gpt-test' } }) })
  after.forEach((params, n) => request(ids[before.length + n]!, params))
  const harness = startHarness(script, { teamTools: tools })
  try {
    harness.driver.start()
    const reply = (id: number) => harness.sent.find(message => message.id === id && message.method === undefined)
    await until(() => ids.every(id => reply(id) !== undefined))
    // A refusal is an answer, never a JSON-RPC error, and raises no card.
    for (const id of ids) expect(reply(id)).not.toHaveProperty('error')
    expect(harness.events.filter(event => event.type === 'approval_request' || event.type === 'question_request')).toEqual([])
    return ids.map(id => reply(id)!.result as Answer)
  } finally {
    await harness.cleanup()
  }
}

const call = (params: Record<string, unknown>) => ({ threadId: THREAD, turnId: 'ct-1', callId: 'call-1', ...params })

/** The first content item's text (every answer here is one inputText item). */
const textOf = (item: { type: string; text?: string } | undefined): string =>
  item?.type === 'inputText' ? item.text ?? '' : ''

test('a call on the session\'s own thread runs the handler and answers its JSON', async () => {
  const [served] = await serve(table, [call({ namespace: 'kawai-team', tool: 'send_message', arguments: { to_kind: 'group', to_id: 'lead', body: 'hi' } })])
  expect(served!.success).toBe(true)
  expect(JSON.parse(textOf(served!.contentItems[0]))).toEqual({ id: 'msg-1', echoed: { to_kind: 'group', to_id: 'lead', body: 'hi' } })
})

test('a child thread is refused; the session\'s own thread is served either way', async () => {
  let ran = 0
  const spy: TeamToolSpec[] = [{ ...table[0]!, handler: input => { ran += 1; return input } }]
  const [refused] = await serve(spy, [call({ threadId: 'thread-child', namespace: 'kawai-team', tool: 'send_message', arguments: {} })])
  expect(refused).toMatchObject({ success: false, contentItems: [{ type: 'inputText', text: expect.stringContaining('thread') }] })
  expect(ran).toBe(0)
  // A subagent's call carries its parent's thread id; that one is served as
  // the session (decision 2 M4) — the call holds no other identity.
  const [parent] = await serve(spy, [call({ namespace: 'kawai-team', tool: 'send_message', arguments: { to_kind: 'group', to_id: 'lead', body: 'x' } })])
  expect(parent!.success).toBe(true)
  expect(ran).toBe(1)
})

test('a foreign namespace, an unknown tool, and a call before the thread are refused', async () => {
  const [early, foreign, unknown] = await serve(
    table,
    [call({ namespace: 'other-team', tool: 'send_message', arguments: {} }), call({ namespace: 'kawai-team', tool: 'no_such_tool', arguments: {} })],
    [call({ namespace: 'kawai-team', tool: 'send_message', arguments: {} })],
  )
  expect(foreign).toMatchObject({ success: false, contentItems: [{ text: expect.stringContaining('kawai-team') }] })
  expect(unknown).toMatchObject({ success: false, contentItems: [{ text: expect.stringContaining('no_such_tool') }] })
  expect(early).toMatchObject({ success: false, contentItems: [{ text: expect.stringContaining('no thread yet') }] })
})

test('arguments a schema rejects are refused with the issue named', async () => {
  const [refused] = await serve(table, [call({ namespace: 'kawai-team', tool: 'send_message', arguments: { to_kind: 'group' } })])
  expect(refused!.success).toBe(false)
  // A18 D-T1: the package's refusal text, where the root copy wrote 'Invalid arguments for send_message'.
  expect(textOf(refused!.contentItems[0])).toContain('Refused: invalid arguments for send_message')
  expect(textOf(refused!.contentItems[0])).toContain('to_id')
})

test('a thrown handler answers success:false with the message, not a JSON-RPC error', async () => {
  const [failed] = await serve(table, [call({ namespace: 'kawai-team', tool: 'boom', arguments: {} })])
  expect(failed).toEqual({ success: false, contentItems: [{ type: 'inputText', text: 'handler failed' }] })
  expect(failed).not.toHaveProperty('error')
})

// HELD (task-ce05430a gap E4, Lead decision pending): on the production path
// the package's RPC layer answers `params: null` with JSON-RPC -32602 before
// dispatch, so this case still reads the root dispatcher until the Lead rules.
test('null params are refused instead of crashing', async () => {
  expect(await dispatchTeamToolCall(table, THREAD, null))
    .toMatchObject({ success: false, contentItems: [{ text: expect.stringContaining('Refused') }] })
})

describe('the drift test (6.1)', () => {
  test('the Codex namespace and the Claude MCP server render one teamToolTable identically', async () => {
    const mailbox = {} as Parameters<typeof teamToolTable>[0]
    // Every optional service present, so every tool family is in the table
    // and compared (N1): an absent one registers no tools in BOTH renderings,
    // and the drift test would pass over a whole missing family. The stubs
    // are never called — registration reads schemas and descriptions only,
    // and every schema must survive z.toJSONSchema (Codex thread/start).
    const services = {
      tasks: {}, results: {}, strategies: {}, plans: {}, validation: {},
      decisions: {}, impact: {}, releases: {}, management: {}, metrics: {}, reports: {},
    } as MailboxServerServices
    const realTable = teamToolTable(mailbox, 'chat-codex-test', services)
    expect(realTable.length).toBeGreaterThan(0)
    // One source of names for both runtimes.
    const names = realTable.map(tool => tool.name).sort()
    // The namespace the production driver registers at thread/start.
    const harness = startHarness(new Script().boot(), { teamTools: realTable })
    let dynamicTools: Array<{ type: string; name: string; tools: Array<{ name: string; description: string; inputSchema: { properties?: Record<string, unknown> } }> }>
    try {
      harness.driver.start()
      await until(() => sentRequest(harness, 'thread/start') !== undefined)
      dynamicTools = sentRequest(harness, 'thread/start')!.dynamicTools as typeof dynamicTools
    } finally {
      await harness.cleanup()
    }
    expect(dynamicTools).toHaveLength(1)
    const ns = dynamicTools[0]!.type === 'namespace' ? dynamicTools[0]! : null
    expect(ns).not.toBeNull()
    expect(ns!.name).toBe('kawai-team')
    expect(ns!.tools.map(tool => tool.name).sort()).toEqual(names)
    const server = await createMailboxServer(mailbox, 'chat-codex-test', services)
    // The SDK's tool() keeps the Zod raw shape it was handed verbatim.
    const registered = (server.instance as unknown as { _registeredTools: Record<string, { inputSchema: { shape: Record<string, unknown> } }> })._registeredTools
    expect(Object.keys(registered).sort()).toEqual(names)
    // The two runtimes render schemas differently, so hold the property
    // sets — not the schema documents — to the table.
    for (const tool of realTable) {
      const jsonSchema = z.toJSONSchema(tool.schema) as { properties?: Record<string, unknown> }
      const shapeKeys = Object.keys(tool.schema.shape).sort()
      expect(Object.keys(jsonSchema.properties ?? {}).sort()).toEqual(shapeKeys)
      expect(Object.keys(registered[tool.name]!.inputSchema.shape).sort()).toEqual(shapeKeys)
      const sent = ns!.tools.find(entry => entry.name === tool.name)!
      expect(sent.description).toBe(tool.description)
      // A18 D-T1: the sent schema is Zod's input side; its property set is the table's.
      expect({ tool: tool.name, keys: Object.keys(sent.inputSchema.properties ?? {}).sort() }).toEqual({ tool: tool.name, keys: shapeKeys })
    }
    await (server.instance as unknown as { close: () => Promise<void> }).close()
  })
})
