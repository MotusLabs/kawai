// @reads: packages/agent-runtime/__tests__/fixtures/**
// Native Codex skills (task 6.1 R2 A9/V7, delegated from tracker
// task-8a1bc14f) through the public factory and the owned fake app-server
// over stdio. The fake answers skills/list from its home's skills.json, so
// every expected command and typed input is written from the catalog this
// test supplied, and the turn input is what the process received. This is the
// source behavior of Kawai's CodexCommandDiscovery/codexCommands:
// - only enabled, safely named, absolute-path skills of a known scope are
//   listed; reserved names, conflicting paths and malformed rows are dropped;
// - a new turn's input is its text, then each whole `/name` skill once, in
//   first-use order; a steer carries text only;
// - skills/changed rescans with forceReload; no catalog means unavailable and
//   a text-only turn; a stop withdraws the list.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import type { CommandState } from '../src/activity.js'
import { codexDriver, sent, stopDrivers, waitFor, type CodexRoot } from './helpers/codexDriverHarness.js'

afterEach(stopDrivers)

const DEPLOY = { name: 'deploy', path: '/skills/deploy/SKILL.md', description: 'Deploy the service', interface: { shortDescription: 'Deploy it' }, scope: 'repo', enabled: true }
const REVIEW = { name: 'review', path: '/home/u/.codex/skills/review/SKILL.md', description: 'Review a diff', scope: 'user', enabled: true }
const DROPPED = [
  { name: 'off', path: '/skills/off/SKILL.md', description: 'disabled', scope: 'repo', enabled: false },
  { name: 'clear', path: '/skills/clear/SKILL.md', description: 'reserved', scope: 'repo', enabled: true },
  { name: 'rel', path: 'skills/rel/SKILL.md', description: 'relative path', scope: 'repo', enabled: true },
  { name: 'odd', path: '/skills/odd/SKILL.md', description: 'unknown scope', scope: 'elsewhere', enabled: true },
  { name: 'dup', path: '/skills/a/SKILL.md', description: 'first', scope: 'repo', enabled: true },
  { name: 'dup', path: '/skills/b/SKILL.md', description: 'second', scope: 'user', enabled: true },
]
const catalog = (root: CodexRoot, skills: unknown[]) => writeFileSync(join(root.home, 'skills.json'), JSON.stringify({ skills }))
const text = (t: string) => ({ type: 'text', text: t, text_elements: [] })
const skill = (s: { name: string; path: string }) => ({ type: 'skill', name: s.name, path: s.path })
const inputs = (root: CodexRoot) => sent(root, 'turn/start').map((message) => message.params.input)

function recorded() {
  const states: CommandState[] = []
  const h = codexDriver({ callbacks: { onCommandState: (state) => states.push(state) } })
  return { ...h, states }
}

describe('Codex native skills', () => {
  // @covers: agent-runtime › Host-compatibility inputs and observations are optional › Native Codex skill input
  test("the runtime's own catalog lists the valid skills and a new turn carries the typed inputs its text names", async () => {
    const h = recorded()
    catalog(h.root, [DEPLOY, REVIEW, ...DROPPED])
    await h.driver.start()
    await waitFor(() => h.states.at(-1)?.status === 'ready')
    expect(h.states).toEqual([
      { status: 'loading', commands: [] },
      { status: 'ready', commands: [{ name: 'deploy', description: 'Deploy it', aliases: [], source: 'project' }, { name: 'review', description: 'Review a diff', aliases: [], source: 'user' }] },
    ])
    expect(sent(h.root, 'skills/list').map((m) => m.params)).toEqual([{ cwds: [h.root.launch().cwd], forceReload: false }])
    const words = 'please /deploy now /deploy then /review, /review /missing /dup x/deploy'
    await (await h.driver.send(words)).result
    // `/review,` is not a whole name; `x/deploy` does not start with a slash.
    expect(inputs(h.root)).toEqual([[text(words), skill(DEPLOY), skill(REVIEW)]])
  })

  // @covers: agent-runtime › Host-compatibility inputs and observations are optional › Native Codex skill input
  test('skills/changed rescans with forceReload on the same process and the new catalog decides the next turn', async () => {
    const h = recorded()
    catalog(h.root, [DEPLOY, REVIEW])
    await h.driver.start()
    await waitFor(() => h.states.at(-1)?.status === 'ready')
    catalog(h.root, [DEPLOY])
    await (await h.driver.send(`/script ${JSON.stringify({ notes: [{ method: 'skills/changed', params: {} }] })}`)).result
    await waitFor(() => sent(h.root, 'skills/list').length === 2 && h.states.at(-1)?.status === 'ready' && h.states.at(-1)!.commands.length === 1)
    expect(sent(h.root, 'skills/list').map((m) => m.params.forceReload)).toEqual([false, true])
    expect(h.states.map((s) => [s.status, s.commands.map((c) => c.name)])).toEqual([['loading', []], ['ready', ['deploy', 'review']], ['loading', []], ['ready', ['deploy']]])
    await (await h.driver.send('/review /deploy')).result
    expect(inputs(h.root).at(-1)).toEqual([text('/review /deploy'), skill(DEPLOY)])
    await h.driver.kill()
    expect(h.states.at(-1)).toEqual({ status: 'unavailable', commands: [] })
  })

  test('without a catalog the list is unavailable and a turn carries its text only', async () => {
    const h = recorded()
    await h.driver.start()
    await waitFor(() => h.states.at(-1)?.status === 'unavailable')
    await (await h.driver.send('/deploy')).result
    expect(h.states).toEqual([{ status: 'loading', commands: [] }, { status: 'unavailable', commands: [] }])
    expect(inputs(h.root)).toEqual([[text('/deploy')]])
  })

  test('a steer carries its text only', async () => {
    const h = recorded()
    catalog(h.root, [DEPLOY])
    await h.driver.start()
    await waitFor(() => h.states.at(-1)?.status === 'ready')
    const opening = await h.driver.send('/hold')
    await waitFor(() => sent(h.root, 'turn/start').length === 1)
    const steered = await h.driver.send('/deploy', { continuation: 'steer' })
    await Promise.all([opening.result, steered.result])
    expect(sent(h.root, 'turn/steer').map((m) => m.params.input)).toEqual([[text('/deploy')]])
  })
})
