// One in-process MCP server per agent start, carrying the mailbox tools,
// (team-tasks) the task tools, (member-release) the release tool, and
// (product-strategy) the strategy tools, and (durable-plans) the plan tools.
// Handlers bind the actual session id and strip unknown arguments before
// passing content to the mailbox, task, release, strategy, or plan service.
import { z } from 'zod'
import type { TeamMailbox } from './TeamMailbox'
import type { TaskService } from './TaskService'
import type { TaskResultService } from './TaskResultService'
import type { MemberRelease } from './memberRelease'
import { TASK_TOOL_NAMES, taskDescriptions, taskHandlers, taskSchemas } from './taskTools'
import type { StrategyService } from '../strategy/StrategyService'
import { STRATEGY_TOOL_NAMES, strategyDescriptions, strategyHandlers, strategySchemas } from '../strategy/strategyTools'
import type { PlanService } from '../plans/PlanService'
import { PLAN_TOOL_NAMES, planDescriptions, planHandlers, planSchemas } from '../plans/planTools'
import type { MailboxManagement } from './mailboxManagement'
import { TEAM_MCP_SERVER } from './teamPrompt'

export const MAILBOX_TOOL_NAMES = ['send_message', 'reply', 'schedule_message', 'list_groups'] as const
export const RELEASE_TOOL_NAMES = ['release_member'] as const
/** Mailbox management (team-mailbox-management): always registered, refused by right. */
export const MANAGEMENT_TOOL_NAMES = ['list_mailbox', 'cancel_message', 'discard_message'] as const
/** Every team tool, allowed without approval cards under either policy. */
export const TEAM_ALLOWED_TOOLS = [...MAILBOX_TOOL_NAMES, ...MANAGEMENT_TOOL_NAMES, ...RELEASE_TOOL_NAMES, ...TASK_TOOL_NAMES, ...STRATEGY_TOOL_NAMES, ...PLAN_TOOL_NAMES].map(name => `mcp__${TEAM_MCP_SERVER}__${name}`)

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

const MESSAGE_STATES = ['queued', 'awaiting-request', 'spawning', 'claimed', 'parked', 'dead', 'uncertain'] as const
// The reason is validated by the service so its refusal can explain itself.
export const managementSchemas = {
  list_mailbox: z.object({
    state: z.array(z.enum(MESSAGE_STATES)).optional(), to: z.string().min(1).optional(),
    from: z.string().min(1).optional(), task_id: z.string().min(1).optional(),
  }),
  cancel_message: z.object({ message_id: z.string().min(1), reason: z.string() }),
  discard_message: z.object({ message_id: z.string().min(1), reason: z.string() }),
}

export const managementDescriptions = {
  list_mailbox: 'List unsettled team mail (queued, scheduled, awaiting a request, being spawned for, claimed, parked, dead, uncertain) with id, state, sender, recipient, claimant, task, age, due or resume time, reason, why it waits, and a cut body. Without mailbox management you see only mail you sent, mail addressed to you, and mail you hold. Optional filters: state, to, from, task_id.',
  cancel_message: 'Cancel a message before it is delivered (queued, scheduled, or awaiting a request) by id, with a required reason. You can cancel your own mail; a group with mailbox management can cancel any team message, including parked work (its resume mail is cancelled with it). Claimed, being-spawned-for, and delivered mail cannot be cancelled.',
  discard_message: 'Discard a dead-lettered or uncertain message by id, with a required reason. Only groups with mailbox management can; retry and hand-off remain the human\'s.',
}

export function managementHandlers(management: MailboxManagement, sessionId: string) {
  return {
    list_mailbox: async (input: unknown) => management.list(sessionId, managementSchemas.list_mailbox.parse(input)),
    cancel_message: async (input: unknown) => management.cancel(sessionId, managementSchemas.cancel_message.parse(input)),
    discard_message: async (input: unknown) => management.discard(sessionId, managementSchemas.discard_message.parse(input)),
  }
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

export const releaseSchemas = {
  release_member: z.object({ session_id: z.string().min(1), reason: z.string().optional() }),
}

export const releaseDescriptions: Record<(typeof RELEASE_TOOL_NAMES)[number], string> = {
  release_member: 'Release one spawned member of your team (permitted unless your group opts out): it is archived — never killed — once it has settled. Refused, with the reason, for yourself, human-created sessions, other teams, and busy members.',
}

export function releaseHandlers(releases: MemberRelease, sessionId: string) {
  return {
    release_member: async (input: unknown) => {
      const { session_id, reason } = releaseSchemas.release_member.parse(input)
      return releases.releaseByAgent(sessionId, session_id, reason)
    },
  }
}

/** The optional services a session's team server exposes; each absent one registers no tools. */
export interface MailboxServerServices {
  tasks?: TaskService
  /** Result, findings, and handoff tools (task-results-handoffs); registered beside the task tools. */
  results?: TaskResultService
  strategies?: StrategyService
  /** Plan read/create/draft/submit tools (durable-plans D11); never approve or lifecycle. */
  plans?: PlanService
  releases?: MemberRelease
  management?: MailboxManagement
}

export async function createMailboxServer(mailbox: TeamMailbox, sessionId: string, services: MailboxServerServices = {}) {
  const { tasks, results, strategies, plans, releases, management } = services
  const { createSdkMcpServer, tool } = await import('@anthropic-ai/claude-agent-sdk')
  const handlers: Record<string, (input: unknown) => Promise<unknown>> = {
    ...mailboxHandlers(mailbox, sessionId),
    ...(management ? managementHandlers(management, sessionId) : {}),
    ...(tasks ? taskHandlers(tasks, sessionId, results) : {}),
    ...(releases ? releaseHandlers(releases, sessionId) : {}),
    // Product strategy: read/propose only — the approve/publish/withdraw
    // surface deliberately does not exist here (design D3).
    ...(strategies ? strategyHandlers(strategies, sessionId) : {}),
    // Plans: no approve, withdraw, close, or reopen tool exists (D11).
    ...(plans ? planHandlers(plans, sessionId) : {}),
  }
  const schemas: Record<string, z.ZodObject> = {
    ...mailboxSchemas, ...(management ? managementSchemas : {}), ...(tasks ? taskSchemas : {}),
    ...(releases ? releaseSchemas : {}), ...(strategies ? strategySchemas : {}), ...(plans ? planSchemas : {}),
  }
  const descriptions: Record<string, string> = {
    send_message: 'Send to a team group or session. Returns immediately with the message id. Optional task_id puts the message under a team task. Mail to the human is refused: reply to a message they sent instead.',
    reply: 'Reply to a received message in its thread. The reply keeps the original task unless task_id is given. A reply to a human-sent message reaches the human.',
    schedule_message: 'Schedule mail at deliver_at (ISO date) or after delay_seconds. Use your session id for reminders. Optional task_id. Mail to the human is refused.',
    list_groups: 'List available team groups and their descriptions.',
    ...(management ? managementDescriptions : {}),
    ...(tasks ? taskDescriptions : {}),
    ...(releases ? releaseDescriptions : {}),
    ...(strategies ? strategyDescriptions : {}),
    ...(plans ? planDescriptions : {}),
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
