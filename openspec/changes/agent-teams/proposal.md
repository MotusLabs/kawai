# Proposal

## Why

Every kawai chat session is an island: a Claude Code agent can only be steered by the human typing into it. Multi-agent work (a team lead splitting a feature, devs asking architects, QA reporting back) today means the human copying text between chats. Agents need roles and a way to message each other — directly or through a role's shared queue — with delivery that respects what the recipient is doing.

## What Changes

- **Groups as roles.** A group is defined by a file `.kawai/groups/<id>.md` (project, layered over `~/.kawai/groups/`): frontmatter with label, description, and group settings; the body is the role prompt. A chat session may be assigned one group at creation; the group is fixed for the session's life. Group prompts are applied at agent spawn; edits affect only later spawns.
- **Team = git repository.** All chat sessions whose project directory belongs to the same repository (main checkout or any of its worktrees) form one team and share its mailboxes.
- **Mailboxes.** Each group has a shared mailbox and each team member has a direct mailbox. Agents get tools to send a message to a group or a member, reply to a message, schedule a message for later delivery (including to themselves), and list the team's groups.
- **Delivery rules.** Normal messages are held until the recipient is idle and delivered as a new turn — they never join or interrupt an in-flight turn. Urgent messages are picked first. An urgent message sent directly to an agent interrupts its turn, but waits while an approval or question card awaits the human. Delivery is crash-safe: receipt is acknowledged only by the recipient transcript's row carrying the message id — submission alone proves nothing — and on restart a pushed claim is completed when that row is found, requeued when the transcript ends cleanly without it, and held for the human when the record is unreadable, so a message is never delivered twice.
- **Group pickup.** A group message goes to the first idle member of that group; claiming is atomic so a message is handled by exactly one agent.
- **Threads and replies.** Messages carry sender session, sender group, sender path (`origin_path`, set by kawai), priority, optional tags, and the thread they belong to. A reply goes to the sending session; an archived sender is restored to receive it; a killed sender's reply goes to its group with the full thread attached.
- **Loop guard.** Each thread has a hop limit (default 20, overridable per group); messages past it are dead-lettered and the human is notified.
- **Visibility.** Delivered mail renders in the transcript as a distinct peer-message row (sender, group, priority); the navigator shows a session's group; a team mailbox view lists queued, scheduled, and dead-lettered messages, with cancel and retry.
- **Agent awareness.** Members receive a mailbox note in their system prompt: their group, the team's groups and descriptions, and how mail arrives.

Non-goals: tasks (follow-up change `team-tasks`), worktree-targeted auto-spawn (`team-tasks`), multiple profiles per group and limit-aware routing (`profile-routing`), cross-repository teams, a UI for editing group files.

## Capabilities

### New Capabilities

- `agent-teams`: group definitions from `.kawai/groups/`, team scope by git repository, group assignment of chat sessions, and the role/mailbox prompt agents receive.
- `agent-mailbox`: sending, scheduling, delivering, interrupting, claiming, replying, threading, loop limiting, and inspecting messages between chat agents.

### Modified Capabilities

None. Existing chat-session behavior (status, interrupt, archive, restore) is unchanged for human-driven use; mailbox behavior is added alongside it.

## Impact

- Server: new `src/server/team/` (group catalog loader, repository resolution, mailbox store and dispatcher, in-process MCP tools); `ChatSessionDriver.ts` (register mailbox tools, append role/mailbox prompt, deliver peer turns, urgent interrupt), `ChatSessionManager.ts` (group on create, idle notifications to the dispatcher, restore-on-reply), `db.ts` (`group_id` on `chat_sessions`; `team_messages` table).
- Shared: `src/shared/chat.ts` / `types.ts` — peer-message event, group on session records, mailbox snapshot messages.
- Client: new-session dialog group picker, navigator group badge, peer-message transcript row, team mailbox view.
- SDK: uses `createSdkMcpServer`/`tool()` and `SDKUserMessage.origin`/`priority`; the `replace-claude-sdk-with-cli` change must carry equivalents if it lands.
- Interacts with `chat-session-spawned-subagents`: a session with running background workers is not idle for delivery.
