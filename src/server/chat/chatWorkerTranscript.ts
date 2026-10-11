// A worker's expanded body (design D5): the subagent transcript Claude Code
// writes under the parent's session directory —
// `<projectDir>/<sdkSessionId>/subagents/agent-<agentId>.jsonl`
// — resolved by joining the roster's workerId (the spawning tool call id)
// against each `agent-<agentId>.meta.json`, which carries `toolUseId`. Read
// live or after settle with one code path; reading while the worker runs is
// safe because whole records are appended, so a trailing partial line (the
// only concurrent-read hazard) is dropped by the line parser. No SDK import:
// the JSONL shape is stable and already parsed by transcriptReplay.
import fs from 'node:fs'
import path from 'node:path'
import type { ChatEvent } from '../../shared/chat'
import { findTranscriptPath, parseTranscriptContent } from './transcriptReplay'

export interface WorkerTranscript {
  status: 'ok' | 'unavailable'
  events: ChatEvent[]
}

/**
 * Read a worker's transcript. Unavailable when the session has no SDK id, its
 * parent transcript cannot be located (so neither can the subagents dir), no
 * `agent-*.meta.json` claims the tool call, or the body file is unreadable —
 * the row reports the body unavailable, never an error.
 */
export function readWorkerTranscript(
  sdkSessionId: string | null,
  workerId: string
): WorkerTranscript {
  if (!sdkSessionId) return unavailable()
  const parentPath = findTranscriptPath(sdkSessionId)
  if (!parentPath) return unavailable()
  // `<dir>/<sdkSessionId>.jsonl` → `<dir>/<sdkSessionId>/subagents`.
  const subagentsDir = path.join(parentPath.replace(/\.jsonl$/, ''), 'subagents')
  const agentId = findAgentId(subagentsDir, workerId)
  if (!agentId) return unavailable()
  let content: string
  try {
    content = fs.readFileSync(
      path.join(subagentsDir, `agent-${agentId}.jsonl`),
      'utf8'
    )
  } catch {
    return unavailable()
  }
  const parsed = parseTranscriptContent(content, { includeSidechain: true })
  return { status: 'ok', events: parsed.events }
}

/** The agent whose meta claims this tool call, or null when none does. */
function findAgentId(subagentsDir: string, workerId: string): string | null {
  let names: string[]
  try {
    names = fs.readdirSync(subagentsDir)
  } catch {
    return null
  }
  for (const name of names) {
    const match = /^agent-(.+)\.meta\.json$/.exec(name)
    if (!match) continue
    try {
      const meta: unknown = JSON.parse(
        fs.readFileSync(path.join(subagentsDir, name), 'utf8')
      )
      if (
        meta &&
        typeof meta === 'object' &&
        (meta as Record<string, unknown>).toolUseId === workerId
      ) {
        return match[1]!
      }
    } catch {
      // A corrupt meta cannot claim anything; keep scanning.
    }
  }
  return null
}

function unavailable(): WorkerTranscript {
  return { status: 'unavailable', events: [] }
}
