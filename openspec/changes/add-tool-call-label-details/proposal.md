# Proposal

## Why

Each tool call in the chat transcript collapses to a bare `Tool: Read` or
`Tool: Bash` header. To see which file was read or what command ran, the user
has to expand every entry, so a run of tool calls is hard to follow at a
glance.

## What Changes

- A collapsed tool-call entry adds a short detail taken from the tool's input,
  for example `Tool: Read (src/server/index.ts)` or
  `Tool: Bash (Run unit tests)`.
- File paths inside the chat session's project directory are shown relative
  to it. Paths outside it are shown as absolute paths.
- Built-in Claude Code tools each have a fixed detail field: the file path for
  file tools, the description (or else the command) for Bash, the pattern for
  Glob and Grep, the URL for WebFetch, the query for WebSearch, the
  description for Agent/Task, and the skill name for Skill.
- A tool with no known field, such as an MCP tool or a tool added later, or an
  input that lacks the field, keeps the plain `Tool: <name>` header.
- The detail stays on one line. Long values are cut off with an ellipsis, and
  the full value is available as a hover tooltip. Expanding the entry still
  shows the full JSON input.
- Out of scope:
  - Approval cards. They already show the full arguments.
  - Tool-result entries.
  - Terminal-session previews (`SessionPreviewContent`).
  - Any server or wire-protocol change. The detail comes only from the
    `tool_call` input that the client already receives.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `chat-sessions`: Adds a requirement that collapsed tool-call entries show a
  short, project-relative detail from the tool's input.

## Impact

- `src/client/components/chat/ChatMessages.tsx`: the tool-call summary renders
  the detail. It needs the session's project path, passed in from
  `ChatView.tsx`.
- New client helper module (for example
  `src/client/components/chat/toolCallLabel.ts`) that maps a tool name and
  input to a detail and makes paths relative.
- `src/client/__tests__/chatComponents.test.tsx` and a new unit test for the
  helper.
- No dependency, API or storage changes.
