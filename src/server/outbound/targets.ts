// Target readers shared by the rule tables (execution-safety-recovery D4):
// a URL's host and port, a registry from a flag or an image reference, and a
// git push target. Each reads one already-literal word; a word that is not a
// URL reads a fixed code, never text from the command. Pure.
import type { SendTarget } from './classify'
import { unresolved } from './proof'
import type { Word } from './tokenize'

export const URLISH = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//
export const SCPISH = /^[^@/\s]+@[^:\s]+:/

/** Public default registries by tool. */
const REGISTRY_DEFAULTS: Record<string, string> = {
  npm: 'registry.npmjs.org', pnpm: 'registry.npmjs.org', yarn: 'registry.yarnpkg.com',
  bun: 'registry.npmjs.org', cargo: 'crates.io', twine: 'pypi.org', docker: 'docker.io',
  podman: 'docker.io', helm: 'docker.io', buildctl: 'docker.io',
}

/** A word that reads as a URL: a scheme form, or a bare `host[:port][/path]`. */
export function isUrlWord(text: string): boolean {
  return URLISH.test(text) || /^([A-Za-z0-9-]+\.)+[A-Za-z0-9-]+(:\d{1,5})?([/?#]|$)/.test(text) || /^localhost(:\d{1,5})?([/?#]|$)/.test(text)
}

/** The URL's scheme, lowercase; `http` for a bare host (curl's and wget's default). */
export function schemeOf(text: string): string {
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(text)
  return scheme === null ? 'http' : scheme[1]!.toLowerCase()
}

/**
 * The URL's host and port. A `scheme://` text parses as a URL (smtp ones are
 * mail); a bare text is read as `host[:port]` — `new URL('localhost:8080')`
 * would take `localhost:` for a scheme and leave no host at all.
 */
export function httpUrlTarget(word: Word | undefined): SendTarget {
  if (word === undefined) return unresolved('no-url')
  if (URLISH.test(word.text)) {
    try {
      const url = new URL(word.text)
      if (url.protocol === 'smtp:' || url.protocol === 'smtps:') return { kind: 'mail' }
      if (url.hostname === '') return unresolved('target-not-url')
      return { kind: 'host', host: url.hostname.toLowerCase().replace(/^\[|\]$/g, ''), ...(url.port ? { port: Number(url.port) } : {}) }
    } catch {
      return unresolved('target-not-url')
    }
  }
  const authority = word.text.split(/[/?#]/, 1)[0] ?? ''
  const bare = /^([A-Za-z0-9._-]+|\[[0-9a-fA-F:.]+\])(?::(\d{1,5}))?$/.exec(authority)
  if (bare === null) return unresolved('target-not-url')
  return { kind: 'host', host: bare[1]!.toLowerCase().replace(/^\[|\]$/g, ''), ...(bare[2] !== undefined ? { port: Number(bare[2]) } : {}) }
}

/** A registry named by a flag value: a URL, or `host[:port]`. */
export function registryFlagTarget(word: Word): SendTarget {
  if (URLISH.test(word.text)) {
    try {
      const url = new URL(word.text)
      if (url.hostname === '') return unresolved('target-not-url')
      return { kind: 'registry', host: url.hostname.toLowerCase(), ...(url.port ? { port: Number(url.port) } : {}) }
    } catch {
      return unresolved('target-not-url')
    }
  }
  const bare = /^([A-Za-z0-9.-]+)(?::(\d{1,5}))?\/?$/.exec(word.text)
  if (bare === null) return unresolved('target-not-url')
  return { kind: 'registry', host: bare[1]!.toLowerCase(), ...(bare[2] !== undefined ? { port: Number(bare[2]) } : {}) }
}

/** The registry an image or OCI reference names (`host[:port]/…`), else the tool's default. */
export function imageTarget(tool: string, reference: string): SendTarget {
  const stripped = reference.replace(/^(docker|oci):\/\//, '')
  if (stripped === '' || /\s/.test(stripped)) return unresolved('target-not-url')
  const first = stripped.includes('/') ? stripped.split('/')[0]! : ''
  const isRegistry = first.includes('.') || first.includes(':') || first === 'localhost'
  if (!isRegistry) return defaultRegistry(tool)
  const [host, port] = first.split(':')
  if (port !== undefined && !/^\d{1,5}$/.test(port)) return unresolved('target-not-url')
  return { kind: 'registry', host: host!.toLowerCase(), ...(port !== undefined ? { port: Number(port) } : {}) }
}

export const defaultRegistry = (tool: string): SendTarget => ({ kind: 'registry', host: REGISTRY_DEFAULTS[tool] ?? 'docker.io' })

/** A git push's repository word: a URL or scp target, else a remote name. */
export function gitRepositoryTarget(text: string): SendTarget {
  if (URLISH.test(text) || SCPISH.test(text)) return { kind: 'url', url: text }
  // A path names a local repository: git pushes to the filesystem.
  if (text.startsWith('/') || text.startsWith('.') || text.includes('/')) return unresolved('target-not-url')
  return { kind: 'remote', name: text }
}
