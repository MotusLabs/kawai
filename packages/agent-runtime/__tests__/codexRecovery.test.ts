// @reads: packages/agent-runtime/__tests__/fixtures/**
// Codex recovery and launch authority through the public driver (L02, R10,
// P04, P08): two ACTUAL host processes share only a retained Codex home and
// keep one conversation across an awaited kill and an awaited shutdown; every
// generation spawns with exactly the launch it read (the callback is re-read
// on respawn) and nothing from the host environment; and the supplied policy
// is sent again on resume, over the broader policy the thread was started with.
import { afterEach, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { LaunchConfiguration } from '../src/options.js'
import { BUN, codexDriver, codexRoot, PERMISSIONS, sent, stopDrivers, waitFor } from './helpers/codexDriverHarness.js'

afterEach(stopDrivers)

const HOST = join(import.meta.dir, 'fixtures', 'codexResumeHost.ts')

interface HostReport {
  pid: number
  checkpoints: Array<{ runtime: string; runtimeSessionId: string; transcriptPath?: string }>
  finalText: string | null
  receipt: { mode: string; processes: Array<{ state: string; pid?: number }> }
}

async function host(args: string[]): Promise<HostReport> {
  const child = Bun.spawn([BUN, HOST, ...args], { stdout: 'pipe', stderr: 'pipe', env: { PATH: '/usr/bin:/bin' } })
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
  if (code !== 0) throw new Error(`host exited ${code}: ${stderr}`)
  return JSON.parse(stdout.trim()) as HostReport
}

const envs = (home: string) => readFileSync(join(home, 'envs.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as { pid: number; cwd: string; env: Record<string, string> })

describe('Codex cross-host recovery (L02/R10/I2)', () => {
  // @covers: agent-runtime › Shutdown preserves resumability › Resume after forced process termination
  test('two host processes keep one conversation through an awaited kill and an awaited shutdown of the retained home', async () => {
    const root = codexRoot()
    const marker = `marker-${crypto.randomUUID()}`
    const args = (resume: string, stop: string, text: string) => [root.root, root.home, root.wrapper, resume, stop, text]
    const first = await host(args('fresh', 'kill', marker))
    expect(first.checkpoints).toHaveLength(1)
    const threadId = first.checkpoints[0]!.runtimeSessionId
    expect(first.receipt).toMatchObject({ mode: 'kill', processes: [{ state: 'exited' }] })
    const second = await host(args(threadId, 'shutdown', 'recall'))
    expect(second.pid).not.toBe(first.pid)
    // The second host resumed the same thread: its reply names the first host's unique marker.
    expect(second.finalText).toBe(`codex:llacer|seen=${marker}`)
    expect(second.checkpoints).toEqual([])
    expect(second.receipt).toMatchObject({ mode: 'shutdown', processes: [{ state: 'exited' }] })
    const third = await host(args(threadId, 'kill', 'again'))
    expect(third.finalText).toBe(`codex:niaga|seen=${marker}+recall`)
    expect(sent(root, 'thread/start')).toHaveLength(1)
    expect(sent(root, 'thread/resume').map((m) => m.params.threadId)).toEqual([threadId, threadId])
  })
})

describe('Codex launch authority (P04/P08)', () => {
  test('P04: each generation spawns with exactly the launch the callback returned then, and nothing from the host environment', async () => {
    const root = codexRoot()
    process.env.POISONED_HOST_SECRET = 'leak'
    process.env.OPENAI_API_KEY = 'host-key'
    let generation = 0
    const launches: LaunchConfiguration[] = []
    const h = codexDriver({
      root,
      launch: () => {
        const launch = root.launch({ GENERATION: String(++generation) })
        launches.push(launch)
        return launch
      },
    })
    try {
      await h.driver.start()
      await (await h.driver.send('/exit 4')).result
      await waitFor(() => h.driver.state === 'exited')
      await h.driver.start()
      const spawned = envs(root.home)
      // The /bin/sh test wrapper adds PWD itself before exec; everything else is the launch's map.
      expect(spawned.map(({ env: { PWD: _pwd, ...env } }) => env)).toEqual(launches.map((l) => ({ ...l.childEnv })))
      expect(launches.map((l) => l.childEnv.GENERATION)).toEqual(['1', '2'])
      expect(spawned.map((s) => s.cwd)).toEqual(launches.map((l) => l.cwd))
      expect(JSON.stringify(spawned)).not.toContain('leak')
      expect(JSON.stringify(spawned)).not.toContain('host-key')
    } finally {
      delete process.env.POISONED_HOST_SECRET
      delete process.env.OPENAI_API_KEY
    }
  })

  // @covers: agent-runtime-policy › Permission configuration is session-specific › Different permissions on one provider
  test('P08/P07: a read-only session resuming a thread started with a broader policy sends its own policy on resume and every turn', async () => {
    const root = codexRoot()
    const broad = codexDriver({ root, permissions: { ...PERMISSIONS, sandbox: 'none', networkAccess: true } })
    await broad.driver.start()
    await (await broad.driver.send('wide')).result
    await broad.driver.shutdown()
    const narrow = codexDriver({ root, resume: broad.checkpoints[0]!, permissions: { ...PERMISSIONS, sandbox: 'read-only', approvalPolicy: 'untrusted' } })
    await narrow.driver.start()
    await (await narrow.driver.send('narrow')).result
    expect(sent(root, 'thread/start')[0]!.params).toMatchObject({ sandbox: 'danger-full-access' })
    const [resume] = sent(root, 'thread/resume')
    expect(resume!.params).toMatchObject({ threadId: broad.checkpoints[0]!.runtimeSessionId, sandbox: 'read-only', approvalPolicy: 'untrusted', approvalsReviewer: 'user', excludeTurns: true })
    expect(resume!.params).not.toHaveProperty('dynamicTools')
    expect(sent(root, 'turn/start').map((m) => m.params.sandboxPolicy)).toEqual([{ type: 'dangerFullAccess' }, { type: 'readOnly', networkAccess: false }])
  })
})
