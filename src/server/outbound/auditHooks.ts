// The audit hooks' construction (execution-safety-recovery D3): the four
// observational SDK hook entries a driver registers verbatim, and the
// per-session observer a manager builds for its driver. Everything here is
// glue — the verdicts live in the classifier, the writes in the observer —
// and the hooks stay observational: each returns exactly `{ continue: true }`,
// hands the use to the sink inside try/catch, and never blocks, delays, or
// denies a tool call.
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk'
import type { DestinationClasses } from './classify'
import { OutboundObserver, type OutboundAuditSink } from './observer'
import type { ResolvedRepoFacts } from './repoFacts'
import type { OutboundObserverOptions } from './observer'

/** The tools whose calls the audit hooks see (D3). */
export const AUDITED_TOOLS = '^(Bash|Monitor|mcp__.+)$'

type AuditEvent = 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | 'PermissionDenied'

/**
 * D3: whether a call runs in the background — a `run_in_background` Bash or
 * any Monitor starts there, and a foreground Bash the harness moved to the
 * background says so in its response ("…was moved to the background (ID: …)"),
 * so its call records `started-background`, not `completed` while it runs.
 */
export function callRanInBackground(toolName: string, toolInput: unknown, response: unknown): boolean {
  if (toolName === 'Monitor') return true
  if (toolName !== 'Bash') return false
  if ((toolInput as { run_in_background?: unknown } | null)?.run_in_background === true) return true
  return typeof response === 'string' && /(?:was moved to the background|running in background with ID:)/.test(response)
}

/** What the driver supplies per event: the sink and the session's live facts. */
export interface OutboundHookContext {
  sink: OutboundAuditSink | undefined
  /** The spawn the current call belongs to (minted per spawned command, D7). */
  spawnId: () => string
  /** The session's project path: the effective cwd a call is judged from. */
  cwd: () => string
}

/**
 * The four audit hook entries (D3). The driver registers them beside its
 * own hooks; each callback returns exactly `{ continue: true }` — no
 * permission decision, input update, retry, or message — before any file
 * read or database write, which the observer defers behind a catch-all.
 */
export function outboundAuditHooks(context: OutboundHookContext): {
  PreToolUse: Array<{ matcher: string; hooks: HookCallback[] }>
  PostToolUse: Array<{ matcher: string; hooks: HookCallback[] }>
  PostToolUseFailure: Array<{ matcher: string; hooks: HookCallback[] }>
  PermissionDenied: Array<{ matcher: string; hooks: HookCallback[] }>
} {
  const auditHook = (event: AuditEvent): HookCallback =>
    async (input) => {
      const sink = context.sink
      if (sink !== undefined) {
        try {
          const use = input as {
            tool_name: string
            tool_input?: unknown
            tool_response?: unknown
            tool_use_id?: string
            agent_id?: string
            error?: string
            is_interrupt?: boolean
            reason?: string
            duration_ms?: number
          }
          const common = {
            toolName: use.tool_name,
            toolInput: use.tool_input,
            toolUseId: use.tool_use_id ?? '',
            spawnId: context.spawnId(),
            ...(use.agent_id === undefined ? {} : { agentId: use.agent_id }),
            cwd: context.cwd(),
          }
          const toolInput = use.tool_input
          if (event === 'PreToolUse') {
            sink.onPreToolUse({ ...common, toolInput })
          } else if (event === 'PostToolUse') {
            sink.onPostToolUse({
              ...common,
              toolInput,
              background: callRanInBackground(use.tool_name, use.tool_input, use.tool_response),
              ...(use.duration_ms === undefined ? {} : { durationMs: use.duration_ms }),
            })
          } else if (event === 'PostToolUseFailure') {
            sink.onPostToolUseFailure({
              ...common,
              error: use.error ?? '',
              ...(use.is_interrupt === undefined ? {} : { isInterrupt: use.is_interrupt }),
              ...(use.duration_ms === undefined ? {} : { durationMs: use.duration_ms }),
            })
          } else {
            sink.onPermissionDenied({ ...common, reason: use.reason ?? '' })
          }
        } catch {
          // Observational only: an audit failure never fails the tool call.
        }
      }
      return { continue: true }
    }
  return {
    PreToolUse: [{ matcher: AUDITED_TOOLS, hooks: [auditHook('PreToolUse')] }],
    PostToolUse: [{ matcher: AUDITED_TOOLS, hooks: [auditHook('PostToolUse')] }],
    PostToolUseFailure: [{ matcher: AUDITED_TOOLS, hooks: [auditHook('PostToolUseFailure')] }],
    PermissionDenied: [{ matcher: AUDITED_TOOLS, hooks: [auditHook('PermissionDenied')] }],
  }
}

/** What a manager supplies to build its session's observer. */
export interface SessionObserverInput {
  sessionId: string
  store: OutboundObserverOptions['store']
  destinations: DestinationClasses
  repos: { factsFor(cwd: string): ResolvedRepoFacts | null }
  /** The session's group, profile, and task when the call is made. */
  context: () => { groupId?: string; profileId?: string; taskId?: string }
  /** team_id for calls whose cwd sits in no repository (D6 names the cwd's team). */
  teamIdFallback: () => string
}

/** The observer a chat session's driver audits through (D7); the manager registers it. */
export function sessionObserver(input: SessionObserverInput): OutboundObserver {
  return new OutboundObserver({
    sessionId: input.sessionId,
    store: input.store,
    destinations: input.destinations,
    repos: input.repos,
    context: input.context,
    teamIdFallback: input.teamIdFallback,
  })
}
