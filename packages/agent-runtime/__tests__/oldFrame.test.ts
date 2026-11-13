// @reads: packages/agent-runtime/__tests__/fixtures/**
// INV-A2 (task 5.4; Lead disposition a546aea5, fresh assessment FRESH-A)
// through the public factories and the default owned compositions. A
// decided terminal frame's publications and its own observations (handle,
// onTurnResult, turn_completed and error events, the result frame's context
// usage) run before any successor opens. An interrupt reentered from them
// acts on that frame's decided turn only: it returns no-active-turn and
// neither steals a queued successor nor one sent from the same callback. A
// send from them is admitted, holds the admission, and opens after the
// frame. Expected outcomes are the provider's own (each prompt succeeds).
// M-scope (the interrupt guard removed) must fail these assertions.
import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { createClaudeDriver } from '../src/claude/index.js'
import type { ClaudeAgentDriver, InterruptReceipt, TurnHandle, TurnResult } from '../src/contract.js'
import { AgentRuntimeError } from '../src/errors.js'
import type { AgentEvent } from '../src/events.js'
import type { AgentCallbacks } from '../src/options.js'
import { codexDriver, stopDrivers } from './helpers/codexDriverHarness.js'
import { fakeClaudeHome } from './helpers/fakeClaudeHome.js'

const QUEUED = join(import.meta.dir, 'fixtures', 'queuedClaude.ts')
const silent = () => {}
const logger = { debug: silent, info: silent, warn: silent, error: silent }
let claudeDriver: ClaudeAgentDriver | null = null
afterEach(async () => {
  await claudeDriver?.kill().catch(() => {})
  claudeDriver = null
  await stopDrivers()
})

/** The first index of each [type, turnId] in the stream. */
const at = (events: AgentEvent[], type: string, turnId: string) => events.findIndex((e) => e.type === type && (e as { turnId?: string }).turnId === turnId)

function claude(callbacks: (d: () => ClaudeAgentDriver) => Partial<AgentCallbacks>, queued: boolean) {
  const home = fakeClaudeHome()
  if (queued) writeFileSync(join(home.root, 'bin', 'claude'), `#!/bin/sh\nexec '${process.execPath}' '${QUEUED}' "$@" 3>&1 1>/dev/null\n`)
  const events: AgentEvent[] = []
  const d = createClaudeDriver({
    launch: home.launch(queued ? { RELEASE: join(home.root, 'release') } : {}),
    logger,
    permissions: { mode: 'default', enabledTools: [], disallowedTools: [] },
    callbacks: { onEvent: (e) => void events.push(e), ...callbacks(() => d) },
  })
  claudeDriver = d
  return { d, events, release: () => writeFileSync(join(home.root, 'release'), '') }
}

describe('INV-A2: a decided frame\'s publications and observations cannot act on a successor', () => {
  for (const via of ['onContextUsage', 'onTurnResult'] as const) {
    test(`Claude: an interrupt from the first result's ${via} returns no-active-turn and the queued successor still succeeds`, async () => {
      const receipts: Promise<InterruptReceipt>[] = []
      let successor: string | null = null
      let openedDuringObservation = null as boolean | null
      const { d, events, release } = claude((driver) => ({
        [via]: (value: unknown) => {
          if (!value || receipts.length > 0) return
          openedDuringObservation = events.some((e) => e.type === 'turn_started' && e.turnId === successor)
          receipts.push(driver().interrupt())
        },
      }), true)
      await d.start()
      const a = await d.send('A')
      const b = await d.send('B', { continuation: 'queue' })
      successor = b.turnId
      release()
      const [ar, br] = await Promise.all([a.result, b.result])
      expect(receipts).toHaveLength(1)
      expect(await receipts[0]).toEqual({ outcome: 'no-active-turn', processExit: false })
      expect([ar.outcome, br.outcome]).toEqual(['success', 'success'])
      expect(br.usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: null, cacheCreationTokens: null })
      // The successor opens only after the first turn's frame was published.
      expect(at(events, 'turn_completed', a.turnId)).toBeLessThan(at(events, 'turn_started', b.turnId))
      expect(events.filter((e) => e.type === 'turn_interrupted')).toEqual([])
      // No successor is opened while the first frame's own observations run.
      expect(openedDuringObservation).toBe(false)
    })
  }

  test('Claude: a send from a result callback holds the admission and opens after the frame; an interrupt there does not reach it', async () => {
    const reentrant: { handle?: Promise<TurnHandle>; busy?: unknown; receipt?: Promise<InterruptReceipt> } = {}
    const { d, events } = claude((driver) => ({
      onTurnResult: (result: TurnResult) => {
        if (reentrant.handle) return
        reentrant.handle = driver().send('hello')
        reentrant.handle.catch(() => {})
        driver().send('second').catch((error: unknown) => (reentrant.busy = error))
        reentrant.receipt = driver().interrupt()
        void result
      },
    }), false)
    await d.start()
    const a = await d.send('first')
    expect((await a.result).outcome).toBe('success')
    const c = await reentrant.handle!
    expect((await c.result).outcome).toBe('success')
    expect(await reentrant.receipt).toEqual({ outcome: 'no-active-turn', processExit: false })
    expect(reentrant.busy).toBeInstanceOf(AgentRuntimeError)
    expect((reentrant.busy as AgentRuntimeError).category).toBe('busy')
    expect(at(events, 'turn_completed', a.turnId)).toBeLessThan(at(events, 'turn_started', c.turnId))
  })

  test('Codex: a send from a failed turn\'s result callback opens after the frame; an interrupt from its error event does not reach it', async () => {
    const reentrant: { handle?: Promise<TurnHandle>; receipt?: Promise<InterruptReceipt> } = {}
    let failedTurn: string | null = null
    const h = codexDriver({
      callbacks: {
        onTurnResult: (result) => {
          if (result.outcome !== 'failed' || reentrant.handle) return
          failedTurn = result.turnId
          reentrant.handle = h.driver.send('C')
          reentrant.handle.catch(() => {})
        },
        onEvent: (event) => {
          if (event.type === 'error' && failedTurn && !reentrant.receipt) reentrant.receipt = h.driver.interrupt()
        },
      },
    })
    await h.driver.start()
    const a = await h.driver.send(`/script ${JSON.stringify({ notes: [], end: 'failed:"other"' })}`)
    expect((await a.result).outcome).toBe('failed')
    const c = await reentrant.handle!
    expect((await c.result).outcome).toBe('success')
    expect(await reentrant.receipt).toEqual({ outcome: 'no-active-turn', processExit: false })
    const errorAt = h.events.findIndex((e) => e.type === 'error')
    expect(errorAt).toBeGreaterThan(-1)
    expect(errorAt).toBeLessThan(at(h.events, 'turn_started', c.turnId))
  })
})
