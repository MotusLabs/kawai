// One Claude spawn's package options, composed by Kawai (extract-agent-runtime
// task 6.1): the catalog profile resolved per spawn (registered names
// withheld, the profile's env, model, flag-layer settings and wrapper
// executable), the team tool table as one host ToolSet, the outbound audit
// hooks replayed from the package's raw hook observations, the denied-card
// and spawn-end audit rows, and the per-spawn launch fields with the wire.
// The package construction is public (`createClaudeDriver`) unless a caller
// injected a query factory — the test fakes and the development fixture,
// which never spawn — and then the package's private repository seam runs
// the same validation and session core over that query.
import os from 'node:os'
import type { HookCallback, Options, Query, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { createClaudeDriver } from '@motuslabs/agent-runtime/claude'
import type { ClaudeAgentDriver, ClaudeDriverOptions, LaunchConfiguration, ToolSet } from '@motuslabs/agent-runtime'
import type { ChatSessionDriverOptions } from '../ChatSessionDriver'
import { runtimeLogger } from './codexRuntimeSupport'
// The repository's private test seam (not exported by any package entry).
import { createClaudeDriverWith } from '../../../../packages/agent-runtime/src/claude/driver'
import type { OutboundAuditSink } from '../../outbound/observer'
import { outboundAuditHooks } from '../../outbound/auditHooks'
import { TEAM_MCP_SERVER } from '../../team/teamPrompt'
import type { ChatQueryFactory } from '../ChatSessionDriver'
import { resolveClaudeProfile } from '../ClaudeProfiles'
import type { ChatProviderEnv } from '../chatProviderEnv'
import type { RetainedNamesDb } from '../secretNameRegistry'
import type { ChatWireRecorder } from '../wireTap'
import type { TeamToolSpec } from '../../team/mailboxTools'

export type CreateClaudeRuntime = (options: ClaudeDriverOptions, queryFactory?: ChatQueryFactory, wire?: ChatWireRecorder) => ClaudeAgentDriver

/** Public construction, or the seam over an injected query (see the header). */
export const createClaudeRuntime: CreateClaudeRuntime = (options, queryFactory, wire) => {
  if (!queryFactory) return createClaudeDriver(options)
  return createClaudeDriverWith(options, {
    queryFactory: ({ prompt, options: sdk }: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => compatibleQuery(queryFactory({ prompt, options: sdk, ...(wire ? { wire } : {}) })),
  })
}

/**
 * An injected query that predates the package's readiness read: fakes that
 * report their commands by pushed frames answer `initializationResult()`
 * with no command list, so the list stays loading until a pushed frame
 * names it (the old driver skipped the call for them).
 */
function compatibleQuery(query: Query): Query {
  if (typeof (query as { initializationResult?: unknown }).initializationResult === 'function') return query
  ;(query as { initializationResult: () => Promise<unknown> }).initializationResult = () => Promise.resolve({})
  return query
}

export interface ClaudeSpawnInput {
  claudeProfileId?: string
  getProviderEnv?: () => ChatProviderEnv
  profileCatalogHome?: string
  retainedNamesDb?: RetainedNamesDb
  projectPath: string
  /** The verified standard executable; a profile wrapper replaces it. */
  claudeExecutablePath?: string
  /** An injected query never spawns: any executable file satisfies the launch check. */
  injected: boolean
}

export interface ClaudeSpawnLaunch {
  launch: LaunchConfiguration
  model?: string
  settingsEnv?: Record<string, string>
}

/**
 * Resolve the profile for one spawn. Throws synchronously, as the old
 * driver's spawn did, for an unknown profile, a Codex profile, or a refused
 * registered name, so the caller's start or send refuses before anything runs.
 */
export function claudeSpawnLaunch(input: ClaudeSpawnInput): ClaudeSpawnLaunch {
  const resolved = resolveClaudeProfile(
    input.claudeProfileId,
    input.getProviderEnv?.() ?? {},
    { projectPath: input.projectPath, ...(input.profileCatalogHome ? { homeDir: input.profileCatalogHome } : {}) },
    undefined,
    input.retainedNamesDb,
  )
  if (resolved.runtime !== 'claude') throw new Error('Codex chats start through the Codex driver, not the Claude Agent SDK.')
  const childEnv = strings(resolved.env ?? process.env)
  const executablePath = resolved.executable ?? input.claudeExecutablePath ?? (input.injected ? process.execPath : undefined)
  const settingsEnv = (resolved.settings as { env?: Record<string, string | undefined> } | undefined)?.env
  return {
    launch: {
      cwd: input.projectPath,
      childEnv,
      ...(executablePath ? { executablePath } : {}),
      homeDir: childEnv.HOME ?? os.homedir(),
      cacheDir: os.tmpdir(),
      tempDir: os.tmpdir(),
    },
    ...(typeof resolved.model === 'string' ? { model: resolved.model } : {}),
    ...(settingsEnv ? { settingsEnv: strings(settingsEnv) } : {}),
  }
}

function strings(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) if (typeof value === 'string') out[name] = value
  return out
}

/** The team tool table as the package's host ToolSet under Kawai's MCP server name. */
export function teamToolSet(table: readonly TeamToolSpec[] | undefined): ToolSet | undefined {
  if (!table?.length) return undefined
  return {
    namespace: TEAM_MCP_SERVER,
    tools: table.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.schema,
      handler: async (input: unknown) => {
        try {
          return { content: JSON.stringify(await tool.handler(input)) }
        } catch (error) {
          return { content: error instanceof Error ? error.message : String(error), isError: true }
        }
      },
    })),
  }
}

type HookKind = 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure' | 'PermissionDenied'

/**
 * Kawai's four outbound audit hooks, fed from the package's raw hook
 * observations (R2 `onHook`). They stay observational: a matcher filters by
 * tool name as the SDK would, and nothing returned reaches the agent.
 */
export function auditHookReplay(context: { sink: OutboundAuditSink | undefined; spawnId: () => string; cwd: () => string }): (kind: HookKind, input: unknown) => void {
  const hooks = outboundAuditHooks(context)
  const signal = new AbortController().signal
  return (kind, input) => {
    const tool = (input as { tool_name?: unknown } | null)?.tool_name
    for (const matcher of hooks[kind]) {
      if (!matches(matcher.matcher, typeof tool === 'string' ? tool : '')) continue
      for (const hook of matcher.hooks as HookCallback[]) {
        const toolUseId = (input as { tool_use_id?: unknown }).tool_use_id
        void Promise.resolve(hook(input as never, typeof toolUseId === 'string' ? toolUseId : undefined, { signal })).catch(() => {})
      }
    }
  }
}

function matches(matcher: string | undefined, tool: string): boolean {
  if (!matcher || matcher === '*') return true
  try {
    return new RegExp(`^(?:${matcher})$`).test(tool)
  } catch {
    return matcher === tool
  }
}

/**
 * The per-spawn package fields Kawai fixes: its logger, the launch, the
 * default permission mode over every tool, all three setting sources, the
 * profile's flag-layer env, the wire, waiting requests, and the host-login
 * usage claim.
 */
export function launchFields(options: Pick<ChatSessionDriverOptions, 'sessionId' | 'wire' | 'claimUsagePull'>, spawn: ClaudeSpawnLaunch) {
  const wire = options.wire
  return {
    logger: runtimeLogger(options.sessionId),
    launch: spawn.launch,
    permissions: { mode: 'default', enabledTools: 'all', disallowedTools: [] },
    settingSources: ['user', 'project', 'local'],
    ...(spawn.settingsEnv ? { settings: { env: spawn.settingsEnv } } : {}),
    ...(wire ? { wire: { record: (frame) => wire.record(frame.direction, frame.text) } } : {}),
    unansweredRequests: 'wait',
    ...(options.claimUsagePull ? { quotaSource: 'host-login' as const, claimUsagePull: options.claimUsagePull } : {}),
  } satisfies Partial<ClaudeDriverOptions>
}

/** A denied or cancelled card's outbound audit row; observational only. */
export function auditDeniedCard(sink: OutboundAuditSink | undefined, card: { tool: string; input: unknown; toolCallId: string }, at: { spawnId: string; cwd: string; interrupted: boolean }): void {
  try {
    sink?.onDeniedCard({ toolName: card.tool, toolInput: card.input, toolUseId: card.toolCallId, spawnId: at.spawnId, cwd: at.cwd, ...(at.interrupted ? { reason: 'interrupted' } : {}) })
  } catch {
    // Observational only.
  }
}

/** The spawn's end in the outbound audit; observational only. */
export function auditSpawnEnd(sink: OutboundAuditSink | undefined, spawnId: string): void {
  try {
    sink?.onSpawnEnd(spawnId)
  } catch {
    // Observational only.
  }
}
