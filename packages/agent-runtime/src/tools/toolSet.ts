// Session-bound host tools (design §5, task 3.4). The host supplies one
// namespace of tools with Zod object schemas and handlers. The runtime adds
// none of its own, and an absent or empty set registers nothing (P09).
//
// Each driver routes a call through invoke(). The handler runs only when:
// - the call is for this session (the caller's identity check);
// - it names the bound namespace and a bound tool;
// - its arguments pass the tool's full schema.
//
// Every other call gets a structured refusal and the handler never runs
// (P10). A throwing handler becomes an error result, never a protocol
// failure (P11). Definitions are validated at construction: duplicate or
// inexact names, non-object schemas and missing handlers are configuration
// errors.
import { z } from 'zod'
import { AgentRuntimeError } from '../errors.js'
import type { ToolCallContext, ToolCallResult, ToolDefinition, ToolSet } from '../options.js'

/** MCP server and tool names the Claude CLI accepts in `mcp__<server>__<tool>`. */
const NAME = /^[A-Za-z0-9_-]+$/

export interface ToolInvocation extends ToolCallContext {
  namespace: string
  tool: string
  arguments: unknown
}

export interface BoundToolSet {
  readonly namespace: string
  readonly tools: readonly ToolDefinition[]
  /** Refuses with a reason, or runs the handler once with the parsed input. */
  invoke(call: ToolInvocation): Promise<ToolCallResult>
}

function configurationError(message: string): AgentRuntimeError {
  return new AgentRuntimeError({ category: 'configuration', message })
}

/** A structured refusal the model reads; the handler did not run. */
export function refusal(reason: string): ToolCallResult {
  return { content: `Refused: ${reason}`, isError: true }
}

/** Validate a host tool set; null when there is nothing to register. */
export function bindToolSet(set: ToolSet | undefined): BoundToolSet | null {
  if (set === undefined) return null
  if (set === null || typeof set !== 'object' || !Array.isArray(set.tools)) throw configurationError('tools must be { namespace, tools: [...] }')
  if (set.tools.length === 0) return null
  if (typeof set.namespace !== 'string' || !NAME.test(set.namespace) || set.namespace.includes('__')) {
    throw configurationError(`tool namespace ${JSON.stringify(set.namespace)} must match ${NAME} without "__"`)
  }
  const byName = new Map<string, ToolDefinition>()
  for (const tool of set.tools) {
    if (!tool || typeof tool.name !== 'string' || !NAME.test(tool.name)) throw configurationError(`tool name ${JSON.stringify(tool?.name)} must match ${NAME}`)
    if (byName.has(tool.name)) throw configurationError(`tool ${tool.name} is defined twice`)
    if (typeof tool.description !== 'string') throw configurationError(`tool ${tool.name} needs a description`)
    if (!(tool.inputSchema instanceof z.ZodObject)) throw configurationError(`tool ${tool.name} needs a Zod object input schema`)
    if (typeof tool.handler !== 'function') throw configurationError(`tool ${tool.name} needs a handler`)
    byName.set(tool.name, tool)
  }
  const namespace = set.namespace
  const tools = Object.freeze([...byName.values()])
  return {
    namespace,
    tools,
    async invoke(call) {
      if (call.namespace !== namespace) return refusal(`this session serves only the ${namespace} namespace`)
      const tool = byName.get(call.tool)
      if (!tool) return refusal(`unknown ${namespace} tool ${JSON.stringify(call.tool)}`)
      const parsed = tool.inputSchema.safeParse(call.arguments ?? {})
      if (!parsed.success) return refusal(`invalid arguments for ${tool.name}: ${z.prettifyError(parsed.error)}`)
      const context: ToolCallContext = { toolCallId: call.toolCallId, turnId: call.turnId, runtimeSessionId: call.runtimeSessionId }
      try {
        const result = await tool.handler(parsed.data, context)
        return { content: String(result.content), ...(result.isError ? { isError: true } : {}) }
      } catch (error) {
        return { content: error instanceof Error ? error.message : String(error), isError: true }
      }
    },
  }
}

/** The Claude CLI's name for a bound tool, as permission lists and hooks see it. */
export function claudeToolName(namespace: string, tool: string): string {
  return `mcp__${namespace}__${tool}`
}
