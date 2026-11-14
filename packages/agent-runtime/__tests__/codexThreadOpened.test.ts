// @reads: packages/agent-runtime/__tests__/fixtures/**
// Codex onThreadOpened (task-7811b455 R3, owner decision 42666cd1; design §2's
// third exception) through the public factory and the owned fake app-server.
// Expected values come from the fixture's own records: the thread it saved
// (threads/<id>.json with its rollout path), its pids and what it received,
// never from the driver.
// - Each actual generation's successful thread/start or thread/resume reports
//   once: its generation, the thread id, the reply's path or null, and whether
//   it resumed; after the checkpoint settled and before start() resolves.
// - A resumed id is still already saved: a same, moved or missing path
//   persists no checkpoint.
// - A refused, wrong-target or stopped opening reports nothing; a held
//   checkpoint holds the report and a refused one suppresses it.
// - The observer is noncritical: a throw or a rejected promise changes nothing
//   and is the stop's raw cause; a kill from inside it is refused instead of
//   joining itself, and no account read follows.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { AgentRuntimeError } from '../src/errors.js'
import type { CodexThreadOpened } from '../src/options.js'
import { codexDriver, codexRoot, deferred, pids, refusal, sent, stopDrivers, waitFor, type CodexRoot, type HarnessOptions } from './helpers/codexDriverHarness.js'

afterEach(stopDrivers)

/** The rollout paths the fake saved for a thread (one per opening that wrote one). */
function savedPath(root: CodexRoot, threadId: string): string {
  const file = readdirSync(join(root.home, 'threads')).find((name) => name.startsWith(threadId))
  return (JSON.parse(readFileSync(join(root.home, 'threads', file!), 'utf8')) as { path: string }).path
}

function observed(options: HarnessOptions = {}, observer?: (info: CodexThreadOpened) => unknown) {
  const opened: Array<CodexThreadOpened & { beforeStart: boolean; checkpoints: number }> = []
  const state = { started: false }
  const h = codexDriver({
    ...options,
    onThreadOpened: (info) => {
      opened.push({ ...info, beforeStart: !state.started, checkpoints: h.checkpoints.length })
      return observer?.(info) as void
    },
  })
  const start = () => h.driver.start().then(() => void (state.started = true))
  return { ...h, opened, start }
}

/** A thread opened and saved by a first driver, its home kept for a resume. */
async function savedThread(): Promise<{ root: CodexRoot; threadId: string; path: string }> {
  const first = codexDriver()
  await first.driver.start()
  const threadId = first.checkpoints[0]!.runtimeSessionId
  await first.driver.kill()
  return { root: first.root, threadId, path: savedPath(first.root, threadId) }
}

describe('Codex onThreadOpened through the public factory and owned stdio', () => {
  // @covers: agent-runtime › Host-compatibility inputs and observations are optional › Codex thread opening reports a moved transcript
  test('a fresh thread reports once after its checkpoint and before start resolves, even for repeated starts', async () => {
    const h = observed()
    await Promise.all([h.start(), h.start()])
    await h.start()
    const threadId = h.checkpoints[0]!.runtimeSessionId
    expect(h.opened).toEqual([{ generation: 1, threadId, transcriptPath: savedPath(h.root, threadId), resumed: false, beforeStart: true, checkpoints: 1 }])
    expect(h.checkpoints).toHaveLength(1)
  })

  // @covers: agent-runtime › Host-compatibility inputs and observations are optional › Codex thread opening reports a moved transcript
  test('a resume reports the reply’s same, moved or missing path and persists no checkpoint', async () => {
    for (const mode of ['same', 'moved', 'nopath'] as const) {
      const saved = await savedThread()
      const h = observed({ root: saved.root, resume: { runtime: 'codex', runtimeSessionId: saved.threadId }, ...(mode === 'same' ? {} : { env: { FAKE_CODEX_RESUME: mode } }) })
      await h.start()
      const path = mode === 'nopath' ? null : savedPath(saved.root, saved.threadId)
      expect([mode, h.opened]).toEqual([mode, [{ generation: 1, threadId: saved.threadId, transcriptPath: path, resumed: true, beforeStart: true, checkpoints: 0 }]])
      if (mode === 'same') expect(path).toBe(saved.path)
      if (mode === 'moved') expect([path === saved.path, path!.includes(`${saved.threadId}-moved-`)]).toEqual([false, true])
      expect(h.checkpoints).toEqual([])
    }
  })

  test('a respawn after an unexpected exit reports its own generation as resumed', async () => {
    const h = observed()
    await h.start()
    const threadId = h.checkpoints[0]!.runtimeSessionId
    const turn = await h.driver.send('/exit 3')
    await turn.result
    await h.start()
    expect(h.opened.map((o) => [o.generation, o.threadId, o.resumed])).toEqual([[1, threadId, false], [2, threadId, true]])
    expect(pids(h.root.home)).toHaveLength(2)
    expect(h.checkpoints).toHaveLength(1)
  })

  test('a refused or wrong-target resume reports nothing', async () => {
    for (const mode of ['refuse', 'substitute'] as const) {
      const saved = await savedThread()
      const h = observed({ root: saved.root, resume: { runtime: 'codex', runtimeSessionId: saved.threadId }, env: { FAKE_CODEX_RESUME: mode } })
      const error = await refusal(h.driver.start())
      expect([mode, error.category, h.opened]).toEqual([mode, mode === 'refuse' ? 'resume' : 'resume', []])
    }
  })

  test('a held checkpoint holds the report; a refused one suppresses it', async () => {
    const held = deferred()
    const h = observed({ callbacks: { onCheckpoint: () => held.promise } })
    const starting = h.start()
    await waitFor(() => h.checkpoints.length === 1)
    expect([h.checkpoints.length, h.opened.length]).toEqual([1, 0])
    held.resolve()
    await starting
    expect(h.opened.map((o) => o.checkpoints)).toEqual([1])

    const refused = observed({ callbacks: { onCheckpoint: () => Promise.reject(new Error('store down')) } })
    const error = await refusal(refused.driver.start())
    expect([error.category, refused.opened]).toEqual(['checkpoint', []])
  })

  test('a stop while the checkpoint is held reports nothing', async () => {
    const held = deferred()
    const h = observed({ callbacks: { onCheckpoint: () => held.promise } })
    const starting = refusal(h.driver.start())
    await waitFor(() => h.checkpoints.length === 1)
    const killing = h.driver.kill()
    held.resolve()
    expect((await starting).category).toBe('stopped')
    await killing
    expect(h.opened).toEqual([])
  })

  test('a throwing or rejecting observer changes nothing and is the stop’s raw cause', async () => {
    for (const kind of ['throw', 'reject'] as const) {
      const boom = new Error(`observer ${kind}`)
      const h = observed({}, () => {
        if (kind === 'throw') throw boom
        return Promise.reject(boom)
      })
      await h.start()
      const result = (await (await h.driver.send('one')).result) as { outcome: string }
      expect([kind, result.outcome, h.opened.length]).toEqual([kind, 'success', 1])
      const stop = await h.driver.shutdown().then(() => 'resolved', (error: unknown) => error)
      expect(stop).toBeInstanceOf(AgentRuntimeError)
      expect([(stop as AgentRuntimeError).category, (stop as AgentRuntimeError).causes]).toEqual(['stop', [boom]])
    }
  })

  test('a kill from inside the observer is refused instead of joining itself; no account read follows', async () => {
    const reentry: { kill?: Promise<unknown> } = {}
    const h = observed({}, () => {
      reentry.kill = h.driver.kill()
    })
    const started = await refusal(h.driver.start())
    expect(started.category).toBe('stopped')
    expect((await refusal(reentry.kill!)).category).toBe('internal')
    expect((await h.driver.kill()).mode).toBe('kill')
    expect(sent(h.root, 'account/rateLimits/read')).toEqual([])
    expect(h.opened).toHaveLength(1)
  })

  test('a supplied non-function refuses construction; omitted, nothing changes', async () => {
    let error: unknown
    try {
      codexDriver({ onThreadOpened: 'yes' as never })
    } catch (caught) {
      error = caught
    }
    expect([(error as AgentRuntimeError).category, (error as Error).message]).toEqual(['configuration', 'onThreadOpened must be a function'])
    const plain = codexDriver({ root: codexRoot() })
    await plain.driver.start()
    expect(plain.checkpoints).toHaveLength(1)
  })
})
