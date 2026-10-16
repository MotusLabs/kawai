// The outbound classifier's matching half (execution-safety-recovery D4):
// `parseSends` walks a parsed command's segments and names each one the rules
// table flags as a send, resolving its target from argument positions and
// flags — never by searching text. Message, title, and body values, and
// anything a heredoc carried, are values and never targets; a `GH_REPO`,
// `GH_HOST`, `GIT_DIR`, or `GIT_WORK_TREE` assignment — as a prefix, through
// `env`, or set by an earlier segment — and a `--git-dir`, `--work-tree`, or
// `remote.*`/`url.*` `git -c` override each make the affected target
// unresolved, because the classifier does not evaluate shell variables.
// `gh repo create`/`fork` and `gh gist create`/`edit` never fall back to
// origin: they publish somewhere new (D1). Reserved words, wrapping
// commands, and git config pinning are stripped by the sibling
// `unwrapping.ts` before these rules see a segment. Pure like the rest.
import { parseCommand } from './parse'
import { gitSubcommandAndPin, WRAPPED_RULE_HEADS } from './unwrapping'
import type { SendCandidate, SendTarget } from './classify'

/** Words that mean "unexpanded text": variables and command substitution. */
const OPAQUE = /[$`]/
const VARIABLE = (): SendTarget => ({ kind: 'unresolved', why: 'the target is a variable or command substitution' })

const GH_WRITE_COMMANDS = new Set(['issue', 'pr', 'release', 'repo', 'gist', 'label', 'secret', 'variable', 'workflow', 'run'])
const GH_WRITE_VERBS = new Set([
  'create', 'edit', 'close', 'reopen', 'comment', 'merge', 'delete', 'review',
  'upload', 'set', 'run', 'cancel', 'rerun', 'archive', 'restore', 'unarchive',
  'enable', 'disable', 'add', 'remove', 'deploy', 'watch-run', 'transfer', 'rename', 'fork',
])
const REGISTRY_DEFAULTS: Record<string, string> = {
  npm: 'registry.npmjs.org', pnpm: 'registry.npmjs.org', yarn: 'registry.yarnpkg.com',
  bun: 'registry.npmjs.org', cargo: 'crates.io', twine: 'pypi.org', docker: 'docker.io',
  podman: 'docker.io', helm: 'docker.io', buildctl: 'docker.io',
}
const URLISH = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//
const SCPISH = /^[^@/\s]+@[^:\s]+:/

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
 * starting `-` is a boolean flag. A short cluster walks letter by letter
 * (`-sX POST`, `-sd x`): the first value-flag letter takes the cluster's
 * rest, or the next word, as its value. `--` ends the flags.
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
      if (text.startsWith('--')) {
        const name = eq === -1 ? text : text.slice(0, eq)
        const attached = eq === -1 ? null : text.slice(eq + 1)
        if (value.includes(name)) {
          if (attached !== null) found.push({ name, value: { text: attached, opaque } })
          else if (i + 1 < argv.length) {
            const next = argv[i + 1]!
            found.push({ name, value: { text: next, opaque: OPAQUE.test(next) } })
            i++
          } else found.push({ name, value: null })
        } else found.push({ name, value: null })
        continue
      }
      // A short cluster: every letter until one that takes a value.
      const letters = text.slice(1)
      const attached: string | null = eq === -1 ? null : text.slice(eq + 1)
      for (let at = 0; at < letters.length; at++) {
        const letter = `-${letters[at]!}`
        if (!value.includes(letter)) { found.push({ name: letter, value: null }); continue }
        const rest = letters.slice(at + 1)
        if (rest !== '') found.push({ name: letter, value: { text: rest, opaque: opaque || OPAQUE.test(rest) } })
        else if (attached !== null && attached !== '') found.push({ name: letter, value: { text: attached, opaque } })
        else if (i + 1 < argv.length) {
          const next = argv[i + 1]!
          found.push({ name: letter, value: { text: next, opaque: OPAQUE.test(next) } })
          i++
        } else found.push({ name: letter, value: null })
        break
      }
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
    if (value.opaque) return VARIABLE()
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

/**
 * `gh repo create` never falls back to origin (D1): the new repository is a
 * positional `owner/name` — a bare name reads as the caller's own account,
 * which can never be shown equal to origin, so it is a violation.
 */
function ghRepoCreationTarget(scanned: Scan): SendTarget {
  const flagged = scanned.values('-R', '--repo')[0]
  const positional = flagged ?? scanned.positionals[0]
  if (positional === undefined || positional.opaque) {
    return { kind: 'repo', repo: "the caller's account/…" }
  }
  if (URLISH.test(positional.text)) return parseRepoUrl(positional.text) ?? VARIABLE()
  const name = positional.text.replace(/\.git$/, '')
  // A name with no owner means the caller's own account.
  return { kind: 'repo', repo: name.includes('/') ? name : `the caller's account/${name}` }
}

/**
 * `gh repo fork` never targets origin (D1): the destination is the `--org`
 * (else the caller's own account) over the `--fork-name` (else the source
 * repository's name). The source stays in the segment; it is never the
 * target. Opaque values leave the destination unresolved.
 */
function ghRepoForkTarget(scanned: Scan): SendTarget {
  const org = scanned.values('--org')[0]
  const forkName = scanned.values('--fork-name')[0]
  if (org?.opaque === true || forkName?.opaque === true) return VARIABLE()
  const positional = scanned.positionals[0]
  const sourceName = positional !== undefined && !positional.opaque
    ? positional.text.replace(/\.git$/, '').split('/').pop() ?? null
    : null
  const owner = org?.text ?? "the caller's account"
  const name = forkName?.text ?? sourceName ?? 'the source name'
  return { kind: 'repo', repo: `${owner}/${name}`, fork: true }
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

/** Every positional that is a URL, scheme forms first; none, then any opaque word. */
function urlWords(words: Word[]): Word[] {
  const scheme = words.filter(word => !word.opaque && (URLISH.test(word.text) || SCPISH.test(word.text)))
  if (scheme.length > 0) return scheme
  const parseable = words.filter(word => {
    if (word.opaque) return false
    for (const text of [word.text, `http://${word.text}`]) {
      try {
        new URL(text)
        return true
      } catch {
        // Not a URL; keep looking.
      }
    }
    return false
  })
  if (parseable.length > 0) return parseable
  const opaque = words.find(word => word.opaque)
  return opaque === undefined ? [] : [opaque]
}

/**
 * The URL's host and port. A `scheme://` text parses as a URL (smtp ones are
 * mail); a bare text is read as `host[:port]` — `new URL('localhost:8080')`
 * would take `localhost:` for a scheme and leave no host at all — and
 * anything that is neither reads unresolved.
 */
function httpUrlTarget(word: Word | undefined): SendTarget {
  if (word === undefined) return { kind: 'unresolved', why: 'no URL in the command' }
  if (word.opaque) return VARIABLE()
  if (URLISH.test(word.text)) {
    try {
      const url = new URL(word.text)
      if (url.protocol === 'smtp:' || url.protocol === 'smtps:') return { kind: 'mail' }
      return { kind: 'host', host: url.hostname, ...(url.port ? { port: Number(url.port) } : {}) }
    } catch {
      return { kind: 'unresolved', why: 'no URL in the command' }
    }
  }
  const authority = word.text.split(/[/?#]/, 1)[0] ?? ''
  const bare = /^([A-Za-z0-9._-]+|\[[0-9a-fA-F:.]+\])(?::(\d{1,5}))?$/.exec(authority)
  if (bare === null) return { kind: 'unresolved', why: 'no URL in the command' }
  return { kind: 'host', host: bare[1]!.replace(/^\[|\]$/g, ''), ...(bare[2] !== undefined ? { port: Number(bare[2]) } : {}) }
}

/** `git push` (D4): `--repo`, the named remote, a URL or scp target, else the push remote. */
function gitPushTarget(argv: string[], subcommandAt: number, pinned: string | null): SendTarget {
  if (pinned !== null) return { kind: 'unresolved', why: pinned }
  const scanned = scan(argv, subcommandAt + 1, ['--repo', '-o', '--push-option', '--receive-pack', '--exec'])
  const repo = scanned.values('--repo')[0]
  if (repo !== undefined) {
    if (repo.opaque) return VARIABLE()
    if (URLISH.test(repo.text) || SCPISH.test(repo.text)) return { kind: 'url', url: repo.text }
    return { kind: 'remote', name: repo.text }
  }
  const first = scanned.positionals[0]
  if (first === undefined) return { kind: 'origin-implicit' }
  if (first.opaque) return VARIABLE()
  if (URLISH.test(first.text) || SCPISH.test(first.text)) return { kind: 'url', url: first.text }
  const refspec = first.text.includes(':') || first.text.startsWith('+') || first.text.startsWith('refs/') || first.text === 'HEAD'
  return refspec ? { kind: 'origin-implicit' } : { kind: 'remote', name: first.text }
}

/** The registry host (and port) a publish flags or its image names; the default otherwise. */
function registryTarget(head: string, host: Word | undefined, reference: Word | undefined): SendTarget {
  if (host !== undefined) {
    if (host.opaque) return VARIABLE()
    if (URLISH.test(host.text)) {
      try {
        const url = new URL(host.text)
        return { kind: 'registry', host: url.hostname.toLowerCase(), ...(url.port ? { port: Number(url.port) } : {}) }
      } catch {
        return { kind: 'unresolved', why: 'the registry did not parse as a URL' }
      }
    }
    const [bareHost, port] = host.text.split(':')
    return { kind: 'registry', host: bareHost!.toLowerCase(), ...(port !== undefined ? { port: Number(port) } : {}) }
  }
  if (reference !== undefined) {
    if (reference.opaque) return VARIABLE()
    const registry = registryOf(reference.text)
    if (registry === null) return { kind: 'registry', host: REGISTRY_DEFAULTS[head] ?? 'docker.io' }
    const [bareHost, port] = registry.split(':')
    return { kind: 'registry', host: bareHost!.toLowerCase(), ...(port !== undefined ? { port: Number(port) } : {}) }
  }
  return { kind: 'registry', host: REGISTRY_DEFAULTS[head] ?? 'docker.io' }
}

/** The first component of an image or OCI reference, when it names a registry. */
function registryOf(reference: string): string | null {
  if (!reference.includes('/')) return null
  const first = reference.split('/')[0] ?? ''
  if (first === '.' || first === '..') return null
  return first.includes('.') || first.includes(':') || first === 'localhost' ? first : null
}

/** Parse a whole command into its send candidates (D4's rules table). */
export function parseSends(command: string, cwd: string): SendCandidate[] {
  // An earlier segment that rewrites git's remote/url/branch config pins
  // every later push in the same call: the facts the resolver read are stale.
  let configTouched = false
  const candidates: SendCandidate[] = []
  for (const segment of parseCommand(command, cwd)) {
    candidates.push(...candidatesOf(segment, configTouched))
    if (segmentConfigTouched(segment.argv)) configTouched = true
  }
  return candidates
}

/** Whether a segment rewrites remote/url/branch config (D4, CC round 4). */
function segmentConfigTouched(argv: readonly string[]): boolean {
  if (argv[0] !== 'git') return false
  if (argv[1] === 'config') {
    return argv.slice(2).some(word => /^(remote|url|branch)\./i.test(word))
  }
  return argv[1] === 'remote' && ['add', 'set-url', 'rename', 'remove'].includes(argv[2] ?? '')
}

function candidatesOf(segment: { argv: string[]; text: string; cwd: string; env: ReadonlyMap<string, string | null>; note?: string }, configTouched = false): SendCandidate[] {
  const { text, cwd, env } = segment
  const base = (rule: SendCandidate['rule'], target: SendTarget): SendCandidate => ({ rule, segment: text, cwd, target })
  if (segment.note !== undefined) {
    // The unwrap could not complete (an unknown wrapper flag, a second -c
    // level, an env option not understood): the segment may send anywhere,
    // so it records unknown-destination under the wrapped command's rule —
    // the wrapper word itself is never the head.
    const head = (segment.argv.slice(1).find(word => !word.startsWith('-')) ?? segment.argv[0] ?? '')
      .split(/[\s/]/)[0]!.toLowerCase()
    const rule = WRAPPED_RULE_HEADS[head] ?? 'http-send'
    return [base(rule, { kind: 'unresolved', why: segment.note })]
  }
  const argv = segment.argv
  if (argv.length === 0) return []
  const ghPinned = env.has('GH_REPO') ? 'GH_REPO is set' : env.has('GH_HOST') ? 'GH_HOST is set' : null
  const head = argv[0]!.split('/').pop()!.toLowerCase()

  if (head === 'git') {
    const { subcommandAt, pinned } = gitSubcommandAndPin(argv, env)
    const stale = pinned ?? (configTouched ? 'an earlier git config or remote command pins the target' : null)
    if (subcommandAt !== -1 && argv[subcommandAt] === 'push') {
      return [base('git-push', gitPushTarget(argv, subcommandAt, stale))]
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
      if (path === undefined || path.opaque) return [base('gh-api-write', VARIABLE())]
      const parts = path.text.replace(/^\/+/, '').split('/')
      if (parts[0] !== 'repos' || parts.length < 3) {
        return [base('gh-api-write', { kind: 'unresolved', why: 'the API path names no repository' })]
      }
      return [base('gh-api-write', { kind: 'repo', repo: `${parts[1]}/${parts[2]}` })]
    }
    if (GH_WRITE_COMMANDS.has(argv[1] ?? '') && GH_WRITE_VERBS.has(argv[2] ?? '')) {
      if (ghPinned !== null) return [base('gh-write', { kind: 'unresolved', why: ghPinned })]
      // `gh repo create`/`fork` value flags are listed so their values are
      // never misread as the repository name.
      const scanned = scan(argv, 3, [
        '-R', '--repo', '--hostname', '--body', '--body-file', '--title', '--assignee', '--label', '--project', '--milestone', '--base', '--head', '--reviewer',
        '-d', '--description', '-h', '--homepage', '-t', '--team', '-p', '--template', '-g', '--gitignore', '-l', '--license', '-s', '--source', '-r', '--remote',
        '--org', '--fork-name', '--remote-name',
      ])
      // Creates and forks publish somewhere new; gists target gist.github.com
      // (D1): none of them may fall back to the repository's origin, and a
      // fork's destination account never reads from the source.
      if (argv[1] === 'repo' && argv[2] === 'fork') {
        return [base('gh-write', ghRepoForkTarget(scanned))]
      }
      if (argv[1] === 'repo' && argv[2] === 'create') {
        return [base('gh-write', ghRepoCreationTarget(scanned))]
      }
      if (argv[1] === 'gist' && (argv[2] === 'create' || argv[2] === 'edit')) {
        return [base('gh-write', { kind: 'host', host: 'gist.github.com' })]
      }
      return [base('gh-write', ghRepoTarget(scanned, scanned.positionals))]
    }
    return []
  }

  if (head === 'npm' || head === 'pnpm' || head === 'yarn' || head === 'bun') {
    // The subcommand may follow package-wide flags (`pnpm -r publish`).
    const scanned = scan(argv, 1, ['--registry', '--tag', '--access', '--otp', '--otp', '--sso-type'])
    const positionals = scanned.positionals.map(word => word.text)
    const publishes =
      positionals[0] === 'publish' ||
      (head === 'yarn' && positionals[0] === 'npm' && positionals[1] === 'publish')
    if (!publishes) return []
    return [base('registry-publish', registryTarget(head, scanned.values('--registry')[0], undefined))]
  }
  if (head === 'twine') {
    const scanned = scan(argv, 1, ['--repository-url', '--index-url', '-r', '--repository', '-i', '--user', '--password', '--verbose'])
    if (scanned.positionals[0]?.text !== 'upload') return []
    const named = scanned.values('--repository-url', '--index-url')[0]
    if (named !== undefined) return [base('registry-publish', registryTarget(head, named, undefined))]
    const short = scanned.values('-r', '--repository')[0]
    if (short !== undefined) {
      if (short.opaque) return [base('registry-publish', VARIABLE())]
      if (!URLISH.test(short.text)) return [base('registry-publish', { kind: 'unresolved', why: 'the twine repository is a name, not a URL' })]
      return [base('registry-publish', registryTarget(head, short, undefined))]
    }
    return [base('registry-publish', registryTarget(head, undefined, undefined))]
  }
  if (head === 'cargo') {
    const scanned = scan(argv, 1, ['--registry', '--index', '--token'])
    if (scanned.positionals[0]?.text !== 'publish') return []
    return [base('registry-publish', registryTarget(head, scanned.values('--registry', '--index')[0], undefined))]
  }
  if (head === 'docker' || head === 'podman') {
    // Global flags (`docker -H …`) may precede the subcommand.
    const scanned = scan(argv, 1, ['-H', '--host', '--context', '-c', '--config', '--log-level'])
    const sub = scanned.positionals[0]?.text
    const positional = (index: number) => scanned.positionals[index]
    if (sub === 'push') {
      return [base('registry-publish', registryTarget(head, undefined, positional(1)))]
    }
    if (sub === 'image' && positional(1)?.text === 'push') {
      return [base('registry-publish', registryTarget(head, undefined, positional(2)))]
    }
    if (sub === 'build') {
      const buildAt = argv.indexOf('build', 1)
      const buildScan = scan(argv, buildAt + 1, ['-t', '--tag', '--output', '--file', '-f', '--target', '--platform'])
      if (!buildScan.has('--push') && !buildScan.values('--output').some(word => word.text.includes('push=true'))) return []
      return [base('registry-publish', registryTarget(head, undefined, buildScan.values('-t', '--tag').at(-1)))]
    }
    if (head === 'docker' && sub === 'buildx' && positional(1)?.text === 'build') {
      const buildAt = argv.indexOf('build', 2)
      const buildScan = scan(argv, buildAt + 1, ['-t', '--tag', '--output', '--builder', '--file', '-f', '--target', '--platform'])
      if (!buildScan.has('--push') && !buildScan.values('--output').some(word => word.text.includes('push=true'))) return []
      const output = buildScan.values('--output').find(word => word.text.includes('push=true'))
      const named = output?.text.split(',').find(part => part.startsWith('name='))?.slice(5)
      if (named !== undefined) return [base('registry-publish', registryTarget(head, undefined, { text: named, opaque: OPAQUE.test(named) }))]
      return [base('registry-publish', registryTarget(head, undefined, buildScan.values('-t', '--tag').at(-1)))]
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
    const scanned = scan(argv, 1, ['--registry-config', '--plain-http', '--insecure', '--ca-file', '--cert-file', '--key-file', '--username', '--password'])
    if (scanned.positionals[0]?.text !== 'push') return []
    // positionals: push, <chart>, <repository url>
    const repository = scanned.positionals[2]
    if (repository === undefined || repository.opaque) return [base('registry-publish', VARIABLE())]
    if (!URLISH.test(repository.text)) return [base('registry-publish', { kind: 'unresolved', why: 'the helm repository is not a URL' })]
    try {
      return [base('registry-publish', { kind: 'registry', host: new URL(repository.text).hostname.toLowerCase() })]
    } catch {
      return [base('registry-publish', VARIABLE())]
    }
  }

  if (head === 'curl') {
    const scanned = scan(argv, 1, [
      '-X', '--request', '-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode',
      '-F', '--form', '-T', '--upload-file', '--url', '-u', '--user', '-H', '--header', '-o', '--output',
      '-A', '--user-agent', '-b', '--cookie', '-e', '--referer', '-E', '--cert', '--key', '-x', '--proxy', '-U', '--proxy-user',
      '-m', '--max-time', '--connect-timeout', '--retry', '--retry-delay',
      '-w', '--write-out', '-K', '--config', '-c', '--cookie-jar', '-D', '--dump-header', '--resolve', '--connect-to',
    ])
    // Every URL argument is judged — a second URL is not cover for the first.
    const urls = [...scanned.values('--url'), ...urlWords(scanned.positionals)]
    const targets = (urls.length > 0 ? urls : [undefined]).map(word => httpUrlTarget(word))
    if (targets.some(target => target.kind === 'mail')) {
      const mail = targets.map(target => target.kind === 'mail' ? target : null).find(target => target !== null)
      return [base('mail-send', mail!)]
    }
    const method = scanned.values('-X', '--request')[0]?.text.toUpperCase()
    const body = scanned.has('-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--data-urlencode', '-F', '--form', '-T', '--upload-file', '--json')
    // An explicit non-GET/HEAD method sends even with `-G`; `-G` alone moves
    // any data into the URL's query, a read.
    const sends = (method !== undefined && method !== 'GET' && method !== 'HEAD') || (body && !scanned.has('-G'))
    if (!sends) return []
    return targets.map(target => base('http-send', target))
  }
  if (head === 'wget') {
    const scanned = scan(argv, 1, ['--post-data', '--post-file', '--method', '-O', '--output-document', '--header', '--user', '--password', '--timeout', '--tries'])
    const urls = urlWords(scanned.positionals)
    const targets = (urls.length > 0 ? urls : [undefined]).map(word => httpUrlTarget(word))
    if (targets.some(target => target.kind === 'mail')) return [base('mail-send', { kind: 'mail' })]
    const method = scanned.values('--method')[0]
    const body = scanned.has('--post-data', '--post-file')
    if (!body && (method === undefined || ['GET', 'HEAD'].includes(method.text.toUpperCase()))) return []
    return targets.map(target => base('http-send', target))
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
    // `:`-prefixed headers and `==` query items carry no body; `=` and `:=` do.
    const body = items.some(word => /^[^:]+:=/.test(word.text) || (/=/.test(word.text) && !/==/.test(word.text)))
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
