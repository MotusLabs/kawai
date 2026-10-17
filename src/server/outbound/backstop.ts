// The backstop (execution-safety-recovery D4): the one text search. A
// segment that produced no candidate and is not a proven non-send is
// searched — quoted strings, heredoc bodies, and its pipeline's other
// commands included — for the entries of a fixed, append-only list: `git`
// followed by `push`; the commands `gh`, `curl`, `wget`, `http`, `https`,
// `ssh`, `scp`, `sftp`, `rsync`, `nc`, `ncat`, `socat`, `ftp`, `telnet`; the
// mail commands; the publish words; an image push; and any `http://`,
// `https://`, `ssh://`, or `git@` URL; and, appended in task revision 3, a
// command word that is not literal and a bash `/dev/tcp` redirection. Each hit names its entry, never
// command text, and only ever yields `unknown-destination`. Pure and linear:
// one pass over word runs plus fixed substring searches.
import { BACKSTOP_ENTRIES, type BackstopEntry } from './proof'

const COMMANDS: Record<string, BackstopEntry> = {
  gh: 'gh', curl: 'curl', wget: 'wget', http: 'http', https: 'https', ssh: 'ssh', scp: 'scp', sftp: 'sftp', rsync: 'rsync',
  nc: 'nc', ncat: 'ncat', socat: 'socat', ftp: 'ftp', telnet: 'telnet',
  sendmail: 'mail', msmtp: 'mail', mailx: 'mail', ssmtp: 'mail', mail: 'mail', smtpd: 'mail', 'send-email': 'mail',
  publish: 'publish', twine: 'publish', '--push': 'image-push',
}
const IMAGE_TOOLS = new Set(['docker', 'podman', 'helm', 'buildah', 'skopeo', 'nerdctl', 'oras', 'crane'])
const RUN = /[A-Za-z0-9_.+-]/
const ORDER = new Map<BackstopEntry, number>(BACKSTOP_ENTRIES.map((entry, index) => [entry, index]))

const PUBLISHERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'cargo', 'twine', 'gem', 'poetry'])

/**
 * The entry a send tool's own name stands for, or null: what a command of
 * that tool may be when a non-literal word hides its verb (`git $V`).
 */
export function toolEntry(name: string): BackstopEntry | null {
  if (name === 'git') return 'git-push'
  if (IMAGE_TOOLS.has(name) || name === 'buildctl') return 'image-push'
  if (PUBLISHERS.has(name)) return 'publish'
  const entry = COMMANDS[name]
  return entry === undefined || name.startsWith('-') ? null : entry
}

/** The list entries `text` names, each once, in list order. */
export function backstopEntries(text: string): BackstopEntry[] {
  const found = new Set<BackstopEntry>()
  let git = false
  let imageTool = false
  let i = 0
  while (i < text.length) {
    if (!RUN.test(text[i]!)) { i++; continue }
    const start = i
    while (i < text.length && RUN.test(text[i]!)) i++
    const word = text.slice(start, i).toLowerCase()
    // `https://…` is a URL, not the httpie command.
    const entry = COMMANDS[word]
    if (entry !== undefined && !((word === 'http' || word === 'https') && text[i] === ':')) found.add(entry)
    if (word === 'git') git = true
    if (IMAGE_TOOLS.has(word)) imageTool = true
    if (word === 'push') {
      if (git) found.add('git-push')
      if (imageTool) found.add('image-push')
    }
  }
  const lower = text.toLowerCase()
  if (lower.includes('push=true') || lower.includes('type=registry')) found.add('image-push')
  if (lower.includes('http://') || lower.includes('https://') || lower.includes('ssh://') || lower.includes('git@')) found.add('url')
  // bash's network redirections: `> /dev/tcp/<host>/<port>`.
  if (lower.includes('/dev/tcp/') || lower.includes('/dev/udp/')) found.add('dev-tcp')
  return [...found].sort((a, b) => ORDER.get(a)! - ORDER.get(b)!)
}
