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
// - R9 SubmitOptions.codexSkills: 'none' sends that submission's text alone
//   (source S1: peer and internal turns never carried skills), read once at
//   send(); omitted or 'auto' is the catalog selection above; any other value,
//   and any value on Claude, refuses the send before anything is sent.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import type { CommandState } from '../src/activity.js'
import { createClaudeDriver } from '../src/claude/index.js'
import type { SubmitOptions } from '../src/contract.js'
import type { AgentEvent } from '../src/events.js'
import { codexDriver, refusal, sent, stopDrivers, waitFor, type CodexRoot, type HarnessOptions } from './helpers/codexDriverHarness.js'
import { fakeClaudeHome } from './helpers/fakeClaudeHome.js'

const claudes: Array<{ kill(): Promise<unknown> }> = []
afterEach(async () => {
  for (const d of claudes.splice(0)) await d.kill().catch(() => {})
  await stopDrivers()
})

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

function recorded(options: HarnessOptions = {}) {
  const states: CommandState[] = []
  const h = codexDriver({ ...options, callbacks: { onCommandState: (state) => states.push(state) } })
  return { ...h, states }
}

/** A driver whose catalog lists DEPLOY and is ready. */
async function ready(options: HarnessOptions = {}) {
  const h = recorded(options)
  catalog(h.root, [DEPLOY])
  await h.driver.start()
  await waitFor(() => h.states.at(-1)?.status === 'ready')
  return h
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

describe('SubmitOptions.codexSkills (R9)', () => {
  // @covers: agent-runtime › Host-compatibility inputs and observations are optional › Codex skill suppression per submission
  test("S1: 'none' sends the text alone, and the following omitted and 'auto' sends carry the catalog's skill again", async () => {
    const h = await ready()
    await (await h.driver.send('peer says /deploy', { codexSkills: 'none' })).result
    await (await h.driver.send('human says /deploy')).result
    await (await h.driver.send('human again /deploy', { codexSkills: 'auto' })).result
    expect(inputs(h.root)).toEqual([[text('peer says /deploy')], [text('human says /deploy'), skill(DEPLOY)], [text('human again /deploy'), skill(DEPLOY)]])
  })

  // @covers: agent-runtime › Host-compatibility inputs and observations are optional › Codex skill suppression per submission
  test('the mode is read once at send(): a caller mutation before admission or inside beforeSubmit changes nothing', async () => {
    // beforeSubmit rewrites the options object of the send being prepared to this value.
    const rewrite = new Map<SubmitOptions, 'auto' | 'none'>()
    const h = await ready({
      beforeSubmit: () => {
        for (const [submit, mode] of rewrite) submit.codexSkills = mode
        rewrite.clear()
        return { accepted: true }
      },
    })
    const early: SubmitOptions = { codexSkills: 'none' }
    const first = h.driver.send('/deploy one', early)
    // Mutated in the same tick, before the admission yield ends.
    early.codexSkills = 'auto'
    await (await first).result
    const quiet: SubmitOptions = { codexSkills: 'none' }
    rewrite.set(quiet, 'auto')
    await (await h.driver.send('/deploy two', quiet)).result
    const loud: SubmitOptions = { codexSkills: 'auto' }
    rewrite.set(loud, 'none')
    await (await h.driver.send('/deploy three', loud)).result
    expect(inputs(h.root)).toEqual([[text('/deploy one')], [text('/deploy two')], [text('/deploy three'), skill(DEPLOY)]])
  })

  test("a steer with 'none' carries its text only, as every steer does", async () => {
    const h = await ready()
    const opening = await h.driver.send('/hold', { codexSkills: 'none' })
    await waitFor(() => sent(h.root, 'turn/start').length === 1)
    const steered = await h.driver.send('/deploy', { continuation: 'steer', codexSkills: 'none' })
    await Promise.all([opening.result, steered.result])
    expect([inputs(h.root), sent(h.root, 'turn/steer').map((m) => m.params.input)]).toEqual([[[text('/hold')]], [[text('/deploy')]]])
  })

  test('a steer asked for after its turn ended opens a new turn that keeps its mode', async () => {
    const h = await ready()
    await (await h.driver.send('first')).result
    await (await h.driver.send('late /deploy', { continuation: 'steer', codexSkills: 'none' })).result
    await (await h.driver.send('late again /deploy', { continuation: 'steer' })).result
    expect([inputs(h.root), sent(h.root, 'turn/steer').length]).toEqual([[[text('first')], [text('late /deploy')], [text('late again /deploy'), skill(DEPLOY)]], 0])
  })

  // @covers: agent-runtime › Host-compatibility inputs and observations are optional › Codex skill suppression per submission
  test('any other value refuses as unsupported before an event or turn/start, and the driver stays usable', async () => {
    const h = await ready()
    const before = h.events.length
    for (const bad of ['', 'None', 'off', null, 0, false, {}, ['none']]) {
      const error = await refusal(h.driver.send('/deploy', { codexSkills: bad as never }))
      expect([error.category, error.message]).toEqual(['unsupported', "codexSkills must be 'auto' or 'none'"])
    }
    expect([h.events.length, sent(h.root, 'turn/start').length]).toEqual([before, 0])
    await (await h.driver.send('/deploy')).result
    expect(inputs(h.root)).toEqual([[text('/deploy'), skill(DEPLOY)]])
  })

  // @covers: agent-runtime › Host-compatibility inputs and observations are optional › Codex skill suppression per submission
  test('Claude refuses any supplied mode as unsupported before a prompt or event, then sends normally (public factory, fake CLI)', async () => {
    const home = fakeClaudeHome()
    const events: AgentEvent[] = []
    const d = createClaudeDriver({
      launch: home.launch(),
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      permissions: { mode: 'default', enabledTools: [], disallowedTools: [] },
      callbacks: { onEvent: (event) => events.push(event) },
    })
    claudes.push(d)
    await d.start()
    const before = events.length
    for (const mode of ['auto', 'none', 'bogus'] as const) {
      const error = await refusal(d.send('/deploy', { codexSkills: mode as 'auto' }))
      expect([error.category, error.message]).toEqual(['unsupported', 'codexSkills is not supported by the Claude runtime'])
    }
    expect(events.slice(before)).toEqual([])
    const result = await (await d.send('hello')).result
    expect([result.outcome, events.filter((e) => e.type === 'user_message').map((e) => (e as { text: string }).text)]).toEqual(['success', ['hello']])
  })
})
