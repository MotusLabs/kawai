import path from 'node:path'
import { extractSessionId } from './logDiscovery'

/** A Codex rollout file name's thread id: `rollout-<time>-<thread uuid>.jsonl`. */
const ROLLOUT_THREAD_ID = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i

export interface LogExclusionVerdict {
  excluded: boolean
  /**
   * The head session id when stage H ran: the id, or null when the bounded
   * head names none. Undefined when H did not run (filter off, or F/R hit).
   */
  headSessionId?: string | null
}

/** A stored identity for a log path: a known session, orphan, or backfill record. */
export interface StoredLogIdentity {
  logFilePath: string | null | undefined
  sessionId: string | null | undefined
}

const KEEP: LogExclusionVerdict = { excluded: false }

/**
 * Design D1: chat transcripts (their SDK ids are the exclude set) are not
 * discovery material. One verdict per log path for the whole request, staged
 * so a hit stops early:
 * - F, the file-name thread id, and R, any stored record id of the path —
 *   neither opens the file;
 * - H, the head session id from the bounded `extractSessionId` parse, only
 *   when F and R missed. Being known never skips H.
 * Only a positive hit excludes: an unresolved head infers nothing. An empty
 * set disables the filter and reads nothing. Every candidate class asks the
 * same instance, so a dropped path stays dropped for the request.
 */
export class LogExclusion {
  private readonly ids: ReadonlySet<string>
  private readonly storedIds = new Map<string, string[]>()
  private readonly verdicts = new Map<string, LogExclusionVerdict>()

  constructor(
    excludeSessionIds: Iterable<string> | undefined,
    stored: Iterable<StoredLogIdentity> = []
  ) {
    this.ids = new Set(excludeSessionIds ?? [])
    for (const { logFilePath, sessionId } of stored) {
      if (!logFilePath || !sessionId) continue
      const ids = this.storedIds.get(logFilePath)
      if (ids) ids.push(sessionId)
      else this.storedIds.set(logFilePath, [sessionId])
    }
  }

  get enabled(): boolean {
    return this.ids.size > 0
  }

  check(logPath: string): LogExclusionVerdict {
    if (!this.enabled) return KEEP
    const cached = this.verdicts.get(logPath)
    if (cached) return cached
    const verdict = this.evaluate(logPath)
    this.verdicts.set(logPath, verdict)
    return verdict
  }

  excludes(logPath: string): boolean {
    return this.check(logPath).excluded
  }

  private evaluate(logPath: string): LogExclusionVerdict {
    const threadId = ROLLOUT_THREAD_ID.exec(path.basename(logPath))?.[1]
    if (threadId && this.ids.has(threadId)) return { excluded: true }
    if (this.storedIds.get(logPath)?.some((id) => this.ids.has(id))) {
      return { excluded: true }
    }
    const headSessionId = extractSessionId(logPath)
    return {
      excluded: headSessionId !== null && this.ids.has(headSessionId),
      headSessionId,
    }
  }
}
