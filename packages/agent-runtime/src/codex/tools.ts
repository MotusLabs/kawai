// Host tools as Codex dynamic tools (design §5, task 3.4). A bound set
// becomes one thread/start `dynamicTools` namespace entry, and each
// `item/tool/call` is served through the bound set. The call runs only for
// this session's own thread. A call that arrives before the thread is known,
// or names another thread, is refused before the set is consulted. Every
// refusal and every handler failure answers `success: false` with text the
// model reads, never a JSON-RPC error. An empty set sends no `dynamicTools`
// at all. Wiring into the driver lands with task 4.2. The driver must run
// each dispatch as a session-owned job, so stop joins it, and refuse calls
// once stop has begun, as the Claude session does. The JSON Schema the model
// sees is the input side, so field transforms are allowed.
import { z } from 'zod'
import { refusal, type BoundToolSet } from '../tools/toolSet.js'
import type { ToolCallResult } from '../options.js'

export interface CodexDynamicToolCall {
  threadId?: unknown
  turnId?: unknown
  callId?: unknown
  namespace?: unknown
  tool?: unknown
  arguments?: unknown
}

export interface CodexDynamicToolResponse {
  success: boolean
  contentItems: Array<{ type: 'inputText'; text: string }>
}

/** thread/start `dynamicTools`: one namespace entry, or none for an empty set. */
export function codexDynamicTools(tools: BoundToolSet | null): unknown[] | undefined {
  if (!tools) return undefined
  return [
    {
      type: 'namespace',
      name: tools.namespace,
      description: `Host tools bound to this session (${tools.namespace}).`,
      tools: tools.tools.map((tool) => ({ type: 'function', name: tool.name, description: tool.description, inputSchema: z.toJSONSchema(tool.inputSchema, { io: 'input' }) })),
    },
  ]
}

function response(result: ToolCallResult): CodexDynamicToolResponse {
  return { success: !result.isError, contentItems: [{ type: 'inputText', text: result.content }] }
}

/** Serve one `item/tool/call` for the session whose thread is `threadId`. */
export async function dispatchCodexToolCall(tools: BoundToolSet | null, threadId: string | null, params: CodexDynamicToolCall | null): Promise<CodexDynamicToolResponse> {
  if (!params || typeof params !== 'object') return response(refusal('the call carries no parameters'))
  if (!threadId) return response(refusal('the session has no thread yet'))
  if (params.threadId !== threadId) return response(refusal("this call is not for this session's thread"))
  if (!tools) return response(refusal('this session has no host tools'))
  return response(
    await tools.invoke({
      namespace: typeof params.namespace === 'string' ? params.namespace : '',
      tool: typeof params.tool === 'string' ? params.tool : '',
      arguments: params.arguments,
      toolCallId: typeof params.callId === 'string' ? params.callId : '',
      turnId: typeof params.turnId === 'string' ? params.turnId : null,
      runtimeSessionId: threadId,
    }),
  )
}
