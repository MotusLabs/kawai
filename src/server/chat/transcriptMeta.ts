// Streaming boot catch-up read of one transcript: its current title and last
// working directory (chat-session-naming D4, worktree tracking D3) without
// holding the file or its parsed events in memory. `parseTranscriptContent`
// decodes the whole file into one string and JSON-parses every line, which
// for a several-hundred-megabyte transcript costs gigabytes and blocks the
// event loop for minutes; this reader scans bytes chunk by chunk (the shared
// `scanLines`), decodes
// only title rows, and parses only the cwd candidates it needs — from the
// newest back — so the result equals the full parse's `title` and `cwd`.
import fsp from 'node:fs/promises'
import { scanLines } from './lineReader'
import {
  parseTranscriptTitleLine,
  recordCwd,
  type TranscriptMeta,
  type TranscriptTitle,
} from './transcriptReplay'

const TITLE_MARKERS = [Buffer.from('"ai-title"'), Buffer.from('"custom-title"')]
// A record carrying a cwd spells one of these keys literally; any other
// line cannot change the result, so it is never decoded or parsed.
const CWD_MARKERS = [Buffer.from('"cwd"'), Buffer.from('"workingDirectory"')]

const EMPTY: TranscriptMeta = { title: null, cwd: null }

function holds(line: Buffer, markers: Buffer[]): boolean {
  return markers.some(marker => line.indexOf(marker) !== -1)
}

/**
 * Title and cwd of a transcript file, read in bounded chunks. Same answer
 * as `parseTranscriptContent(content).title/.cwd`; nulls when unreadable.
 */
export async function scanTranscriptMeta(filePath: string): Promise<TranscriptMeta> {
  let handle: fsp.FileHandle
  try {
    handle = await fsp.open(filePath, 'r')
  } catch {
    return EMPTY
  }
  try {
    let title: TranscriptTitle | null = null
    // Byte ranges of cwd candidate lines, oldest first; resolved newest first.
    const candidates: Array<[number, number]> = []
    const take = (line: Buffer, start: number): void => {
      if (holds(line, TITLE_MARKERS)) {
        const lineTitle = parseTranscriptTitleLine(line.toString('utf8').trim())
        if (lineTitle) {
          // A user-set title is terminal (D1/D7); generated ones: latest wins.
          if (lineTitle.source === 'manual' || title?.source !== 'manual') title = lineTitle
          return
        }
      }
      if (holds(line, CWD_MARKERS)) candidates.push([start, start + line.length])
    }
    await scanLines(handle, take)
    return { title, cwd: await newestCwd(handle, candidates) }
  } catch {
    return EMPTY
  } finally {
    await handle.close().catch(() => {})
  }
}

/** The newest candidate that the full parse would take a cwd from. */
async function newestCwd(
  handle: fsp.FileHandle,
  candidates: Array<[number, number]>
): Promise<string | null> {
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const [start, end] = candidates[i]
    const line = Buffer.allocUnsafe(end - start)
    const { bytesRead } = await handle.read(line, 0, line.length, start)
    let record: unknown
    try {
      record = JSON.parse(line.subarray(0, bytesRead).toString('utf8'))
    } catch {
      continue
    }
    // The full parse's filters: objects only, no meta or sidechain records.
    if (!record || typeof record !== 'object') continue
    const fields = record as Record<string, unknown>
    if (fields.isMeta === true || fields.isSidechain === true) continue
    const cwd = recordCwd(fields)
    if (cwd) return cwd
  }
  return null
}
