// The development fixture's outbound-audit walkthrough through the production
// composition (task 6.1 R10): createChatDriver -> claudeRuntime.ts -> the
// package's hooks -> Kawai's audit sink. The fixture runs the registered
// hooks with inputs that name their event, as the CLI's do. The package reads
// hook_event_name, so each of the two sends reaches the sink as one pre and
// one post call.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { ChatEvent } from '../../shared/chat'
import { fixtureQueryFactory } from '../chat/developmentFixture'
import { createChatDriver } from '../chat/provider/createChatDriver'
import type { ChatAgentDriver } from '../chat/provider/driver'
import type { OutboundAuditSink } from '../outbound/observer'

let driver: (ChatAgentDriver & { settled(): Promise<void> }) | null = null
let priorHold: string | undefined
beforeEach(() => {
  priorHold = process.env.AGENTBOARD_CHAT_FIXTURE_HOLD_MS
  process.env.AGENTBOARD_CHAT_FIXTURE_HOLD_MS = '0'
})
afterEach(async () => {
  driver?.kill()
  await driver?.settled().catch(() => {})
  driver = null
  if (priorHold === undefined) delete process.env.AGENTBOARD_CHAT_FIXTURE_HOLD_MS
  else process.env.AGENTBOARD_CHAT_FIXTURE_HOLD_MS = priorHold
})

test('the fixture audit walkthrough records both sends through the package hooks', async () => {
  const calls: string[] = []
  const sink: OutboundAuditSink = {
    onPreToolUse: (use) => void calls.push(`pre ${use.toolName} ${(use.toolInput as { command: string }).command}`),
    onPostToolUse: (use) => void calls.push(`post ${use.toolName} ${(use.toolInput as { command: string }).command}`),
    onPostToolUseFailure: (use) => void calls.push(`failure ${use.toolName}`),
    onPermissionDenied: (use) => void calls.push(`denied ${use.toolName}`),
    onDeniedCard: (use) => void calls.push(`card ${use.toolName}`),
    onSpawnEnd: () => {},
  }
  const events: ChatEvent[] = []
  driver = createChatDriver({
    runtime: 'claude',
    options: { sessionId: 'chat-fixture-audit', projectPath: '/tmp', queryFactory: fixtureQueryFactory, outbound: sink, onEvent: (event) => void events.push(event), onStatus: () => {} },
  }) as ChatAgentDriver & { settled(): Promise<void> }
  driver.send('audit')
  const deadline = Date.now() + 5_000
  while (!events.some((e) => e.type === 'turn_completed')) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  expect(events.some((e) => e.type === 'assistant_text' && e.text === 'Recorded the audit walkthrough sends.')).toBe(true)
  expect(calls).toEqual([
    'pre Bash git push origin main', 'post Bash git push origin main',
    'pre Bash gh issue create -R other/repo --title Fixture', 'post Bash gh issue create -R other/repo --title Fixture',
  ])
})
