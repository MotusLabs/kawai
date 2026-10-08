# Design

## Context

`ChatMessages.tsx` renders each `tool_call` event as
`<details><summary>Tool: {event.tool}</summary><pre>{JSON input}</pre></details>`
and each `tool_result` as
`<details><summary>Tool result</summary><pre>{output}</pre></details>`. The
`tool_call` event carries the raw SDK tool input (`input: unknown`); the
`tool_result` event carries the flattened output text (`output: string`) and
`isError`. `ChatView.tsx` has the session (`session.projectPath`, the absolute
directory that `ChatSessionDriver` passes to the SDK as `cwd`), but
`ChatMessages` receives only `events`. Claude Code's built-in file tools take
absolute paths (`file_path`, `notebook_path`), so making them relative to
`projectPath` gives the same result as making them relative to the agent's
working directory.

Input shapes below come from real SDK transcripts (6,785 tool calls and 6,801
results across 81 sessions): `Bash` carries `command` and `description`;
`Edit` carries `file_path`, `old_string`, `new_string`, `replace_all`; `Write`
carries `file_path` and `content`; `TaskUpdate` carries `taskId` and `status`;
`AskUserQuestion` carries a `questions[]` array of `{question, header,
multiSelect, options}`; `TaskCreate` carries `subject`, `description` and
`activeForm`.

## Goals / Non-Goals

**Goals:**
- One pure, unit-tested function computes the call detail, and one the result
  hint, so the mapping and path rules can be tested without rendering.
- The change stays in the client. The wire contract and server stay as they
  are.

**Non-Goals:**
- Tool-specific formatting beyond picking fields and counting lines, such as
  shortening glob patterns or showing line ranges for Read.
- Making the field table configurable.
- Parsing structured result payloads (`<exit_code>`, `tool_reference` blocks).

## Decisions

1. **A static table mapping each tool name to a detail spec, in a new
   `src/client/components/chat/toolCallLabel.ts`.** It exports
   `toolCallDetail(tool, input, projectPath): string | null`,
   `toolResultDetail(output): string | null`, and a `relativeToProject` helper.
   A spec is either a field rule or a formatter:

   ```ts
   type ToolDetailSpec =
     | {
         fields: string[]
         isPath?: boolean
         /** Keep every usable field, joined by this. Default: first usable only. */
         join?: string
         /** Append `+added −removed` from these inputs' line counts. */
         lineDelta?: { added?: string; removed?: string }
       }
     | { format: (input: Record<string, unknown>) => string | null }
   ```

   The field rule takes the first field whose value is a non-blank string after
   newline collapsing; with `join`, every usable field is kept and joined. The
   result is `null`, meaning a plain label, only for an unknown tool or when
   nothing usable is produced. Table entries:

   | Tool | Spec |
   | --- | --- |
   | `Read` | `fields: ['file_path'], isPath` |
   | `Write` | `fields: ['file_path'], isPath, lineDelta: { added: 'content' }` |
   | `Edit` | `fields: ['file_path'], isPath, lineDelta: { added: 'new_string', removed: 'old_string' }` |
   | `NotebookEdit` | `fields: ['notebook_path'], isPath` |
   | `Bash` | `fields: ['description', 'command'], join: ' — '` |
   | `Glob`, `Grep` | `fields: ['pattern']` |
   | `WebFetch` | `fields: ['url']` |
   | `WebSearch`, `ToolSearch` | `fields: ['query']` |
   | `Agent`, `Task` | `fields: ['description']` |
   | `Monitor` | `fields: ['description']` |
   | `Skill` | `fields: ['skill']` |
   | `TaskCreate` | `fields: ['subject']` |
   | `TaskStop`, `TaskOutput` | `fields: ['task_id']` |
   | `EnterWorktree` | `fields: ['path', 'name'], isPath` on `path` only |
   | `ExitPlanMode` | `fields: ['planFilePath'], isPath` — never `plan`, which is a whole markdown document |
   | `TaskUpdate` | `format` → `Task <taskId> → <status>` |
   | `AskUserQuestion` | `format` → `<header>` or `<header> · <n> questions` |

   `EnterPlanMode` takes no input at all, so it is deliberately absent and
   keeps the plain label.
   *Alternative:* a generic rule like "first string field". It was rejected
   because input key order is not guaranteed and it would surface noisy
   values, such as Edit's `old_string`.

2. **Bash shows `description` and `command` together, description first.**
   The description says what the call is for; the command says what will run.
   Together they are the hint the collapsed entry exists to provide. Composed
   as `<description> — <command>`, each part dropped when it is missing, blank
   or not a string, so a call with only a command still shows something.
   *Alternative:* description-first with a command fallback. It was rejected
   because when both are present the command — the more literal hint at what
   will run — stays hidden behind a click.

3. **Path relativization is string-based and POSIX-only.** Trailing slashes
   are removed from both the project path and the input path before
   comparing (a bare `/` stays `/`). If the two are then equal, the result
   is `.`. This check runs before prefix removal, so `/repo/` against
   `/repo` gives `.` and never an empty string. Otherwise, a path starting
   with `<project>/` has that prefix removed (when the project is `/`, the
   prefix is `/` alone), and any other path is returned in its original
   form. Checking for the `/` separator keeps `/repo-other`
   from matching `/repo`. Relative inputs are returned as they are. The
   server runs on Linux/macOS hosts, so there is no Windows path handling, and
   no `node:path` import in client code. `EnterWorktree` relativizes `path`
   and leaves `name` alone.

4. **Edit and Write append a git-style line delta from the input text.**
   `Edit` counts the lines of `old_string` and `new_string`; `Write` counts the
   lines of `content` and has no removals, because the previous file contents
   are not in the input. A value's line count is the number of
   `\n`-separated segments after dropping one trailing newline, or `0` for the
   empty string, so `"a\nb\nc"` and `"a\nb\nc\n"` are both 3. The delta renders
   `+12 −3` with U+2212, in that order, omitting a zero side and omitting the
   whole delta when both sides are zero. It is per replacement: a call with
   `replace_all: true` can change many occurrences and the input does not say
   how many, so the label reports the per-replacement change.
   *Alternative:* suppress the delta when `replace_all` is true. It was
   rejected because a rename is exactly when the scope hint matters, and all
   1,144 Edits in the inspected transcripts have `replace_all: false`.

5. **The result hint is the first non-blank line of the output.** Same one-line
   treatment as a call detail: truncate with an ellipsis, full value on hover.
   It is exactly right for the tools whose results are prose — `Task #1
   created successfully: …`, `Your questions have been answered: "…"="Blue,
   Green"`, `Launching skill: …`, `The file … has been updated successfully` —
   and uninformative for Bash and Read, whose first line is `{` or `1\t## Why`.
   *Alternative:* a shape summary (`40 lines`). It was rejected as the primary
   rule because it is never semantic. *Alternative:* first line, falling back
   to a line count. It was rejected as a second rule for one blind spot.
   Parsing structured result payloads was rejected as a second rule engine.

6. **`TaskUpdate` and `AskUserQuestion` use the table's `format` escape
   hatch.** Their detail is not "fields joined": `TaskUpdate` renders
   `Task <taskId> → <status>`, dropping the `→ <status>` half when `status` is
   missing and the `Task <id>` half when `taskId` is missing; `AskUserQuestion`
   renders the first question's `header`, suffixed with ` · <n> questions` when
   `questions.length > 1`. `format` is a pure function from the input record to
   a detail or null and takes precedence over the field rule. `header` is used
   rather than `questions[0].question` because the question text runs 60–120
   characters and truncates, while `header` is the short label Claude Code
   puts on the card; the count answers "how many" without widening the label.

7. **Rendering keeps the `<summary>` element and adds the detail as a child
   span.** The tool-call summary becomes `Tool: {tool}` plus, when there is a
   detail, ` (<span class="truncate" title={full}>{detail}</span>)`; the
   tool-result summary becomes `Tool result` or `Tool failed` plus the same
   parenthetical. Newlines are collapsed to spaces so the label stays on one
   line. The span uses `truncate` (overflow-hidden, ellipsis, nowrap) inside a
   flex/min-w-0 summary so long values cut off at the column edge instead of
   wrapping. The `title` attribute holds the full value for hover. No
   character limit is applied in JS, so the cut-off follows the available
   width.
   *Alternative:* a fixed character limit in JS. It was rejected because it
   wastes space on wide screens and still overflows on narrow ones.

8. **`ChatMessages` takes a `projectPath` prop from `ChatView`.** This is
   simpler than reading the session store inside the list. The prop is
   optional so existing callers and tests keep working. Without it, paths
   are shown as they are.

## Risks / Trade-offs

- [Tool names or input fields change in future Claude Code versions] → Unknown
  tools and unusable fields fall back to the plain label, so a rename only
  loses the detail and nothing breaks. Updating the table is a one-line
  change.
- [Detail could expose long secrets inline, such as a Bash command containing
  a token] → The full input is already one click away in the same entry, so
  the exposure is the same. The value is truncated to one line and the
  command was already visible when the entry is expanded.
- [`replace_all: true` undercounts the line delta] → The delta is per
  replacement and the occurrence count is not in the input. Accepting the
  undercount keeps one rule; the expanded JSON shows the real edit.
- [Bash and Read result hints are uninformative] → Their first line is JSON or
  a line-numbered row. The expanded output is unchanged and one click away; a
  per-tool result table is deliberately out of scope.
- [CSS truncation inside `<summary>` needs the disclosure marker to remain
  visible] → Keep the default `list-item` display on `<summary>` and put the
  flex row in an inner wrapper, then confirm in the browser with the
  `dev-browser` skill.
