// decision_ask and decision_record on the kawai-team server (plan-supervision
// 6.1, design D16): called through the registered MCP handlers, identity
// bound to the session, D4's and D5's refusals reaching the agent.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import { DECISION_FORBIDDEN_TOOL_NAMES, DECISION_TOOL_NAMES } from '../plans/decisions/decisionTools'
import { NEEDS_PLAN_WORK } from '../plans/decisions/decisionScope'
import { createMailboxServer, TEAM_ALLOWED_TOOLS } from '../team/mailboxTools'
import { TEAM_MCP_SERVER } from '../team/teamPrompt'
import { createPlanWorld, type PlanWorld } from './planHarness'
import { createDecisionBench, type DecisionBench } from './decisionHarness'

type ToolResult = { isError?: boolean; content: Array<{ type: 'text'; text: string }> }
type Registered = Record<string, { handler: (args: unknown, extra: unknown) => Promise<ToolResult> }>

let world: PlanWorld
let bench: DecisionBench
const servers: Array<{ instance: { close: () => Promise<void> } }> = []

beforeAll(async () => { world = await createPlanWorld('kawai-decision-tools-') })
afterAll(() => fs.rmSync(world.root, { recursive: true, force: true }))
beforeEach(() => {
  bench?.db.close()
  bench = createDecisionBench(world)
})
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.instance.close()))
})

const count = (table: string) => (bench.db.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n

/** The session's registered tools on its real team server. */
async function toolsOf(sessionId: string): Promise<Registered> {
  const server = await createMailboxServer(bench.mailbox, sessionId, { decisions: bench.decide })
  servers.push(server as unknown as { instance: { close: () => Promise<void> } })
  return (server.instance as unknown as { _registeredTools: Registered })._registeredTools
}

async function call(sessionId: string, name: string, args: unknown): Promise<{ error: string | null; value: Record<string, unknown> | null }> {
  const result = await (await toolsOf(sessionId))[name]!.handler(args, {})
  const text = result.content[0]!.text
  return result.isError ? { error: text, value: null } : { error: null, value: JSON.parse(text) as Record<string, unknown> }
}

describe('the decision tool surface (D16)', () => {
  test('exactly decision_ask and decision_record are registered and allowed without cards; no answer, override, retry, or stop tool', async () => {
    const names = Object.keys(await toolsOf('dev'))
    expect(names.filter(name => name.startsWith('decision_')).sort()).toEqual([...DECISION_TOOL_NAMES].sort())
    for (const name of DECISION_TOOL_NAMES) expect(TEAM_ALLOWED_TOOLS).toContain(`mcp__${TEAM_MCP_SERVER}__${name}`)
    for (const name of DECISION_FORBIDDEN_TOOL_NAMES) {
      expect(names).not.toContain(name)
      expect(TEAM_ALLOWED_TOOLS).not.toContain(`mcp__${TEAM_MCP_SERVER}__${name}`)
    }
  })

  test('a server without the decision service registers neither tool', async () => {
    const server = await createMailboxServer(bench.mailbox, 'dev')
    servers.push(server as unknown as { instance: { close: () => Promise<void> } })
    const names = Object.keys((server.instance as unknown as { _registeredTools: Registered })._registeredTools)
    expect(names.filter(name => name.startsWith('decision_'))).toEqual([])
  })
})

describe('decision_ask through the server (D4)', () => {
  test("a plan task's session asks; the card goes to the Lead group with the guidance", async () => {
    const planId = await bench.approvedPlan()
    const taskId = await bench.onTask('dev', planId, 'ui')
    const { error, value } = await call('dev', 'decision_ask', { question: 'Which store?', options: ['sqlite', 'files'] })
    expect(error).toBeNull()
    expect(value).toMatchObject({ addressed_to: 'lead', addressed_group: 'leads' })
    expect(String(value!.guidance)).toContain('do not wait in a loop')
    const card = bench.decisions.card(world.team.teamId, String(value!.card_id))
    expect(card).toMatchObject({ planId, taskId, change: 'ui', askedBy: { session: 'dev' } })
  })

  test("identity is the calling session: an asker id in the arguments is stripped", async () => {
    const planId = await bench.approvedPlan()
    await bench.onTask('dev', planId, 'ui')
    const { value } = await call('dev', 'decision_ask', { question: 'q', session_id: 'lead', sessionId: 'lead', asked_by: 'lead' })
    expect(bench.decisions.card(world.team.teamId, String(value!.card_id))!.askedBy.session).toBe('dev')
  })

  test("a session outside plan work gets D4's refusal and nothing is written", async () => {
    await bench.approvedPlan()
    const { error } = await call('dev', 'decision_ask', { question: 'q' })
    expect(error).toBe(NEEDS_PLAN_WORK)
    expect(count('plan_decision_cards')).toBe(0)
  })
})

describe('decision_record through the server (D5)', () => {
  test('the Lead answers a card addressed to its group; the answer mail reaches the asker', async () => {
    const planId = await bench.approvedPlan()
    await bench.onTask('dev', planId, 'ui')
    const asked = await call('dev', 'decision_ask', { question: 'Which store?', options: ['sqlite', 'files'] })
    const { error, value } = await call('lead', 'decision_record', { plan_id: planId, card_id: asked.value!.card_id, option_index: 1, rationale: 'one file' })
    expect(error).toBeNull()
    expect(value).toMatchObject({ card_id: asked.value!.card_id, kind: 'answer', choice: 'sqlite', replayed: false })
    expect(typeof value!.message_id).toBe('string')
  })

  test("a session outside the addressed group is refused naming the group, and nothing is written", async () => {
    const planId = await bench.approvedPlan()
    await bench.onTask('dev', planId, 'ui')
    const asked = await call('dev', 'decision_ask', { question: 'q', options: ['a', 'b'] })
    const { error } = await call('dev', 'decision_record', { plan_id: planId, card_id: asked.value!.card_id, option_index: 1, rationale: 'r' })
    expect(error).toContain('is addressed to group leads')
    expect(count('plan_decisions')).toBe(0)
  })

  test("an own call outside the Lead role is refused with D5's message", async () => {
    const planId = await bench.approvedPlan()
    await bench.onTask('dev', planId, 'ui')
    const { error } = await call('dev', 'decision_record', { plan_id: planId, question: 'q', choice: 'x', rationale: 'r' })
    expect(error).toContain("An own call needs the plan's Lead role (leads)")
    expect(count('plan_decisions')).toBe(0)
  })

  test("a card addressed to the owner is refused for every agent", async () => {
    const planId = await bench.approvedPlan()
    const asked = await call('lead', 'decision_ask', { question: 'q', plan_id: planId })
    const { error } = await call('lead', 'decision_record', { plan_id: planId, card_id: asked.value!.card_id, choice: 'x', rationale: 'r' })
    expect(error).toContain('only the owner answers it')
  })
})
