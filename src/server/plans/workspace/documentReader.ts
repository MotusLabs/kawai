// Bounded document reads for the plan workspace (plan-workspace 2.3, design
// D4). INVARIANT S: bytes are served only from a regular file that (a) has a
// relative path staying inside the permitted worktree root, (b) is opened
// race-safely, (c) has an allowed type and is within its type's size bound.
// Everything else returns no content and names a reason; the server never
// fetches a URL.
//
// Containment is decided from the kernel's path for the open descriptor,
// compared against the exact authorized root string (B8.1) — never a
// resolution taken at request time, which a swapped root would widen. The
// base must be canonical before any open: a root that is, or passes
// through, a symlink refuses `root-not-canonical` (B8.2, fails closed).
// The open runs with O_RDONLY|O_NONBLOCK|O_NOCTTY (a FIFO cannot hang the
// open, a tty cannot take the controlling terminal), then
// `/proc/self/fd/<fd>` is read and must equal the base or start with
// `base + sep`, byte-exact. That link names the open file description's
// dentry — not a fresh lookup — so a directory swap between the open and
// the check cannot re-race it (the three-phase open-outside/realpath-inside/
// stat-outside attack is refused; see planWorkspaceDocumentReader.test.ts).
// Any readlink failure refuses `containment-unavailable`; there is no
// realpath+stat fallback. A ` (deleted)` suffix refuses. Hard links are not
// special-cased: an in-root entry hard-linked to an outside inode is a member
// of the worktree (hard links cannot cross filesystems).
//
// Types and bounds (design D4): UTF-8 `.md`/`.markdown` up to 1 MiB; PNG,
// JPEG, WebP, GIF up to 10 MiB, extension matched case-insensitively. HTML
// and SVG are never servable. Markdown bytes that are not valid UTF-8 are
// refused, never lossily decoded.
//
// Test-only seams (stated per CP1 B4, B8.5): `onRootVerified` runs between
// the canonical-root check and the open (the root-swap hook); `onOpened`
// runs between the open and the containment check (the swap-race hook);
// `readProcLink` replaces the `/proc/self/fd` read (the non-Linux seam).
// None is set in production.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

/** Why a read served no content; the reason code is the refusal's whole text. */
export type DocumentRefusalReason =
  | 'invalid-path'            // empty, NUL, backslash, absolute, drive letter, UNC or URL-shaped
  | 'escape'                  // `..` resolving above the root
  | 'missing'                 // the open failed (ENOENT, EACCES, …); no target detail is leaked
  | 'not-regular'             // the opened inode is not a regular file (FIFO, dir, device)
  | 'oversized'               // content beyond the type's size bound, refused before any read
  | 'unsupported-type'        // extension outside the allowlist (HTML and SVG included)
  | 'invalid-utf8'            // markdown bytes are not valid UTF-8
  | 'containment-unavailable' // /proc/self/fd read failed (non-Linux); no fallback exists
  | 'containment-failed'      // the open descriptor resolves outside the root, or was deleted
  | 'root-not-canonical'      // the permitted root is, or passes through, a symlink (B8.2)

export type WorkspaceDocumentContent =
  | { ok: true; kind: 'markdown'; text: string; bytes: Uint8Array<ArrayBuffer>; hash: string; size: number; mtimeMs: number }
  | { ok: true; kind: 'image'; contentType: string; bytes: Uint8Array<ArrayBuffer>; hash: string; size: number; mtimeMs: number }
  | { ok: false; reason: DocumentRefusalReason }

const MARKDOWN_EXTENSION_CONTENT_TYPES: Record<string, string> = {
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
}
const IMAGE_EXTENSION_CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}
const MARKDOWN_LIMIT_BYTES = 1024 * 1024
const IMAGE_LIMIT_BYTES = 10 * 1024 * 1024

export interface ReadWorkspaceDocumentOptions {
  /** Test seam (B8.5): runs after the canonical-root check, before the open. */
  onRootVerified?: () => Promise<void> | void
  /** Test seam (B4): runs after the open, before the containment check. */
  onOpened?: (fd: number) => Promise<void> | void
  /** Test seam (B4): the `/proc/self/fd/<fd>` read; a throw reads as unavailable. */
  readProcLink?: (fd: number) => Promise<string>
}

/**
 * Lexical gate: refuses empty, NUL, backslash, absolute, drive-letter, UNC
 * and URL-shaped inputs, then normalizes `.`/`..` segments; `..` above the
 * top refuses. Interior `..` that stays inside is legal (a document's
 * relative links may use it), unlike the stricter `isRelativeWorkspacePath`
 * the ref layer applies to stored paths.
 */
export function normalizeRelativeDocumentPath(value: string):
  { ok: true; normalized: string } | { ok: false; reason: 'invalid-path' | 'escape' } {
  if (typeof value !== 'string' || value === '') return { ok: false, reason: 'invalid-path' }
  if (value.includes('\0') || value.includes('\\')) return { ok: false, reason: 'invalid-path' }
  if (value.startsWith('/') || value.startsWith('//') || /^[A-Za-z]:/.test(value)) {
    return { ok: false, reason: 'invalid-path' }
  }
  if (value.includes('://')) return { ok: false, reason: 'invalid-path' }
  const segments: string[] = []
  for (const segment of value.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) return { ok: false, reason: 'escape' }
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  if (segments.length === 0) return { ok: false, reason: 'invalid-path' }
  return { ok: true, normalized: segments.join('/') }
}

function extensionOf(normalized: string): string | null {
  const base = normalized.slice(normalized.lastIndexOf('/') + 1)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return null
  return base.slice(dot).toLowerCase()
}

const refuse = (reason: DocumentRefusalReason): WorkspaceDocumentContent => ({ ok: false, reason })

/** The open flags: nonblocking so a FIFO cannot hang the open, no controlling tty (CP1 B1). */
const OPEN_FLAGS = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOCTTY

/**
 * Reads one document of the worktree at `root` (any listed team worktree;
 * reached through its realpath). All async I/O (CP1 B3); the handle closes
 * on every path. The size bound is checked on the open descriptor's stat
 * before any read, and the bounded read itself stops at bound+1 bytes.
 */
export async function readWorkspaceDocument(
  root: string,
  relativePath: string,
  options: ReadWorkspaceDocumentOptions = {},
): Promise<WorkspaceDocumentContent> {
  const lexical = normalizeRelativeDocumentPath(relativePath)
  if (!lexical.ok) return refuse(lexical.reason)
  const extension = extensionOf(lexical.normalized)
  const markdown = extension !== null && extension in MARKDOWN_EXTENSION_CONTENT_TYPES
  const imageContentType = extension !== null ? IMAGE_EXTENSION_CONTENT_TYPES[extension] : undefined
  if (extension === null || (!markdown && imageContentType === undefined)) return refuse('unsupported-type')
  const limit = markdown ? MARKDOWN_LIMIT_BYTES : IMAGE_LIMIT_BYTES

  // B8.1/B8.2: the anchor is the exact authorized base string, never a
  // request-time resolution. A root that is, or passes through, a symlink
  // refuses root-not-canonical before any open.
  const base = path.resolve(root)
  try {
    if (await fsp.realpath(base) !== base) return refuse('root-not-canonical')
  } catch {
    return refuse('missing')
  }
  await options.onRootVerified?.()

  let handle: fs.promises.FileHandle | null = null
  try {
    try {
      handle = await fsp.open(path.join(base, lexical.normalized), OPEN_FLAGS)
    } catch {
      return refuse('missing')
    }
    await options.onOpened?.(handle.fd)

    const stat = await handle.stat()
    if (!stat.isFile()) return refuse('not-regular')
    if (stat.size > limit) return refuse('oversized')

    // Containment (CP1 B2, B8.1): the kernel's path for the open descriptor
    // must equal the authorized base or start with base + sep, byte-exact.
    // This link is the open file description's dentry, so directory swaps
    // cannot re-race it, and a root swapped after the canonical check lands
    // outside the base and refuses here.
    let link: string
    try {
      link = await (options.readProcLink
        ? options.readProcLink(handle.fd)
        : fsp.readlink(`/proc/self/fd/${handle.fd}`))
    } catch {
      return refuse('containment-unavailable')
    }
    if (link.endsWith(' (deleted)')) return refuse('containment-failed')
    if (link !== base && !link.startsWith(base + path.sep)) return refuse('containment-failed')

    // Bounded read: bound+1 bytes proves oversize even if the file grew
    // between the stat and this read.
    const buffer = Buffer.alloc(limit + 1)
    let total = 0
    while (total <= limit) {
      const { bytesRead } = await handle.read(buffer, total, limit + 1 - total, total)
      if (bytesRead === 0) break
      total += bytesRead
    }
    if (total > limit) return refuse('oversized')
    const bytes = new Uint8Array(buffer.subarray(0, total))

    let text: string | null = null
    if (markdown) {
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
      } catch {
        return refuse('invalid-utf8')
      }
    }
    const hash = createHash('sha256').update(bytes).digest('hex')
    if (markdown && text !== null) {
      return { ok: true, kind: 'markdown', text, bytes, hash, size: total, mtimeMs: stat.mtimeMs }
    }
    return { ok: true, kind: 'image', contentType: imageContentType!, bytes, hash, size: total, mtimeMs: stat.mtimeMs }
  } finally {
    await handle?.close()
  }
}


