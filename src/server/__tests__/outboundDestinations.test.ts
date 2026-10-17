import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { OutboundDestinations, outboundFile } from '../outbound/destinations'

describe('OutboundDestinations', () => {
  let root: string
  let home: string

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-outbound-')))
    home = path.join(root, 'home')
    fs.mkdirSync(path.join(home, '.kawai'), { recursive: true })
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  const write = (content: unknown) => {
    fs.writeFileSync(outboundFile(home), typeof content === 'string' ? content : JSON.stringify(content))
  }
  const errorsOf = () => {
    const errors: string[] = []
    const make = (options: { globalBaseUrl?: () => string | undefined } = {}) => new OutboundDestinations({
      homeDir: home,
      onErrors: lines => errors.push(...lines),
      ...options,
    })
    return { errors, make }
  }

  test('a missing file gives the defaults: loopback and private ranges are internal, nothing configured renders', () => {
    const { errors, make } = errorsOf()
    const loader = make()
    expect(loader.facts()).toEqual({ internal: [], modelProviders: [] })
    // IPv4 loopback and every private range.
    for (const host of ['127.0.0.1', '127.255.0.9', '10.0.0.1', '172.16.0.1', '172.31.255.254', '192.168.1.1', '169.254.7.7']) {
      expect(loader.isInternal(host)).toBe(true)
    }
    // IPv6 loopback, unique-local, and v4-mapped loopback.
    for (const host of ['::1', '[::1]', 'fc00::1', 'fd12:3456::789a', '::ffff:127.0.0.1']) {
      expect(loader.isInternal(host)).toBe(true)
    }
    // Reserved example addresses outside every default stay external.
    for (const host of ['198.51.100.7', '2001:db8::1', '203.0.113.7']) {
      expect(loader.isInternal(host)).toBe(false)
    }
    // The public model-provider endpoints, and nothing else by name.
    expect(loader.isModelProvider('api.anthropic.com')).toBe(true)
    expect(loader.isModelProvider('claude.ai')).toBe(true)
    expect(loader.isModelProvider('www.claude.ai')).toBe(true)
    expect(loader.isModelProvider('example.internal')).toBe(false)
    expect(loader.isAllowedMcpServer('docs-search')).toBe(false)
    expect(errors).toEqual([])
  })

  test('an unparsable file is reported and the defaults apply', () => {
    write('{ not json')
    const { errors, make } = errorsOf()
    const loader = make()
    expect(loader.facts()).toEqual({ internal: [], modelProviders: [] })
    expect(loader.isInternal('10.0.0.1')).toBe(true)
    expect(loader.isInternal('example.internal')).toBe(false)
    expect(errors.some(e => e.includes(outboundFile(home)) && e.includes('using the defaults'))).toBe(true)
  })

  test('a malformed entry is dropped and reported while its siblings apply', () => {
    write({ internal: ['example.internal', '192.0.2.999/24', 'bad host'], modelProviders: ['llm.example.com', 'not a host'] })
    const { errors, make } = errorsOf()
    const loader = make()
    expect(loader.facts().internal).toEqual(['example.internal'])
    expect(loader.facts().modelProviders).toEqual(['llm.example.com'])
    expect(loader.isInternal('example.internal')).toBe(true)
    expect(loader.isInternal('build.example.internal')).toBe(true)
    expect(loader.isModelProvider('llm.example.com')).toBe(true)
    expect(errors.some(e => e.includes('192.0.2.999/24'))).toBe(true)
    expect(errors.some(e => e.includes('bad host'))).toBe(true)
    expect(errors.some(e => e.includes('not a host'))).toBe(true)
  })

  test('an unknown key is reported and ignored', () => {
    write({ internal: ['example.internal'], registries: ['npm.example.com'] })
    const { errors, make } = errorsOf()
    const loader = make()
    expect(loader.facts().internal).toEqual(['example.internal'])
    expect(errors.some(e => e.includes('unknown key "registries" is ignored'))).toBe(true)
  })

  test('an mtime change re-reads the file', () => {
    write({ internal: ['one.example.internal'] })
    const loader = new OutboundDestinations({ homeDir: home, matchRevalidateMs: 0 })
    expect(loader.isInternal('one.example.internal')).toBe(true)
    // Same size, new mtime: only the stamp's mtime half moves.
    write({ internal: ['two.example.internal'] })
    const earlier = new Date('2026-01-01T00:00:00Z')
    fs.utimesSync(outboundFile(home), earlier, earlier)
    expect(loader.isInternal('one.example.internal')).toBe(false)
    expect(loader.isInternal('two.example.internal')).toBe(true)
  })

  test('a project .kawai/outbound.json is never read', () => {
    const project = path.join(root, 'project')
    fs.mkdirSync(path.join(project, '.kawai'), { recursive: true })
    fs.writeFileSync(path.join(project, '.kawai', 'outbound.json'), JSON.stringify({ internal: ['project.example.internal'] }))
    const { errors, make } = errorsOf()
    const loader = make()
    expect(outboundFile(home)).toBe(path.join(home, '.kawai', 'outbound.json'))
    expect(loader.isInternal('project.example.internal')).toBe(false)
    expect(loader.facts().internal).toEqual([])
    expect(errors).toEqual([])
  })

  test('a profile base-URL host is a model provider, and so is the global one', () => {
    fs.writeFileSync(
      path.join(home, '.kawai', 'profiles.json'),
      JSON.stringify({ glm: { label: 'GLM', env: { ANTHROPIC_BASE_URL: 'https://llm.example.com/api' } } })
    )
    let globalUrl: string | undefined
    const loader = new OutboundDestinations({ homeDir: home, globalBaseUrl: () => globalUrl, matchRevalidateMs: 0 })
    expect(loader.isModelProvider('llm.example.com')).toBe(true)
    expect(loader.isModelProvider('api.anthropic.com')).toBe(true)
    expect(loader.isInternal('llm.example.com')).toBe(false)
    globalUrl = 'http://gw.example.org:9292/anthropic'
    expect(loader.isModelProvider('gw.example.org')).toBe(true)
  })

  test('a provider-level base URL is a model provider; providers.json changes re-derive', () => {
    const providersFile = path.join(home, '.kawai', 'providers.json')
    fs.writeFileSync(providersFile, JSON.stringify({
      zai: {
        label: 'Z.AI',
        env: { ANTHROPIC_BASE_URL: 'https://zai.example.internal/api/anthropic' },
        models: { glm: { label: 'GLM' }, 'glm-flash': { label: 'GLM Flash' } },
      },
    }))
    const loader = new OutboundDestinations({ homeDir: home })
    // The provider's env reaches every flattened model entry (design D1).
    expect(loader.isModelProvider('zai.example.internal')).toBe(true)
    // The stamp covers providers.json, so a change re-derives.
    fs.writeFileSync(providersFile, JSON.stringify({
      zai: { env: { ANTHROPIC_BASE_URL: 'https://other.example.internal/api' }, models: { glm: {} } },
    }))
    expect(loader.isModelProvider('zai.example.internal')).toBe(false)
    expect(loader.isModelProvider('other.example.internal')).toBe(true)
  })

  test('entry forms: domains match subdomains, ports restrict, CIDRs and brackets contain', () => {
    write({
      internal: ['example.internal', 'svc.example.com:8443', '192.0.2.0/24', '2001:db8::/32', '198.51.100.7:8443'],
    })
    const loader = new OutboundDestinations({ homeDir: home })
    expect(loader.isInternal('EXAMPLE.internal')).toBe(true)
    expect(loader.isInternal('a.b.example.internal')).toBe(true)
    expect(loader.isInternal('notexample.internal')).toBe(false)
    // The port-pinned host matches only that port.
    expect(loader.isInternal('svc.example.com', 8443)).toBe(true)
    expect(loader.isInternal('svc.example.com')).toBe(false)
    expect(loader.isInternal('svc.example.com', 80)).toBe(false)
    // CIDRs contain their range and nothing outside it.
    expect(loader.isInternal('192.0.2.199')).toBe(true)
    expect(loader.isInternal('192.0.2.199', 443)).toBe(true)
    expect(loader.isInternal('198.51.100.9')).toBe(false)
    expect(loader.isInternal('2001:db8:ffff::1')).toBe(true)
    expect(loader.isInternal('2001:db9::1')).toBe(false)
    // A port-pinned IPv4 literal outside the configured CIDR.
    expect(loader.isInternal('198.51.100.7', 8443)).toBe(true)
    expect(loader.isInternal('198.51.100.7', 80)).toBe(false)
    expect(loader.isInternal('198.51.100.7')).toBe(false)
  })

  test('configured mcpServers are allowed; facts render as written', () => {
    write({ internal: ['example.internal'], modelProviders: ['llm.example.com'], mcpServers: ['docs-search', 'docs-search'] })
    const loader = new OutboundDestinations({ homeDir: home })
    expect(loader.isAllowedMcpServer('docs-search')).toBe(true)
    expect(loader.isAllowedMcpServer('other')).toBe(false)
    expect(loader.facts()).toEqual({ internal: ['example.internal'], modelProviders: ['llm.example.com'] })
  })
})

describe('OutboundDestinations matching path (CC #161 review)', () => {
  let root: string
  let home: string
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-outbound-hot-')))
    home = path.join(root, 'home')
    fs.mkdirSync(path.join(home, '.kawai'), { recursive: true })
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  test('the matching path serves its window without stat-ing, facts stays exact', () => {
    fs.writeFileSync(outboundFile(home), JSON.stringify({ internal: ['one.example.internal'] }))
    const loader = new OutboundDestinations({ homeDir: home, matchRevalidateMs: 60_000 })
    expect(loader.isInternal('one.example.internal')).toBe(true)
    fs.writeFileSync(outboundFile(home), JSON.stringify({ internal: ['two.example.internal'] }))
    // Within the window the hot path keeps its cached snapshot…
    expect(loader.isInternal('one.example.internal')).toBe(true)
    expect(loader.isInternal('two.example.internal')).toBe(false)
    // …while the spawn path (facts) reads exact.
    expect(loader.facts().internal).toEqual(['two.example.internal'])
  })

  test('file errors report once per content change, not per stamp change', () => {
    const errors: string[] = []
    let globalUrl: string | undefined
    const loader = new OutboundDestinations({
      homeDir: home,
      matchRevalidateMs: 0,
      globalBaseUrl: () => globalUrl,
      onErrors: lines => errors.push(...lines),
    })
    expect(errors).toEqual([])
    fs.writeFileSync(outboundFile(home), '{ not json')
    loader.facts()
    expect(errors).toHaveLength(1)
    // A stamp change from another half (the global base URL) re-derives the
    // snapshot but does not re-report the same file errors.
    globalUrl = 'https://llm.example.com'
    loader.facts()
    globalUrl = 'https://gw.example.org'
    loader.facts()
    expect(errors).toHaveLength(1)
    // New content with a different error reports again; a clean file resets
    // the pin, so the same error returning reports once more.
    fs.writeFileSync(outboundFile(home), '[]')
    loader.facts()
    expect(errors).toHaveLength(2)
    fs.writeFileSync(outboundFile(home), JSON.stringify({ internal: ['example.internal'] }))
    loader.facts()
    expect(errors).toHaveLength(2)
    fs.writeFileSync(outboundFile(home), '{ not json')
    loader.facts()
    expect(errors).toHaveLength(3)
  })
})

describe('OutboundDestinations matching window and stat errors (CC)', () => {
  let root: string
  let home: string
  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kawai-outbound-window-')))
    home = path.join(root, 'home')
    fs.mkdirSync(path.join(home, '.kawai'), { recursive: true })
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  test('a positive window passes: the edit is seen once the clock advances', () => {
    fs.writeFileSync(outboundFile(home), JSON.stringify({ internal: ['one.example.internal'] }))
    let clock = 0
    const loader = new OutboundDestinations({ homeDir: home, matchRevalidateMs: 5_000, matchNow: () => clock })
    expect(loader.isInternal('one.example.internal')).toBe(true)
    fs.writeFileSync(outboundFile(home), JSON.stringify({ internal: ['two.example.internal'] }))
    expect(loader.isInternal('two.example.internal')).toBe(false)
    clock = 6_000
    expect(loader.isInternal('two.example.internal')).toBe(true)
    expect(loader.isInternal('one.example.internal')).toBe(false)
  })

  test('the window is stamped per pass: no revalidation while it holds (CC round 3)', () => {
    // A clock far from zero: if matchedAt were never stamped, every call
    // would read as outside the window and re-read the file — the edit would
    // show through immediately and this test fails.
    fs.writeFileSync(outboundFile(home), JSON.stringify({ internal: ['one.example.internal'] }))
    let clock = 60_000
    const loader = new OutboundDestinations({ homeDir: home, matchRevalidateMs: 5_000, matchNow: () => clock })
    expect(loader.isInternal('one.example.internal')).toBe(true)
    fs.writeFileSync(outboundFile(home), JSON.stringify({ internal: ['two.example.internal'] }))
    for (let call = 0; call < 5; call++) {
      expect(loader.isInternal('two.example.internal')).toBe(false)
      expect(loader.isInternal('one.example.internal')).toBe(true)
    }
    clock = 66_000
    expect(loader.isInternal('two.example.internal')).toBe(true)
    expect(loader.isInternal('one.example.internal')).toBe(false)
  })

  test('a stat error other than a missing file reports once and the defaults apply', () => {
    // ~/.kawai as a plain file makes the outbound path ENOTDIR, not ENOENT.
    const brokenHome = path.join(root, 'broken')
    fs.writeFileSync(path.join(brokenHome), 'not a directory')
    const errors: string[] = []
    let clock = 0
    const loader = new OutboundDestinations({
      homeDir: brokenHome,
      matchRevalidateMs: 0,
      matchNow: () => clock,
      onErrors: lines => errors.push(...lines),
    })
    expect(loader.facts()).toEqual({ internal: [], modelProviders: [] })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('cannot stat')
    // Re-reads through other stamp halves do not repeat it.
    loader.facts()
    expect(errors).toHaveLength(1)
    // A good home beside it stays quiet.
    const quiet = new OutboundDestinations({ homeDir: home, onErrors: lines => errors.push(...lines) })
    expect(quiet.facts()).toEqual({ internal: [], modelProviders: [] })
    expect(errors).toHaveLength(1)
  })
})
