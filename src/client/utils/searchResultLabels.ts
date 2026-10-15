// Pure labels for chat search results (chat-session-search D6): the worktree
// name a chat belongs to, the relative match time, and the snippet text split
// at the matched ranges.
import type { SearchRange } from '@shared/sessionSearch'
import { formatRelativeTime } from './time'
import { getPathLeaf } from './sessionLabel'

/**
 * Name of the worktree containing `projectPath` (the deepest listed root that
 * equals or encloses it), else the path's own leaf — a chat outside any
 * discovered worktree still gets a short name.
 */
export function worktreeNameFor(projectPath: string, worktreePaths: readonly string[]): string {
  let best: string | null = null
  for (const root of worktreePaths) {
    const encloses = projectPath === root || projectPath.startsWith(root.endsWith('/') ? root : `${root}/`)
    if (encloses && (best === null || root.length > best.length)) best = root
  }
  return getPathLeaf(best ?? projectPath) ?? projectPath
}

/** `10m ago`, `2h ago`, `3d ago`, or `now` for a match under a minute old. */
export function relativeMatchTime(iso: string, now: number): string {
  const relative = formatRelativeTime(iso, now)
  return relative === 'now' || relative === '' ? relative : `${relative} ago`
}

export interface TextSegment {
  text: string
  match: boolean
}

/** Splits `text` at the ranges (sorted, non-overlapping, clipped to the text). */
export function splitByRanges(text: string, ranges: readonly SearchRange[]): TextSegment[] {
  const segments: TextSegment[] = []
  let cursor = 0
  for (const range of ranges) {
    const start = Math.max(cursor, Math.min(range.start, text.length))
    const end = Math.min(range.end, text.length)
    if (end <= start) continue
    if (start > cursor) segments.push({ text: text.slice(cursor, start), match: false })
    segments.push({ text: text.slice(start, end), match: true })
    cursor = end
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), match: false })
  return segments
}
