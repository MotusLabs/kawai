// Credential store: one user-level file holding imported provider credential
// values as versioned entries — design D1 of the provider-relay-setup change
// (openspec/changes/provider-relay-setup/design.md). Deliberately dormant:
// nothing imports this module yet, and importing it performs no I/O. Stored
// values are readable only through resolve(); every other surface is
// value-free, and every failure reports a fixed safe reason that never
// carries a value, prefix, length, parser message, or cause.

import { constants as fsConstants } from 'node:fs'
import type { Stats } from 'node:fs'
import * as nodeFs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

export type CredentialKind = 'secret-source' | 'launch-env'
export type CredentialEntryState = 'set' | 'blank'

export interface CredentialListingEntry { name: string; kind: CredentialKind; state: CredentialEntryState }

/** Fixed safe reasons — never a value, prefix, length, parser message, or cause. */
export type CredentialFailureReason =
  | 'missing' | 'malformed' | 'unreadable' | 'unsafe-permissions'
  | 'symlink' | 'not-regular-file' | 'foreign-owner' | 'identity-changed'

export type CredentialRefusalCode =
  | 'invalid-path' | 'invalid-name' | 'name-not-catalog' | 'invalid-kind'
  | 'invalid-value' | 'value-nul' | 'retain-collaborator-required'
  | 'retain-collaborator-failed' | 'write-failed'

export type CredentialStoreCode = CredentialFailureReason | CredentialRefusalCode

export class CredentialStoreError extends Error {
  readonly code: CredentialStoreCode
  constructor(code: CredentialStoreCode) {
    super(`credential store: ${code}`)
    this.name = 'CredentialStoreError'
    this.code = code
  }
}

export type CredentialStoreStatus = { ok: true } | { ok: false; reason: CredentialFailureReason }

/// applied: the rename committed — new content stands, never retried.
/// durable: the directory fsync confirmed the rename on disk.
export interface CredentialSetOutcome {
  applied: boolean
  durable: boolean
}

/// Called with the NAME (never a value) before a secret-source set changes
/// the credential file; a missing or throwing collaborator refuses first.
export interface CredentialRetainCollaborator {
  retainSecretName: (name: string) => void | Promise<void>
}

/** Narrow fs seam for controlled test faults only; every default is the real
 * node:fs function, so a test never substitutes an alternate writer. */
export type CredentialFsDeps = Pick<
  typeof nodeFs,
  | 'lstatSync' | 'statSync' | 'openSync' | 'closeSync' | 'fstatSync' | 'readSync'
  | 'writeSync' | 'fchmodSync' | 'fsyncSync' | 'renameSync' | 'unlinkSync' | 'mkdirSync'
>

const realDeps: CredentialFsDeps = nodeFs

// Local duplicates of the pinned admission patterns (catalogParse.ts keeps the
// catalog pattern module-private; chatProviderEnv.ts ENV_NAME is the legacy
// shape); neither is exported and no shared source is edited. Each duplicate
// is pinned by its own separated equivalence test in credentialStore.test.ts.
const STORE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const CATALOG_NAME = /^[A-Z_][A-Z0-9_]*$/
const KINDS: readonly string[] = ['secret-source', 'launch-env']

interface CredentialEntry { kind: CredentialKind; value: string }
type Entries = Record<string, CredentialEntry>

type Loaded =
  | { state: 'ok'; entries: Entries; stamp: string; dev: number; ino: number }
  | { state: 'missing' }
  | { state: 'failed'; reason: CredentialFailureReason }

const malformed = (): never => {
  throw new CredentialStoreError('malformed')
}
const isMissing = (err: unknown): boolean => (err as NodeJS.ErrnoException)?.code === 'ENOENT'
const euid = (): number =>
  typeof process.geteuid === 'function' ? process.geteuid() : (process.getuid?.() ?? -1)

/** Regular non-symlink file, owned by this user, no group/other bits. Gates run before every access; a cache hit is never served without them. */
function gateStats(st: Stats): { ok: true } | { ok: false; reason: CredentialFailureReason } {
  if (st.isSymbolicLink()) return { ok: false, reason: 'symlink' }
  if (!st.isFile()) return { ok: false, reason: 'not-regular-file' }
  if (st.uid !== euid()) return { ok: false, reason: 'foreign-owner' }
  if ((st.mode & 0o077) !== 0) return { ok: false, reason: 'unsafe-permissions' }
  return { ok: true }
}

/** Strictly validate a v1 document: {version:1, entries:{NAME:{kind,value}}} —
 * anything else (bad shape, unknown kind, name invalid for its kind, NUL) is
 * malformed: reported and refused, never salvaged. */
function parseDocument(raw: string): Entries {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return malformed()
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return malformed()
  if (Object.keys(parsed).length !== 2) return malformed()
  const doc = parsed as Record<string, unknown>
  if (doc.version !== 1) return malformed()
  const entries = doc.entries
  if (typeof entries !== 'object' || entries === null || Array.isArray(entries)) return malformed()
  const out = Object.create(null) as Entries
  for (const [name, entry] of Object.entries(entries)) {
    if (!STORE_NAME.test(name)) return malformed()
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return malformed()
    if (Object.keys(entry).length !== 2) return malformed()
    const item = entry as Record<string, unknown>
    if (!KINDS.includes(item.kind as string)) return malformed()
    if (typeof item.value !== 'string' || item.value.includes('\0')) return malformed()
    const kind = item.kind as CredentialKind
    if (kind === 'secret-source' && !CATALOG_NAME.test(name)) return malformed()
    out[name] = { kind, value: item.value }
  }
  return out
}

/** One gated read: lstat gates, O_NOFOLLOW open, fstat identity matched to the
 * lstat, gates again on the opened file (chmod race), read, parse. The stamp
 * is the accepted mtime/size heuristic — a freshness hint, never a trust
 * proof; an edit keeping size+mtime can hide behind a hit (stated, not solved). */
function loadDocument(deps: CredentialFsDeps, storePath: string): Loaded {
  let st: Stats
  try {
    st = deps.lstatSync(storePath)
  } catch (err) {
    return isMissing(err) ? { state: 'missing' } : { state: 'failed', reason: 'unreadable' }
  }
  const gate = gateStats(st)
  if (!gate.ok) return { state: 'failed', reason: gate.reason }
  let fd: number
  try {
    fd = deps.openSync(storePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    return { state: 'failed', reason: code === 'ELOOP' ? 'symlink' : 'unreadable' }
  }
  try {
    const fst = deps.fstatSync(fd)
    if (fst.dev !== st.dev || fst.ino !== st.ino) return { state: 'failed', reason: 'identity-changed' }
    const reopen = gateStats(fst)
    if (!reopen.ok) return { state: 'failed', reason: reopen.reason }
    let buf = Buffer.alloc(fst.size > 0 ? fst.size : 256)
    let off = 0
    for (;;) {
      if (off === buf.length) {
        const grown = Buffer.alloc(buf.length * 2)
        buf.copy(grown, 0, 0, off)
        buf = grown
      }
      const read = deps.readSync(fd, buf, off, buf.length - off, null)
      if (read === 0) break
      off += read
    }
    return {
      state: 'ok',
      entries: parseDocument(buf.toString('utf8', 0, off)),
      stamp: `${st.mtimeMs}:${st.size}`,
      dev: st.dev,
      ino: st.ino,
    }
  } catch (err) {
    if (err instanceof CredentialStoreError) return { state: 'failed', reason: 'malformed' }
    return { state: 'failed', reason: 'unreadable' }
  } finally {
    try { deps.closeSync(fd) } catch { /* already closed */ }
  }
}

/**
 * Per-file coordination owner (D1): one Map entry holds the parse cache AND
 * the whole RMW queue for every instance resolving to the same file, keyed
 * by the parent directory's real dev+ino plus basename — a stable parent
 * symlink or bind alias converges; a swapped parent gets a fresh owner and
 * cold cache. Other processes are outside this guarantee.
 */
interface FileOwner {
  queue: Promise<unknown>
  cache: { stamp: string; dev: number; ino: number; entries: Entries } | null
}
const owners = new Map<string, FileOwner>()

const ownerKey = (pst: Stats, storePath: string): string =>
  `${pst.dev}:${pst.ino}:${path.basename(storePath)}`

function ownerFor(deps: CredentialFsDeps, pst: Stats, storePath: string): FileOwner {
  const key = ownerKey(pst, storePath)
  let owner = owners.get(key)
  if (!owner) {
    owner = { queue: Promise.resolve(), cache: null }
    owners.set(key, owner)
  }
  return owner
}

function findOwner(deps: CredentialFsDeps, storePath: string): FileOwner | undefined {
  let pst: Stats
  try {
    pst = deps.statSync(path.dirname(storePath))
  } catch {
    return undefined
  }
  return pst.isDirectory() ? owners.get(ownerKey(pst, storePath)) : undefined
}

function fsyncDir(deps: CredentialFsDeps, dir: string): void {
  const fd = deps.openSync(dir, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY)
  try {
    deps.fsyncSync(fd)
  } finally {
    try { deps.closeSync(fd) } catch { /* nothing safe to report */ }
  }
}

export interface CredentialStoreOptions {
  /** Required collaborator for secret-source mutations (§2.3 wires the real registry). */
  retainSecretNames?: CredentialRetainCollaborator
  /** Controlled fault-injection seam; defaults to the real node:fs functions. */
  deps?: Partial<CredentialFsDeps>
}

export class CredentialStore {
  private readonly deps: CredentialFsDeps
  private readonly retain?: CredentialRetainCollaborator

  constructor(
    private readonly storePath: string,
    options: CredentialStoreOptions = {},
  ) {
    this.deps = { ...realDeps, ...options.deps }
    this.retain = options.retainSecretNames
  }

  /** Create a missing parent (0700, pinned past the umask) and fsync the
   * nearest existing ancestor. A stable symlinked parent (HOME alias) is
   * legitimate. Every raw fs error here reports as write-failed. */
  private ensureParent(): Stats {
    const dir = path.dirname(this.storePath)
    try {
      const st = this.deps.statSync(dir)
      if (!st.isDirectory()) throw new CredentialStoreError('write-failed')
      return st
    } catch (err) {
      if (err instanceof CredentialStoreError) throw err
      if (!isMissing(err)) throw new CredentialStoreError('write-failed')
    }
    try {
      this.deps.mkdirSync(dir, { recursive: true, mode: 0o700 })
      const dfd = this.deps.openSync(dir, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY)
      try {
        this.deps.fchmodSync(dfd, 0o700)
      } finally {
        try { this.deps.closeSync(dfd) } catch { /* best effort */ }
      }
    } catch (err) {
      if (err instanceof CredentialStoreError) throw err
      throw new CredentialStoreError('write-failed')
    }
    let anc = path.dirname(dir)
    for (;;) {
      try {
        fsyncDir(this.deps, anc)
        return this.deps.statSync(dir)
      } catch (err) {
        if (err instanceof CredentialStoreError) throw err
        const parent = path.dirname(anc)
        if (parent === anc) throw new CredentialStoreError('write-failed')
        anc = parent
      }
    }
  }

  /** One gated, stamp-checked load. Gates and identity always run; the
   * mtime/size stamp only decides re-read versus a shared cache hit. */
  private load(): Loaded {
    let pst: Stats
    try {
      pst = this.deps.statSync(path.dirname(this.storePath))
    } catch (err) {
      if (!isMissing(err)) return { state: 'failed', reason: 'unreadable' }
      return { state: 'missing' }
    }
    if (!pst.isDirectory()) return { state: 'failed', reason: 'unreadable' }
    let st: Stats
    try {
      st = this.deps.lstatSync(this.storePath)
    } catch (err) {
      return isMissing(err) ? { state: 'missing' } : { state: 'failed', reason: 'unreadable' }
    }
    const gate = gateStats(st)
    if (!gate.ok) return { state: 'failed', reason: gate.reason }
    const stamp = `${st.mtimeMs}:${st.size}`
    const owner = findOwner(this.deps, this.storePath)
    const cached = owner?.cache
    if (cached && cached.dev === st.dev && cached.ino === st.ino && cached.stamp === stamp) {
      return { state: 'ok', entries: cached.entries, stamp, dev: st.dev, ino: st.ino }
    }
    const loaded = loadDocument(this.deps, this.storePath)
    if (loaded.state === 'ok' && owner) {
      owner.cache = { stamp: loaded.stamp, dev: loaded.dev, ino: loaded.ino, entries: loaded.entries }
    }
    return loaded
  }

  private fillCache(entries: Entries): void {
    const owner = findOwner(this.deps, this.storePath)
    if (!owner) return
    try {
      const st = this.deps.lstatSync(this.storePath)
      if (!gateStats(st).ok) {
        owner.cache = null
        return
      }
      owner.cache = { stamp: `${st.mtimeMs}:${st.size}`, dev: st.dev, ino: st.ino, entries }
    } catch { owner.cache = null }
  }

  /** Applied but not durable: invalidate, then one verified reload. No retry. */
  private invalidateAndReload(): void {
    const owner = findOwner(this.deps, this.storePath)
    if (owner) owner.cache = null
    const loaded = this.load()
    if (loaded.state === 'ok') this.fillCache(loaded.entries)
  }

  /** Serialized RMW: queue first, then fresh bytes. A refused load keeps the
   * prior bytes and refuses; a missing file starts from an empty document. */
  private writeEntries(mutate: (entries: Entries) => void): CredentialSetOutcome {
    const loaded = this.load()
    let entries: Entries
    if (loaded.state === 'ok') entries = Object.assign(Object.create(null) as Entries, loaded.entries)
    else if (loaded.state === 'missing') entries = Object.create(null) as Entries
    else throw new CredentialStoreError(loaded.reason)
    mutate(entries)
    return this.atomicWrite(entries)
  }

  /** Temp O_EXCL|O_NOFOLLOW at 0600, write, fsync, close, rename = commit
   * point. Before it a failure keeps prior bytes and removes the temp (each
   * descriptor closed exactly once); after it a directory-fsync failure
   * reports applied but not durable — no rollback, no retry. */
  private atomicWrite(entries: Entries): CredentialSetOutcome {
    const dir = path.dirname(this.storePath)
    const payload = Buffer.from(JSON.stringify({ version: 1, entries }), 'utf8')
    const tmp = path.join(dir, `.${path.basename(this.storePath)}.tmp-${process.pid}-${tmpSeq++}`)
    let fd: number
    let closed = false
    try {
      fd = this.deps.openSync(
        tmp,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600,
      )
    } catch {
      throw new CredentialStoreError('write-failed')
    }
    try {
      let written = 0
      while (written < payload.length) {
        written += this.deps.writeSync(fd, payload, written, payload.length - written)
      }
      this.deps.fchmodSync(fd, 0o600)
      this.deps.fsyncSync(fd)
      this.deps.closeSync(fd)
      closed = true
    } catch {
      this.discardTemp(fd, tmp, closed)
      throw new CredentialStoreError('write-failed')
    }
    try {
      this.deps.renameSync(tmp, this.storePath)
    } catch {
      this.discardTemp(fd, tmp, closed)
      throw new CredentialStoreError('write-failed')
    }
    let durable = true
    try {
      fsyncDir(this.deps, dir)
    } catch {
      durable = false
    }
    if (durable) this.fillCache(entries)
    else this.invalidateAndReload()
    return { applied: true, durable }
  }

  private discardTemp(fd: number, tmp: string, closed: boolean): void {
    if (!closed) {
      try { this.deps.closeSync(fd) } catch { /* already closed */ }
    }
    try { this.deps.unlinkSync(tmp) } catch { /* nothing safe to report */ }
  }

  /** Store a value: '' is blank, non-empty is set. Validation runs first —
   * admission, kind, value, NUL, catalog shape, and collaborator presence —
   * before queue, parent creation, and the file, so a refusal has had no
   * side effect. Names per kind, never silently uppercased; no count/length
   * caps here (legacy limits stay at the legacy input boundary). */
  async set(name: string, value: string, kind: CredentialKind): Promise<CredentialSetOutcome> {
    if (typeof name !== 'string' || !STORE_NAME.test(name)) throw new CredentialStoreError('invalid-name')
    if (!KINDS.includes(kind)) throw new CredentialStoreError('invalid-kind')
    if (typeof value !== 'string') throw new CredentialStoreError('invalid-value')
    if (value.includes('\0')) throw new CredentialStoreError('value-nul')
    if (kind === 'secret-source' && !CATALOG_NAME.test(name)) throw new CredentialStoreError('name-not-catalog')
    if (kind === 'secret-source' && !this.retain) {
      throw new CredentialStoreError('retain-collaborator-required')
    }
    const owner = ownerFor(this.deps, this.ensureParent(), this.storePath)
    return enqueue(owner, async () => {
      if (kind === 'secret-source' && this.retain) {
        try {
          await this.retain.retainSecretName(name)
        } catch {
          throw new CredentialStoreError('retain-collaborator-failed')
        }
      }
      return this.writeEntries((entries) => {
        entries[name] = { kind, value }
      })
    })
  }

  /** Status of the store as a whole — the reason the source listing reports. */
  status(): CredentialStoreStatus {
    const loaded = this.load()
    if (loaded.state === 'ok') return { ok: true }
    return { ok: false, reason: loaded.state === 'missing' ? 'missing' : loaded.reason }
  }

  /** Trusted internal read — the only value-returning surface. Own entries
   * only (inherited names never resolve); absent or unreadable reads as
   * absent with status() carrying the reason. */
  resolve(name: string): string | undefined {
    const loaded = this.load()
    return loaded.state === 'ok' && Object.hasOwn(loaded.entries, name)
      ? loaded.entries[name].value
      : undefined
  }

  /** Value-free metadata: name, kind, and set/blank per entry, plus status. */
  list(): { status: CredentialStoreStatus; entries: CredentialListingEntry[] } {
    const loaded = this.load()
    if (loaded.state !== 'ok') {
      const status: CredentialStoreStatus =
        loaded.state === 'missing' ? { ok: false, reason: 'missing' } : { ok: false, reason: loaded.reason }
      return { status, entries: [] }
    }
    const entries = Object.entries(loaded.entries).map(([name, entry]) => ({
      name,
      kind: entry.kind,
      state: entry.value === '' ? ('blank' as const) : ('set' as const),
    }))
    return { status: { ok: true }, entries }
  }
}

function enqueue<T>(owner: FileOwner, task: () => Promise<T> | T): Promise<T> {
  const run = owner.queue.then(task, task)
  const settle = (): undefined => undefined
  owner.queue = run.then(settle, settle)
  return run
}

let tmpSeq = 0

/**
 * Resolve the production store path. Pure — no I/O, no directory creation;
 * §2 callers invoke it explicitly.
 */
export function defaultCredentialStorePath(): string {
  return path.join(os.homedir(), '.kawai', 'credentials.json')
}

/** Create a store bound to one explicit absolute path. Performs no I/O. */
export function createCredentialStore(
  storePath: string,
  options: CredentialStoreOptions = {},
): CredentialStore {
  if (typeof storePath !== 'string' || storePath.length === 0) {
    throw new CredentialStoreError('invalid-path')
  }
  return new CredentialStore(path.resolve(storePath), options)
}
