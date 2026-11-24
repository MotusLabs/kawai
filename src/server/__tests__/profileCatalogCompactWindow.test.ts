// @reads: config/profiles.default.json, config/providers.default.json
// The catalog `autoCompactWindow` scalar (mimo-million-token-context D2):
// rows C2-C4, C5a, C5b and L5 over real catalog files — parse, merge,
// flatten, shipped-model re-homing, file-level refusal, and the Claude-only
// and wrapper boundaries.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveProfileCatalog } from '../chat/profileCatalog'

let root: string
let home: string
let emptyHome: string
let project: string

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-catalog-window-')))
  home = path.join(root, 'home')
  emptyHome = path.join(root, 'empty-home')
  project = path.join(root, 'work', 'project')
  fs.mkdirSync(path.join(home, '.kawai'), { recursive: true })
  fs.mkdirSync(emptyHome, { recursive: true })
  fs.mkdirSync(path.join(project, '.kawai'), { recursive: true })
})

afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

const write = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value))
const userFile = (name: string) => path.join(home, '.kawai', name)
const projectFile = (name: string, dir = project) => path.join(dir, '.kawai', name)
const URL = { ANTHROPIC_BASE_URL: 'https://p.example.internal/anthropic' }

describe('rows C2, C3: model over provider, nearer over farther, re-homed keys keep theirs', () => {
  // @covers: claude-session-profiles › Claude catalog entries can specify an auto-compaction window › A model overrides the provider default
  test('C2 a provider at 400000 with one model at 300000: that model 300000, its sibling inherits 400000', () => {
    write(userFile('providers.json'), { p: { env: URL, autoCompactWindow: 400000, models: { a: { autoCompactWindow: 300000 }, b: {} } } })
    const { profiles, errors } = resolveProfileCatalog({ homeDir: home })
    expect(errors).toEqual([])
    expect(profiles.get('a')?.autoCompactWindow).toBe(300000)
    expect(profiles.get('b')?.autoCompactWindow).toBe(400000)
  })

  test('C3 the nearer model value wins; a shipped key re-homed without a value keeps its inherited 300000', () => {
    write(userFile('providers.json'), { p: { env: URL, models: { m: { autoCompactWindow: 300000 }, n: { autoCompactWindow: 300000 } } } })
    write(projectFile('providers.json'), { p: { models: { m: { autoCompactWindow: 400000 }, n: { label: 'N' } } } })
    const near = resolveProfileCatalog({ homeDir: home, projectPath: project })
    expect(near.errors).toEqual([])
    expect(near.profiles.get('m')?.autoCompactWindow).toBe(400000)
    expect(near.profiles.get('n')?.autoCompactWindow).toBe(300000)
    // Shipped base (empty home): a project provider re-homes shipped `mimo`
    // without a value of its own, under a provider that declares another.
    write(projectFile('providers.json'), { relay: { env: URL, autoCompactWindow: 500000, models: { mimo: { label: 'Relay MiMo' }, other: {} } } })
    const rehomed = resolveProfileCatalog({ homeDir: emptyHome, projectPath: project })
    expect(rehomed.errors).toEqual([])
    expect(rehomed.profiles.get('mimo')?.providerId).toBe('relay')
    expect(rehomed.profiles.get('mimo')?.autoCompactWindow).toBe(300000)
    expect(rehomed.profiles.get('other')?.autoCompactWindow).toBe(500000)
    // A nearer legacy entry with its own value wins over the shipped one.
    write(projectFile('providers.json'), {})
    write(projectFile('profiles.json'), { mimo: { label: 'Project MiMo', autoCompactWindow: 450000 } })
    expect(resolveProfileCatalog({ homeDir: emptyHome, projectPath: project }).profiles.get('mimo')?.autoCompactWindow).toBe(450000)
  })
})

describe('row C4: invalid catalog sizes reject the file', () => {
  const INVALID: Array<[string, unknown]> = [
    ['string', '300000'], ['boolean', true], ['null', null], ['fractional', 300000.5], ['below range', 99999], ['above range', 1000001],
  ]

  // @covers: claude-session-profiles › Claude catalog entries can specify an auto-compaction window › Invalid catalog size
  test('C4 a string, boolean, null, fractional, 99999 or 1000001 rejects its whole file with an actionable error; another file stays usable', () => {
    for (const [kind, value] of INVALID) {
      for (const [file, content] of [
        ['profiles.json', { bad: { label: 'Bad', autoCompactWindow: value }, fine: { label: 'Fine' } }],
        ['providers.json', { q: { env: URL, autoCompactWindow: value, models: { qa: {} } } }],
        ['providers.json', { q: { env: URL, models: { qa: { autoCompactWindow: value } } } }],
      ] as const) {
        const other = file === 'profiles.json' ? 'providers.json' : 'profiles.json'
        write(projectFile(file), content)
        write(projectFile(other), other === 'providers.json' ? { ok: { env: URL, models: { 'ok-model': { autoCompactWindow: 250000 } } } } : { 'ok-model-2': { label: 'OK', autoCompactWindow: 250000 } })
        const { profiles, errors } = resolveProfileCatalog({ homeDir: emptyHome, projectPath: project })
        const label = `${kind} in ${file} ${JSON.stringify(content).slice(0, 40)}`
        expect(errors, label).toHaveLength(1)
        expect(errors[0], label).toContain(projectFile(file))
        expect(errors[0], label).toContain('autoCompactWindow must be a JSON integer from 100000 to 1000000 tokens')
        expect(profiles.has('bad') || profiles.has('fine') || profiles.has('qa'), label).toBe(false)
        expect(profiles.get(other === 'providers.json' ? 'ok-model' : 'ok-model-2')?.autoCompactWindow, label).toBe(250000)
        // Shipped entries still resolve beside the skipped file.
        expect(profiles.get('mimo')?.autoCompactWindow, label).toBe(300000)
        fs.rmSync(projectFile(file))
        fs.rmSync(projectFile(other))
      }
    }
  })
})

describe('rows C5a, C5b: the user level replaces the shipped value; a project overlay inherits it', () => {
  // @covers: claude-session-profiles › Claude catalog entries can specify an auto-compaction window › User-level catalog replaces the shipped preference
  test('C5a a user-level catalog defining mimo without the scalar gets no shipped 300000', () => {
    write(userFile('profiles.json'), { mimo: { label: 'MiMo', model: 'mimo-v2.6-pro[1m]', env: { ANTHROPIC_BASE_URL: 'https://api.xiaomimimo.com/anthropic' } } })
    const { profiles, errors } = resolveProfileCatalog({ homeDir: home, projectPath: project })
    expect(errors).toEqual([])
    expect(profiles.get('mimo')?.model).toBe('mimo-v2.6-pro[1m]')
    expect(profiles.get('mimo')?.autoCompactWindow).toBeUndefined()
    // An empty user-level providers file alone replaces the shipped base too.
    fs.rmSync(userFile('profiles.json'))
    write(userFile('providers.json'), {})
    expect(resolveProfileCatalog({ homeDir: home }).profiles.has('mimo')).toBe(false)
  })

  // @covers: claude-session-profiles › Claude catalog entries can specify an auto-compaction window › Project overlay omits the window
  test('C5b a project overlay redefining mimo models without the scalar inherits the base 300000', () => {
    write(projectFile('profiles.json'), { mimo: { model: 'mimo-v2.6-flash[1m]', env: { ANTHROPIC_MODEL: 'mimo-v2.6-flash[1m]' } } })
    const legacy = resolveProfileCatalog({ homeDir: emptyHome, projectPath: project })
    expect(legacy.errors).toEqual([])
    expect(legacy.profiles.get('mimo')?.model).toBe('mimo-v2.6-flash[1m]')
    expect(legacy.profiles.get('mimo')?.autoCompactWindow).toBe(300000)
    fs.rmSync(projectFile('profiles.json'))
    write(projectFile('providers.json'), { mimo: { models: { mimo: { model: 'mimo-v2.6-flash[1m]' } } } })
    const provider = resolveProfileCatalog({ homeDir: emptyHome, projectPath: project })
    expect(provider.errors).toEqual([])
    expect(provider.profiles.get('mimo')?.autoCompactWindow).toBe(300000)
  })
})

describe('row L5: Codex and executable-backed entries refuse the scalar', () => {
  // @covers: claude-session-profiles › Claude catalog entries can specify an auto-compaction window › Runtime and executable boundaries
  test('L5 a Codex entry or an executable-backed Claude entry carrying autoCompactWindow is an actionable incompatibility error', () => {
    const wrapper = path.join(root, 'wrapper.sh')
    fs.writeFileSync(wrapper, '#!/bin/sh\n', { mode: 0o755 })
    const cases: Array<{ file: string; content: unknown; message: string }> = [
      { file: 'profiles.json', content: { cx: { runtime: 'codex', autoCompactWindow: 300000 } }, message: 'declares runtime "codex"; field "autoCompactWindow" belongs to Claude entries' },
      { file: 'profiles.json', content: { wr: { executable: wrapper, autoCompactWindow: 300000 } }, message: 'profile "wr" sets executable and autoCompactWindow' },
      { file: 'providers.json', content: { wp: { executable: wrapper, models: { wm: { autoCompactWindow: 300000 } } } }, message: 'provider "wp" sets executable and autoCompactWindow' },
      { file: 'providers.json', content: { wp: { executable: wrapper, autoCompactWindow: 300000, models: { wm: {} } } }, message: 'provider "wp" sets executable and autoCompactWindow' },
    ]
    for (const { file, content, message } of cases) {
      write(userFile(file), content)
      const { profiles, errors } = resolveProfileCatalog({ homeDir: home })
      expect(errors, message).toHaveLength(1)
      expect(errors[0], message).toContain(message)
      expect(profiles.has('cx') || profiles.has('wr') || profiles.has('wm'), message).toBe(false)
      fs.rmSync(userFile(file))
    }
    // Across files: a project overlay adding the scalar to a user-level
    // wrapper is reported, and the wrapper keeps no window.
    write(userFile('profiles.json'), { wr: { executable: wrapper }, cx: { runtime: 'codex' } })
    write(projectFile('profiles.json'), { wr: { autoCompactWindow: 300000 } })
    const across = resolveProfileCatalog({ homeDir: home, projectPath: project })
    expect(across.profiles.get('wr')?.executable).toBe(wrapper)
    expect(across.profiles.get('wr')?.autoCompactWindow).toBeUndefined()
    expect(across.errors.some(error => error.includes('model "wr" is executable-backed, so its autoCompactWindow is ignored'))).toBe(true)
    // A project Claude-shaped overlay of a Codex profile is ignored with its error.
    write(projectFile('profiles.json'), { cx: { autoCompactWindow: 300000 } })
    const codex = resolveProfileCatalog({ homeDir: home, projectPath: project })
    expect(codex.profiles.get('cx')?.runtime).toBe('codex')
    expect(codex.profiles.get('cx')?.autoCompactWindow).toBeUndefined()
    expect(codex.errors.some(error => error.includes('profile "cx" is a Claude entry here but a Codex entry'))).toBe(true)
  })
})
