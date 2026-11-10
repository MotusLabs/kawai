// The public Codex driver over the owned fake app-server (task 4.2, first
// path): createCodexDriver with the default transport, an isolated root and
// the fixture launched as executablePath. Start is explicit and promptless;
// a real turn returns the fake's unique transformed text on the minted
// identity; a second new turn is refused busy; kill settles the open turn as
// stopped only after the process actually exited; and the composed policy is
// on the wire of thread/start and turn/start.
import { afterEach, describe, expect, test } from 'bun:test'
import { alive, codexDriver, pids, refusal, sent, stopDrivers, waitFor } from './helpers/codexDriverHarness.js'

afterEach(stopDrivers)

describe('Codex driver: the first public-factory path', () => {
  // @covers: agent-runtime › Session start and turn results are distinct › Successful turn
  test('L01/L07: the factory is inert; start runs initialize then thread/start with no prompt; one turn returns the unique transformed result on the minted identity', async () => {
    const h = codexDriver()
    expect(h.driver.runtime).toBe('codex')
    expect(h.driver.state).toBe('unstarted')
    expect(h.root.received()).toEqual([])
    await h.driver.start()
    expect(h.driver.state).toBe('idle')
    expect(h.root.received().map((m) => m.method)).toEqual(['initialize', 'thread/start'])
    expect(h.checkpoints).toHaveLength(1)
    const threadId = h.checkpoints[0]!.runtimeSessionId
    expect(h.checkpoints[0]).toEqual({ runtime: 'codex', runtimeSessionId: threadId, transcriptPath: `${h.root.home}/sessions/${threadId}.jsonl` })

    const handle = await h.driver.send('hello')
    const result = await handle.result
    expect(result).toMatchObject({ turnId: handle.turnId, messageUuid: handle.messageUuid, outcome: 'success', finalText: 'codex:olleh|seen=', model: 'fake-model', error: null })
    const [turnStart] = sent(h.root, 'turn/start')
    expect(turnStart!.params).toMatchObject({ threadId, clientUserMessageId: handle.messageUuid, input: [{ type: 'text', text: 'hello', text_elements: [] }] })
    expect(h.types()).toEqual(['turn_started', 'user_message', 'assistant_delta', 'assistant_text', 'turn_completed'])
    expect(h.events.every((event) => !('turnId' in event) || event.turnId === handle.turnId)).toBe(true)
    expect(h.results).toEqual([result])
    expect(h.driver.state).toBe('idle')
  })

  test('L08/L23: a new turn while one is active is refused busy and a queued message unsupported, with nothing sent', async () => {
    const h = codexDriver()
    await h.driver.start()
    const held = await h.driver.send('/hold')
    expect((await refusal(h.driver.send('again'))).category).toBe('busy')
    expect((await refusal(h.driver.send('again', { continuation: 'queue' }))).category).toBe('unsupported')
    await waitFor(() => sent(h.root, 'turn/started').length + sent(h.root, 'turn/start').length > 0)
    await h.driver.interrupt()
    await held.result
    expect(sent(h.root, 'turn/start')).toHaveLength(1)
    expect((await held.result).outcome).toBe('interrupted')
    expect(await waitFor(() => sent(h.root, 'turn/interrupt').length === 1)).toBe(true)
  })

  test('L11/I1: kill settles the open turn as stopped and resolves only after the app-server actually exited', async () => {
    const h = codexDriver()
    await h.driver.start()
    const handle = await h.driver.send('/hold')
    const pid = pids(h.root.home)[0]!
    const receipt = await h.driver.kill()
    expect(alive(pid)).toBe(false)
    expect(receipt.processes).toEqual([expect.objectContaining({ generation: 1, state: 'exited', pid, groupCleared: true })])
    expect(await handle.result).toMatchObject({ outcome: 'interrupted', error: { category: 'stopped' } })
    expect(h.types()).toContain('turn_interrupted')
    expect(h.ends).toEqual([])
    expect(h.driver.state).toBe('stopped')
    expect((await refusal(h.driver.send('late'))).category).toBe('stopped')
  })

  test('P07/M-wire: the supplied policy is on thread/start and every turn/start, with the launch cwd', async () => {
    const h = codexDriver({ permissions: { approvalPolicy: 'never', sandbox: 'read-only', networkAccess: true, writableRoots: [], userInput: 'disabled', elicitation: 'disabled' } })
    await h.driver.start()
    await (await h.driver.send('one')).result
    const [start] = sent(h.root, 'thread/start')
    expect(start!.params).toMatchObject({ cwd: `${h.root.root}/work`, approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'read-only', ephemeral: false })
    const [turn] = sent(h.root, 'turn/start')
    expect(turn!.params).toMatchObject({ approvalPolicy: 'never', approvalsReviewer: 'user', sandboxPolicy: { type: 'readOnly', networkAccess: true } })
  })
})
