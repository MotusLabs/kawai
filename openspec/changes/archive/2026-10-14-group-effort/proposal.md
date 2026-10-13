# Proposal

## Why

Roles on a team need different amounts of reasoning: a team lead planning and integrating work benefits from `max` effort, while developers running many routine implementation steps are better served (in cost and latency) by `medium`. Today kawai offers no per-role control. Claude Code's `effortLevel` setting applies by directory or host, not by role, and the profile catalog deliberately refuses `CLAUDE_CODE_EFFORT_LEVEL` (an unlisted env key rejects the whole catalog file). So the only workaround is a fragile settings-file split by checkout that also catches reviewers and the human's own chats.

## What Changes

- Group frontmatter accepts an optional `effort: low|medium|high|xhigh|max`.
- When a group member's agent process starts (created by the human or spawned by worktree staffing, on first start, restart, or resume), kawai launches it with the group's effort, read from the group file at that moment. A running agent keeps its effort; edits apply to the next start, like the role prompt.
- Sessions without a group, and members of groups that set no `effort`, launch exactly as today: Claude Code's own settings decide.
- An invalid `effort` value is a group warning (shown where profile-routing warnings already appear) and the group behaves as if `effort` were unset; the rest of the file still applies.
- The documentation of group settings (`CLAUDE.md`, `docs/routing/README.md`) gains the field.

Not changed: the profile catalog's environment allowlist, the chat UI (no effort picker or header indicator), and Claude Code's own precedence rules. `CLAUDE_CODE_EFFORT_LEVEL` in the server environment and a settings effort cap still override or clamp the launch value, and `/effort` inside a chat still changes the running agent.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `agent-teams`: group files gain an optional `effort` setting that applies to every member's agent at start.

## Impact

- `src/server/team/groupFile.ts`: parse and validate `effort`, store it on `GroupDefinition`, report bad values as warnings.
- `src/server/team/sessionTeams.ts`: resolve a session's group effort from the catalog at spawn time (beside `promptFor`).
- `src/server/chat/ChatSessionManager.ts` and `ChatSessionDriver.ts`: a per-spawn effort getter passed into the SDK `Options.effort` (the SDK forwards it as `--effort`).
- Tests for the parser, the resolver, and the driver options.
- Docs: `CLAUDE.md` group settings bullet and `docs/routing/README.md`.
- No database, wire protocol, or client changes.
