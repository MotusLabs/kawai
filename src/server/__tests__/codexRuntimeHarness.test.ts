// The production-path Codex harness's own teardown (task-5906f19c A3):
// startRuntimeHarness's cleanup kills the adapter, joins everything it owns
// through settled(), and only then removes the temp root (the project, the
// Codex home, the transcript the fake replays). A host promise the adapter
// owns holds the removal; every cleanup call is the same join; a raw failure
// reaches the caller once, as the original object among the reported causes.
// The fake is a real default-owned child over stdio; nothing here claims a
// native exit beyond the package wire's own lifecycle frame.
import fs from 'node:fs'
import { expect, test } from 'bun:test'
import { Script, startRuntimeHarness, until } from './codexDriverHarness'

/** Every object a settled() failure carries: itself, its causes, an AggregateError's errors. */
function causes(error: unknown): unknown[] {
  if (error === null || typeof error !== 'object') return [error]
  const nested = [...((error as { causes?: unknown[] }).causes ?? []), ...(error instanceof AggregateError ? error.errors : [])]
  return [error, ...nested.flatMap(causes)]
}

const exited = (wire: Array<{ dir: string; raw: string }>) => wire.some(entry => entry.dir === 'lifecycle' && entry.raw.includes('"exit"'))

test('cleanup removes the temp root only after a held host promise settles; overlapping cleanups share one join', async () => {
  let release!: () => void
  const held = new Promise<void>(resolve => (release = resolve))
  let reported = 0
  const harness = startRuntimeHarness(new Script().boot(), { onTranscriptPath: () => { reported += 1; return held as unknown as void } })
  try {
    harness.driver.start()
    await until(() => reported === 1)
    const order: string[] = []
    const first = harness.cleanup()
    const second = harness.cleanup()
    expect(second).toBe(first)
    const cleaned = first.then(() => void order.push('cleaned'))
    // The kill ends the process; the held promise still holds the join.
    await until(() => exited(harness.wire))
    await new Promise(resolve => setTimeout(resolve, 100))
    expect({ order, rootKept: fs.existsSync(harness.dir) }).toEqual({ order: [], rootKept: true })
    order.push('release')
    release()
    await cleaned
    expect(order).toEqual(['release', 'cleaned'])
    expect(fs.existsSync(harness.dir)).toBe(false)
  } finally {
    // Failure-safe: a failed assertion above still releases the held work
    // and joins the same cleanup before the test ends.
    release()
    await harness.cleanup()
  }
})

test('a raw host failure rejects cleanup once as the original object, after the join removed the root', async () => {
  const boom = new Error('path store down')
  let reported = 0
  const harness = startRuntimeHarness(new Script().boot(), { onTranscriptPath: () => { reported += 1; return Promise.reject(boom) as unknown as void } })
  harness.driver.start()
  await until(() => reported === 1)
  const first = harness.cleanup()
  expect(harness.cleanup()).toBe(first)
  const error = await first.then(() => null, (caught: unknown) => caught)
  expect(causes(error).filter(cause => cause === boom)).toHaveLength(1)
  expect(exited(harness.wire)).toBe(true)
  expect(fs.existsSync(harness.dir)).toBe(false)
  // The same join answers a later call the same way; nothing is reported twice.
  expect(await harness.cleanup().then(() => null, (caught: unknown) => caught)).toBe(error)
})
