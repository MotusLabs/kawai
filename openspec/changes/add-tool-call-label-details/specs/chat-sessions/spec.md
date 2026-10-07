# Spec Delta

## ADDED Requirements

### Requirement: Collapsed tool calls show a short input detail
The chat view SHALL label each collapsed tool-call entry with the tool name
followed by a one-line detail in parentheses. Each known Claude Code tool has
an ordered list of eligible input fields; the detail SHALL be the first one
that is a non-blank string. Only an unknown tool, or a known tool whose
eligible fields are all unusable, SHALL show the tool name alone. Long
details SHALL be truncated visually, with the full detail on hover.
Expanding the entry SHALL still show the full input.

#### Scenario: File tool shows its path
- **WHEN** the transcript contains a `Read`, `Write` or `Edit` call whose input has a `file_path`
- **THEN** the collapsed entry reads `Tool: <name> (<path>)`

#### Scenario: Bash prefers its description
- **WHEN** a `Bash` call has a non-blank `description`
- **THEN** the detail is the description

#### Scenario: Bash falls back to its command
- **WHEN** a `Bash` call's `description` is missing, blank or not a string, and its `command` is a non-blank string
- **THEN** the detail is the command

#### Scenario: Other known tools show their key field
- **WHEN** a call is to `Glob` or `Grep` (pattern), `WebFetch` (url), `WebSearch` (query), `Agent` or `Task` (description), `Skill` (skill) or `NotebookEdit` (notebook_path)
- **THEN** the detail is that field's value

#### Scenario: Unknown tool keeps the plain label
- **WHEN** a call is to a tool with no known field, such as an MCP tool
- **THEN** the collapsed entry reads `Tool: <name>` with no parentheses

#### Scenario: No usable field keeps the plain label
- **WHEN** every eligible field of a known tool's input is missing, blank or not a string (for `Bash`, both `description` and `command`)
- **THEN** the collapsed entry reads `Tool: <name>` with no parentheses

#### Scenario: Multi-line value stays on one line
- **WHEN** the detail value contains line breaks, such as a multi-line Bash command
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
