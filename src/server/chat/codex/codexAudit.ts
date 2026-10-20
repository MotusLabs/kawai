// Outbound-audit parity for Codex chats (codex-chat-sessions design D13,
// ruling R5): every `commandExecution` item reaches the session's outbound
// observer as a `Bash` use and every external `mcpToolCall` as
// `mcp__<server>__<tool>` — the same classifier, withholding, and redaction
// a Claude agent's Bash and MCP calls pass through. The item lifecycle maps
// onto the observer's hook methods: started → Pre, completed → Post, failed
// → PostFailure, declined → PermissionDenied (a declined card is reported by
// codexRequests through `onDeniedCard`). Observation only: nothing here can
// block, delay, or deny a call, and a throwing observer is swallowed.
// `kawai-team` dynamic-tool calls are never fed (the mailbox records them),
// and a `fileChange` is not a send.
import type { OutboundAuditSink } from '../../outbound/observer'
import type { ThreadItem } from './protocol/v2/ThreadItem'
import { mcpToolName, TEAM_NAMESPACE } from './codexEvents'

/** The live facts each fed use carries. */
export interface CodexAuditContext {
  sink: OutboundAuditSink | undefined
  /** The audit id of the app-server process the item runs under (D7). */
  spawnId: string
  /** The session's project path, when the item names no cwd of its own. */
  cwd: string
}

/** The audited use an item stands for, or null when it is not audited. */
export function auditedUse(item: ThreadItem, fallbackCwd: string): { toolName: string; toolInput: unknown; cwd: string } | null {
  if (item.type === 'commandExecution') {
    return { toolName: 'Bash', toolInput: { command: item.command }, cwd: item.cwd || fallbackCwd }
  }
  if (item.type === 'mcpToolCall' && item.server !== TEAM_NAMESPACE) {
    return { toolName: mcpToolName(item.server, item.tool), toolInput: item.arguments ?? {}, cwd: fallbackCwd }
  }
  return null
}

/** Feed one item edge to the observer; never throws. */
export function auditItem(phase: 'started' | 'completed', item: ThreadItem | undefined, context: CodexAuditContext): void {
  const sink = context.sink
  if (!sink || !item || typeof (item as { id?: unknown }).id !== 'string') return
  try {
    const use = auditedUse(item, context.cwd)
    if (!use) return
    const common = { toolName: use.toolName, toolUseId: (item as { id: string }).id, spawnId: context.spawnId, cwd: use.cwd }
    if (phase === 'started') {
      sink.onPreToolUse({ ...common, toolInput: use.toolInput })
      return
    }
    const status = (item as { status?: unknown }).status
    const durationMs = (item as { durationMs?: unknown }).durationMs
    const duration = typeof durationMs === 'number' ? { durationMs } : {}
    if (status === 'completed') {
      sink.onPostToolUse({ ...common, toolInput: use.toolInput, background: false, ...duration })
    } else if (status === 'declined') {
      sink.onPermissionDenied({ ...common, reason: 'declined' })
    } else if (status === 'failed') {
      sink.onPostToolUseFailure({ ...common, error: failureText(item), ...duration })
    }
  } catch {
    // Observational only: an audit failure never fails the tool call.
  }
}

/** The process ended: its calls read outcome-unknown unless settled (D7). */
export function auditSpawnEnd(sink: OutboundAuditSink | undefined, spawnId: string): void {
  try {
    sink?.onSpawnEnd(spawnId)
  } catch {
    // Observational only.
  }
}

/** A declined or cancelled card (codexRequests), as Claude's canUseTool deny. */
export function auditDeniedCard(
  sink: OutboundAuditSink | undefined,
  use: { tool: string; itemId: string; input: unknown; reason?: string },
  context: { spawnId: string; cwd: string },
): void {
  if (!sink || use.tool === 'Edit' || use.tool === 'Permissions') return
  try {
    sink.onDeniedCard({
      toolName: use.tool,
      toolInput: use.input,
      toolUseId: use.itemId,
      spawnId: context.spawnId,
      cwd: context.cwd,
      ...(use.reason === undefined ? {} : { reason: use.reason }),
    })
  } catch {
    // Observational only.
  }
}

function failureText(item: ThreadItem): string {
  if (item.type === 'mcpToolCall') return item.error?.message ?? 'failed'
  if (item.type === 'commandExecution') {
    const output = (item.aggregatedOutput ?? '').slice(-512)
    return item.exitCode === null ? output || 'failed' : `exit code ${item.exitCode}${output ? `: ${output}` : ''}`
  }
  return 'failed'
}
