# Proposal

## Why

Each tool call in the chat transcript collapses to a bare `Tool: Read` or
`Tool: Bash` header, and each result collapses to `Tool result`. To see which
file was read, what command ran, or what came back, the user has to expand
every entry, so a run of tool calls is hard to follow at a glance.

## What Changes

- A collapsed tool-call entry adds a short detail taken from the tool's input,
  for example `Tool: Read (src/server/index.ts)`,
  `Tool: Bash (Run unit tests — bun test)`, or
  `Tool: Edit (src/server/index.ts +12 −3)`.
- A collapsed tool-result entry adds a short hint from its output: the first
  non-blank line, for example
  `Tool result (Task #1 created successfully: Run 6.3: …)`.
- File paths inside the chat session's project directory are shown relative
  to it. Paths outside it are shown as absolute paths.
- Most known tools show one input field: the file path for Read, Write, Edit
  and NotebookEdit, the pattern for Glob and Grep, the URL for WebFetch, the
  query for WebSearch and ToolSearch, the description for Agent, Task and
  Monitor, the skill name for Skill, the `subject` for TaskCreate, the
  `task_id` for TaskStop and TaskOutput, the `planFilePath` for ExitPlanMode,
  and the `path` (else `name`) for EnterWorktree.
- Some tools compose more than one part:
  - `Bash` shows `description — command`, dropping either part when it is
    missing, blank or not a string.
  - `Edit` and `Write` append a git-style line delta, `+12 −3`, computed
    from the line counts of the replaced and replacement text. `Write` is
    additions only, because the previous file contents are not in the input.
    A zero side is omitted; when both sides are zero the delta is left out.
  - `TaskUpdate` shows `Task 1 → in_progress`
    (`Task <taskId> → <status>`).
  - `AskUserQuestion` shows the first question's header, with a question
    count when there is more than one: `Spec sync · 2 questions`.
- A tool with no known mapping, such as an MCP tool or a tool added later, or
  an input with no usable field, keeps the plain `Tool: <name>` header.
- The detail stays on one line. Long values are cut off with an ellipsis, and
  the full value is available as a hover tooltip. Expanding the entry still
  shows the full JSON input, or the full result output.
- Out of scope:
  - Approval cards. They already show the full arguments.
  - Terminal-session previews (`SessionPreviewContent`).
  - Parsing structured result payloads, such as TaskOutput's `<exit_code>` or
    ToolSearch's `tool_reference` blocks, for the result hint.
  - Any server or wire-protocol change. The detail comes only from the
    `tool_call` input and `tool_result` output that the client already
    receives.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `chat-sessions`: Adds requirements that collapsed tool-call entries show a
  short, project-relative detail from the tool's input, and that collapsed
  tool-result entries show a one-line hint from their output.

## Impact

- `src/client/components/chat/ChatMessages.tsx`: the tool-call and tool-result
  summaries render the detail. It needs the session's project path, passed in
  from `ChatView.tsx`.
- New client helper module (for example
  `src/client/components/chat/toolCallLabel.ts`) that maps a tool name and
  input to a detail, composes multi-field details and line deltas, makes paths
  relative, and derives the result hint.
- `src/client/__tests__/chatComponents.test.tsx` and a new unit test for the
  helper.
- `src/server/chat/developmentFixture.ts`: give the fixture's Bash input a
  `description`, so the browser check exercises the composed label.
- No dependency, API or storage changes.
