# Spec Delta

## ADDED Requirements

### Requirement: Tool activity is one entry per tool use
The chat view SHALL render each tool use as a single transcript entry,
pairing its tool call and tool result by their shared tool-call id. A tool
call SHALL NOT appear as its own entry alongside a separate result entry.
Expanding the entry SHALL show the tool input, and the tool output beneath it
once a result has arrived.

#### Scenario: Call and result share one entry
- **WHEN** the transcript contains a tool call and a later tool result with the same tool-call id
- **THEN** they render as one collapsed entry, and no standalone result entry appears

#### Scenario: Expand shows input then output
- **WHEN** the user expands an entry whose result has arrived
- **THEN** the tool input is shown first and the tool output beneath it

#### Scenario: Pending call shows the input alone
- **WHEN** a tool call has been streamed but its result has not arrived
- **THEN** the entry renders and expands to the input alone

#### Scenario: Result without a matching call still renders
- **WHEN** the transcript contains a tool result whose tool-call id matches no earlier tool call
- **THEN** the chat view still renders one entry for it and the entry expands to the output

### Requirement: Collapsed tool entries show a short handle
The chat view SHALL label each collapsed tool entry `<toolName>(<handle>)`,
where the handle is a one-line value derived from the tool's input. An entry
with no usable handle SHALL show the tool name alone. Long handles SHALL be
truncated visually with an ellipsis, with the full value on hover.

#### Scenario: Label shows the tool name and its handle
- **WHEN** a tool call has a usable handle
- **THEN** the collapsed entry reads `<toolName>(<handle>)`

#### Scenario: No usable handle keeps the bare name
- **WHEN** a call is to an unknown tool, or every part of a known tool's handle is unusable
- **THEN** the collapsed entry reads the tool name with no parentheses

#### Scenario: Multi-line value stays on one line
- **WHEN** a handle value contains line breaks, such as a multi-line Bash command
- **THEN** the collapsed label shows it on a single line, truncated with an ellipsis when too long, and hovering shows the full value

### Requirement: Tool handles come from the tool's input
Each known tool's handle SHALL be the value of its designated input field,
and an entry whose designated value is entirely unusable SHALL show the tool
name alone.

#### Scenario: Known tools show their designated field
- **WHEN** a call is to `Read`, `Write`, `Edit` or `NotebookEdit` (path); `Glob` or `Grep` (pattern); `WebFetch` (url); `WebSearch` or `ToolSearch` (query); `Agent`, `Task` or `Monitor` (description); `Skill` (skill); `TaskCreate` (subject); `TaskStop` or `TaskOutput` (task_id); or `ExitPlanMode` (planFilePath)
- **THEN** the handle is that field's value

#### Scenario: EnterWorktree shows its path or name
- **WHEN** an `EnterWorktree` call has a non-blank `path`, or only a non-blank `name`
- **THEN** the handle is the path, or the name when no path is usable

#### Scenario: TaskUpdate shows the task id and status
- **WHEN** a `TaskUpdate` call has a `taskId` and a `status`
- **THEN** the handle is `Task <taskId> → <status>`

#### Scenario: AskUserQuestion shows the question header
- **WHEN** an `AskUserQuestion` call's first question has a non-blank `header`
- **THEN** the handle is the header, suffixed with ` · <n> questions` when the call has more than one question

#### Scenario: No usable field keeps the bare name
- **WHEN** every part of a known tool's designated value is missing, blank or not a string
- **THEN** the collapsed entry reads the tool name with no parentheses

### Requirement: Bash shows its description with a command fallback
A Bash call's handle SHALL be its `description`, falling back to its
`command` when the description is missing, blank or not a string. The handle
SHALL NOT compose the description and the command.

#### Scenario: Bash shows its description
- **WHEN** a `Bash` call has a non-blank `description`
- **THEN** the handle is the description

#### Scenario: Bash falls back to its command
- **WHEN** a `Bash` call's `description` is missing, blank or not a string, and its `command` is a non-blank string
- **THEN** the handle is the command

#### Scenario: Bash does not compose description and command
- **WHEN** a `Bash` call has both a non-blank `description` and a non-blank `command`
- **THEN** the handle is the description alone, with no part of the command

### Requirement: A failed tool use is marked on its entry
When a tool use's result is an error, the chat view SHALL mark the collapsed
entry with `✗`. A result that is not an error SHALL carry no status mark.

#### Scenario: Error result is marked
- **WHEN** a tool use's result is an error
- **THEN** the collapsed entry shows `✗` alongside the label

#### Scenario: Successful result carries no mark
- **WHEN** a tool use's result is not an error
- **THEN** the collapsed entry shows no status mark

## MODIFIED Requirements

### Requirement: Tool-call paths are shown relative to the project
When a tool handle is a file path, the chat view SHALL show it relative
to the chat session's project directory if the path is inside that
directory, and SHALL show it unchanged otherwise. Trailing slashes on either
the path or the project directory SHALL NOT affect the result. Paths that
only share a name prefix with the project directory SHALL count as outside.

#### Scenario: Path inside the project
- **WHEN** the project directory is `/repo` and a `Read` call has `file_path` `/repo/src/index.ts`
- **THEN** the label reads `Read(src/index.ts)`

#### Scenario: Path outside the project
- **WHEN** the project directory is `/repo` and a `Read` call has `file_path` `/etc/hosts`
- **THEN** the label reads `Read(/etc/hosts)`

#### Scenario: Sibling directory with a shared prefix
- **WHEN** the project directory is `/repo` and a `Read` call has `file_path` `/repo-other/a.ts`
- **THEN** the label reads `Read(/repo-other/a.ts)`

#### Scenario: Path equal to the project directory
- **WHEN** the project directory is `/repo` or `/repo/` and a path handle is `/repo` or `/repo/`
- **THEN** the handle shows `.` in all four combinations

## REMOVED Requirements

### Requirement: Edit and Write show a line delta
**Reason**: The delta was evidence sitting on the orientation line, and it
was appended at the tail where the ellipsis cuts first. It also counted
`replace_all` replacements once instead of per occurrence.
**Migration**: Expand the entry to read the input text; the label shows the
path alone.

### Requirement: Collapsed tool results show a one-line hint
**Reason**: The first non-blank output line was usually a test banner, a file
header comment, or a confirmation sentence rather than signal, and it
decorated every result row on top of the call row.
**Migration**: Expand the entry to read the full output. A failed result is
marked `✗` on the entry instead.
