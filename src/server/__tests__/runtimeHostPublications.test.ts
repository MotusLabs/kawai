// The adapters' own host publications, onEvent and onStatus, are owned work
// (task 6.1 R10, F1/A5; reviewer reproducer findings-ae03e397, SHA 70fb9fbc):
// through the public createChatDriver over a real-SDK fake CLI and actual
// Codex stdio, a promise either callback returns holds the adapter's terminal
// join (kill + settled) until it settles, and its original rejection is what
// settled() reports, once. A synchronous throw is reported once as well: an
// onEvent throw inside a package callback goes to the package, whose stop
// carries the raw error as its cause; an onStatus throw from the caller's own
// send() reaches that caller, as in the source driver, and nothing more.
import { expect, test } from 'bun:test'
import { AgentRuntimeError } from '@motuslabs/agent-runtime'
import fs from 'node:fs'
import { createChatDriver } from '../chat/provider/createChatDriver'
import { fakeClaudeHome } from '../../../packages/agent-runtime/__tests__/helpers/fakeClaudeHome'
import { codexRoot } from '../../../packages/agent-runtime/__tests__/helpers/codexDriverHarness'

type Adapter = ReturnType<typeof createChatDriver> & { settled(): Promise<void> }
type Runtime = 'claude' | 'codex'
type Hook = 'onEvent' | 'onStatus'

async function until(probe: () => boolean) {
  const end = Date.now() + 5000
  while (!probe()) {
    if (Date.now() > end) throw new Error('probe setup did not reach its boundary')
    await Bun.sleep(5)
  }
}

/** One public default composition whose `hook` answers once with `answer()`; the rest return nothing. */
function composition(runtime: Runtime, hook: Hook, answer: () => unknown) {
  const home = fakeClaudeHome()
  const launch = home.launch({ ANTHROPIC_API_KEY: 'test-only' })
  const codex = runtime === 'codex' ? codexRoot() : null
  let entered = false
  const once = () => {
    if (entered) return undefined
    entered = true
    return answer()
  }
  const callbacks = {
    onEvent: (event: { type: string }) => (hook === 'onEvent' && event.type === 'turn_started' ? once() : undefined),
    onStatus: () => (hook === 'onStatus' ? once() : undefined),
  }
  const driver = (codex
    ? createChatDriver({ runtime: 'codex', options: {
        sessionId: `publication-${hook}`, projectPath: `${codex.root}/work`, executable: codex.wrapper,
        codexHome: codex.home, network: false, serverEnv: { PATH: process.env.PATH ?? '', HOME: codex.root },
        withheldCredentials: () => new Set(), wire: { record() {} }, ...callbacks,
      } as never })
    : createChatDriver({ runtime: 'claude', options: {
        sessionId: `publication-${hook}`, projectPath: launch.cwd,
        claudeExecutablePath: launch.executablePath ?? `${launch.childEnv.PATH!.split(':')[0]}/claude`,
        profileCatalogHome: launch.homeDir, getProviderEnv: () => ({ ...launch.childEnv }),
        ...callbacks,
      } as never })) as Adapter
  const reached = () => entered && (codex ? codex.received().some((x) => x.method === 'turn/start') : home.received().some((x) => x.type === 'user'))
  const cleanup = () => {
    fs.rmSync(home.root, { recursive: true, force: true })
    if (codex) fs.rmSync(codex.root, { recursive: true, force: true })
  }
  return { driver, reached, entered: () => entered, hang: codex ? '/hold' : 'hang', cleanup }
}

const cases: Array<[Runtime, Hook]> = [['claude', 'onEvent'], ['claude', 'onStatus'], ['codex', 'onEvent'], ['codex', 'onStatus']]

for (const [runtime, hook] of cases) {
  test(`public default ${runtime} composition joins a returned ${hook} promise and reports its raw rejection once`, async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const boom = new Error(`held ${hook} rejection`)
    const callbackJob = gate.then(() => {
      throw boom
    })
    // The test observes its own promise so a lost rejection cannot become a Bun
    // unhandled-rejection failure; the assertion concerns the adapter's owner.
    void callbackJob.catch(() => {})
    const c = composition(runtime, hook, () => callbackJob)
    let joined = false
    let failure: unknown
    let wait: Promise<void> | undefined
    try {
      c.driver.send(c.hang)
      await until(c.reached)
      c.driver.kill()
      wait = c.driver.settled().then(() => void (joined = true), (error) => void ((joined = true), (failure = error)))
      await Bun.sleep(100)
      const terminalBeforeRelease = joined
      release()
      await wait
      expect({ terminalBeforeRelease, rawCauseReported: failure === boom }).toEqual({ terminalBeforeRelease: false, rawCauseReported: true })
      // Reported once: a later join has nothing new to report.
      await c.driver.settled()
    } finally {
      release()
      c.driver.kill()
      await (wait ?? c.driver.settled()).catch(() => {})
      await callbackJob.catch(() => {})
      c.cleanup()
    }
  })
}

for (const [runtime, hook] of cases) {
  test(`public default ${runtime} composition reports a synchronous ${hook} throw exactly once`, async () => {
    const boom = new Error(`sync ${hook} throw`)
    const c = composition(runtime, hook, () => {
      throw boom
    })
    let sendThrew: unknown = null
    try {
      try {
        c.driver.send(c.hang)
      } catch (error) {
        sendThrew = error
      }
      // The status throw reaches send()'s caller; the case does not wait for a native turn.
      await until(hook === 'onEvent' ? c.reached : c.entered)
      c.driver.kill()
      const first = await c.driver.settled().then(() => null, (error: unknown) => error)
      const second = await c.driver.settled().then(() => null, (error: unknown) => error)
      const reports = [sendThrew, first].filter((x) => x !== null).map((x) => (x === boom ? 'raw' : x instanceof AgentRuntimeError && x.causes.length === 1 && x.causes[0] === boom ? `${x.category}:cause` : String(x)))
      expect({ reports, second }).toEqual({ reports: [hook === 'onEvent' ? 'stop:cause' : 'raw'], second: null })
    } finally {
      c.driver.kill()
      await c.driver.settled().catch(() => {})
      c.cleanup()
    }
  })
}
