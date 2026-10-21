// The kawai-team tools as Codex dynamic tools (codex-chat-sessions D6): one
// `kawai-team` namespace built from the same teamToolTable the Claude MCP
// server uses, and the `item/tool/call` dispatch. A call runs its handler
// only for the session's own thread, the kawai-team namespace, a tool in the
// table, and arguments the tool's Zod schema accepts; every refusal and a
// throwing handler answer `success: false` with the reason as text, so the
// model reads it — never a JSON-RPC error. Dynamic calls bypass Codex
// approval (spike), so no Kawai card is ever raised for them.
import { z } from 'zod'
import { TEAM_MCP_SERVER } from '../../team/teamPrompt'
import type { TeamToolSpec } from '../../team/mailboxTools'
import type { DynamicToolCallParams } from './protocol/v2/DynamicToolCallParams'
import type { DynamicToolCallResponse } from './protocol/v2/DynamicToolCallResponse'
import type { DynamicToolSpec } from './protocol/v2/DynamicToolSpec'
import type { JsonValue } from './protocol/serde_json/JsonValue'

export const TEAM_NAMESPACE = TEAM_MCP_SERVER

/** The thread/start `dynamicTools` entry: one namespace holding every team tool. */
export function teamNamespaceSpec(table: readonly TeamToolSpec[]): DynamicToolSpec {
  return {
    type: 'namespace',
    name: TEAM_NAMESPACE,
    description: 'Kawai team tools: mailbox, tasks, plans, strategy, and reports, bound to this session.',
    tools: table.map(tool => ({
      type: 'function' as const,
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(tool.schema) as JsonValue,
    })),
  }
}

function answer(success: boolean, text: string): DynamicToolCallResponse {
  return { success, contentItems: [{ type: 'inputText', text }] }
}

/**
 * Serve one `item/tool/call` for the session whose thread is `threadId`.
 * `table` is read per call, so the handlers bound at this agent start serve
 * it; a tool a stored registration names but the table lacks is unknown.
 * A subagent's call carries its parent's thread id — the session's own —
 * and is served as the session; the call holds no other identity (M4). A
 * child thread's id is not this session's and is refused, as is a call
 * before the thread is known (fail closed).
 */
export async function dispatchTeamToolCall(
  table: readonly TeamToolSpec[],
  threadId: string | null,
  params: Partial<DynamicToolCallParams> | null,
): Promise<DynamicToolCallResponse> {
  if (!params) return answer(false, 'Refused: the call carries no parameters.')
  if (!threadId) return answer(false, 'Refused: no thread yet — the Codex thread has not started, so Kawai serves no team tool.')
  if (params.threadId !== threadId) return answer(false, 'Refused: this call is not for this session\'s thread.')
  if (params.namespace !== TEAM_NAMESPACE) return answer(false, `Refused: Kawai serves only the ${TEAM_NAMESPACE} namespace.`)
  const tool = table.find(entry => entry.name === params.tool)
  if (!tool) return answer(false, `Unknown ${TEAM_NAMESPACE} tool: ${String(params.tool)}`)
  try {
    const parsed = tool.schema.safeParse(params.arguments ?? {})
    if (!parsed.success) return answer(false, `Invalid arguments for ${tool.name}: ${z.prettifyError(parsed.error)}`)
    return answer(true, JSON.stringify(await tool.handler(parsed.data)))
  } catch (error) {
    return answer(false, error instanceof Error ? error.message : String(error))
  }
}
