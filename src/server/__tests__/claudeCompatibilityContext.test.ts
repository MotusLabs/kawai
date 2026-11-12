// GAP8 (task-98101592 A2): the respawn context correction through Kawai's
// production composition (createChatDriver -> claudeRuntime.ts -> the
// accepted package) over a scripted CLI. Kawai boots a fresh package driver
// per process, so the adapter's mirror (claudeContextMirror.ts) re-anchors
// the last forwarded reading on the new process's profile window, as a
// correction, at that process's spawn and before its first frame. The old
// process's report threshold is never borrowed. The new process's own
// readings follow unchanged; a clear forgets the reading; with no window to
// re-anchor on nothing is published; a failed attach probe and a throwing
// host callback stay raw owned failures, reported once.
import { afterEach, describe, expect, test } from 'bun:test'
import type { ChatContextUsage } from '../../shared/chat'
import { allCauses, compatibilityAdapter, finishAll, initFrame, settle, until, type ContextProbe, type Harness } from './helpers/claudeCompatibilityHarness'

afterEach(async () => {
  await finishAll()
})

interface Published {
  usage: ChatContextUsage | null
  persist: boolean
  thresholdSource: string | null
}

/** An adapter whose host records every context publication and every spawn, in one ordered log. */
function contextAdapter(window: { env: string | null }, probe?: ContextProbe, onContextUsage?: (usage: ChatContextUsage | null) => void) {
  const published: Published[] = []
  const order: string[] = []
  const h = compatibilityAdapter({
    getProviderEnv: () => (window.env === null ? {} : { CLAUDE_CODE_AUTO_COMPACT_WINDOW: window.env }),
    onContextUsage: (usage: ChatContextUsage | null, meta?: { persist?: boolean; thresholdSource?: string }) => {
      published.push({ usage, persist: meta?.persist === true, thresholdSource: meta?.thresholdSource ?? null })
      order.push(`context:${usage?.usedTokens ?? null}/${usage?.thresholdTokens ?? null}`)
      onContextUsage?.(usage)
    },
    onSpawn: () => void order.push(`spawn:${h.scripts.length}`),
  }, probe)
  return { h, published, order }
}

const assistantUsage = (inputTokens: number, id: string) => ({
  type: 'assistant', message: { id, role: 'assistant', model: 'claude-test', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: inputTokens, output_tokens: 0 } },
})

/** Turn 1 on the first process, a reading of `tokens`, then that process exits. */
async function firstProcess(h: Harness, tokens: number, settledProbe: () => boolean = () => true): Promise<void> {
  h.driver.send('hello')
  await until(() => h.scripts[0]?.prompts.length === 1)
  h.scripts[0]!.push(initFrame())
  h.scripts[0]!.push(assistantUsage(tokens, 'msg_1'))
  await until(settledProbe)
  h.scripts[0]!.exit()
  await until(() => h.driver.isDead)
}

const reading = (p: Published | undefined) => p && { used: p.usage?.usedTokens ?? null, threshold: p.usage?.thresholdTokens ?? null, percentage: p.usage?.percentage ?? null, persist: p.persist, source: p.thresholdSource }

describe('Claude respawn context correction through the production composition (GAP8)', () => {
  // The parent's original oracle: a respawn drops the old process's report threshold when the new probe fails.
  test("a respawn drops the old process's report threshold when the new probe fails", async () => {
    const window = { env: '200000' as string | null }
    const probeFailed = new Error('probe failed')
    const { h, published, order } = contextAdapter(window, (index, call) => (index === 0 && call === 1 ? Promise.resolve({ autoCompactThreshold: 167_000 }) : Promise.reject(probeFailed)))
    await firstProcess(h, 157_900, () => published.at(-1)?.usage?.thresholdTokens === 167_000)
    expect(reading(published.at(-1))).toMatchObject({ used: 157_900, threshold: 167_000 })

    window.env = '100000'
    const before = published.length
    h.driver.send('again')
    await until(() => h.scripts.length === 2)
    // The spawn itself re-anchors the retained reading on the new window, flagged as a correction, before any frame.
    expect(published.slice(before).map(reading)).toEqual([{ used: 157_900, threshold: 100_000, percentage: 157.9, persist: true, source: 'profile-window-fallback' }])
    // After the old process's last reading: the correction, then the new spawn's host callback, then nothing else yet.
    expect(order.slice(order.lastIndexOf('context:157900/167000') + 1)).toEqual(['context:157900/100000', 'spawn:2'])

    // The respawn's attach probe failed, so the profile window keeps ruling.
    await until(() => h.scripts[1]!.prompts.length === 1)
    h.scripts[1]!.push(initFrame())
    h.scripts[1]!.push(assistantUsage(80_000, 'msg_2'))
    await until(() => published.at(-1)?.usage?.usedTokens === 80_000)
    expect(reading(published.at(-1))).toMatchObject({ used: 80_000, threshold: 100_000, percentage: 80, persist: false })
    expect(published.filter((p) => p.usage?.thresholdTokens === 167_000 && p.usage.usedTokens !== 157_900)).toEqual([])

    // The failed probe is the new driver's raw owned failure, reported once by identity.
    const outcome = await h.finish()
    expect([outcome.resolved, allCauses(outcome.error).filter((cause) => cause === probeFailed).length]).toEqual([false, 1])
    await expect(h.driver.settled()).resolves.toBeUndefined()
  })

  test('the first spawn publishes no correction', async () => {
    const { h, published } = contextAdapter({ env: '100000' })
    h.driver.send('hello')
    await until(() => h.scripts[0]?.prompts.length === 1)
    await settle()
    expect(published).toEqual([])
  })

  test('a cleared reading is not resurrected by the respawn', async () => {
    const window = { env: '200000' as string | null }
    const { h, published } = contextAdapter(window)
    h.driver.send('hello')
    await until(() => h.scripts[0]?.prompts.length === 1)
    h.scripts[0]!.push(initFrame())
    h.scripts[0]!.push(assistantUsage(150_000, 'msg_1'))
    await until(() => published.at(-1)?.usage?.usedTokens === 150_000)
    // The conversation reset clears the meter (null, persisted) before the exit.
    h.scripts[0]!.push({ type: 'conversation_reset' })
    await until(() => published.at(-1)?.usage === null)
    expect(published.at(-1)).toEqual({ usage: null, persist: true, thresholdSource: null })
    h.scripts[0]!.exit()
    await until(() => h.driver.isDead)
    window.env = '100000'
    const before = published.length
    h.driver.send('again')
    await until(() => h.scripts.length === 2)
    await settle()
    expect(published.slice(before)).toEqual([])
  })

  test('with no window to re-anchor on, the respawn publishes nothing (the old report threshold is not a window)', async () => {
    const window = { env: null as string | null }
    const { h, published } = contextAdapter(window, (index, call) => (index === 0 && call === 1 ? Promise.resolve({ autoCompactThreshold: 167_000 }) : Promise.resolve(null)))
    await firstProcess(h, 157_900, () => published.at(-1)?.usage?.thresholdTokens === 167_000)
    const before = published.length
    h.driver.send('again')
    await until(() => h.scripts.length === 2)
    await settle()
    expect(published.slice(before)).toEqual([])
  })

  test("a throwing host callback on the correction is reported once by identity; the new process's readings still arrive", async () => {
    const window = { env: '200000' as string | null }
    const boom = new Error('context store refused the correction')
    const { h, published } = contextAdapter(window, undefined, (usage) => {
      if (usage?.thresholdTokens === 100_000 && usage.usedTokens === 150_000) throw boom
    })
    await firstProcess(h, 150_000, () => published.at(-1)?.usage?.usedTokens === 150_000)
    window.env = '100000'
    h.driver.send('again')
    await until(() => h.scripts.length === 2)
    expect(reading(published.at(-1))).toMatchObject({ used: 150_000, threshold: 100_000, persist: true })
    await until(() => h.scripts[1]!.prompts.length === 1)
    h.scripts[1]!.push(initFrame())
    h.scripts[1]!.push(assistantUsage(60_000, 'msg_2'))
    await until(() => published.at(-1)?.usage?.usedTokens === 60_000)
    expect(reading(published.at(-1))).toMatchObject({ used: 60_000, threshold: 100_000, percentage: 60, persist: false })
    const outcome = await h.finish()
    expect([outcome.resolved, allCauses(outcome.error).filter((cause) => cause === boom).length]).toEqual([false, 1])
    await expect(h.driver.settled()).resolves.toBeUndefined()
  })
})
