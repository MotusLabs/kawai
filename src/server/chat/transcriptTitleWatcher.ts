// Tail of an SDK transcript for title rows (chat-session-naming design D4).
// Claude Code persists its generated session title as `ai-title` state rows
// (and `custom-title` rows for renames made inside Claude Code) in the
// session's JSONL — they never appear on the SDK message stream, so the file
// is the only source. The watcher reports each title row as it lands, in
// order: a `custom-title` is user-set and must stick, so the caller has to
// see it even when a later `ai-title` follows in the same read (design D7).
// It reads only the appended region, tolerates a truncated trailing line by
// holding it until the next write completes it, and resets when the file is
// rewritten (a shrink) or replaced (a temp-file rename hands back a different
// inode — an inode watch cannot follow that, so the parent directory is
// watched alongside the file and a changed identity re-arms from the start).
// Until the file exists it watches the parent directory, so a watch armed
// before the transcript's first write still picks the file up on creation.
import fs from 'node:fs'
import path from 'node:path'
import { parseTranscriptTitleLine } from './transcriptReplay'

export interface TranscriptTitleWatcher {
  /** Stop watching. Safe to call more than once. */
  close(): void
}

/**
 * Watch `filePath` for appended title rows, reporting every title row in the
 * order it appears. The file's current content is read once up front
 * (catch-up), so a watch started after titles were already written still
 * reports them.
 */
export function watchTranscriptTitle(
  filePath: string,
  onTitle: (title: string, source: 'auto' | 'manual') => void
): TranscriptTitleWatcher {
  let offset = 0
  let remainder = ''
  /** dev:ino of the file the offset belongs to; null while none is tracked. */
  let identity: string | null = null
  let fileWatcher: fs.FSWatcher | null = null
  let dirWatcher: fs.FSWatcher | null = null
  let closed = false

  const stopWatchers = (): void => {
    fileWatcher?.close()
    fileWatcher = null
    dirWatcher?.close()
    dirWatcher = null
  }

  /** dev:ino of the file currently at the path; null when it does not exist. */
  const fileIdentity = (): string | null => {
    try {
      const stats = fs.statSync(filePath, { bigint: true })
      return `${stats.dev}:${stats.ino}`
    } catch {
      return null
    }
  }

  /**
   * Consume the appended region. A changed identity (rename-over) or a shrink
   * (an in-place rewrite) discards what we tracked — restart from the start.
   */
  const readAppended = (): void => {
    let size: number
    let current: string | null
    try {
      const stats = fs.statSync(filePath, { bigint: true })
      size = Number(stats.size)
      current = `${stats.dev}:${stats.ino}`
    } catch {
      return
    }
    if (current !== identity || size < offset) {
      identity = current
      offset = 0
      remainder = ''
    }
    if (size === offset) return
    let chunk: string
    try {
      const fd = fs.openSync(filePath, 'r')
      try {
        const buffer = Buffer.alloc(size - offset)
        fs.readSync(fd, buffer, 0, buffer.length, offset)
        chunk = buffer.toString('utf8')
      } finally {
        fs.closeSync(fd)
      }
    } catch {
      return
    }
    offset = size
    // Only newline-terminated lines are complete; the tail piece waits for
    // the write that finishes it.
    const lines = (remainder + chunk).split('\n')
    remainder = lines.pop() ?? ''
    // Every row is reported, in order. Collapsing a batch to its last row
    // would drop a `custom-title` that a later `ai-title` follows, letting a
    // generated title overwrite a user's rename (design D1/D7).
    for (const line of lines) {
      const title = parseTranscriptTitleLine(line.trim())
      if (title) onTitle(title.title, title.source)
    }
  }

  /** Keep only the directory watch: waiting for the file to (re)appear. */
  const armDirectory = (): void => {
    if (closed) return
    stopWatchers()
    offset = 0
    remainder = ''
    identity = null
    try {
      dirWatcher = fs.watch(
        path.dirname(filePath),
        (_eventType, filename) => {
          if (filename === path.basename(filePath)) check()
        }
      )
      // A vanished directory has nothing left to watch; the caller's next
      // catch-up or spawn re-arms.
      dirWatcher.on('error', () => {})
    } catch {
      // Same: nothing further to do here.
    }
  }

  /**
   * React to anything touching the file. Vanished → wait for it to come back
   * via the directory alone. Replaced (same name, different inode) → re-arm
   * on the new file, because a watch on the old inode cannot see it. Otherwise
   * consume the appended region.
   */
  const check = (): void => {
    if (closed) return
    const current = fileIdentity()
    if (current === null) {
      armDirectory()
      return
    }
    if (current !== identity) {
      watchFile()
      return
    }
    readAppended()
  }

  const watchFile = (): void => {
    if (closed) return
    stopWatchers()
    offset = 0
    remainder = ''
    const id = fileIdentity()
    if (id === null) {
      armDirectory()
      return
    }
    identity = id
    readAppended()
    try {
      // Two live watchers: the file watch reports appends to the current
      // inode, while the directory watch reports the name-level events
      // (creation, replacement by rename) an inode watch cannot see.
      fileWatcher = fs.watch(filePath, () => check())
      fileWatcher.on('error', () => check())
    } catch {
      armDirectory()
      return
    }
    try {
      dirWatcher = fs.watch(
        path.dirname(filePath),
        (_eventType, filename) => {
          if (filename === path.basename(filePath)) check()
        }
      )
      dirWatcher.on('error', () => {})
    } catch {
      // File watch alone is enough here; a later check() re-arms everything.
    }
  }

  if (fs.existsSync(filePath)) {
    watchFile()
  } else {
    armDirectory()
  }

  return {
    close(): void {
      closed = true
      stopWatchers()
    },
  }
}
