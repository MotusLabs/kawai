// The contextual send path (plan-workspace §4, CP2): the driver's
// mint → record → open → emit → enqueue order on the shared fake-query
// harness, and the I1 failure rule — a refused record opens no turn, emits
// no event, and enqueues nothing.
import { describe, expect, test } from 'bun:test'
import { workspaceContextBlock, type WorkspaceMessageContext } from '../../shared/planWorkspace'
import type { WorkspaceContextOutcome } from '../plans/workspace/workspaceContext'
import { createHarness, flush, typesOf } from './fixtures/chatDriverHarness'

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
})
