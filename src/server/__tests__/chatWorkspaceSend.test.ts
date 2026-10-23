// The contextual send path (plan-workspace §4, CP2): the driver's
// mint → record → open → emit → enqueue order on the shared fake-query
// harness, and the I1 failure rule — a refused record opens no turn, emits
// no event, and enqueues nothing.
import { describe, expect, test } from 'bun:test'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { workspaceContextBlock, type WorkspaceMessageContext } from '../../shared/planWorkspace'
import type { ChatEvent } from '../../shared/chat'
import type { WorkspaceContextOutcome } from '../plans/workspace/workspaceContext'
import { createHarness, flush, result, typesOf } from './fixtures/chatDriverHarness'

const context: WorkspaceMessageContext = {
  teamId: '/repo/example/main',
  planId: 'plan-1',
  planTitle: 'Workspace roadmap',
  version: { kind: 'revision', revision: 2, contentHash: 'a'.repeat(64) },
  executionId: null,
  changeName: 'plan-workspace',
  documentRefId: null,
}

describe('chatWorkspaceSend', () => {
  test('a contextual send records, then opens, emits, and enqueues with the context pasted', async () => {
    const recorded: Array<{ sessionId: string; messageUuid: string; turnId: string; context: WorkspaceMessageContext }> = []
    const harness = createHarness({
      recordWorkspaceContext: input => {
        recorded.push(input)
        return { ok: true, recorded: true }
      },
    })
    expect(harness.driver.sendWorkspaceContext('Ship the checklist', context)).toEqual({ ok: true })
    await flush()
    // One row, keyed by the minted uuid, naming the turn that then opened.
    expect(recorded).toHaveLength(1)
    expect(typesOf(harness.events)).toEqual(['turn_started', 'user_message'])
    expect(recorded[0]!.sessionId).toBe('chat-test')
    expect(recorded[0]!.turnId).toBe((harness.events[0] as { turnId: string }).turnId)
    const userEvent = harness.events[1] as { type: 'user_message'; text: string; messageUuid?: string; workspaceContext?: WorkspaceMessageContext }
    expect(userEvent.text).toBe('Ship the checklist')
    expect(userEvent.messageUuid).toBe(recorded[0]!.messageUuid)
    expect(userEvent.workspaceContext).toEqual(context)
    // The SDK shape (I3): literal typed text, the context pasted beside it
    // under the pre-minted uuid, client_composed never set.
    const prompt = await harness.fakes[0]!.pullPrompt()
    expect(prompt).not.toBeNull()
    expect(prompt!.message.content).toBe('Ship the checklist')
    expect(prompt!.pasted_content).toEqual([workspaceContextBlock(context)])
    expect(String(prompt!.uuid)).toBe(recorded[0]!.messageUuid)
    expect((prompt as { client_composed?: unknown }).client_composed).toBeUndefined()
  })

  test('I1 a refused record opens no turn, emits no event, and enqueues nothing', async () => {
    const refusals: WorkspaceContextOutcome[] = [
      { ok: false, reason: 'conflict', message: 'Message x already carries a different context; the first record stands.' },
      { ok: false, reason: 'invalid', message: 'A context record needs the session id and the message UUID it belongs to.' },
    ]
    for (const refused of refusals) {
      const harness = createHarness({ recordWorkspaceContext: () => refused })
      const outcome = harness.driver.sendWorkspaceContext('Hello there', context)
      expect(outcome.ok).toBe(false)
      await flush()
      expect(harness.events).toEqual([])
      expect(await harness.fakes[0]!.pullPrompt()).toBeNull()
    }
  })

  test('I1 a throwing context store refuses the send and leaves nothing observable', async () => {
    const harness = createHarness({
      recordWorkspaceContext: () => {
        throw new Error('disk gone')
      },
    })
    const outcome = harness.driver.sendWorkspaceContext('Hello there', context)
    expect(outcome.ok).toBe(false)
    await flush()
    expect(harness.events).toEqual([])
    expect(await harness.fakes[0]!.pullPrompt()).toBeNull()
  })

  test('B1 a uuid-preserving echo whose text differs from the submitted text renders one bubble and leaves no text token', async () => {
    const harness = createHarness({ recordWorkspaceContext: () => ({ ok: true, recorded: true }) })
    harness.driver.sendWorkspaceContext('mine', context)
    const fake = harness.fakes[0]!
    const prompt = await fake.pullPrompt()
    const sentUuid = String(prompt!.uuid)
    // The CLI appends each pasted_content entry to the echoed text
    // (sdk.d.ts:6294), so a contextual echo's text differs from what was
    // submitted. The uuid must suppress it regardless.
    fake.push(echoFrame(sentUuid, `mine\n${workspaceContextBlock(context)}`))
    await flush()
    expect(userTexts(harness.events)).toEqual(['mine'])
    // Suppression consumed the typed text's token beside the uuid's: a later
    // foreign frame with the SUBMITTED text is kept, not swallowed.
    fake.push(echoFrame(undefined, 'mine'))
    await flush()
    expect(userTexts(harness.events)).toEqual(['mine', 'mine'])
  })

  test('B1 a foreign same-text user frame after a uuid-suppressed echo is kept', async () => {
    const harness = createHarness({ recordWorkspaceContext: () => ({ ok: true, recorded: true }) })
    harness.driver.sendWorkspaceContext('mine', context)
    const fake = harness.fakes[0]!
    const prompt = await fake.pullPrompt()
    fake.push(echoFrame(String(prompt!.uuid), 'mine'))
    await flush()
    expect(userTexts(harness.events)).toEqual(['mine'])
    fake.push(echoFrame(undefined, 'mine'))
    await flush()
    expect(userTexts(harness.events)).toEqual(['mine', 'mine'])
  })

  test('B1 one uuid match suppresses every text block of the echoed message', async () => {
    const harness = createHarness({ recordWorkspaceContext: () => ({ ok: true, recorded: true }) })
    harness.driver.sendWorkspaceContext('mine', context)
    const fake = harness.fakes[0]!
    const prompt = await fake.pullPrompt()
    // A block-form echo carries the typed text and the appended context as
    // two text blocks of one message sharing the uuid: neither may fall
    // through to the text path (a spurious context-block bubble).
    fake.push({
      type: 'user',
      message: {
        role: 'user',
        content: [
          { type: 'text', text: 'mine' },
          { type: 'text', text: workspaceContextBlock(context) },
        ],
      },
      parent_tool_use_id: null,
      uuid: String(prompt!.uuid),
    } as unknown as SDKMessage)
    await flush()
    expect(userTexts(harness.events)).toEqual(['mine'])
    // Exactly one typed-text token was consumed: a foreign frame is kept.
    fake.push(echoFrame(undefined, 'mine'))
    await flush()
    expect(userTexts(harness.events)).toEqual(['mine', 'mine'])
  })

  test('B2 a contextual send whose result names its uuid ends the turn', async () => {
    const harness = createHarness({ recordWorkspaceContext: () => ({ ok: true, recorded: true }) })
    harness.driver.sendWorkspaceContext('Ship the checklist', context)
    const fake = harness.fakes[0]!
    const prompt = await fake.pullPrompt()
    expect(prompt).not.toBeNull()
    fake.push(result('success', { user_message_uuids: [String(prompt!.uuid)] }))
    await flush()
    expect(typesOf(harness.events)).toEqual(['turn_started', 'user_message', 'turn_completed'])
  })

  test('I2 two messages in one active turn keep distinct contexts', async () => {
    const recorded: Array<{ sessionId: string; messageUuid: string; turnId: string }> = []
    const harness = createHarness({
      recordWorkspaceContext: input => {
        recorded.push(input)
        return { ok: true, recorded: true }
      },
    })
    harness.driver.sendWorkspaceContext('first message', context)
    harness.driver.sendWorkspaceContext('second message', context)
    await flush()
    // One active turn reused: exactly one turn_started for both messages.
    expect(typesOf(harness.events).filter(type => type === 'turn_started')).toHaveLength(1)
    const turnId = (harness.events[0] as { turnId: string }).turnId
    const userEvents = harness.events.filter(e => e.type === 'user_message')
    expect(userEvents).toHaveLength(2)
    const uuids = userEvents.map(e => (e as { messageUuid?: string }).messageUuid ?? '')
    expect(uuids[0]).not.toBe(uuids[1])
    // Both context rows share the active turn's id and keep their own uuid.
    expect(recorded).toHaveLength(2)
    expect(recorded.map(row => row.turnId)).toEqual([turnId, turnId])
    expect(recorded.map(row => row.messageUuid)).toEqual(uuids)
  })

  test('I3 a slash command keeps its literal text and still dispatches with the context pasted', async () => {
    const harness = createHarness({ recordWorkspaceContext: () => ({ ok: true, recorded: true }) })
    harness.driver.sendWorkspaceContext('/context verbose', context)
    const fake = harness.fakes[0]!
    const prompt = await fake.pullPrompt()
    // I3: the typed text is exactly the command; the context rides only
    // pasted_content, and client_composed is never set — the CLI dispatches.
    expect(prompt!.message.content).toBe('/context verbose')
    expect(prompt!.pasted_content).toEqual([workspaceContextBlock(context)])
    expect((prompt as { client_composed?: unknown }).client_composed).toBeUndefined()
    // The command-output turn: the CLI answers on the same turn.
    fake.push({ type: 'system', subtype: 'local_command_output', content: 'Context usage: 12%' } as unknown as SDKMessage)
    await flush()
    const output = harness.events.find(e => e.type === 'command_output')
    expect(output).toMatchObject({ text: 'Context usage: 12%', turnId: (harness.events[0] as { turnId: string }).turnId })
  })

  test('I4 an unscoped send is unchanged', async () => {
    const recorded: unknown[] = []
    const harness = createHarness({
      recordWorkspaceContext: input => {
        recorded.push(input)
        return { ok: true, recorded: true }
      },
    })
    harness.driver.send('Hello there')
    await flush()
    const fake = harness.fakes[0]!
    const prompt = await fake.pullPrompt()
    expect(prompt!.message.content).toBe('Hello there')
    expect((prompt as { pasted_content?: unknown }).pasted_content).toBeUndefined()
    // N1's assertion shape: types, texts, and the fields that must not be
    // there — not a whole-event deep-equal (messageUuid rides every
    // user_message by I4's answer).
    expect(typesOf(harness.events)).toEqual(['turn_started', 'user_message'])
    const event = harness.events[1] as { type: string; text: string; messageUuid?: string; workspaceContext?: unknown }
    expect(event.text).toBe('Hello there')
    expect(typeof event.messageUuid).toBe('string')
    expect('workspaceContext' in event).toBe(false)
    expect(recorded).toEqual([])
  })

  test('LC-D3 a UUID-preserving echo renders one bubble', async () => {
    const harness = createHarness({ recordWorkspaceContext: () => ({ ok: true, recorded: true }) })
    harness.driver.sendWorkspaceContext('ship it', context)
    const fake = harness.fakes[0]!
    const prompt = await fake.pullPrompt()
    fake.push(echoFrame(String(prompt!.uuid), `ship it\n${workspaceContextBlock(context)}`))
    await flush()
    expect(typesOf(harness.events).filter(type => type === 'user_message')).toHaveLength(1)
  })

  test("LC-D3 an echo without the UUID takes today's text path", async () => {
    const harness = createHarness({ recordWorkspaceContext: () => ({ ok: true, recorded: true }) })
    harness.driver.sendWorkspaceContext('ship it', context)
    const fake = harness.fakes[0]!
    await fake.pullPrompt()
    // Equal text without the uuid: suppressed, exactly today.
    fake.push(echoFrame(undefined, 'ship it'))
    await flush()
    expect(typesOf(harness.events).filter(type => type === 'user_message')).toHaveLength(1)
    // Different text without the uuid: a second bubble, exactly today.
    fake.push(echoFrame(undefined, 'a different message'))
    await flush()
    expect(userTexts(harness.events)).toEqual(['ship it', 'a different message'])
  })

  test('B6 a refused record stores nothing and its retry mints a fresh uuid', async () => {
    const refused: string[] = []
    let accepted: string | null = null
    let calls = 0
    const harness = createHarness({
      recordWorkspaceContext: input => {
        calls += 1
        if (calls === 1) {
          refused.push(input.messageUuid)
          return { ok: false, reason: 'conflict', message: 'Message x already carries a different context; the first record stands.' }
        }
        accepted = input.messageUuid
        return { ok: true, recorded: true }
      },
    })
    const first = harness.driver.sendWorkspaceContext('retry me', context)
    expect(first.ok).toBe(false)
    await flush()
    expect(harness.events).toEqual([])
    // The retry revalidates and enqueues under a fresh uuid. (One pull only:
    // a timed-out pull orphans the pending iterator and would swallow the
    // next pushed prompt.)
    const second = harness.driver.sendWorkspaceContext('retry me', context)
    expect(second.ok).toBe(true)
    await flush()
    expect(accepted).not.toBeNull()
    expect(accepted).not.toBe(refused[0])
    const prompt = await harness.fakes[0]!.pullPrompt()
    expect(prompt).not.toBeNull()
    expect(String(prompt!.uuid)).toBe(accepted!)
    // The refused mint left no suppression token: a frame carrying it renders.
    harness.fakes[0]!.push(echoFrame(refused[0], 'never submitted'))
    await flush()
    expect(userTexts(harness.events)).toEqual(['retry me', 'never submitted'])
  })
})

/** The live user_message texts, in order. */
function userTexts(events: ChatEvent[]): string[] {
  return events.filter((e) => e.type === 'user_message').map((e) => e.text ?? '')
}

/** An SDK user frame as the CLI streams it back, with an optional uuid. */
function echoFrame(uuid: string | undefined, text: string): SDKMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    ...(uuid !== undefined ? { uuid } : {}),
  } as unknown as SDKMessage
}
