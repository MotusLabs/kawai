// Outbound destinations (execution-safety-recovery design D2): the owner's
// user-level `~/.kawai/outbound.json`, the only place internal destinations
// are configured —
//
//   { "internal": ["example.internal", "build.example.internal", "192.0.2.0/24"],
//     "modelProviders": ["llm.example.com"],
//     "mcpServers": ["docs-search"] }
//
// `internal` entries are domains (matching themselves and every subdomain),
// hosts with an optional `:port`, or IPv4/IPv6 CIDRs and literals. Every key
// is optional; an unknown key is reported and ignored; a malformed entry is
// reported and dropped while its siblings apply; a file that does not parse
// is reported and the defaults apply. Like TeamCaps, the file is read at
// startup and re-read whenever its mtime/size stamp changes, sharing one
// read per stamp among callers — synchronously, because the prompt is built
// on the sync getSystemPromptAppend path at spawn — and a project
// `.kawai/outbound.json` is never read: destinations are user-level
// configuration only.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { profileCatalogLevels, resolveProfileCatalog } from '../chat/profileCatalog'

/** What the security note renders (design D1): configured entries, as written. */
export interface OutboundPromptFacts {
  /** Configured `internal` entries, as written. */
  internal: string[]
  /** Configured extra `modelProviders` hosts, as written. */
  modelProviders: string[]
}

export function outboundFile(homeDir?: string): string {
  return path.join(homeDir ?? process.env.HOME ?? os.homedir(), '.kawai', 'outbound.json')
}

/** Loopback and the private ranges are always internal (D2). */
const DEFAULT_INTERNAL_CIDRS = [
  '127.0.0.0/8', '::1/128', '10.0.0.0/8', '172.16.0.0/12',
  '192.168.0.0/16', 'fc00::/7', '169.254.0.0/16',
] as const
/** Names always internal (D2): loopback by name. */
const DEFAULT_INTERNAL_NAMES = ['localhost'] as const
/**
 * Public model-provider endpoints every build knows (D2): the API host plus
 * the claude.ai login hosts the CLI uses. Profile gateways are derived on
 * top of these; none of them is internal.
 */
export const DEFAULT_MODEL_PROVIDER_HOSTS = ['api.anthropic.com', 'claude.ai', 'www.claude.ai'] as const

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/** Numeric IPv4 address, or null when `text` is not one. */
function parseIPv4(text: string): number | null {
  const match = IPV4_PATTERN.exec(text)
  if (!match) return null
  const parts = match.slice(1).map(Number)
  if (parts.some(part => part > 255)) return null
  return parts.reduce((acc, part) => acc * 256 + part, 0)
}

/** Expanded IPv6 address as a bigint, or null; dotted-quad tails accepted. */
function parseIPv6(text: string): bigint | null {
  if (!/^[0-9a-fA-F:.]+$/.test(text)) return null
  const halves = text.split('::')
  if (halves.length > 2) return null
  const expand = (half: string): number[] | null => {
    if (half === '') return []
    const groups: number[] = []
    for (const part of half.split(':')) {
      if (part.includes('.')) {
        const v4 = parseIPv4(part)
        if (v4 === null) return null
        groups.push(v4 >>> 16, v4 & 0xffff)
      } else {
        if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null
        groups.push(Number.parseInt(part, 16))
      }
    }
    return groups
  }
  const head = expand(halves[0] ?? '')
  if (head === null) return null
  const tail = halves.length === 2 ? expand(halves[1] ?? '') : []
  if (tail === null || head.length + tail.length > 8) return null
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0
  if (head.length + tail.length + fill !== 8) return null
  const groups = [...head, ...Array<number>(fill).fill(0), ...tail]
  return groups.reduce((acc, group) => (acc << 16n) + BigInt(group), 0n)
}

/** A configured `internal` entry in matching form. */
type InternalEntry =
  | { kind: 'cidr'; ipv6: boolean; base: bigint; mask: bigint; port?: number }
  | { kind: 'name'; name: string; port?: number }

function cidrMask(prefix: number, ipv6: boolean): bigint {
  const width = ipv6 ? 128n : 32n
  const bits = BigInt(prefix)
  return bits === 0n ? 0n : ((1n << bits) - 1n) << (width - bits)
}

const HOST_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i

/**
 * One `internal` entry (D2): a domain — matching itself and every subdomain —
 * a host with an optional `:port` (IPv6 in brackets), or an IPv4/IPv6 CIDR or
 * literal address. Returns the entry, or an error message naming it.
 */
function parseInternalEntry(raw: string): InternalEntry | string {
  if (raw.length === 0 || /\s/.test(raw)) return `"${raw}" must be a non-empty entry without whitespace`
  const entry = raw.toLowerCase()
  const portOf = (text: string): number | string => {
    if (!/^\d{1,5}$/.test(text)) return `"${raw}" must carry a port of 1-65535`
    const port = Number(text)
    return port >= 1 && port <= 65535 ? port : `"${raw}" must carry a port of 1-65535`
  }
  // A bracketed IPv6 host, optionally with a port: `[2001:db8::1]:443`.
  const bracketed = /^\[([0-9a-f:.]+)\](?::(\d+))?$/.exec(entry)
  if (bracketed) {
    const base = parseIPv6(bracketed[1]!)
    if (base === null) return `"${raw}" must be an IPv6 address in brackets`
    const port = bracketed[2] === undefined ? undefined : portOf(bracketed[2])
    if (typeof port === 'string') return port
    return { kind: 'cidr', ipv6: true, base, mask: cidrMask(128, true), ...(port === undefined ? {} : { port }) }
  }
  const literal = (text: string): { ipv6: boolean; base: bigint } | null => {
    const v4 = parseIPv4(text)
    if (v4 !== null) return { ipv6: false, base: BigInt(v4) }
    const v6 = parseIPv6(text)
    return v6 === null ? null : { ipv6: true, base: v6 }
  }
  const hostEntry = (host: string, port?: number): InternalEntry | string => {
    const ip = literal(host)
    if (ip) {
      return { kind: 'cidr', ...ip, mask: cidrMask(ip.ipv6 ? 128 : 32, ip.ipv6), ...(port === undefined ? {} : { port }) }
    }
    if (!host.split('.').every(label => HOST_LABEL.test(label))) return `"${raw}" is not a valid host name`
    return { kind: 'name', name: host, ...(port === undefined ? {} : { port }) }
  }
  // A CIDR: `192.0.2.0/24`, `2001:db8::/32` — the address part must be an IP.
  const slash = entry.lastIndexOf('/')
  if (slash !== -1) {
    const address = entry.slice(0, slash)
    const prefixText = entry.slice(slash + 1)
    const ip = literal(address)
    if (ip === null) return `"${raw}" is neither a host name nor an IP address or CIDR`
    if (!/^\d{1,3}$/.test(prefixText) || Number(prefixText) > (ip.ipv6 ? 128 : 32)) {
      return `"${raw}" carries a prefix length outside its address family`
    }
    return { kind: 'cidr', ...ip, mask: cidrMask(Number(prefixText), ip.ipv6) }
  }
  const colons = entry.split(':').length - 1
  // No colon: an IP literal or a plain domain.
  if (colons === 0) return hostEntry(entry)
  // One colon: `host:port`, the host itself a name or an IPv4 literal.
  if (colons === 1) {
    const colonAt = entry.indexOf(':')
    const port = portOf(entry.slice(colonAt + 1))
    if (typeof port === 'string') return port
    return hostEntry(entry.slice(0, colonAt), port)
  }
  // More colons without brackets or a slash: only a bare IPv6 literal reads.
  const v6 = parseIPv6(entry)
  if (v6 === null) return `"${raw}" must bracket IPv6 addresses to carry a port`
  return { kind: 'cidr', ipv6: true, base: v6, mask: cidrMask(128, true) }
}

/** The defaults, parsed once; the constants are valid by construction. */
const DEFAULT_INTERNAL_ENTRIES: readonly InternalEntry[] = DEFAULT_INTERNAL_CIDRS.map(
  cidr => parseInternalEntry(cidr) as InternalEntry
)

/** A query host in matching form: brackets and the trailing dot dropped. */
function normalizeHost(host: string): string {
  return host.replace(/^\[/, '').replace(/\]$/, '').toLowerCase().replace(/\.$/, '')
}

/** A query host as an IP literal; v4-mapped v6 (`::ffff:192.0.2.1`) reads as IPv4. */
function queryLiteral(host: string): { ipv6: boolean; value: bigint } | null {
  const v4 = parseIPv4(host)
  if (v4 !== null) return { ipv6: false, value: BigInt(v4) }
  const v6 = parseIPv6(host)
  if (v6 === null) return null
  if (v6 >> 32n === 0xffffn) return { ipv6: false, value: v6 & 0xffff_ffffn }
  return { ipv6: true, value: v6 }
}

/** Hostname of a base URL, normalized for matching; null when it has none. */
function hostOf(url: string): string | null {
  try {
    return normalizeHost(new URL(url).hostname)
  } catch {
    return null
  }
}

/** One read of the file and the catalog, kept while their stamps hold. */
interface OutboundSnapshot {
  /** Configured `internal` entries, as written. */
  internal: string[]
  /** Configured extra `modelProviders` hosts, as written. */
  modelProviders: string[]
  /** Configured `mcpServers` names, in matching form. */
  mcpServers: Set<string>
  /** Every internal entry in matching form, defaults first. */
  entries: readonly InternalEntry[]
  /** Every host that counts as a model provider. */
  modelHosts: Set<string>
}

export class OutboundDestinations {
  /** The last read, keyed by the stamp it was read under. */
  private cache: { stamp: string; snapshot: OutboundSnapshot } | null = null

  constructor(private readonly options: {
    homeDir?: string
    /** Problems with the file, one line each; defaults apply where they occur. */
    onErrors?: (errors: string[]) => void
    /** Base URL every profile without one inherits (the server's provider env). */
    globalBaseUrl?: () => string | undefined
  } = {}) {
    // Startup read; later calls re-read only when the files changed.
    void this.current()
  }

  /** The configured entries the security note renders (D1), as written. */
  facts(): OutboundPromptFacts {
    const snapshot = this.current()
    return { internal: [...snapshot.internal], modelProviders: [...snapshot.modelProviders] }
  }

  /**
   * Whether a host counts as internal: a configured entry, or loopback or a
   * private range (the defaults). Names match themselves and their subdomains;
   * a `host:port` entry matches only that port, so a query without one — or
   * with another — does not match it.
   */
  isInternal(host: string, port?: number): boolean {
    const normalized = normalizeHost(host)
    const literal = queryLiteral(normalized)
    for (const entry of this.current().entries) {
      if (entry.port !== undefined && entry.port !== port) continue
      if (entry.kind === 'cidr') {
        if (literal === null || entry.ipv6 !== literal.ipv6) continue
        if ((literal.value & entry.mask) === (entry.base & entry.mask)) return true
      } else if (literal === null) {
        if (normalized === entry.name || normalized.endsWith(`.${entry.name}`)) return true
      }
    }
    if (literal === null) {
      for (const name of DEFAULT_INTERNAL_NAMES) {
        if (normalized === name || normalized.endsWith(`.${name}`)) return true
      }
    }
    return false
  }

  /** Whether a host counts as a model provider (D2 defaults plus the file). */
  isModelProvider(host: string): boolean {
    return this.current().modelHosts.has(normalizeHost(host))
  }

  /** Whether an external MCP server's calls count as allowed (D5). */
  isAllowedMcpServer(server: string): boolean {
    return this.current().mcpServers.has(server)
  }

  private fileStamp(): string {
    try {
      const stat = fs.statSync(outboundFile(this.options.homeDir))
      return `${stat.mtimeMs}:${stat.size}`
    } catch {
      return 'missing'
    }
  }

  /** The stamp of the profile catalog files the derived hosts come from. */
  private catalogStamp(): string {
    const levels = profileCatalogLevels(
      this.options.homeDir ? { homeDir: this.options.homeDir } : {}
    )
    return levels.map(level => {
      try {
        const stat = fs.statSync(level.file)
        return `${stat.mtimeMs}:${stat.size}`
      } catch {
        return 'missing'
      }
    }).join('|')
  }

  private current(): OutboundSnapshot {
    // The global base URL joins the stamp: a Settings change re-derives too.
    const stamp = `${this.fileStamp()}\n${this.catalogStamp()}\n${this.options.globalBaseUrl?.() ?? ''}`
    if (this.cache?.stamp !== stamp) this.cache = { stamp, snapshot: this.load() }
    return this.cache.snapshot
  }

  private load(): OutboundSnapshot {
    const file = outboundFile(this.options.homeDir)
    const errors: string[] = []
    const internal: string[] = []
    const modelProviders: string[] = []
    const mcpServers = new Set<string>()
    const entries: InternalEntry[] = []
    let parsed: unknown
    if (this.fileStamp() !== 'missing') {
      try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
      } catch (error) {
        errors.push(`${file}: ${(error as Error).message}; using the defaults`)
      }
    }
    if (parsed !== undefined) {
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        errors.push(`${file}: expected a JSON object; using the defaults`)
      } else {
        const root = parsed as Record<string, unknown>
        for (const key of Object.keys(root)) {
          if (key !== 'internal' && key !== 'modelProviders' && key !== 'mcpServers') {
            errors.push(`${file}: unknown key "${key}" is ignored`)
          }
        }
        const readArray = (key: 'internal' | 'modelProviders' | 'mcpServers'): unknown[] | null => {
          const value = root[key]
          if (value === undefined) return null
          if (!Array.isArray(value)) {
            errors.push(`${file}: ${key} must be an array`)
            return null
          }
          return value
        }
        for (const value of readArray('internal') ?? []) {
          if (typeof value !== 'string') {
            errors.push(`${file}: internal entry ${JSON.stringify(value)} must be a string`)
            continue
          }
          const entry = parseInternalEntry(value)
          if (typeof entry === 'string') errors.push(`${file}: internal entry ${entry}`)
          else {
            internal.push(value)
            entries.push(entry)
          }
        }
        for (const value of readArray('modelProviders') ?? []) {
          if (typeof value !== 'string' || !value.split('.').every(label => HOST_LABEL.test(label))) {
            errors.push(`${file}: modelProviders entry ${JSON.stringify(value)} must be a host name`)
            continue
          }
          modelProviders.push(value)
        }
        for (const value of readArray('mcpServers') ?? []) {
          if (typeof value !== 'string' || value.length === 0 || /\s/.test(value)) {
            errors.push(`${file}: mcpServers entry ${JSON.stringify(value)} must be a name without whitespace`)
            continue
          }
          mcpServers.add(value)
        }
      }
    }
    if (errors.length > 0) this.options.onErrors?.(errors)
    // Derived model-provider hosts: every configured profile's base URL from
    // the home-scoped catalog (never a project file) plus the global one.
    const modelHosts = new Set<string>(DEFAULT_MODEL_PROVIDER_HOSTS)
    const catalog = resolveProfileCatalog(
      this.options.homeDir ? { homeDir: this.options.homeDir } : {}
    )
    for (const profile of catalog.profiles.values()) {
      const url = profile.env.ANTHROPIC_BASE_URL
      const host = url ? hostOf(url) : null
      if (host) modelHosts.add(host)
    }
    const globalUrl = this.options.globalBaseUrl?.()
    const globalHost = globalUrl ? hostOf(globalUrl) : null
    if (globalHost) modelHosts.add(globalHost)
    for (const host of modelProviders) modelHosts.add(normalizeHost(host))
    return {
      internal,
      modelProviders,
      mcpServers,
      entries: [...DEFAULT_INTERNAL_ENTRIES, ...entries],
      modelHosts,
    }
  }
}
