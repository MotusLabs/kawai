// GAP9 (task-98101592 A3): a send racing the agent's own turn joins it,
// through Kawai's production composition (createChatDriver ->
// claudeRuntime.ts, which sets joinAgentStartedTurns, -> the accepted
// package) over a scripted CLI. The joined send shows one user message
// under the agent-started turn, opens no second turn and completes with
// that turn's one result.
import { afterEach, describe, expect, test } from 'bun:test'
import { compatibilityAdapter, finishAll, initFrame, settle, until } from './helpers/claudeCompatibilityHarness'

afterEach(async () => {
  await finishAll()
})

const taskNotification = { type: 'system', subtype: 'task_notification', task_id: 'btask_1', tool_use_id: 'call_task_1', status: 'completed', summary: 'Background command "btask_1" completed (exit code 0)' }
const text = (id: string, value: string) => ({ type: 'assistant', message: { id, role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: value }] } })
const success = (uuids: string[]) => ({
  type: 'result', subtype: 'success', is_error: false, result: 'joined answer', num_turns: 1, total_cost_usd: 0, duration_ms: 1, duration_api_ms: 1, usage: { input_tokens: 4, output_tokens: 1 },
  ...(uuids.length ? { user_message_uuid: uuids.at(-1), user_message_uuids: uuids } : {}),
})

describe('Claude agent-started turns join a racing send through the production composition (GAP9)', () => {
  for (const named of [false, true]) {
    // The parent's original oracle: a send racing the self-start joins the open turn (its result UUID-less, then naming the prompt).
    test(`a send racing the self-start joins the open turn (result ${named ? 'names the prompt' : 'names none'})`, async () => {
      const h = compatibilityAdapter()
      h.driver.start()
      await until(() => h.scripts.length === 1)
      h.scripts[0]!.push(taskNotification)
      h.scripts[0]!.push(initFrame())
      await until(() => h.events.some((e) => e.type === 'turn_started'))
      const started = h.events.filter((e) => e.type === 'turn_started')
      expect(started).toHaveLength(1)
      const turnId = (started[0] as { turnId: string }).turnId
      h.driver.send('while you are at it')
      await until(() => h.scripts[0]!.prompts.length === 1)
      const uuid = String(h.scripts[0]!.prompts[0]!.uuid)
      h.scripts[0]!.push(text('msg_j', 'joined answer'))
      h.scripts[0]!.push(success(named ? [uuid] : []))
      await until(() => h.events.some((e) => e.type === 'turn_completed'))
      await settle()
      const firstTwo = h.events.slice(0, 2).map((event) => ({ type: event.type, turnId: (event as { turnId: string }).turnId }))
      expect(firstTwo).toEqual([{ type: 'turn_started', turnId }, { type: 'user_message', turnId }])
      expect(h.events.filter((e) => e.type === 'turn_started')).toHaveLength(1)
      expect(h.events.filter((e) => e.type === 'user_message').map((e) => [(e as { turnId: string }).turnId, (e as { messageUuid: string }).messageUuid])).toEqual([[turnId, uuid]])
      expect(h.events.filter((e) => e.type === 'turn_completed').map((e) => (e as { turnId: string }).turnId)).toEqual([turnId])
      expect(h.statuses.at(-1)).toBe('waiting')
    })
  }
})
