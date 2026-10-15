// The outbound classifier's matching half (execution-safety-recovery D4):
// `parseSends` walks a parsed command's segments and names each one the rules
// table flags as a send, resolving its target from argument positions and
// flags — never by searching text. Message, title, and body values, and
// anything a heredoc carried, are values and never targets; a `GH_REPO`,
// `GH_HOST`, `GIT_DIR`, or `GIT_WORK_TREE` assignment — as a prefix, through
// `env`, or set by an earlier segment — makes the affected target unresolved,
// because the classifier does not evaluate shell variables. Pure like the
// rest of `src/server/outbound/`.
import { parseCommand } from './parse'
import type { SendCandidate, SendTarget } from './classify'

/** Words that mean "unexpanded text": variables and command substitution. */
const OPAQUE = /[$`]/

const GH_WRITE_COMMANDS = new Set(['issue', 'pr', 'release', 'repo', 'gist', 'label', 'secret', 'variable', 'workflow', 'run'])
const GH_WRITE_VERBS = new Set([
  'create', 'edit', 'close', 'reopen', 'comment', 'merge', 'delete', 'review',
  'upload', 'set', 'run', 'cancel', 'rerun', 'archive', 'restore', 'unarchive',
  'enable', 'disable', 'add', 'remove', 'deploy', 'watch-run', 'transfer', 'rename',
])
const REGISTRY_DEFAULTS: Record<string, string> = {
  npm: 'registry.npmjs.org', pnpm: 'registry.npmjs.org', yarn: 'registry.yarnpkg.com',
  bun: 'registry.npmjs.org', cargo: 'crates.io', twine: 'pypi.org', docker: 'docker.io',
  podman: 'docker.io', helm: 'docker.io', buildctl: 'docker.io',
}

const URLISH = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//
const SCPISH = /^[^@/\s]+@[^:\s]+:/

/** The first component of an image or OCI reference, when it names a registry. */
function registryOf(reference: string): string | null {
  if (!reference.includes('/')) return null
  const first = reference.split('/')[0] ?? ''
  if (first === '.' || first === '..') return null
  return first.includes('.') || first.includes(':') || first === 'localhost' ? first : null
}

interface Word {
  text: string
  opaque: boolean
}

interface Scan {
  /** Non-flag arguments in order. */
  positionals: Word[]
  /** Every value a listed value-flag took, attached (`--f=v`, `-fv`) or separate. */
  values(...names: string[]): Word[]
  /** Whether a listed flag appears at all (value flags count too). */
  has(...names: string[]): boolean
}

/**
 * Walk `argv` from `start`, splitting flag values from positionals. `value`
 * lists the long and short flags that consume a value; everything else
 * starting `-` is a boolean flag. `--` ends the flags.
 */
function scan(argv: string[], start: number, value: string[]): Scan {
  const positionals: Word[] = []
  const found: Array<{ name: string; value: Word | null }> = []
  let onlyPositionals = false
  for (let i = start; i < argv.length; i++) {
    const text = argv[i]!
    const opaque = OPAQUE.test(text)
    if (!onlyPositionals && text === '--') { onlyPositionals = true; continue }
    if (!onlyPositionals && text.startsWith('-') && text !== '-') {
      const eq = text.indexOf('=')
      const attached = eq === -1 ? null : text.slice(eq + 1)
      let name = (eq === -1 ? text : text.slice(0, eq))
      // Short flags may carry their value attached: `-XPOST`, `-Rother/repo`.
      if (!name.startsWith('--') && name.length > 2 && value.includes(name.slice(0, 2))) {
        found.push({ name: name.slice(0, 2), value: { text: text.slice(2), opaque } })
        continue
      }
      if (value.includes(name)) {
        if (attached !== null) found.push({ name, value: { text: attached, opaque } })
        else if (i + 1 < argv.length) {
          const next = argv[i + 1]!
          found.push({ name, value: { text: next, opaque: OPAQUE.test(next) } })
          i++
        } else found.push({ name, value: null })
        continue
      }
      found.push({ name, value: null })
      continue
    }
    positionals.push({ text, opaque })
  }
  return {
    positionals,
    values: (...names: string[]) => found.filter(entry => names.includes(entry.name) && entry.value !== null).map(entry => entry.value!),
    has: (...names: string[]) => found.some(entry => names.includes(entry.name)),
  }
}

/** The gh repository target: `-R`/`--repo`, a URL positional, else origin. */
function ghRepoTarget(scanned: Scan, positionals: Word[]): SendTarget {
  const value = scanned.values('-R', '--repo')[0]
  if (value !== undefined) {
    if (value.opaque) return { kind: 'unresolved', why: 'the target is a variable or command substitution' }
    const asUrl = URLISH.test(value.text) ? parseRepoUrl(value.text) : null
    if (asUrl !== null) return asUrl
    const parts = value.text.split('/')
    if (parts.length === 3) return { kind: 'repo', repo: `${parts[1]}/${parts[2]}`, host: parts[0]!.toLowerCase() }
    return { kind: 'repo', repo: value.text }
  }
  const positional = positionals.find(word => word.text.startsWith('github.com/')) ?? null
  if (positional !== null && !positional.opaque) {
    const parts = positional.text.replace(/\.git$/, '').split('/')
    if (parts.length === 3) return { kind: 'repo', repo: `${parts[1]}/${parts[2]}`, host: 'github.com' }
  }
  return { kind: 'origin-implicit' }
}

function parseRepoUrl(text: string): SendTarget | null {
  try {
    const url = new URL(text)
    const parts = url.pathname.replace(/^\/+|\/+$/g, '').split('/')
    if (parts.length < 2) return { kind: 'host', host: url.hostname }
    return { kind: 'repo', repo: `${parts[0]}/${parts[1].replace(/\.git$/, '')}`, host: url.hostname.toLowerCase() }
  } catch {
    return null
  }
}

const MAIL_TOOLS = new Set(['sendmail', 'msmtp', 'mailx', 'ssmtp'])

/** The first positional that is the URL: one that parses, else the first opaque word. */
function pickUrl(words: Word[]): Word | undefined {
  for (const word of words) {
    if (word.opaque) continue
    for (const text of [word.text, `http://${word.text}`]) {
      try {
        new URL(text)
        return word
      } catch {
        // Not a URL; keep looking.
      }
    }
  }
  return words.find(word => word.opaque) ?? words[0]
}

/** The URL's host and port; a bare host reads as http; smtp URLs are mail. */
function httpUrlTarget(word: Word | undefined): SendTarget {
  if (word === undefined) return { kind: 'unresolved', why: 'no URL in the command' }
  if (word.opaque) return { kind: 'unresolved', why: 'the target is a variable or command substitution' }
  for (const text of [word.text, `http://${word.text}`]) {
    try {
      const url = new URL(text)
      if (url.protocol === 'smtp:' || url.protocol === 'smtps:') return { kind: 'mail' }
      return { kind: 'host', host: url.hostname, ...(url.port ? { port: Number(url.port) } : {}) }
    } catch {
      // Try the bare-host form once, then read it unresolved.
    }
  }
  return { kind: 'unresolved', why: 'no URL in the command' }
}

/** `git push` (D4): `--repo`, the named remote, a URL or scp target, else the push remote. */
function gitPushTarget(argv: string[], subcommandAt: number, gitPinned: string | null): SendTarget {
  if (gitPinned !== null) return { kind: 'unresolved', why: gitPinned }
  const scanned = scan(argv, subcommandAt + 1, ['--repo', '-o', '--push-option', '--receive-pack', '--exec'])
  const repo = scanned.values('--repo')[0]
  if (repo !== undefined) {
    if (repo.opaque) return { kind: 'unresolved', why: 'the target is a variable or command substitution' }
    if (URLISH.test(repo.text) || SCPISH.test(repo.text)) return { kind: 'url', url: repo.text }
    return { kind: 'remote', name: repo.text }
  }
  const first = scanned.positionals[0]
  if (first === undefined) return { kind: 'origin-implicit' }
  if (first.opaque) return { kind: 'unresolved', why: 'the target is a variable or command substitution' }
  if (URLISH.test(first.text) || SCPISH.test(first.text)) return { kind: 'url', url: first.text }
  const refspec = first.text.includes(':') || first.text.startsWith('+') || first.text.startsWith('refs/') || first.text === 'HEAD'
  return refspec ? { kind: 'origin-implicit' } : { kind: 'remote', name: first.text }
}

/** The registry host a publish flags or its image names; the tool's public default otherwise. */
function registryTarget(head: string, host: Word | undefined, reference: Word | undefined): SendTarget {
  if (host !== undefined) {
    if (host.opaque) return { kind: 'unresolved', why: 'the target is a variable or command substitution' }
    if (URLISH.test(host.text)) {
      try {
        return { kind: 'registry', host: new URL(host.text).hostname.toLowerCase() }
      } catch {
        return { kind: 'unresolved', why: 'the registry did not parse as a URL' }
      }
    }
    return { kind: 'registry', host: host.text.toLowerCase() }
  }
  if (reference !== undefined) {
    if (reference.opaque) return { kind: 'unresolved', why: 'the target is a variable or command substitution' }
    return { kind: 'registry', host: registryOf(reference.text) ?? REGISTRY_DEFAULTS[head] ?? 'docker.io' }
  }
  return { kind: 'registry', host: REGISTRY_DEFAULTS[head] ?? 'docker.io' }
}

/** Parse a whole command into its send candidates (D4's rules table). */
export function parseSends(command: string, cwd: string): SendCandidate[] {
  return parseCommand(command, cwd).flatMap(segment => candidatesOf(segment))
}

function candidatesOf(segment: { argv: string[]; text: string; cwd: string; env: ReadonlyMap<string, string | null> }): SendCandidate[] {
  const { argv, text, cwd, env } = segment
  if (argv.length === 0) return []
  const base = (rule: SendCandidate['rule'], target: SendTarget): SendCandidate => ({ rule, segment: text, cwd, target })
  const ghPinned = env.has('GH_REPO') ? 'GH_REPO is set' : env.has('GH_HOST') ? 'GH_HOST is set' : null
  const gitPinned = env.has('GIT_DIR') ? 'GIT_DIR is set' : env.has('GIT_WORK_TREE') ? 'GIT_WORK_TREE is set' : null
  const head = argv[0]!.split('/').pop()!.toLowerCase()
  const variable = { kind: 'unresolved', why: 'the target is a variable or command substitution' } as const

  if (head === 'git') {
    // Skip the global flags to find the subcommand.
    let subcommandAt = -1
    for (let i = 1; i < argv.length; i++) {
      const word = argv[i]!
      if (word === '-C' || word === '-c') { i++; continue }
      if (word.startsWith('--git-dir') || word.startsWith('--work-tree') || word.startsWith('--namespace')) {
        if (!word.includes('=')) i++
        continue
      }
      if (word.startsWith('-')) continue
      subcommandAt = i
      break
    }
    if (subcommandAt !== -1 && argv[subcommandAt] === 'push') {
      return [base('git-push', gitPushTarget(argv, subcommandAt, gitPinned))]
    }
    return []
  }

  if (head === 'gh') {
    if (argv[1] === 'api') {
      const scanned = scan(argv, 2, ['-X', '--method', '-f', '-F', '--field', '--raw-field', '--input', '-H', '--header', '-a', '--hostname'])
      const method = scanned.values('-X', '--method')[0]
      const writes = (method !== undefined && method.text.toUpperCase() !== 'GET') || scanned.has('-f', '-F', '--field', '--raw-field', '--input')
      if (!writes) return []
      if (ghPinned !== null) return [base('gh-api-write', { kind: 'unresolved', why: ghPinned })]
      const path = scanned.positionals[0]
      if (path === undefined || path.opaque) return [base('gh-api-write', variable)]
      const parts = path.text.split('/')
      if (parts[0] !== 'repos' || parts.length < 3) {
        return [base('gh-api-write', { kind: 'unresolved', why: 'the API path names no repository' })]
      }
      return [base('gh-api-write', { kind: 'repo', repo: `${parts[1]}/${parts[2]}` })]
    }
    if (GH_WRITE_COMMANDS.has(argv[1] ?? '') && GH_WRITE_VERBS.has(argv[2] ?? '')) {
      if (ghPinned !== null) return [base('gh-write', { kind: 'unresolved', why: ghPinned })]
      const scanned = scan(argv, 3, ['-R', '--repo', '--hostname', '--body', '--body-file', '--title', '--assignee', '--label', '--project', '--milestone', '--base', '--head', '--reviewer'])
      return [base('gh-write', ghRepoTarget(scanned, scanned.positionals))]
    }
    return []
  }

  if (head === 'npm' || head === 'pnpm' || head === 'yarn' || head === 'bun') {
    if (argv[1] !== 'publish') return []
    const scanned = scan(argv, 2, ['--registry', '--tag', '--access'])
    return [base('registry-publish', registryTarget(head, scanned.values('--registry')[0], undefined))]
  }
  if (head === 'twine') {
    if (argv[1] !== 'upload') return []
    const scanned = scan(argv, 2, ['--repository-url', '--index-url', '-r', '--repository', '-i', '--user', '--password', '--verbose'])
    const named = scanned.values('--repository-url', '--index-url')[0]
    if (named !== undefined) return [base('registry-publish', registryTarget(head, named, undefined))]
    const short = scanned.values('-r', '--repository')[0]
    if (short !== undefined) {
      if (short.opaque) return [base('registry-publish', variable)]
      if (!URLISH.test(short.text)) return [base('registry-publish', { kind: 'unresolved', why: 'the twine repository is a name, not a URL' })]
      return [base('registry-publish', registryTarget(head, short, undefined))]
    }
    return [base('registry-publish', registryTarget(head, undefined, undefined))]
  }
  if (head === 'cargo') {
    if (argv[1] !== 'publish') return []
    const scanned = scan(argv, 2, ['--registry', '--index', '--token'])
    return [base('registry-publish', registryTarget(head, scanned.values('--registry', '--index')[0], undefined))]
  }
  if (head === 'docker' || head === 'podman') {
    if (argv[1] === 'push') {
      return [base('registry-publish', registryTarget(head, undefined, { text: argv[2] ?? '', opaque: argv[2] === undefined ? true : OPAQUE.test(argv[2]!) }))]
    }
    if (head === 'docker' && argv[1] === 'buildx' && argv[2] === 'build') {
      const scanned = scan(argv, 3, ['-t', '--tag', '--output', '--builder', '--file', '-f', '--target', '--platform'])
      if (!scanned.has('--push') && !scanned.values('--output').some(word => word.text.includes('push=true'))) return []
      const output = scanned.values('--output').find(word => word.text.includes('push=true'))
      const named = output?.text.split(',').find(part => part.startsWith('name='))?.slice(5)
      if (named !== undefined) return [base('registry-publish', registryTarget(head, undefined, { text: named, opaque: false }))]
      return [base('registry-publish', registryTarget(head, undefined, scanned.values('-t', '--tag').at(-1)))]
    }
    return []
  }
  if (head === 'buildctl') {
    const scanned = scan(argv, 1, ['--output', '--local', '--frontend', '--opt', '--progress'])
    const output = scanned.values('--output').find(word => word.text.includes('push=true'))
    if (output === undefined) return []
    const named = output.text.split(',').find(part => part.startsWith('name='))?.slice(5)
    if (named === undefined) return [base('registry-publish', registryTarget(head, undefined, undefined))]
    return [base('registry-publish', registryTarget(head, undefined, { text: named, opaque: OPAQUE.test(named) }))]
  }
  if (head === 'helm') {
    if (argv[1] !== 'push') return []
    const scanned = scan(argv, 2, ['--registry-config', '--plain-http', '--insecure', '--ca-file', '--cert-file', '--key-file', '--username', '--password'])
    const repository = scanned.positionals[1]
    if (repository === undefined || repository.opaque) return [base('registry-publish', variable)]
    if (!URLISH.test(repository.text)) return [base('registry-publish', { kind: 'unresolved', why: 'the helm repository is not a URL' })]
    try {
      return [base('registry-publish', { kind: 'registry', host: new URL(repository.text).hostname.toLowerCase() })]
    } catch {
      return [base('registry-publish', variable)]
    }
  }

  if (head === 'curl') {
    const scanned = scan(argv, 1, [
      '-X', '--request', '-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode',
      '-F', '--form', '-T', '--upload-file', '--url', '-u', '--user', '-H', '--header', '-o', '--output',
      '-A', '--user-agent', '-b', '--cookie', '-e', '--referer', '-E', '--cert', '--key', '-x', '--proxy', '-U', '--proxy-user',
      '-m', '--max-time', '--connect-timeout', '--retry', '--retry-delay',
    ])
    const target = httpUrlTarget(scanned.values('--url')[0] ?? pickUrl(scanned.positionals))
    if (target.kind === 'mail') return [base('mail-send', target)]
    const method = scanned.values('-X', '--request')[0]?.text.toUpperCase()
    const body = scanned.has('-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode', '-F', '--form', '-T', '--upload-file', '--json')
    // `-G` moves any data into the URL's query: a read, not a send.
    const sends = !scanned.has('-G') && (body || (method !== undefined && method !== 'GET' && method !== 'HEAD'))
    if (!sends) return []
    return [base('http-send', target)]
  }
  if (head === 'wget') {
    const scanned = scan(argv, 1, ['--post-data', '--post-file', '--method', '-O', '--output-document', '--header', '--user', '--password', '--timeout', '--tries'])
    const target = httpUrlTarget(pickUrl(scanned.positionals))
    if (target.kind === 'mail') return [base('mail-send', target)]
    const method = scanned.values('--method')[0]
    const body = scanned.has('--post-data', '--post-file')
    if (!body && (method === undefined || ['GET', 'HEAD'].includes(method.text.toUpperCase()))) return []
    return [base('http-send', target)]
  }
  if (head === 'http' || head === 'https') {
    const scanned = scan(argv, 1, ['--auth', '--proxy', '--verify', '--timeout', '--session'])
    const positionals = scanned.positionals
    const maybeMethod = positionals[0]
    const method = maybeMethod !== undefined && /^[A-Z]+$/.test(maybeMethod.text) ? maybeMethod.text : undefined
    const url = method === undefined ? positionals[0] : positionals[1]
    const items = positionals.slice(method === undefined ? 1 : 2)
    const target = httpUrlTarget(url)
    if (target.kind === 'mail') return [base('mail-send', target)]
    const body = items.some(word => word.text.includes('=') || word.text.includes(':'))
    if (!body && (method === undefined || method === 'GET' || method === 'HEAD')) return []
    return [base('http-send', target)]
  }

  if (MAIL_TOOLS.has(head)) return [base('mail-send', { kind: 'mail' })]
  if (head === 'mail' && argv[1] === '-s') return [base('mail-send', { kind: 'mail' })]
  if ((head === 'python' || head === 'python3') && argv[1] === '-m' && argv[2] === 'smtpd') {
    return [base('mail-send', { kind: 'mail' })]
  }
  return []
}
