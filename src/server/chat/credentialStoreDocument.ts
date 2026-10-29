// Credential-store document layer: strict v1 {version:1, entries:{…}} parsing,
// the gated O_NOFOLLOW read, and the shared name/kind vocabulary. Extracted
// verbatim from credentialStore.ts (M6 of the provider-relay-setup design);
// imports only the error module — never the facade — and performs no I/O at
// import time.

import { constants as fsConstants } from 'node:fs'
import type { Stats } from 'node:fs'
import type * as nodeFs from 'node:fs'

import { CredentialStoreError, malformed, type CredentialFailureReason } from './credentialStoreErrors'

export type CredentialKind = 'secret-source' | 'launch-env'

/** Narrow fs seam for controlled test faults only; every default is real node:fs. */
export type CredentialFsDeps = Pick<
  typeof nodeFs,
  | 'lstatSync' | 'statSync' | 'realpathSync' | 'openSync' | 'closeSync' | 'fstatSync'
  | 'readSync' | 'writeSync' | 'fchmodSync' | 'fsyncSync' | 'renameSync' | 'unlinkSync'
  | 'mkdirSync'
>

// Local duplicates of the pinned admission patterns (catalogParse.ts keeps the
// catalog pattern module-private; chatProviderEnv.ts ENV_NAME is the legacy
// shape); neither is exported and no shared source is edited. Each duplicate
// is pinned by its own separated equivalence test in credentialStore.test.ts.
export const STORE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
export const CATALOG_NAME = /^[A-Z_][A-Z0-9_]*$/
export const KINDS: readonly string[] = ['secret-source', 'launch-env']

export interface CredentialEntry { kind: CredentialKind; value: string }
export type Entries = Record<string, CredentialEntry>

export type Loaded =
  | { state: 'ok'; entries: Entries; stamp: string; dev: number; ino: number }
  | { state: 'missing' }
  | { state: 'failed'; reason: CredentialFailureReason }

export const isMissing = (err: unknown): boolean => (err as NodeJS.ErrnoException)?.code === 'ENOENT'
const euid = (): number =>
  typeof process.geteuid === 'function' ? process.geteuid() : (process.getuid?.() ?? -1)

/** Regular non-symlink file, owned by this user, no group/other bits. Gates run before every access; a cache hit is never served without them. */
export function gateStats(st: Stats): { ok: true } | { ok: false; reason: CredentialFailureReason } {
  if (st.isSymbolicLink()) return { ok: false, reason: 'symlink' }
  if (!st.isFile()) return { ok: false, reason: 'not-regular-file' }
  if (st.uid !== euid()) return { ok: false, reason: 'foreign-owner' }
  if ((st.mode & 0o077) !== 0) return { ok: false, reason: 'unsafe-permissions' }
  return { ok: true }
}

/** Strictly validate a v1 document {version:1, entries:{NAME:{kind,value}}};
 * anything else (bad shape, unknown kind, bad name, NUL) is malformed. */
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

/** One gated read: lstat gates, O_NOFOLLOW open, fstat identity rematch,
 * gates again (chmod race), read, parse. The stamp is the accepted mtime/size
 * hint — never a trust proof; same-size+mtime edits can hide behind a hit. */
export function loadDocument(deps: CredentialFsDeps, storePath: string): Loaded {
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
