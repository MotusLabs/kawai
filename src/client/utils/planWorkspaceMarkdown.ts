// The plan workspace reader's scoped Markdown resolvers (plan-workspace 5.3,
// design D4): pure helpers that turn a document's relative links and images
// into reader navigation and scoped-asset URLs. The server still enforces
// every boundary (worktree membership, containment, type, size) — these
// helpers only decide what the reader may attempt, and refuse the rest:
// external https links open separately, every other scheme is refused, and
// a relative target that escapes the worktree (`..` past the root) is not
// attempted at all. Chat rendering never uses these options.
import { isRelativeWorkspacePath } from '@shared/planWorkspace'

/** The document the resolver resolves against (design D4). */
export interface ReaderDocument {
  /** The worktree root the displayed document lives in (an absolute path). */
  worktreeId: string
  /** The displayed document's path relative to the worktree root. */
  relativePath: string
  /** The team key the scoped asset route addresses. */
  teamPath: string
}

/** Resolved relative Markdown link: the reader navigates to it in place. */
export interface ReaderLink {
  kind: 'document'
  relativePath: string
}

/** Refused target: the reader renders it inert with its reason. */
export interface RefusedLink {
  kind: 'refused'
  reason: 'external' | 'scheme' | 'escape' | 'empty' | 'anchor'
  /** The original href, for the visible label; never fetched. */
  href: string
}

/** A permitted external link: opens separately, never fetched by the server. */
export interface ExternalLink {
  kind: 'external'
  href: string
}

export type ResolvedLink = ReaderLink | ExternalLink | RefusedLink

/** What a rendered image needs: the scoped asset URL, or the refusal. */
export type ResolvedImage =
  | { kind: 'image'; src: string; relativePath: string }
  | RefusedLink

/** The displayed document's directory as path segments. */
const directoryOf = (documentPath: string): string[] =>
  documentPath.includes('/')
    ? documentPath.slice(0, documentPath.lastIndexOf('/')).split('/').filter(segment => segment !== '')
    : []

/** Resolve `target` over `base`; null when a `..` climbs past the base (the worktree root). */
const resolveFrom = (base: string[], target: string): string | null => {
  const segments = [...base]
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) return null
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return segments.join('/')
}

/**
 * Resolve one Markdown link as the reader sees it (design D4): relative
 * links navigate within the reader when the final path stays inside the
 * worktree; `https:` opens separately; every other scheme — file, script,
 * javascript, protocol-relative — is refused without exposure.
 */
export function resolveReaderLink(document: ReaderDocument, href: string): ResolvedLink {
  if (href === '' || href.trim() === '') return { kind: 'refused', reason: 'empty', href }
  if (/^https:/i.test(href)) return { kind: 'external', href }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href) || href.startsWith('//')) {
    return { kind: 'refused', reason: 'scheme', href }
  }
  if (href.startsWith('#')) return { kind: 'refused', reason: 'anchor', href }
  // A root-absolute target reads from the worktree root; anything else from
  // the displayed document's directory.
  const absolute = href.startsWith('/')
  const base = absolute ? [] : directoryOf(document.relativePath)
  const target = resolveFrom(base, absolute ? href.slice(1) : href)
  if (target === null || !isRelativeWorkspacePath(target)) {
    return { kind: 'refused', reason: 'escape', href }
  }
  // A target that resolves to the document's directory (`.`, `./`) names no file.
  if (target === '' || target === base.join('/')) {
    return { kind: 'refused', reason: 'empty', href }
  }
  return { kind: 'document', relativePath: target }
}

/** One supported image's asset URL (the scoped route serves the bytes). */
export function readerAssetUrl(document: ReaderDocument, relativePath: string): string {
  const query = new URLSearchParams({
    teamPath: document.teamPath,
    worktree: document.worktreeId,
    path: relativePath,
  })
  return `/api/plan-workspace/asset?${query.toString()}`
}

/** Resolve one Markdown image: permitted relative targets render through the asset route. */
export function resolveReaderImage(document: ReaderDocument, src: string): ResolvedImage {
  if (src === '' || src.trim() === '') return { kind: 'refused', reason: 'empty', href: src }
  if (/^https?:/i.test(src)) return { kind: 'refused', reason: 'external', href: src }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(src) || src.startsWith('//')) {
    return { kind: 'refused', reason: 'scheme', href: src }
  }
  if (src.startsWith('#')) return { kind: 'refused', reason: 'anchor', href: src }
  const absolute = src.startsWith('/')
  const base = absolute ? [] : directoryOf(document.relativePath)
  const target = resolveFrom(base, absolute ? src.slice(1) : src)
  if (target === null || !isRelativeWorkspacePath(target)) {
    return { kind: 'refused', reason: 'escape', href: src }
  }
  if (target === '' || target === base.join('/')) {
    return { kind: 'refused', reason: 'empty', href: src }
  }
  return { kind: 'image', src: readerAssetUrl(document, target), relativePath: target }
}

/**
 * Whether a refused target's reason reads as broken-in-place (the reader
 * shows the label and path) rather than as an ordinary external link.
 */
export function refusedReasonLabel(reason: RefusedLink['reason']): string {
  switch (reason) {
    case 'external': return 'External image — shown as a link, never fetched'
    case 'scheme': return 'Unsupported link scheme'
    case 'escape': return 'Target resolves outside the permitted worktree'
    case 'empty': return 'Empty link target'
    case 'anchor': return 'In-document anchor — the reader does not scroll anchors'
  }
}
