// Lifecycle table L on the production driver (Kawai's Codex adapter over the
// package core and the replaying fake as a real child, task-5906f19c): L1/L4
// and L5. The class-level L cases and P3's seeded race model moved to the
// package with the discovery itself (task-ce05430a R2):
// packages/agent-runtime/__tests__/codexSkillDiscovery.test.ts.
import { afterEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import type { ChatCommandState } from '../../shared/chat'
import { createCodexDriverWith } from '../../../packages/agent-runtime/src/codex/driver'
import { Script, startHarness, tempDirs, THREAD_ID, until, type Harness } from './codexDriverHarness'

const response = (cwd: string, name = 'explore') => ({ data: [{ cwd, errors: [], skills: [
  { name, description: 'Explore code', path: `/skills/${name}/SKILL.md`, scope: 'repo', enabled: true },
] }] })
let harness: Harness | null = null
afterEach(async () => {
  const done = harness?.cleanup()
  harness = null
  await done
})
// @covers: codex-chat-sessions › Codex skills populate the chat command list › Opening a Codex chat discovers skills
test('L1/L4: production driver starts discovery after boot, before a model turn, and refreshes on resume', async () => {
  for (const resume of [false, true]) {
    // Kawai's production Codex composition over the replaying fake as a real
    // default-owned child (task-5906f19c); the server's skills/changed waits
    // at a gate so the first ready is observed before the refresh.
    const dirs = tempDirs()
    const other = path.join(dirs.dir, 'other')
    const changed = path.join(dirs.dir, 'skills-changed')
    const states: ChatCommandState[] = []
    const script = new Script().boot(resume ? 'thread/resume' : 'thread/start').request('skills/list', response(dirs.project))
    script.lines.push({ fake: 'gate', path: changed })
    script.notify('skills/changed', {}).request('skills/list', response(dirs.project)).request('skills/list', response(other))
    const run = startHarness(script, { onCommandState: state => states.push(state), ...(resume ? { resumeThreadId: THREAD_ID } : {}) }, dirs)
    try {
      run.driver.start()
      await until(() => run.driver.getCommandState().status === 'ready')
      expect(run.sent.flatMap(message => (message.method && message.method !== 'initialize' ? [message.method] : []))).toEqual([resume ? 'thread/resume' : 'thread/start', 'skills/list'])
      expect(run.events).toEqual([])
      expect(states.map(state => state.status)).toEqual(['loading', 'ready'])
      fs.writeFileSync(changed, '')
      await until(() => states.length === 4)
      expect(states.map(state => state.status)).toEqual(['loading', 'ready', 'loading', 'ready'])
      run.driver.setProjectPath(other)
      expect(run.driver.getCommandState().status).toBe('loading')
      await until(() => run.driver.getCommandState().status === 'ready')
      expect(run.sent.filter(message => message.method === 'skills/list').map(message => message.params)).toEqual([
        { cwds: [dirs.project], forceReload: false }, { cwds: [dirs.project], forceReload: true }, { cwds: [other], forceReload: true },
      ])
      expect(run.sent.some(message => message.method === 'turn/start')).toBe(false)
      run.driver.kill(); expect(run.driver.getCommandState().status).toBe('unavailable')
    } finally {
      await run.cleanup()
    }
  }
})

// @covers: codex-chat-sessions › Codex command discovery refreshes without interrupting chat › Unsupported or failed discovery
test('L5: a real RPC timeout leaves ordinary turns working without awaiting discovery', async () => {
  const dirs = tempDirs()
  const gate = path.join(dirs.dir, 'release')
  const script = new Script().boot().request('skills/list', response(dirs.project)).turn('ct-1').completed('ct-1')
  script.lines.splice(5, 0, { fake: 'gate', path: gate })
  // Only discovery has a short test deadline, through the package's private
  // per-method deadlines (createCodexDriverWith, task-5906f19c A7) under
  // Kawai's own adapter; cold child startup and ordinary turns keep the
  // production 30 000 ms bound under suite contention.
  harness = startHarness(script, {}, dirs, options => createCodexDriverWith(options, { requestTimeoutsMs: { 'skills/list': 500 } }))
  harness.driver.start()
  await until(() => harness!.sent.some(message => message.method === 'skills/list'))
  harness.driver.send('hello')
  await until(() => harness!.sent.some(message => message.method === 'turn/start'))
  expect(harness.driver.getCommandState().status).toBe('loading')
  await until(() => harness!.driver.getCommandState().status === 'unavailable')
  // The held turn/start outlives a 500 ms bound by this finite hold, so only
  // discovery's own deadline can have expired (a global 500 fails the turn).
  await Bun.sleep(600)
  fs.writeFileSync(gate, '')
  await until(() => harness!.events.some(event => event.type === 'turn_completed'))
  expect(harness.events.filter(event => event.type === 'error')).toEqual([])
  expect(harness.driver.getCommandState().status).toBe('unavailable')
})
