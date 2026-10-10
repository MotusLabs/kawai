// Tail of an SDK transcript for title rows (chat-session-naming design D4).
// Claude Code persists its generated session title as `ai-title` state rows
// (and `custom-title` rows for renames made inside Claude Code) in the
// session's JSONL — they never appear on the SDK message stream, so the file
// is the only source. The watcher reports each batch's latest title row as it
// lands: it reads only the appended region, tolerates a truncated trailing
// line by holding it until the next write completes it, and resets when the
// file shrinks (a rewrite) or is replaced under the same name (a temp-file
// rename hands back a different inode — an inode watch cannot follow that, so
// the parent directory is watched alongside the file and a changed identity
// re-arms from the start). Until the file exists it watches only the parent
// directory, so a watch armed before the transcript's first write still picks
// the file up on creation.
import fs from 'node:fs'
import path from 'node:path'
import { parseTranscriptTitleLine } from './transcriptReplay'

export interface TranscriptTitleWatcher {
  /** Stop watching. Safe to call more than once. */
  close(): void
}

/**
 * Watch `filePath` for appended title rows, reporting the latest one per
 * batch. The file's current content is read once up front (catch-up), so a
 * watch started after titles were already written still reports them.
 */
export function watchTranscriptTitle(
  filePath: string,
  onTitle: (title: string, source: 'auto' | 'manual') => void
): TranscriptTitleWatcher {
  let offset = 0
  let remainder = ''
  // dev:ino of the file the offset belongs to; null while no file is tracked.
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
   * Consume the appended region; a shrunk file means a rewrite — restart.
   * Only the batch's last title row is reported: earlier rows are history a
   * later row already superseded, and replaying them would momentarily move
   * the name backwards.
   */
  const readAppended = (): void => {
    let size: number
    try {
      size = fs.statSync(filePath).size
    } catch {
      return
    }
    if (size < offset) {
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
    let latest: { title: string; source: 'auto' | 'manual' } | null = null
    for (const line of lines) {
      const title = parseTranscriptTitleLine(line.trim())
      if (title) latest = { title: title.title, source: title.source }
    }
    if (latest) onTitle(latest.title, latest.source)
  }

  const watchDirectory = (): void => {
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

  /** Wait for the file (to be created, or re-created) via the directory. */
  const armDirectory = (): void => {
    if (closed) return
    stopWatchers()
    offset = 0
    remainder = ''
    identity = null
    watchDirectory()
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
    watchDirectory()
  }

  /**
   * React to any event touching the file: vanished → wait for creation via
   * the directory alone; replaced (different inode under the same name) →
   * re-arm on the new file; otherwise consume the appended region.
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
