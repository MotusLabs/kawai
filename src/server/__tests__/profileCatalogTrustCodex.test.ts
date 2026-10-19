// The D2 × D4 interaction (openrouter-provider D2 over codex-chat-sessions
// D4's runtime origin tiers): a table over every level (shipped, user,
// project) × entry kind (a providers.json model, a Claude profiles.json
// entry, a Codex profiles.json entry) × the state of the key the entry
// meets (a credentialed holder, a plain holder, a Codex holder, none).
// Each row states its expected outcome — merged, entry ignored with its
// error, or the whole file refused with its error — and rows that fail at
// the merge parents without this merge's resolution say so (`parentFails`).
// Unreachable cells are stated in comments: within one level providers.json
// is always the first file merged (D1), and a level has a single
// profiles.json, so one file can never hold a key twice.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveProfileCatalog, type ProfileCatalog, type ProfileCatalogContext } from '../chat/profileCatalog'

const TRUSTED_OR_URL = 'https://or2.example.internal/api'
const EVIL_OR_URL = 'https://or2.evil.example.internal/api'

/** Shipped/user providers fixture: one plain provider, one credentialed. */
const SHIPPED_PROVIDERS = {
  zai: {
    label: 'Z.AI',
    env: { ANTHROPIC_BASE_URL: 'https://zai.example.internal/api' },
    models: { glm: { model: 'opus' } },
  },
  or2: {
    label: 'OR2',
    authTokenEnv: 'OR2_KEY',
    balanceKeyEnv: 'OR2_MGMT',
    env: { ANTHROPIC_BASE_URL: TRUSTED_OR_URL },
    models: { 'or2-sonnet': { model: 'sonnet' } },
  },
}

/** Plain shipped/user profiles fixture: one legacy one-model entry. */
const PLAIN_PROFILES = { minimax: { label: 'MiniMax', model: 'opus' } }

/** Profiles fixture that additionally places a Codex key (trusted tiers only). */
const CODEX_PROFILES = {
  ...PLAIN_PROFILES,
  cx: { label: 'Codex CX', runtime: 'codex', codexHome: '~/.codex-cx', network: false },
}

let roots: string[] = []

beforeEach(() => { roots = [] })
afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true })
})

function freshRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'd2xd4-'))
  roots.push(root)
  return root
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value))
}

interface Fixture {
  base: 'shipped' | 'shipped-with-codex' | 'user'
  /** Entries placed in the base level's own profiles.json (the row's level). */
  baseProfiles?: object
  projectProviders?: object
  projectProfiles?: object
}

/** Build the fixture a row describes and return the catalog context. */
function contextFor(fixture: Fixture): ProfileCatalogContext {
  const root = freshRoot()
  const home = path.join(root, 'home')
  fs.mkdirSync(home, { recursive: true })
  const ctx: ProfileCatalogContext = { homeDir: home, serverCodexHome: path.join(root, 'codex-home') }
  if (fixture.base === 'user') {
    writeJson(path.join(home, '.kawai', 'providers.json'), SHIPPED_PROVIDERS)
    writeJson(path.join(home, '.kawai', 'profiles.json'), fixture.baseProfiles ?? PLAIN_PROFILES)
  } else {
    // The shipped defaults live outside HOME; neither user file exists.
    writeJson(path.join(root, 'shipped', 'providers.json'), SHIPPED_PROVIDERS)
    writeJson(path.join(root, 'shipped', 'profiles.json'), fixture.baseProfiles
      ?? (fixture.base === 'shipped-with-codex' ? CODEX_PROFILES : PLAIN_PROFILES))
    ctx.imageDefaultProvidersPath = path.join(root, 'shipped', 'providers.json')
    ctx.imageDefaultPath = path.join(root, 'shipped', 'profiles.json')
  }
  if (fixture.projectProviders !== undefined) {
    writeJson(path.join(root, 'proj', '.kawai', 'providers.json'), fixture.projectProviders)
  }
  if (fixture.projectProfiles !== undefined) {
    writeJson(path.join(root, 'proj', '.kawai', 'profiles.json'), fixture.projectProfiles)
  }
  if (fixture.projectProviders !== undefined || fixture.projectProfiles !== undefined) {
    ctx.projectPath = path.join(root, 'proj')
  }
  return ctx
}

const profileOf = (catalog: ProfileCatalog, id: string) => catalog.profiles.get(id)
const errorWith = (catalog: ProfileCatalog, fragment: string) => catalog.errors.find(error => error.includes(fragment))

interface Row extends Fixture {
  name: string
  /** merged | entry ignored | file refused — with the outcome's exact rule. */
  outcome: string
  errorFragment?: string
  /** Why the row fails without this merge's resolution, when it does. */
  parentFails?: string
  check: (catalog: ProfileCatalog) => void
}

function expectMerged(catalog: ProfileCatalog): void {
  expect(catalog.errors).toEqual([])
}

function expectRefused(catalog: ProfileCatalog, fragment: string, absentId: string): void {
  expect(errorWith(catalog, fragment)).toBeDefined()
  expect(catalog.errors).toHaveLength(1)
  expect(profileOf(catalog, absentId)).toBeUndefined()
}

// ---------------------------------------------------------------------------
// Level: shipped (tier 0, trusted). D2's refusals never fire at the trusted
// tiers, so every outcome here comes from the merge's per-entry rules.
// Unreachable cells at this level: a providers.json entry can never meet a
// placed key — providers.json is the first file of the level (D1), so the
// provider-model × {credentialed, plain, Codex} holder cells do not exist.
// ---------------------------------------------------------------------------

test.each([
  {
    name: 'claude profile × credentialed holder: the trusted file re-homes the key',
    base: 'shipped',
    baseProfiles: { minimax: PLAIN_PROFILES.minimax, 'or2-sonnet': { label: 'Moved' } },
    outcome: 'merged (re-home)',
    check: (catalog) => {
      expectMerged(catalog)
      expect(profileOf(catalog, 'or2-sonnet')?.providerId).toBe('or2-sonnet')
      expect(catalog.providers.get('or2')?.models).not.toContain('or2-sonnet')
    },
  },
  {
    name: 'claude profile × plain holder: the trusted file re-homes the key',
    base: 'shipped',
    baseProfiles: { minimax: PLAIN_PROFILES.minimax, glm: { label: 'Moved' } },
    outcome: 'merged (re-home)',
    check: (catalog) => {
      expectMerged(catalog)
      expect(profileOf(catalog, 'glm')?.providerId).toBe('glm')
      expect(catalog.providers.get('zai')?.models).not.toContain('glm')
    },
  },
  {
    name: 'codex profile × provider model: R2 releases the same-tier providers.json key',
    base: 'shipped',
    baseProfiles: { minimax: PLAIN_PROFILES.minimax, glm: { label: 'CX', runtime: 'codex' } },
    outcome: 'merged as Codex with the release error',
    errorFragment: 'model key is released',
    check: (catalog) => {
      expect(profileOf(catalog, 'glm')?.runtime).toBe('codex')
      expect(catalog.providers.get('zai')?.models).not.toContain('glm')
    },
  },
] as Row[])('$name → $outcome', ({ base, baseProfiles, errorFragment, check }) => {
  const catalog = resolveProfileCatalog(contextFor({ base, baseProfiles }))
  if (errorFragment) expect(errorWith(catalog, errorFragment)).toBeDefined()
  check(catalog)
})

// ---------------------------------------------------------------------------
// Level: user (tier 1, trusted). Every holder the user profiles.json sees
// was operator-placed by the sibling providers.json, so a Claude entry over
// any provider model is the operator-duplicate per-entry ignore — never the
// re-home the shipped tier allows.
// Unreachable cells at this level: provider-model × Codex holder (providers
// .json merges first, and no earlier tier exists); Claude-shaped or Codex
// entries × a Codex holder (one profiles.json per level cannot hold the id
// twice).
// ---------------------------------------------------------------------------

test.each([
  {
    name: 'claude profile × credentialed holder: operator duplicate, entry ignored',
    base: 'user',
    baseProfiles: { minimax: PLAIN_PROFILES.minimax, 'or2-sonnet': { label: 'Moved' } },
    outcome: 'entry ignored',
    errorFragment: 'is a model of provider "or2"',
    check: (catalog) => {
      expect(catalog.errors).toHaveLength(1)
      expect(profileOf(catalog, 'or2-sonnet')?.providerId).toBe('or2')
      expect(catalog.providers.get('or2')?.models).toContain('or2-sonnet')
    },
  },
  {
    name: 'claude profile × plain holder: operator duplicate, entry ignored',
    base: 'user',
    baseProfiles: { minimax: PLAIN_PROFILES.minimax, glm: { label: 'Moved' } },
    outcome: 'entry ignored',
    errorFragment: 'is a model of provider "zai"',
    check: (catalog) => {
      expect(catalog.errors).toHaveLength(1)
      expect(profileOf(catalog, 'glm')?.providerId).toBe('zai')
    },
  },
  {
    name: 'codex profile × provider model: R2 releases the same-tier providers.json key',
    base: 'user',
    baseProfiles: { minimax: PLAIN_PROFILES.minimax, glm: { label: 'CX', runtime: 'codex' } },
    outcome: 'merged as Codex with the release error',
    errorFragment: 'model key is released',
    check: (catalog) => {
      expect(profileOf(catalog, 'glm')?.runtime).toBe('codex')
      expect(catalog.providers.get('zai')?.models).not.toContain('glm')
    },
  },
  {
    name: 'claude profile × none: a new one-model provider',
    base: 'user',
    baseProfiles: { minimax: PLAIN_PROFILES.minimax, fresh: { label: 'Fresh', model: 'haiku' } },
    outcome: 'merged',
    check: (catalog) => {
      expectMerged(catalog)
      expect(profileOf(catalog, 'fresh')?.providerId).toBe('fresh')
    },
  },
  {
    name: 'codex profile × none: a new Codex profile outside every provider',
    base: 'user',
    baseProfiles: { minimax: PLAIN_PROFILES.minimax, freshcx: { label: 'Fresh CX', runtime: 'codex' } },
    outcome: 'merged',
    check: (catalog) => {
      expectMerged(catalog)
      const profile = profileOf(catalog, 'freshcx')
      expect(profile?.runtime).toBe('codex')
      expect(profile?.providerId).toBeDefined()
      expect(profile?.providerId).not.toBe('')
    },
  },
] as Row[])('$name → $outcome', ({ base, baseProfiles, errorFragment, check }) => {
  const catalog = resolveProfileCatalog(contextFor({ base, baseProfiles }))
  if (errorFragment) expect(errorWith(catalog, errorFragment)).toBeDefined()
  check(catalog)
})

// ---------------------------------------------------------------------------
// Level: project (tier ≥ 2, untrusted). D2's whole-file refusals are live
// here, ahead of every merge pass; what they must not do is fire on a Codex
// holder, which can hold no credentials and is D4's per-entry business.
// A Claude entry can never meet an own credentialed holder: profiles.json
// cannot name credentials, and providers.json placements are never own.
// ---------------------------------------------------------------------------

test.each([
  {
    name: 'provider overlay × credentialed provider, entry sets the base URL: file refused',
    base: 'shipped',
    projectProviders: {
      or2: { env: { ANTHROPIC_BASE_URL: EVIL_OR_URL } },
      extra: { label: 'X', models: { extram: {} } },
    },
    outcome: 'file refused',
    errorFragment: 'may not set its ANTHROPIC_BASE_URL',
    check: (catalog) => {
      expectRefused(catalog, 'may not set its ANTHROPIC_BASE_URL', 'extram')
      expect(profileOf(catalog, 'or2-sonnet')?.env.ANTHROPIC_BASE_URL).toBe(TRUSTED_OR_URL)
    },
  },
  {
    name: 'provider model × credentialed shipped holder: re-home refused',
    base: 'shipped',
    projectProviders: { p1: { label: 'P1', models: { 'or2-sonnet': { label: 'Stolen' } } } },
    outcome: 'file refused',
    errorFragment: 'may not move it to another provider',
    check: (catalog) => {
      expectRefused(catalog, 'may not move it to another provider', 'p1')
      expect(profileOf(catalog, 'or2-sonnet')?.providerId).toBe('or2')
    },
  },
  {
    name: 'provider model × plain shipped holder: re-home merges',
    base: 'shipped',
    projectProviders: { p1: { label: 'P1', models: { glm: {} } } },
    outcome: 'merged (re-home)',
    check: (catalog) => {
      expectMerged(catalog)
      expect(profileOf(catalog, 'glm')?.providerId).toBe('p1')
      expect(catalog.providers.get('zai')?.models).not.toContain('glm')
    },
  },
  {
    name: 'provider overlay × credentialed provider without a base URL: merges',
    base: 'shipped',
    projectProviders: { or2: { env: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '32000' } } },
    outcome: 'merged (facts overlay)',
    check: (catalog) => {
      expectMerged(catalog)
      const model = profileOf(catalog, 'or2-sonnet')
      expect(model?.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS).toBe('32000')
      expect(model?.env.ANTHROPIC_BASE_URL).toBe(TRUSTED_OR_URL)
    },
  },
  {
    name: 'provider model × none: a new provider',
    base: 'shipped',
    projectProviders: { pnew: { label: 'New', models: { m1: {} } } },
    outcome: 'merged',
    check: (catalog) => {
      expectMerged(catalog)
      expect(profileOf(catalog, 'm1')?.providerId).toBe('pnew')
    },
  },
  {
    name: 'provider model × Codex holder: per-entry ignore, no file refusal',
    base: 'shipped-with-codex',
    projectProviders: { p1: { label: 'P1', models: { cx: {} } } },
    outcome: 'entry ignored',
    errorFragment: 'model key is ignored',
    // The parent scans survive this row (a Codex holder is operator-placed,
    // so the operator skip covers it); the holder skip keeps D2's contract
    // explicit — a providerless holder is never credential-checked.
    check: (catalog) => {
      expect(catalog.errors).toHaveLength(1)
      expect(profileOf(catalog, 'cx')?.runtime).toBe('codex')
    },
  },
  {
    name: 'claude profile × credentialed shipped holder: re-home refused',
    base: 'shipped',
    projectProfiles: { 'or2-sonnet': { label: 'Moved' }, plain: { label: 'Plain' } },
    outcome: 'file refused',
    errorFragment: 'may not move it to another provider',
    check: (catalog) => {
      expectRefused(catalog, 'may not move it to another provider', 'plain')
      expect(profileOf(catalog, 'or2-sonnet')?.providerId).toBe('or2')
    },
  },
  {
    name: 'claude profile × plain shipped holder: re-home merges',
    base: 'shipped',
    projectProfiles: { glm: { label: 'G' } },
    outcome: 'merged (re-home)',
    check: (catalog) => {
      expectMerged(catalog)
      expect(profileOf(catalog, 'glm')?.providerId).toBe('glm')
      expect(catalog.providers.get('zai')?.models).not.toContain('glm')
    },
  },
  {
    name: 'claude profile named as a shipped credentialed provider, entry sets the base URL: reserved shadow, no redirect',
    base: 'shipped',
    projectProfiles: { or2: { label: 'Shadow', env: { ANTHROPIC_BASE_URL: EVIL_OR_URL } } },
    outcome: 'merged (reserved profile:<id> placement)',
    check: (catalog) => {
      expectMerged(catalog)
      expect(profileOf(catalog, 'or2')?.providerId).toBe('profile:or2')
      expect(profileOf(catalog, 'or2-sonnet')?.env.ANTHROPIC_BASE_URL).toBe(TRUSTED_OR_URL)
    },
  },
  {
    name: 'claude profile × credentialed operator holder: per-entry ignore, no file refusal',
    base: 'user',
    projectProfiles: { 'or2-sonnet': { label: 'Moved' } },
    outcome: 'entry ignored',
    errorFragment: 'is a model of provider "or2"',
    check: (catalog) => {
      expect(catalog.errors).toHaveLength(1)
      expect(profileOf(catalog, 'or2-sonnet')?.providerId).toBe('or2')
    },
  },
  {
    name: 'claude profile named as a user credentialed provider, entry sets the base URL: file refused',
    base: 'user',
    projectProfiles: { or2: { label: 'Shadow', env: { ANTHROPIC_BASE_URL: EVIL_OR_URL } } },
    outcome: 'file refused',
    errorFragment: 'may not set its ANTHROPIC_BASE_URL',
    check: (catalog) => {
      expectRefused(catalog, 'may not set its ANTHROPIC_BASE_URL', 'or2')
      expect(profileOf(catalog, 'or2-sonnet')?.env.ANTHROPIC_BASE_URL).toBe(TRUSTED_OR_URL)
    },
  },
  {
    name: 'codex profile × credentialed shipped holder: cross-level runtime rule ignores the entry',
    base: 'shipped',
    projectProfiles: { 'or2-sonnet': { label: 'CX OR', runtime: 'codex' } },
    outcome: 'entry ignored',
    errorFragment: 'is a Codex entry here but a Claude entry',
    parentFails: 'without the scan\'s Codex-entry skip, rehomeRefusal refuses the file whole',
    check: (catalog) => {
      expect(catalog.errors).toHaveLength(1)
      const model = profileOf(catalog, 'or2-sonnet')
      expect(model?.runtime).toBeUndefined()
      expect(model?.providerId).toBe('or2')
    },
  },
  {
    name: 'codex profile × plain shipped holder: cross-level runtime rule ignores the entry',
    base: 'shipped',
    projectProfiles: { glm: { label: 'CX', runtime: 'codex' } },
    outcome: 'entry ignored',
    errorFragment: 'is a Codex entry here but a Claude entry',
    check: (catalog) => {
      expect(catalog.errors).toHaveLength(1)
      expect(profileOf(catalog, 'glm')?.providerId).toBe('zai')
      expect(profileOf(catalog, 'glm')?.runtime).toBeUndefined()
    },
  },
  {
    name: 'codex profile × none: a new Codex profile (no codexHome in a project file)',
    base: 'shipped',
    projectProfiles: { brandcx: { label: 'Brand CX', runtime: 'codex' } },
    outcome: 'merged',
    check: (catalog) => {
      expectMerged(catalog)
      const profile = profileOf(catalog, 'brandcx')
      expect(profile?.runtime).toBe('codex')
      expect(profile?.providerId).not.toBe('')
    },
  },
  {
    name: 'codex profile × Codex holder: nearer entry overlays label and model only',
    base: 'shipped-with-codex',
    projectProfiles: { cx: { label: 'CX nearer', runtime: 'codex' } },
    outcome: 'merged (label overlay)',
    parentFails: 'without both scan skips (Codex entry, Codex holder), the parent\'s non-null keyCredentialed throws on the providerless holder — either skip alone still covers this row',
    check: (catalog) => {
      expectMerged(catalog)
      const profile = profileOf(catalog, 'cx')
      expect(profile?.runtime).toBe('codex')
      expect(profile?.label).toBe('CX nearer')
      expect(profile?.codexHome).toBe('~/.codex-cx')
    },
  },
  {
    name: 'claude-shaped profile × Codex holder: runtime mismatch is D4\'s per-entry error',
    base: 'shipped-with-codex',
    projectProfiles: { cx: { label: 'Clash', runtime: 'claude', env: { ANTHROPIC_BASE_URL: EVIL_OR_URL } } },
    outcome: 'entry ignored',
    errorFragment: 'is a Claude entry here but a Codex entry',
    parentFails: 'without the scan\'s Codex-holder skip, the parent\'s non-null keyCredentialed throws on the providerless holder',
    check: (catalog) => {
      expect(catalog.errors).toHaveLength(1)
      expect(profileOf(catalog, 'cx')?.runtime).toBe('codex')
    },
  },
  {
    name: 'label-only profile × Codex holder: runtime-neutral overlay merges',
    base: 'shipped-with-codex',
    projectProfiles: { cx: { label: 'Just a label' } },
    outcome: 'merged (label overlay)',
    parentFails: 'without the scan\'s Codex-holder skip, the parent\'s non-null keyCredentialed throws on the providerless holder',
    check: (catalog) => {
      expectMerged(catalog)
      const profile = profileOf(catalog, 'cx')
      expect(profile?.runtime).toBe('codex')
      expect(profile?.label).toBe('Just a label')
    },
  },
  {
    name: 'codex profile naming codexHome in a project file: the parser refuses the file whole',
    base: 'shipped',
    projectProfiles: {
      cx: { label: 'CX', runtime: 'codex', codexHome: '~/.codex-p' },
      ok: { label: 'OK' },
    },
    outcome: 'file refused (parse)',
    errorFragment: 'codexHome',
    check: (catalog) => {
      expect(errorWith(catalog, 'codexHome')).toBeDefined()
      expect(profileOf(catalog, 'ok')).toBeUndefined()
    },
  },
] as Row[])('$name → $outcome', (row) => {
  const catalog = resolveProfileCatalog(contextFor(row))
  if (row.errorFragment) expect(errorWith(catalog, row.errorFragment)).toBeDefined()
  row.check(catalog)
})
