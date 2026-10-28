// Transcript discovery without one projects-tree walk per lookup. A lookup
// by SDK id searches `<CLAUDE_CONFIG_DIR>/projects` to depth 3 (see
// `findTranscriptPath`); with hundreds of chats and project directories,
// walking once per row at boot, or per candidate on every mailbox pass,
// kept the event loop busy for minutes. Two tools replace those walks:
// - `indexTranscripts`: one async walk naming every transcript file, for
//   the boot restore of all persisted rows;
// - `TranscriptPathCache`: a remembered existing path per SDK id, for the
//   existence check the start blocker makes — reused while the file still
//   exists, re-walked on a miss.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { getClaudeConfigDir } from '../logDiscovery'
import { findTranscriptPath } from './transcriptReplay'

/** The depth `findTranscriptPath` searches below the projects root. */
const MAX_DEPTH = 3

export function transcriptsRoot(): string {
  return path.join(getClaudeConfigDir(), 'projects')
}

/**
 * File name (`<sdk id>.jsonl`) → path, from one walk of the projects tree.
 * Same walk and the same answer as `findTranscriptPath` per name: a name
 * found more than once keeps the newest copy (ties keep the first found);
 * only duplicates are stat'ed, and a copy that vanishes before its stat is
 * skipped.
 */
export async function indexTranscripts(root = transcriptsRoot()): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  const mtimes = new Map<string, number>()
  const mtimeOf = async (file: string): Promise<number | null> => {
    try {
      return (await fsp.stat(file)).mtimeMs
    } catch {
      return null
    }
  }
  const walk = async (dir: string, depth: number): Promise<void> => {
    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) await walk(full, depth + 1)
        continue
      }
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue
      const held = found.get(entry.name)
      if (held === undefined) {
        found.set(entry.name, full)
        continue
      }
      if (!mtimes.has(held)) mtimes.set(held, (await mtimeOf(held)) ?? -1)
      const mtime = await mtimeOf(full)
      if (mtime !== null && mtime > (mtimes.get(held) ?? -1)) {
        found.set(entry.name, full)
        mtimes.set(full, mtime)
      }
    }
  }
  await walk(root, 0)
  return found
}

/**
 * Some existing transcript of an SDK id, for checks that ask whether one
 * exists (not which copy is newest). A remembered path is reused while it
 * exists; a miss walks the tree once and remembers what it finds. Missing
 * transcripts are never remembered, so a restored file is seen at once.
 */
export class TranscriptPathCache {
  private readonly paths = new Map<string, string>()

  constructor(
    private readonly find: (sdkSessionId: string) => string | null = findTranscriptPath,
    private readonly exists: (filePath: string) => boolean = fs.existsSync
  ) {}

  existing(sdkSessionId: string): string | null {
    const known = this.paths.get(sdkSessionId)
    if (known !== undefined && this.exists(known)) return known
    this.paths.delete(sdkSessionId)
    const found = this.find(sdkSessionId)
    if (found) this.paths.set(sdkSessionId, found)
    return found
  }

  remember(sdkSessionId: string, filePath: string): void {
    this.paths.set(sdkSessionId, filePath)
  }
}
