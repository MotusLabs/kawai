// One in-process MCP server per agent start, carrying the mailbox tools,
// (team-tasks) the task tools, and (product-strategy) the strategy tools.
// Handlers bind the actual session id and strip unknown arguments before
// passing content to the mailbox, task, or strategy service.
import { z } from 'zod'
import type { TeamMailbox } from './TeamMailbox'
import type { TaskService } from './TaskService'
import { TASK_TOOL_NAMES, taskDescriptions, taskHandlers, taskSchemas } from './taskTools'
import type { StrategyService } from '../strategy/StrategyService'
import { STRATEGY_TOOL_NAMES, strategyDescriptions, strategyHandlers, strategySchemas } from '../strategy/strategyTools'
import { TEAM_MCP_SERVER } from './teamPrompt'

export const MAILBOX_TOOL_NAMES = ['send_message', 'reply', 'schedule_message', 'list_groups'] as const
/** Every team tool, allowed without approval cards under either policy. */
export const TEAM_ALLOWED_TOOLS = [...MAILBOX_TOOL_NAMES, ...TASK_TOOL_NAMES, ...STRATEGY_TOOL_NAMES].map(name => `mcp__${TEAM_MCP_SERVER}__${name}`)

const content = { body: z.string().min(1), urgent: z.boolean().optional(), tags: z.array(z.string()).optional(), task_id: z.string().min(1).optional() }
// `human` is accepted so the service can refuse it with the reply path,
// rather than an opaque enum error (team-message-threads D5).
const recipient = { to_kind: z.enum(['group', 'session', 'human']), to_id: z.string().min(1).optional() }
export const mailboxSchemas = {
  send_message: z.object({ ...recipient, ...content }),
  reply: z.object({ message_id: z.string().min(1), ...content }),
  schedule_message: z.object({ ...recipient, ...content, deliver_at: z.string().optional(), delay_seconds: z.number().nonnegative().optional() }),
  list_groups: z.object({}),
}

export function mailboxHandlers(mailbox: TeamMailbox, sessionId: string) {
  const caller = { kind: 'agent', sessionId } as const
  return {
    send_message: (input: unknown) => mailbox.send(caller, mailboxSchemas.send_message.parse(input)),
    reply: (input: unknown) => mailbox.reply(caller, mailboxSchemas.reply.parse(input)),
    schedule_message: (input: unknown) => mailbox.schedule(caller, mailboxSchemas.schedule_message.parse(input)),
    list_groups: (_input: unknown) => mailbox.listGroups(caller),
  }
}

export async function createMailboxServer(mailbox: TeamMailbox, sessionId: string, tasks?: TaskService, strategies?: StrategyService) {
  const { createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk')
  const handlers: Record<string, (input: unknown) => Promise<unknown>> = {
    ...mailboxHandlers(mailbox, sessionId),
    ...(tasks ? taskHandlers(tasks, sessionId) : {}),
    // Product strategy: read/propose only — the approve/publish/withdraw
    // surface deliberately does not exist here (design D3).
    ...(strategies ? strategyHandlers(strategies, sessionId) : {}),
  }
  const schemas: Record<string, z.ZodObject> = { ...mailboxSchemas, ...(tasks ? taskSchemas : {}), ...(strategies ? strategySchemas : {}) }
  const descriptions: Record<string, string> = {
    send_message: 'Send to a team group or session. Returns immediately with the message id. Optional task_id puts the message under a team task. Mail to the human is refused: reply to a message they sent instead.',
    reply: 'Reply to a received message in its thread. The reply keeps the original task unless task_id is given. A reply to a human-sent message reaches the human.',
    schedule_message: 'Schedule mail at deliver_at (ISO date) or after delay_seconds. Use your session id for reminders. Optional task_id. Mail to the human is refused.',
    list_groups: 'List available team groups and their descriptions.',
    ...(tasks ? taskDescriptions : {}),
    ...(strategies ? strategyDescriptions : {}),
  }
  return createSdkMcpServer({ name: TEAM_MCP_SERVER, version: '1.0.0', tools: Object.keys(handlers).map(name =>
    tool(name, descriptions[name]!, schemas[name]!.shape, async (input) => {
      try {
        const result = await handlers[name]!(input)
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
      } catch (error) {
        return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] }
      }
    })
  ) })
}
