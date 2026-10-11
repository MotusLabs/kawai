// One in-process MCP server per agent start. Handlers bind the actual session
// id and strip unknown arguments before passing content to the mailbox.
import { z } from 'zod'
import type { TeamMailbox } from './TeamMailbox'
import { TEAM_MCP_SERVER } from './teamPrompt'

export const MAILBOX_TOOL_NAMES = ['send_message', 'reply', 'schedule_message', 'list_groups'] as const
export const MAILBOX_ALLOWED_TOOLS = MAILBOX_TOOL_NAMES.map(name => `mcp__${TEAM_MCP_SERVER}__${name}`)

const content = { body: z.string().min(1), urgent: z.boolean().optional(), tags: z.array(z.string()).optional() }
const recipient = { to_kind: z.enum(['group', 'session']), to_id: z.string().min(1) }
export const mailboxSchemas = {
  send_message: z.object({ ...recipient, ...content }),
  reply: z.object({ message_id: z.string().min(1), ...content }),
  schedule_message: z.object({ ...recipient, ...content, deliver_at: z.string().optional(), delay_seconds: z.number().nonnegative().optional() }),
  list_groups: z.object({}),
}

export function mailboxHandlers(mailbox: TeamMailbox, sessionId: string) {
  return {
    send_message: (input: unknown) => mailbox.send(sessionId, mailboxSchemas.send_message.parse(input)),
    reply: (input: unknown) => mailbox.reply(sessionId, mailboxSchemas.reply.parse(input)),
    schedule_message: (input: unknown) => mailbox.schedule(sessionId, mailboxSchemas.schedule_message.parse(input)),
    list_groups: (_input: unknown) => mailbox.listGroups(sessionId),
  }
}

export async function createMailboxServer(mailbox: TeamMailbox, sessionId: string) {
  const { createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk')
  const handlers = mailboxHandlers(mailbox, sessionId)
  const descriptions = {
    send_message: 'Send to a team group or session. Returns immediately with the message id.',
    reply: 'Reply to a received message in its thread.',
    schedule_message: 'Schedule mail at deliver_at (ISO date) or after delay_seconds. Use your session id for reminders.',
    list_groups: 'List available team groups and their descriptions.',
  }
  return createSdkMcpServer({ name: TEAM_MCP_SERVER, version: '1.0.0', tools: MAILBOX_TOOL_NAMES.map(name =>
    tool(name, descriptions[name], mailboxSchemas[name].shape, async (input) => {
      try {
        const result = await handlers[name](input)
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] }
      } catch (error) {
        return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] }
      }
    })
  ) })
}
