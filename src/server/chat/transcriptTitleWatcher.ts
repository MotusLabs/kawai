// Tail of an SDK transcript for title rows (chat-session-naming design D4).
// Claude Code persists its generated session title as `ai-title` state rows
// (and `custom-title` rows for renames made inside Claude Code) in the
// session's JSONL — they never appear on the SDK message stream, so the file
// is the only source. The watcher reports each new title row as it lands:
// it reads only the appended region, tolerates a truncated trailing line by
// holding it until the next write completes it, and resets when the file
// shrinks (a rewrite). Until the file exists it watches the parent directory,
// so a watch armed before the transcript's first write still picks the file
// up on creation.
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
  let fileWatcher: fs.FSWatcher | null = null
  let dirWatcher: fs.FSWatcher | null = null
  let closed = false

  const stopWatchers = (): void => {
    fileWatcher?.close()
    fileWatcher = null
    dirWatcher?.close()
    dirWatcher = null
  }

  /** Consume the appended region; a shrunk file means a rewrite — restart. */
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
    for (const line of lines) {
      const title = parseTranscriptTitleLine(line.trim())
      if (title) onTitle(title.title, title.source)
    }
  }

  const armDirectory = (): void => {
    if (closed) return
    stopWatchers()
    offset = 0
    remainder = ''
    try {
      dirWatcher = fs.watch(
        path.dirname(filePath),
        (_eventType, filename) => {
          if (filename === path.basename(filePath)) watchFile()
        }
      )
      // A vanished directory has nothing left to watch; the caller's next
      // catch-up or spawn re-arms.
      dirWatcher.on('error', () => {})
    } catch {
      // Same: nothing further to do here.
    }
  }

  const watchFile = (): void => {
    if (closed) return
    stopWatchers()
    try {
      readAppended()
      fileWatcher = fs.watch(filePath, () => {
        // A rename event can mean deletion: fall back to waiting for the
        // file to come back.
        if (!fs.existsSync(filePath)) {
          armDirectory()
          return
        }
        readAppended()
      })
      fileWatcher.on('error', () => armDirectory())
    } catch {
      armDirectory()
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
