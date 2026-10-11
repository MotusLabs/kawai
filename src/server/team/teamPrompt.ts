// The system-prompt addition for a chat agent (agent-teams design D7): the
// role prompt of its group (members only) followed by a mailbox note — who
// the agent is on the team, which groups exist, how mail arrives, and how to
// send it — then a task note (team-tasks): the task tools, who owns a task's
// direction, how others contribute, and that a linked OpenSpec change is the
// authoritative direction. Pure: the caller supplies the catalog read at
// spawn time, so an edited group file reaches only later spawns.
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
  sections.push(taskNote(input))
  return sections.join('\n\n')
}

function taskNote({ group }: TeamPromptInput): string {
  const tool = (name: string) => `mcp__${TEAM_MCP_SERVER}__${name}`
  const creation = group?.canCreateTasks
    ? `Your group may create tasks: \`${tool('task_create')}\` makes you the task's creator, which means you own its direction and decide when it is done or cancelled.`
    : 'You cannot create tasks; a team lead or the human does. You contribute to tasks others created.'
  return [
    '# Team tasks',
    '',
    `A task is the team's durable record of one feature or request: title, direction, acceptance criteria, status, and an append-only journal. Messages may reference a task (\`task_id\`); a delivered task message carries the task's current title, direction, acceptance criteria, status, and latest journal entries, so act on that, not on older copies. ${creation}`,
    '',
    'Task tools:',
    `- \`${tool('task_get')}\`: the full task — every revision, the whole journal, subtasks, and messages.`,
    `- \`${tool('task_list')}\`: the team's tasks, optionally by status.`,
    `- \`${tool('task_note')}\`: append a journal note. Record decisions, findings, and handoff state here; notes are permanent and every participant sees them.`,
    `- \`${tool('task_update_status')}\`: set \`active\` or \`blocked\` (anyone); \`done\` or \`cancelled\` (the creator only).`,
    `- \`${tool('task_amend')}\`: change direction or acceptance criteria (the creator only; each change is a new revision).`,
    '',
    "Only a task's creator (or the human) changes its direction. If you disagree with the direction or find it wrong, add a journal note or message the creator — do not work around it. When a task links an OpenSpec change, that change's proposal, design, and tasks are the authoritative direction; the task's own direction text only summarizes it.",
  ].join('\n')
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
