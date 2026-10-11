// The system-prompt addition for a chat agent (agent-teams design D7): the
// role prompt of its group (members only) followed by a mailbox note — who
// the agent is on the team, which groups exist, how mail arrives, and how to
// send it. Pure: the caller supplies the catalog read at spawn time, so an
// edited group file reaches only later spawns.
import type { GroupDefinition } from './groupFile'

/** The in-process MCP server name; tools surface as `mcp__kawai-team__*`. */
export const TEAM_MCP_SERVER = 'kawai-team'
/** The envelope tag delivered mail arrives in (see envelope.ts). */
export const ENVELOPE_TAG = 'kawai-message'

export interface TeamPromptInput {
  sessionId: string
  /** The member's group; undefined for a session without one. */
  group?: GroupDefinition
  /** Every group of the team, in catalog order. */
  groups: GroupDefinition[]
}

export function buildTeamPrompt(input: TeamPromptInput): string {
  const sections: string[] = []
  if (input.group?.prompt) {
    sections.push(`# Your role: ${input.group.label}\n\n${input.group.prompt}`)
  }
  sections.push(mailboxNote(input))
  return sections.join('\n\n')
}

function mailboxNote({ sessionId, group, groups }: TeamPromptInput): string {
  const tool = (name: string) => `mcp__${TEAM_MCP_SERVER}__${name}`
  const membership = group
    ? `You are chat session \`${sessionId}\`, a member of the \`${group.id}\` group (${group.label}).`
    : `You are chat session \`${sessionId}\`. You belong to no group: you can send and receive direct messages, but never receive group mail.`
  const roster = groups.length > 0
    ? groups.map(entry =>
      `- \`${entry.id}\` (${entry.label})${entry.description ? `: ${entry.description}` : ''}`).join('\n')
    : '- (this team defines no groups yet)'
  return [
    '# Team mailbox',
    '',
    `${membership} Your team is every chat session working in this git repository, including its worktrees.`,
    '',
    'Groups of your team:',
    roster,
    '',
    `Messages from other agents arrive as a new turn wrapped in \`<${ENVELOPE_TAG}>\`, whose attributes name the message id, sender session, sender group, priority, origin path, thread, and tags. They never arrive in the middle of your turn, except an urgent message sent directly to you, which stops your current turn first.`,
    '',
    'To communicate:',
    `- \`${tool('send_message')}\`: message a group (one idle member picks it up) or a specific session; mark it urgent only when it must interrupt.`,
    `- \`${tool('reply')}\`: answer a message you received; the reply joins its thread and goes back to the sender.`,
    `- \`${tool('schedule_message')}\`: deliver a message later — to a group, a session, or yourself as a reminder.`,
    `- \`${tool('list_groups')}\`: list the team's groups.`,
    '',
    'Sending returns a message id immediately; it never waits for an answer. Replies arrive as later turns. Do not spin waiting for them — finish your turn.',
  ].join('\n')
}
