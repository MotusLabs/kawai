# Proposal

## Why

`add-tool-call-label-details` made every collapsed row carry a parenthetical
detail: composed Bash `description — command`, Edit/Write `+N −M` deltas, and
a first-line hint on every tool result. A five-tool turn now renders ten rows,
eight of them decorated, and the assistant's own text is drowned with
mechanics. The hints in particular are noise: the first non-blank output line
is a test banner, a file header comment, or `The file … has been updated.`
more often than it is signal. The details also fight truncation — deltas are
appended at the tail, so they are the first thing an ellipsis eats.

## What Changes

- **BREAKING (visual):** A tool call and its result collapse into a single
  transcript entry, paired by `toolCallId`. One row per tool use instead of
  two.
- The collapsed label drops the `Tool: ` / `Tool result` prefixes and reads
  `<toolName>(<handle>)`, for example `Read(src/client/chat/toolCallLabel.ts)`.
  An entry with no usable handle reads the tool name alone.
- The handle is one short piece of orientation from the input:
  - `Bash` shows its `description`, falling back to its `command` when the
    description is missing, blank or not a string. The two are never composed.
  - Other known tools keep their single key field: the path for Read, Write,
    Edit and NotebookEdit, the pattern for Glob and Grep, the URL for
    WebFetch, the query for WebSearch and ToolSearch, the description for
    Agent, Task and Monitor, the skill name for Skill, the `subject` for
    TaskCreate, the `task_id` for TaskStop and TaskOutput, the `planFilePath`
    for ExitPlanMode, and `path` (else `name`) for EnterWorktree.
  - `TaskUpdate` shows `Task <taskId> → <status>` and `AskUserQuestion` shows
    the first question's header with a question count past one, as today.
- **Removed:** Edit and Write line deltas. They were evidence, not
  orientation, and they sat where truncation cuts.
- **Removed:** tool-result first-line hints. The output moves behind the
  expand.
- Failure is marked on the row with `✗` when the result is an error. Success
  carries no glyph — a run of `✓` is as loud as the text it replaced.
- Expanding the entry shows the tool input and, when a result has arrived, the
  tool output beneath it.
- File paths in handles stay relative to the chat session's project directory,
  unchanged from `add-tool-call-label-details`.
- Handles stay on one line, truncated with an ellipsis when too long, with the
  full value on hover.
- Out of scope:
  - Approval cards. They already show the full arguments.
  - The live activity row (`Running Bash…` and the elapsed timer). This
    change is history density only.
  - Terminal-session previews (`SessionPreviewContent`).
  - A density preference in Settings. A better default first; a setting only
    if the compact form turns out to be wrong for some chats.
  - Any server or wire-protocol change. `toolCallId` already links the two
    events client-side.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `chat-sessions`: Collapsed tool activity becomes one entry per tool use
  labelled `<toolName>(<handle>)`, failures carry a mark, and the line-delta
  and result-hint requirements are removed.

## Impact

- `src/client/components/chat/toolCallLabel.ts`: the handle table survives,
  with Bash switched to description-else-command. Line-delta and result-hint
  helpers go away.
- `src/client/components/chat/ChatMessages.tsx`: pairs `tool_call` and
  `tool_result` by `toolCallId` into one `<details>`, renders
  `<toolName>(<handle>)` plus a failure mark, and expands to input then
  output.
- `src/client/__tests__/toolCallLabel.test.ts` and
  `src/client/__tests__/chatComponents.test.tsx`: expectations follow the new
  label shape; pairing and the failure mark get coverage.
- `src/server/chat/developmentFixture.ts`: fixture rows stay representative of
  the compact label.
- No dependency, API or storage changes.
