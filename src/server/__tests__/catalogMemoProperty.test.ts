// Property P1 of catalog-resolution-cache: through the shared memo,
// `providerOf`, `providerLabelOf`, and the merged definitions equal a fresh
// `resolveProfileCatalog` projection for the same context after any sequence
// of lookups and file edits, so an edit is seen at the next lookup. Seeded
// generator: nested `.kawai` directories, overlapping provider and model ids
// across tiers, six project paths, and rewrite/add/delete edits each stamped
// with a strictly later mtime.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { providerLabelOf, providerOf, resolvedCatalog } from '../chat/catalogMemo'
import { resolveProfileCatalog, type ProfileCatalogContext } from '../chat/profileCatalog'

const SEED = 0xca7a
const SEQUENCES = 40
const STEPS = 30
const PROVIDERS = ['p0', 'p1', 'p2', 'p3', 'p4']
const MODELS = ['m0', 'm1', 'm2', 'm3', 'm4']
const NAMES = ['providers.json', 'profiles.json'] as const

let root: string

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-catalog-memo-p1-')))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

/** LCG drawing from the high bits: the low bits cycle too briefly. */
function rng(seed: number): (n: number) => number {
  let state = seed >>> 0
  return n => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0
    return (state >>> 16) % n
  }
}

function content(rand: (n: number) => number, name: (typeof NAMES)[number]): unknown {
  const pick = <T>(list: T[]): T => list[rand(list.length)]
  if (name === 'providers.json') {
    const out: Record<string, unknown> = {}
    for (let i = 0, n = 1 + rand(2); i < n; i++) {
      const models: Record<string, unknown> = {}
      for (let j = 0, m = 1 + rand(2); j < m; j++) models[pick(MODELS)] = { label: `L${rand(9)}`, model: pick(['opus', 'sonnet']) }
      out[pick(PROVIDERS)] = { label: `P${rand(9)}`, models }
    }
    return out
  }
  const out: Record<string, unknown> = {}
  for (let i = 0, n = 1 + rand(3); i < n; i++) out[pick(MODELS)] = { label: `M${rand(9)}`, model: pick(['opus', 'sonnet']) }
  return out
}

test('P1: memoized lookups equal a fresh resolution after every lookup and edit', () => {
  const rand = rng(SEED)
  let clock = Date.parse('2026-01-01T00:00:00Z')
  for (let sequence = 0; sequence < SEQUENCES; sequence++) {
    const base = path.join(root, `s${sequence}`)
    const home = path.join(base, 'home')
    fs.mkdirSync(home, { recursive: true })
    const shippedDir = path.join(base, 'shipped', '.kawai')
    fs.mkdirSync(shippedDir, { recursive: true })
    fs.writeFileSync(path.join(shippedDir, 'providers.json'), '{}')
    fs.writeFileSync(path.join(shippedDir, 'profiles.json'), JSON.stringify({ default: { label: 'Default' } }))
    const dirs: string[] = []
    for (let depth = 0, n = 1 + rand(4), dir = path.join(base, 'w'); depth < n; depth++, dir = path.join(dir, `d${depth}`)) dirs.push(dir)
    const projects = Array.from({ length: 6 }, (_, i) => path.join(dirs[rand(dirs.length)], `p${i}`))
    for (const project of projects) fs.mkdirSync(project, { recursive: true })
    const files = dirs.flatMap(dir => NAMES.map(name => ({ file: path.join(dir, '.kawai', name), name })))

    const edit = (): void => {
      const target = files[rand(files.length)]
      if (rand(3) === 0) {
        fs.rmSync(target.file, { force: true })
        return
      }
      fs.mkdirSync(path.dirname(target.file), { recursive: true })
      fs.writeFileSync(target.file, JSON.stringify(content(rand, target.name)))
      clock += 2000
      fs.utimesSync(target.file, new Date(clock), new Date(clock))
    }
    for (let i = 0, n = 1 + rand(4); i < n; i++) edit()

    for (let step = 0; step < STEPS; step++) {
      if (rand(3) === 0) {
        edit()
        continue
      }
      const ctx: ProfileCatalogContext = {
        homeDir: home,
        serverCodexHome: '',
        projectPath: projects[rand(projects.length)],
        imageDefaultProvidersPath: path.join(shippedDir, 'providers.json'),
        imageDefaultPath: path.join(shippedDir, 'profiles.json'),
      }
      const fresh = resolveProfileCatalog(ctx)
      const label = `sequence ${sequence} step ${step} at ${ctx.projectPath}`
      for (const model of [...MODELS, 'default', 'unknown']) {
        expect({ label, model, provider: providerOf(model, ctx) })
          .toEqual({ label, model, provider: fresh.profiles.get(model)?.providerId ?? model })
      }
      for (const provider of [...PROVIDERS, 'default', 'unknown']) {
        expect({ label, provider, name: providerLabelOf(provider, ctx) })
          .toEqual({ label, provider, name: fresh.providers.get(provider)?.label ?? null })
      }
      expect({ label, merged: [...resolvedCatalog(ctx).definitions()] }).toEqual({ label, merged: [...fresh.merged] })
    }
  }
})
