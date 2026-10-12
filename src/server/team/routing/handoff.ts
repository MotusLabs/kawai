// Handoff packages (profile-routing design D10): when an agent that hit a
// provider limit forwards its work, the new message carries what kawai saw —
// the tool calls and touched files since the claim, the last error, and the
// repository commit at claim time — plus an instruction to rebuild context
// from the working directory before acting. Task header, journal, and thread
// ride the envelope already (task context, attached thread).
import type { ChatHandoffPackage } from '../../../shared/team'

/** Tool names kept in a digest. */
export const DIGEST_TOOL_LIMIT = 30
/** Touched paths kept in a digest. */
export const DIGEST_FILE_LIMIT = 50

/** Input fields that name a file a tool touched. */
const PATH_FIELDS = ['file_path', 'notebook_path', 'path'] as const

/** Tool calls an agent ran while handling one message. */
export class ProgressDigest {
  toolCalls = 0
  readonly tools: string[] = []
  readonly files = new Set<string>()

  record(tool: string, input: unknown): void {
    this.toolCalls++
    this.tools.push(tool)
    if (this.tools.length > DIGEST_TOOL_LIMIT) this.tools.shift()
    if (!input || typeof input !== 'object') return
    for (const field of PATH_FIELDS) {
      const value = (input as Record<string, unknown>)[field]
      if (typeof value === 'string' && value.trim() !== '' && this.files.size < DIGEST_FILE_LIMIT) this.files.add(value)
    }
  }

  snapshot(): ChatHandoffPackage['progress'] {
    return { toolCalls: this.toolCalls, tools: [...this.tools], filesTouched: [...this.files] }
  }
}

/** The readable section above a forwarded message's body. */
export function formatHandoffHeader(handoff: ChatHandoffPackage): string {
  const { progress } = handoff
  const lines = [
    `[Handoff] Session ${handoff.fromSession} (profile ${handoff.fromProfile}) hit a provider limit and handed this work on.`,
    `Progress since it claimed the work: ${progress.toolCalls} tool call${progress.toolCalls === 1 ? '' : 's'}` +
      (progress.tools.length > 0 ? ` (${progress.tools.join(', ')})` : '') + '.',
    `Files touched: ${progress.filesTouched.length > 0 ? progress.filesTouched.join(', ') : 'none recorded'}.`,
    `Last error: ${handoff.lastError ?? 'unknown'}.`,
  ]
  if (handoff.claimCommit) {
    lines.push(
      `Commit at claim: ${handoff.claimCommit}.`,
      `Before acting, reconstruct its progress from the working directory: run \`git status\`, \`git diff ${handoff.claimCommit}\`, and \`git log ${handoff.claimCommit}..\`.`,
    )
  } else {
    lines.push('Before acting, reconstruct its progress from the working directory: run `git status` and inspect what changed.')
  }
  return `${lines.join('\n')}\n`
}

export function isHandoffPackage(value: unknown): value is ChatHandoffPackage {
  const handoff = value as Record<string, unknown> | null
  if (!handoff || typeof handoff !== 'object') return false
  const progress = handoff.progress as Record<string, unknown> | null
  const strings = (list: unknown) => Array.isArray(list) && list.every(item => typeof item === 'string')
  return typeof handoff.fromSession === 'string' && typeof handoff.fromProfile === 'string' &&
    (handoff.claimCommit === null || typeof handoff.claimCommit === 'string') &&
    (handoff.lastError === null || typeof handoff.lastError === 'string') &&
    !!progress && typeof progress === 'object' && typeof progress.toolCalls === 'number' &&
    strings(progress.tools) && strings(progress.filesTouched)
}
