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
    const loader = new OutboundDestinations({ homeDir: home })
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
    const loader = new OutboundDestinations({ homeDir: home, globalBaseUrl: () => globalUrl })
    expect(loader.isModelProvider('llm.example.com')).toBe(true)
    expect(loader.isModelProvider('api.anthropic.com')).toBe(true)
    expect(loader.isInternal('llm.example.com')).toBe(false)
    globalUrl = 'http://gw.example.org:9292/anthropic'
    expect(loader.isModelProvider('gw.example.org')).toBe(true)
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
