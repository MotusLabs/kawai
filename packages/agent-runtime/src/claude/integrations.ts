// Host integrations for one Claude generation (design §5, task 3.4). Every
// seam is optional and adds nothing when absent (P09/I8):
//
// - tools: one in-process SDK MCP server named after the host namespace,
//   created per generation (an SDK server instance connects to one query).
//   Its handlers route through the bound set, so schema and name refusals
//   never run a handler. The CLI does not pass its tool_use_id to SDK
//   servers, so a handler's toolCallId is the MCP request id.
// - systemPromptAppend: the claude_code preset with the caller's append.
// - onToolObservation: PreToolUse and PostToolUse(Failure) hooks that report
//   only the tool name, call id and turn. They never see or forward
//   arguments (P14), and always answer with no decision, so they cannot
//   grant or block a tool (P15).
// - auditHooks: the detailed opt-in adapter. preToolUse receives the input.
//
// Observers run through `observe`, which retains a throw as a diagnostic and
// never lets it change the hook's answer.
import type { HookCallbackMatcher, HookEvent, HookInput, Options } from '@anthropic-ai/claude-agent-sdk'
import type { JsonValue } from '../json.js'
import type { ClaudeAuditHooks, ToolObservation } from '../options.js'
import type { BoundToolSet } from '../tools/toolSet.js'

type SdkModule = typeof import('@anthropic-ai/claude-agent-sdk')
type Hooks = Partial<Record<HookEvent, HookCallbackMatcher[]>>

export interface ClaudeIntegrationInput {
  tools: BoundToolSet | null
  systemPromptAppend?: string
  onToolObservation?(observation: ToolObservation): void
  auditHooks?: ClaudeAuditHooks
  /** The active turn at the moment a hook or call arrives. */
  turnId(): string | null
  /** The CLI session id from system/init, once known. */
  sessionId(): string | null
  /** Run an observational callback; a throw is retained and changes nothing. */
  observe(name: string, callback: () => void): void
}

export interface ClaudeIntegrationOptions {
  mcpServers?: NonNullable<Options['mcpServers']>
  systemPrompt?: Options['systemPrompt']
  hooks: Hooks
}

function observationHooks(input: ClaudeIntegrationInput): Hooks {
  const { onToolObservation, auditHooks } = input
  if (!onToolObservation && !auditHooks?.preToolUse && !auditHooks?.postToolUse) return {}
  const report = (phase: ToolObservation['phase'], tool: string, toolCallId: string, isError?: boolean) => {
    if (!onToolObservation) return
    // Built here from names only: nothing from the hook input's arguments is copied.
    const observation: ToolObservation = { phase, tool, toolCallId, turnId: input.turnId(), ...(isError === undefined ? {} : { isError }) }
    input.observe('onToolObservation', () => onToolObservation(observation))
  }
  const pre: HookCallbackMatcher = {
    hooks: [
      async (hook: HookInput) => {
        if (hook.hook_event_name !== 'PreToolUse') return {}
        report('call', hook.tool_name, hook.tool_use_id)
        if (auditHooks?.preToolUse) {
          const preToolUse = auditHooks.preToolUse
          input.observe('auditHooks.preToolUse', () => preToolUse({ tool: hook.tool_name, toolCallId: hook.tool_use_id, input: hook.tool_input as JsonValue }))
        }
        return {}
      },
    ],
  }
  const post = (isError: boolean): HookCallbackMatcher => ({
    hooks: [
      async (hook: HookInput) => {
        if (hook.hook_event_name !== 'PostToolUse' && hook.hook_event_name !== 'PostToolUseFailure') return {}
        report('result', hook.tool_name, hook.tool_use_id, isError)
        if (auditHooks?.postToolUse) {
          const postToolUse = auditHooks.postToolUse
          input.observe('auditHooks.postToolUse', () => postToolUse({ tool: hook.tool_name, toolCallId: hook.tool_use_id, isError }))
        }
        return {}
      },
    ],
  })
  return { PreToolUse: [pre], PostToolUse: [post(false)], PostToolUseFailure: [post(true)] }
}

function toolServer(sdk: SdkModule, input: ClaudeIntegrationInput, tools: BoundToolSet): NonNullable<Options['mcpServers']> {
  const definitions = tools.tools.map((definition) =>
    sdk.tool(definition.name, definition.description, (definition.inputSchema as unknown as { shape: Record<string, never> }).shape, async (args: unknown, extra: unknown) => {
      const requestId = (extra as { requestId?: unknown } | undefined)?.requestId
      const result = await tools.invoke({
        namespace: tools.namespace,
        tool: definition.name,
        arguments: args,
        toolCallId: requestId === undefined ? '' : `mcp-request:${String(requestId)}`,
        turnId: input.turnId(),
        runtimeSessionId: input.sessionId(),
      })
      return { content: [{ type: 'text' as const, text: result.content }], ...(result.isError ? { isError: true } : {}) }
    }),
  )
  return { [tools.namespace]: sdk.createSdkMcpServer({ name: tools.namespace, version: '1.0.0', tools: definitions }) }
}

/** The SDK options one generation's integrations contribute. */
export function claudeIntegrationOptions(sdk: SdkModule, input: ClaudeIntegrationInput): ClaudeIntegrationOptions {
  return {
    ...(input.tools ? { mcpServers: toolServer(sdk, input, input.tools) } : {}),
    ...(input.systemPromptAppend ? { systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: input.systemPromptAppend } } : {}),
    hooks: observationHooks(input),
  }
}

/** Concatenate hook lists per event, `first` before `second`. */
export function mergeHooks(first: Hooks | undefined, second: Hooks | undefined): Hooks {
  const merged: Hooks = { ...first }
  for (const [event, matchers] of Object.entries(second ?? {}) as Array<[HookEvent, HookCallbackMatcher[]]>) {
    merged[event] = [...(merged[event] ?? []), ...matchers]
  }
  return merged
}
