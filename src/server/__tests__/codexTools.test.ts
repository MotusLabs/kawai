// codex-chat-sessions 6.1 (D6, decision 1 F7, decision 2 M4): the dispatch
// table — a good call on the session's thread (a subagent carrying its
// parent's thread id is served the same way), a child thread refused, a
// foreign namespace, an unknown tool, invalid arguments, null params, a
// thrown handler — every refusal answering `success: false` with text,
// never a JSON-RPC error and never an approval card — and the drift test
// holding the Codex namespace spec and the Claude MCP server to one
// teamToolTable.
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { createMailboxServer, teamToolTable, type MailboxServerServices, type TeamToolSpec } from '../team/mailboxTools'
import { dispatchTeamToolCall, teamNamespaceSpec } from '../chat/codex/codexTools'

const THREAD = 'thread-0001'

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

const call = (params: Record<string, unknown>, thread: string | null = THREAD) =>
  dispatchTeamToolCall(table, thread, params as never)

/** The first content item's text (every answer here is one inputText item). */
const textOf = (item: { type: string; text?: string } | undefined): string =>
  item?.type === 'inputText' ? item.text ?? '' : ''

test('a call on the session\'s own thread runs the handler and answers its JSON', async () => {
  const served = await call({ threadId: THREAD, namespace: 'kawai-team', tool: 'send_message', arguments: { to_kind: 'group', to_id: 'lead', body: 'hi' } })
  expect(served.success).toBe(true)
  expect(JSON.parse(textOf(served.contentItems[0]))).toEqual({ id: 'msg-1', echoed: { to_kind: 'group', to_id: 'lead', body: 'hi' } })
})

test('a child thread is refused; the session\'s own thread is served either way', async () => {
  let ran = 0
  const spy: TeamToolSpec[] = [{ ...table[0]!, handler: input => { ran += 1; return input } }]
  const refused = await dispatchTeamToolCall(spy, THREAD, { threadId: 'thread-child', namespace: 'kawai-team', tool: 'send_message', arguments: {} } as never)
  expect(refused).toMatchObject({ success: false, contentItems: [{ type: 'inputText', text: expect.stringContaining('thread') }] })
  expect(ran).toBe(0)
  // A subagent's call carries its parent's thread id; that one is served as
  // the session (decision 2 M4) — the call holds no other identity.
  const parent = await dispatchTeamToolCall(spy, THREAD, { threadId: THREAD, namespace: 'kawai-team', tool: 'send_message', arguments: { to_kind: 'group', to_id: 'lead', body: 'x' } } as never)
  expect(parent.success).toBe(true)
  expect(ran).toBe(1)
})

test('a foreign namespace, an unknown tool, and a call before the thread are refused', async () => {
  expect(await call({ threadId: THREAD, namespace: 'other-team', tool: 'send_message', arguments: {} }))
    .toMatchObject({ success: false, contentItems: [{ text: expect.stringContaining('kawai-team') }] })
  expect(await call({ threadId: THREAD, namespace: 'kawai-team', tool: 'no_such_tool', arguments: {} }))
    .toMatchObject({ success: false, contentItems: [{ text: expect.stringContaining('no_such_tool') }] })
  expect(await call({ threadId: THREAD, namespace: 'kawai-team', tool: 'send_message', arguments: {} }, null))
    .toMatchObject({ success: false, contentItems: [{ text: expect.stringContaining('no thread yet') }] })
})

test('arguments a schema rejects are refused with the issue named', async () => {
  const refused = await call({ threadId: THREAD, namespace: 'kawai-team', tool: 'send_message', arguments: { to_kind: 'group' } })
  expect(refused.success).toBe(false)
  expect(textOf(refused.contentItems[0])).toContain('Invalid arguments for send_message')
  expect(textOf(refused.contentItems[0])).toContain('to_id')
})

test('a thrown handler answers success:false with the message, not a JSON-RPC error', async () => {
  const failed = await call({ threadId: THREAD, namespace: 'kawai-team', tool: 'boom', arguments: {} })
  expect(failed).toEqual({ success: false, contentItems: [{ type: 'inputText', text: 'handler failed' }] })
  expect(failed).not.toHaveProperty('error')
})

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
    const spec = teamNamespaceSpec(realTable)
    const ns = spec.type === 'namespace' ? spec : null
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
      expect(ns!.tools.find(entry => entry.name === tool.name)!.description).toBe(tool.description)
    }
    await (server.instance as unknown as { close: () => Promise<void> }).close()
  })
})
