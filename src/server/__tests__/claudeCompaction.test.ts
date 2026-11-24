// @reads: config/profiles.default.json, config/providers.default.json
// Launch composition of the selected auto-compaction window
// (mimo-million-token-context D1-D3): table W through the real resolver
// (SessionTeams.compactWindowFor over a group file) and claudeSpawnLaunch
// over a real catalog file; the composed-name/registered-set table over
// composeCompaction; row C1 for the shipped MiMo entry on an isolated empty
// home; property P1 for isolation between sessions and the process env.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveClaudeProfile } from '../chat/ClaudeProfiles'
import { composeCompaction, composedCompactionNames, declaresMillionContext, parseWindowToken } from '../chat/claudeCompaction'
import { claudeSpawnLaunch } from '../chat/provider/claudeRuntimeLaunch'
import { RegisteredNameRefusal } from '../chat/secretNameRegistry'
import { SessionTeams } from '../team/sessionTeams'
import { propertyCases } from './helpers/propertyCases'

const COMPOSED = ['CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'DISABLE_AUTO_COMPACT', 'DISABLE_COMPACT', 'CLAUDE_CODE_DISABLE_1M_CONTEXT'] as const
const original = Object.fromEntries(COMPOSED.map(name => [name, process.env[name]]))

let root: string

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-compaction-')))
  for (const name of COMPOSED) delete process.env[name]
})

afterEach(() => {
  for (const name of COMPOSED) {
    if (original[name] === undefined) delete process.env[name]
    else process.env[name] = original[name]
  }
  fs.rmSync(root, { recursive: true, force: true })
})

/** One project with a role file and a user-level catalog for profile `w`. */
function setup(dir: string, input: { roleProfile?: number; roleDefault?: number; catalog?: number; legacy?: number }) {
  const project = path.join(dir, 'project')
  const home = path.join(dir, 'home')
  fs.mkdirSync(path.join(project, '.kawai', 'groups'), { recursive: true })
  fs.mkdirSync(path.join(home, '.kawai'), { recursive: true })
  const lines = [
    ...(input.roleDefault !== undefined ? [`autoCompactWindow: ${input.roleDefault}`] : []),
    ...(input.roleProfile !== undefined ? [`profileAutoCompactWindow: { w: ${input.roleProfile} }`] : []),
  ]
  fs.writeFileSync(path.join(project, '.kawai', 'groups', 'devs.md'), `---\nlabel: Devs\n${lines.join('\n')}\n---\nBuild.`)
  fs.writeFileSync(path.join(home, '.kawai', 'profiles.json'), JSON.stringify({
    w: {
      label: 'W', model: 'w-model',
      ...(input.catalog !== undefined ? { autoCompactWindow: input.catalog } : {}),
      env: {
        ANTHROPIC_BASE_URL: 'https://w.example.internal/anthropic',
        ...(input.legacy !== undefined ? { CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(input.legacy) } : {}),
      },
    },
  }))
  return { project, home }
}

async function launchFor(dir: string, sessionId: string, input: Parameters<typeof setup>[1]) {
  const { project, home } = setup(dir, input)
  const teams = new SessionTeams({ homeDir: home })
  await teams.track(sessionId, project)
  const spawn = () => claudeSpawnLaunch({
    claudeProfileId: 'w', projectPath: project, profileCatalogHome: home, injected: true,
    getCompactWindow: () => teams.compactWindowFor(sessionId, 'devs', 'w'),
  })
  return { project, home, teams, spawn }
}

/** Today's launch (I3): the resolver's env and settings.env as plain strings, nothing composed. */
function todaysLayers(project: string, home: string) {
  const resolved = resolveClaudeProfile('w', {}, { projectPath: project, homeDir: home })
  if (resolved.runtime !== 'claude') throw new Error('expected a Claude launch')
  const strings = (env: Record<string, string | undefined> | undefined) =>
    Object.fromEntries(Object.entries(env ?? {}).filter(([, value]) => typeof value === 'string')) as Record<string, string>
  return { childEnv: strings(resolved.env), settingsEnv: strings((resolved.settings as { env?: Record<string, string> } | undefined)?.env) }
}

describe('table W: effective window precedence', () => {
  // design.md "Acceptance oracles", table W, verbatim.
  const W = [
    { id: 'W1', roleProfile: 300000, roleDefault: 250000, catalog: 400000, legacy: 150000, window: '300000', cleared: true },
    { id: 'W2', roleProfile: undefined, roleDefault: 250000, catalog: 400000, legacy: 150000, window: '250000', cleared: true },
    { id: 'W3', roleProfile: undefined, roleDefault: undefined, catalog: 300000, legacy: 150000, window: '300000', cleared: true },
    { id: 'W4', roleProfile: undefined, roleDefault: undefined, catalog: undefined, legacy: 150000, window: '150000', cleared: false },
    { id: 'W5', roleProfile: undefined, roleDefault: undefined, catalog: undefined, legacy: undefined, window: undefined, cleared: false },
  ] as const

  // @covers: agent-teams › Roles can choose an auto-compaction window › Global MiMo preference is inherited
  // @covers: agent-teams › Roles can choose an auto-compaction window › Profile-specific role preference wins
  // @covers: claude-session-profiles › Claude catalog entries can specify an auto-compaction window › Configuration absent
  test('W1-W5 resolve role profile > role default > catalog scalar > legacy env in both layers; W4/W5 launch exactly as today', async () => {
    for (const row of W) {
      const dir = path.join(root, row.id)
      const { project, home, spawn } = await launchFor(dir, `s-${row.id}`, row)
      const launch = spawn()
      const child = launch.launch.childEnv
      const flag = launch.settingsEnv ?? {}
      expect(child.CLAUDE_CODE_AUTO_COMPACT_WINDOW as string | undefined, row.id).toBe(row.window)
      expect(flag.CLAUDE_CODE_AUTO_COMPACT_WINDOW, row.id).toBe(row.window ?? '')
      if (row.cleared) {
        for (const layer of [child, flag]) {
          expect(layer.DISABLE_AUTO_COMPACT, row.id).toBe('')
          expect(layer.DISABLE_COMPACT, row.id).toBe('')
        }
      } else {
        // I3: no selected value — byte-identical to the resolver's launch.
        const today = todaysLayers(project, home)
        expect(JSON.stringify(child), row.id).toBe(JSON.stringify(today.childEnv))
        expect(JSON.stringify(flag), row.id).toBe(JSON.stringify(today.settingsEnv))
      }
      // No `[1m]` on profile w: the 1M opt-out is never composed (D1).
      expect('CLAUDE_CODE_DISABLE_1M_CONTEXT' in child || 'CLAUDE_CODE_DISABLE_1M_CONTEXT' in flag, row.id).toBe(false)
    }
  })

  // @covers: agent-teams › Roles can choose an auto-compaction window › Role default overrides the catalog
  test('W2 at the resolver: the role default wins over the catalog while a session without the role keeps the catalog value', async () => {
    const { project, home, teams, spawn } = await launchFor(root, 's1', { roleDefault: 250000, catalog: 300000 })
    expect(teams.compactWindowFor('s1', 'devs', 'w')).toBe(250000)
    expect(spawn().launch.childEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('250000')
    expect(teams.compactWindowFor('s1', null, 'w')).toBeUndefined()
    const ungrouped = claudeSpawnLaunch({
      claudeProfileId: 'w', projectPath: project, profileCatalogHome: home, injected: true,
      getCompactWindow: () => teams.compactWindowFor('s1', null, 'w'),
    })
    expect(ungrouped.launch.childEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('300000')
  })
})

describe('composed names against the registered set (D3)', () => {
  const plain = { env: { ANTHROPIC_MODEL: 'plain' } }
  const tagged = { model: 'm[1m]', env: {} }
  const tierOnly = { env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'flash[1m]' } }

  // @covers: claude-session-profiles › Selected window preferences compose within the launch's protections › 1M opt-out cleared only under the explicit condition
  test('the 1M opt-out joins the composed set only for an explicit [1m] declaration with a selected value', () => {
    expect(composedCompactionNames(plain)).toEqual(['CLAUDE_CODE_AUTO_COMPACT_WINDOW', 'DISABLE_AUTO_COMPACT', 'DISABLE_COMPACT'])
    expect(composedCompactionNames(tagged)).toContain('CLAUDE_CODE_DISABLE_1M_CONTEXT')
    expect(declaresMillionContext(tierOnly)).toBe(true)
    expect(declaresMillionContext({ model: 'm[1M]', env: {} })).toBe(false)
    // A tagged declaration without a selected value keeps the flag's behavior.
    const layers = { childEnv: { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' }, settingsEnv: { CLAUDE_CODE_DISABLE_1M_CONTEXT: '1' } }
    expect(composeCompaction(layers, tagged, undefined, new Set())).toBe(layers)
    const composed = composeCompaction(layers, tagged, 300000, new Set())
    expect(composed.childEnv.CLAUDE_CODE_DISABLE_1M_CONTEXT).toBe('')
    expect(composed.settingsEnv?.CLAUDE_CODE_DISABLE_1M_CONTEXT).toBe('')
    // A window alone never infers capacity.
    const untagged = composeCompaction(layers, plain, 1_000_000, new Set())
    expect(untagged.childEnv.CLAUDE_CODE_DISABLE_1M_CONTEXT).toBe('1')
    expect(untagged.settingsEnv?.CLAUDE_CODE_DISABLE_1M_CONTEXT).toBe('1')
  })

  test('each composed name that is registered refuses names-only before either layer is written; the set never grows', () => {
    for (const name of COMPOSED) {
      const layers = { childEnv: { KEEP: 'child' }, settingsEnv: { KEEP: 'flag' } }
      const before = JSON.stringify(layers)
      const registered = new Set([name, 'UNRELATED_TOKEN'])
      let refusal: unknown
      try {
        composeCompaction(layers, tagged, 300000, registered)
      } catch (error) {
        refusal = error
      }
      expect(refusal, name).toBeInstanceOf(RegisteredNameRefusal)
      expect((refusal as RegisteredNameRefusal).names, name).toEqual([name])
      expect((refusal as Error).message, name).not.toContain('UNRELATED_TOKEN')
      expect(JSON.stringify(layers), name).toBe(before)
      expect([...registered].sort(), name).toEqual([name, 'UNRELATED_TOKEN'].sort())
    }
    // A noncolliding set composes into new objects and leaves the inputs and the set alone.
    const layers = { childEnv: { KEEP: 'child' } }
    const registered = new Set(['UNRELATED_TOKEN'])
    const composed = composeCompaction(layers, plain, 250000, registered)
    expect(composed.childEnv).not.toBe(layers.childEnv)
    expect(layers).toEqual({ childEnv: { KEEP: 'child' } })
    expect(composed.settingsEnv).toEqual({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '250000', DISABLE_AUTO_COMPACT: '', DISABLE_COMPACT: '' })
    expect([...registered]).toEqual(['UNRELATED_TOKEN'])
  })

  test('role window tokens accept plain decimal integers in range only', () => {
    for (const raw of ['100000', '300000', '1000000']) expect(parseWindowToken(raw), raw).toBe(Number(raw))
    for (const raw of ['99999', '1000001', '3e5', '300_000', '+300000', '0300000', '300000.0', '-300000', 'abc', '']) {
      expect(parseWindowToken(raw), raw).toBeNull()
    }
  })
})

describe('row C1: shipped MiMo on an isolated empty home', () => {
  // @covers: claude-session-profiles › Named profiles configure independent provider sessions › MiniMax and MiMo configuration
  // @covers: claude-session-profiles › Claude catalog entries can specify an auto-compaction window › MiMo global default
  test('C1 resolveClaudeProfile and claudeSpawnLaunch tag Pro and Flash [1m], keep the URL, and compose 300000 in both layers', () => {
    const home = path.join(root, 'empty-home')
    fs.mkdirSync(home)
    const resolved = resolveClaudeProfile('mimo', {}, { homeDir: home })
    if (resolved.runtime !== 'claude') throw new Error('expected a Claude launch')
    expect(resolved.model).toBe('mimo-v2.6-pro[1m]')
    const env = { ...resolved.env }
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.xiaomimimo.com/anthropic')
    expect(env.ANTHROPIC_MODEL).toBe('mimo-v2.6-pro[1m]')
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('mimo-v2.6-pro[1m]')
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('mimo-v2.6-pro[1m]')
    expect(env.ANTHROPIC_DEFAULT_FABLE_MODEL).toBe('mimo-v2.6-pro[1m]')
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('mimo-v2.6-flash[1m]')
    const launch = claudeSpawnLaunch({ claudeProfileId: 'mimo', projectPath: root, profileCatalogHome: home, injected: true })
    expect(launch.model).toBe('mimo-v2.6-pro[1m]')
    for (const layer of [launch.launch.childEnv, launch.settingsEnv ?? {}]) {
      expect(layer.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('300000')
      expect(layer.DISABLE_AUTO_COMPACT).toBe('')
      expect(layer.DISABLE_COMPACT).toBe('')
      expect(layer.CLAUDE_CODE_DISABLE_1M_CONTEXT).toBe('')
      expect(layer.ANTHROPIC_BASE_URL).toBe('https://api.xiaomimimo.com/anthropic')
      expect(layer.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('mimo-v2.6-flash[1m]')
    }
  })
})

/** mulberry32 over one seeded stream (propertyCases: a reduced run is a prefix). */
function stream(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('property P1: a chosen override never leaks', () => {
  const SEED = 0x4d494d4f
  const CASES = 128
  const BOUNDARIES = [100000, 100001, 999999, 1000000]

  test('P1 seed 0x4d494d4f over 128 cases: each session launches its own W resolution and process.env never changes', async () => {
    const next = stream(SEED)
    const size = () => next() < 0.25 ? BOUNDARIES[Math.floor(next() * BOUNDARIES.length)]! : 100000 + Math.floor(next() * 900001)
    const maybe = () => next() < 0.5 ? size() : undefined
    for (let index = 0; index < propertyCases(CASES); index++) {
      const configs = [0, 1].map(() => ({ roleProfile: maybe(), roleDefault: maybe(), catalog: maybe() }))
      const envBefore = JSON.stringify(process.env)
      const sessions = await Promise.all(configs.map((config, side) => launchFor(path.join(root, `case-${index}-${side}`), `s-${index}-${side}`, config)))
      const first = sessions[0]!.spawn()
      const firstBytes = JSON.stringify(first)
      const second = sessions[1]!.spawn()
      for (const [side, launch] of [first, second].entries()) {
        const config = configs[side]!
        const expected = config.roleProfile ?? config.roleDefault ?? config.catalog
        const label = `case ${index} side ${side} ${JSON.stringify(config)}`
        expect(launch.launch.childEnv.CLAUDE_CODE_AUTO_COMPACT_WINDOW as string | undefined, label).toBe(expected === undefined ? undefined : String(expected))
        expect(launch.settingsEnv?.CLAUDE_CODE_AUTO_COMPACT_WINDOW, label).toBe(expected === undefined ? '' : String(expected))
        expect('DISABLE_COMPACT' in launch.launch.childEnv, label).toBe(expected !== undefined)
      }
      // The second launch never touched the first, nor the process env.
      expect(JSON.stringify(first), `case ${index}`).toBe(firstBytes)
      expect(JSON.stringify(process.env), `case ${index}`).toBe(envBefore)
    }
  })
})
