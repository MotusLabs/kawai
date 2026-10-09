# Spec Delta

## ADDED Requirements

### Requirement: Collapsed tool calls show a short input detail
The chat view SHALL label each collapsed tool-call entry with the tool name
followed by a one-line detail in parentheses, derived from the tool's input.
Only an unknown tool, or a known tool whose detail is unusable, SHALL show the
tool name alone. Long details SHALL be truncated visually, with the full
detail on hover. Expanding the entry SHALL still show the full input.

#### Scenario: File tool shows its path
- **WHEN** the transcript contains a `Read` or `NotebookEdit` call whose input has a path field
- **THEN** the collapsed entry reads `Tool: <name> (<path>)`

#### Scenario: Bash shows its description and command
- **WHEN** a `Bash` call has a non-blank `description` and a non-blank `command`
- **THEN** the detail is `<description> — <command>`

#### Scenario: Bash falls back to its command
- **WHEN** a `Bash` call's `description` is missing, blank or not a string, and its `command` is a non-blank string
- **THEN** the detail is the command

#### Scenario: Bash falls back to its description
- **WHEN** a `Bash` call's `command` is missing, blank or not a string, and its `description` is a non-blank string
- **THEN** the detail is the description

#### Scenario: Other known tools show their key field
- **WHEN** a call is to `Glob` or `Grep` (pattern), `WebFetch` (url), `WebSearch` or `ToolSearch` (query), `Agent`, `Task` or `Monitor` (description), `Skill` (skill), `TaskCreate` (subject), `TaskStop` or `TaskOutput` (task_id), or `ExitPlanMode` (planFilePath)
- **THEN** the detail is that field's value

#### Scenario: EnterWorktree shows its path or name
- **WHEN** an `EnterWorktree` call has a non-blank `path`, or only a non-blank `name`
- **THEN** the detail is the path, or the name when no path is usable

#### Scenario: TaskUpdate shows the task id and status
- **WHEN** a `TaskUpdate` call has a `taskId` and a `status`
- **THEN** the detail is `Task <taskId> → <status>`

#### Scenario: AskUserQuestion shows the question header
- **WHEN** an `AskUserQuestion` call's first question has a non-blank `header`
- **THEN** the detail is the header, suffixed with ` · <n> questions` when the call has more than one question

#### Scenario: Unknown tool keeps the plain label
- **WHEN** a call is to a tool with no known mapping, such as an MCP tool
- **THEN** the collapsed entry reads `Tool: <name>` with no parentheses

#### Scenario: No usable field keeps the plain label
- **WHEN** every part of a known tool's detail is missing, blank or not a string (for `Bash`, both `description` and `command`)
- **THEN** the collapsed entry reads `Tool: <name>` with no parentheses

#### Scenario: Multi-line value stays on one line
- **WHEN** a detail value contains line breaks, such as a multi-line Bash command
- **THEN** the collapsed label shows it on a single line, truncated with an ellipsis when too long, and hovering shows the full value

### Requirement: Tool-call paths are shown relative to the project
When a tool-call detail is a file path, the chat view SHALL show it relative
to the chat session's project directory if the path is inside that
directory, and SHALL show it unchanged otherwise. Trailing slashes on either
the path or the project directory SHALL NOT affect the result. Paths that
only share a name prefix with the project directory SHALL count as outside.

#### Scenario: Path inside the project
- **WHEN** the project directory is `/repo` and a `Read` call has `file_path` `/repo/src/index.ts`
- **THEN** the label reads `Tool: Read (src/index.ts)`

#### Scenario: Path outside the project
- **WHEN** the project directory is `/repo` and a `Read` call has `file_path` `/etc/hosts`
- **THEN** the label reads `Tool: Read (/etc/hosts)`

#### Scenario: Sibling directory with a shared prefix
- **WHEN** the project directory is `/repo` and a `Read` call has `file_path` `/repo-other/a.ts`
- **THEN** the label reads `Tool: Read (/repo-other/a.ts)`

#### Scenario: Path equal to the project directory
- **WHEN** the project directory is `/repo` or `/repo/` and a path detail is `/repo` or `/repo/`
- **THEN** the label shows `.` in all four combinations

### Requirement: Edit and Write show a line delta
When a collapsed `Edit` or `Write` tool-call entry has a detail, the chat view
SHALL append the changed line counts as `+<added> −<removed>`, counted over
the input text. A zero side SHALL be omitted, and when both sides are zero the
delta SHALL be omitted entirely.

#### Scenario: Edit shows added and removed lines
- **WHEN** an `Edit` call replaces three lines of `old_string` with five lines of `new_string`
- **THEN** the label reads `Tool: Edit (<path> +5 −3)`

#### Scenario: Write shows added lines only
- **WHEN** a `Write` call has `content` of forty-five lines
- **THEN** the label reads `Tool: Write (<path> +45)`

#### Scenario: A trailing newline does not add a line
- **WHEN** a counted value is `"a\nb\nc"` or `"a\nb\nc\n"`
- **THEN** both count three lines, and the empty string counts zero

#### Scenario: A zero side is omitted
- **WHEN** an `Edit` call's `new_string` is empty, or its `old_string` is empty
- **THEN** the delta shows only the non-zero side, for example `−3` or `+5`

#### Scenario: No delta when nothing changes
- **WHEN** both sides of the delta count zero lines
- **THEN** the label shows the path alone, with no delta

### Requirement: Collapsed tool results show a one-line hint
The chat view SHALL label each collapsed tool-result entry with the first
non-blank line of its output, in parentheses, on one line. The hint SHALL be
truncated visually, with the full line on hover. An output with no non-blank
line SHALL keep the plain `Tool result` or `Tool failed` label. Expanding the
entry SHALL still show the full output.

#### Scenario: Result hint is the first non-blank line
- **WHEN** a tool result's output starts with blank lines and then reads `Task #1 created successfully: Run 6.3`
- **THEN** the collapsed entry reads `Tool result (Task #1 created successfully: Run 6.3)`

#### Scenario: Error result shows the first error line
- **WHEN** a tool result is an error whose first line is `Command failed: bun test`
- **THEN** the collapsed entry reads `Tool failed (Command failed: bun test)`

#### Scenario: Empty output keeps the plain label
- **WHEN** a tool result's output has no non-blank line
- **THEN** the collapsed entry reads `Tool result` or `Tool failed` with no parentheses

#### Scenario: Long hint stays on one line
- **WHEN** the first non-blank line is longer than the available width
- **THEN** the hint is truncated with an ellipsis, and hovering shows the full line
