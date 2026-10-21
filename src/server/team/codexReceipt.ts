// A Codex chat's mail receipt over every rollout file of its thread
// (codex-chat-sessions D8; PR D decision 2, M1–M2). One reader backs the
// startup reconcile and the turn-end settle, so a resume that moved the
// rollout never hides a receipt written to the older file.
//
// Fail closed: absence licenses a requeue only when the reader is proven —
// some file of the session holds a recognized envelope row — and the
// stored path carries the thread id in its name. Any other absence holds.
import fs from 'node:fs'
import path from 'node:path'
import { codexReceiptMessageId, type Receipt } from './receipt'

/** Directory levels below `<codex_home>/sessions` walked (YYYY/MM/DD is 3). */
const MAX_DEPTH = 4

export interface CodexReceiptSource {
  /** The rollout the driver last reported (`transcript_path`), the newest one. */
  transcriptPath: string | null | undefined
  /** The chat's creation-fixed Codex home. */
  codexHome: string | null | undefined
  /** The chat's thread id (`sdk_session_id`). */
  threadId: string | null | undefined
}

export const isThreadRolloutName = (name: string, threadId: string) =>
  name.startsWith('rollout-') && name.endsWith(`-${threadId}.jsonl`)

/**
 * Every `rollout-*-<threadId>.jsonl` under `<home>/sessions`, at most
 * MAX_DEPTH directories down, never through a symlink. `complete` is false
 * when a directory could not be read: a receipt may hide there.
 */
export function threadRolloutFiles(home: string, threadId: string): { files: string[]; complete: boolean } {
  const files: string[] = []
  let complete = true
  const walk = (dir: string, depth: number) => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') complete = false
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isFile() && isThreadRolloutName(entry.name, threadId)) files.push(full)
      else if (entry.isDirectory() && depth < MAX_DEPTH) walk(full, depth + 1)
    }
  }
  walk(path.join(home, 'sessions'), 1)
  return { files, complete }
}

type FileRead = { found: boolean; proven: boolean; intact: boolean }

function readRollout(file: string, messageId: string): FileRead {
  let found = false
  let proven = false
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(line => line.trim())
    for (const line of lines) {
      const id = codexReceiptMessageId(line)
      if (id) proven = true
      if (id === messageId) found = true
    }
    for (const line of lines) JSON.parse(line)
    return { found, proven, intact: true }
  } catch {
    // A torn tail beside a delivered row is still a delivery (found wins
    // before the integrity check, as transcriptReceipt reads a Claude
    // transcript); only absence loses its intactness, and that holds.
    return { found, proven, intact: false }
  }
}

export function codexRolloutReceipt(source: CodexReceiptSource, messageId: string): Receipt {
  const { transcriptPath, codexHome, threadId } = source
  if (!threadId) return 'uncertain'
  const walked = codexHome ? threadRolloutFiles(codexHome, threadId) : { files: [], complete: true }
  const files = [...new Set([...(transcriptPath ? [transcriptPath] : []), ...walked.files])]
  const reads = files.map(file => readRollout(file, messageId))
  if (reads.some(read => read.found)) return 'found'
  const named = !!transcriptPath && isThreadRolloutName(path.basename(transcriptPath), threadId)
  const proven = reads.some(read => read.proven)
  if (!named || !proven || !walked.complete || reads.some(read => !read.intact)) return 'uncertain'
  return 'absent'
}
