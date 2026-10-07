# Design

## Context

`ChatMessages.tsx` renders each `tool_call` event as
`<details><summary>Tool: {event.tool}</summary><pre>{JSON input}</pre></details>`.
The event carries the raw SDK tool input (`input: unknown`). `ChatView.tsx` has
the session (`session.projectPath`, the absolute directory that
`ChatSessionDriver` passes to the SDK as `cwd`), but `ChatMessages` receives
only `events`. Claude Code's built-in file tools take absolute paths
(`file_path`, `notebook_path`), so making them relative to `projectPath`
gives the same result as making them relative to the agent's working
directory.

## Goals / Non-Goals

**Goals:**
- One pure, unit-tested function computes the detail, so the mapping and
  path rules can be tested without rendering.
- The change stays in the client. The wire contract and server stay as they
  are.

**Non-Goals:**
- Tool-specific formatting beyond picking one field, such as shortening
  glob patterns or showing line ranges for Read.
- Making the field table configurable.

## Decisions

1. **A static table mapping each tool name to an ordered list of eligible
   fields, in a new `src/client/components/chat/toolCallLabel.ts`.** It
   exports
   `toolCallDetail(tool, input, projectPath): { text: string; isPath: boolean } | null`
   (exact shape left to implementation) and a small `relativeToProject`
   helper. The detail is the first eligible field whose value is a string
   that is non-empty after trimming. The result is `null`, meaning a plain
   label, only for an unknown tool or when every eligible field fails that
   check. Entries: `Read`/`Write`/`Edit` → [`file_path`] (path);
   `NotebookEdit` → [`notebook_path`] (path); `Bash` → [`description`,
   `command`]; `Glob`/`Grep` → [`pattern`]; `WebFetch` → [`url`];
   `WebSearch` → [`query`]; `Agent`/`Task` → [`description`]; `Skill` →
   [`skill`]. A single ordered-list rule covers both the Bash fallback and
   the missing-field case, so the two cannot disagree.
   *Alternative:* a generic rule like "first string field". It was rejected
   because input key order is not guaranteed and it would surface noisy
   values, such as Edit's `old_string`.

2. **Bash prefers `description` over `command`.** The description says what
   the call is for in a few words, which is the point of the feature. The
   command can be long and is still visible when the entry is expanded.

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
   no `node:path` import in client code.

4. **Rendering keeps the `<summary>` element and adds the detail as a child
   span.** The summary becomes `Tool: {tool}` plus, when there is a detail,
   ` (<span class="truncate" title={full}>{detail}</span>)`. Newlines are
   collapsed to spaces so the label stays on one line. The span uses
   `truncate` (overflow-hidden, ellipsis, nowrap) inside a flex/min-w-0
   summary so long values cut off at the column edge instead of wrapping. The
   `title` attribute holds the full value for hover. No character limit is
   applied in JS, so the cut-off follows the available width.
   *Alternative:* a fixed character limit in JS. It was rejected because it
   wastes space on wide screens and still overflows on narrow ones.

5. **`ChatMessages` takes a `projectPath` prop from `ChatView`.** This is
   simpler than reading the session store inside the list. The prop is
   optional so existing callers and tests keep working. Without it, paths
   are shown as they are.

## Risks / Trade-offs

- [Tool names or input fields change in future Claude Code versions] → Unknown
  tools and missing fields fall back to the plain label, so a rename only
  loses the detail and nothing breaks. Updating the table is a one-line
  change.
- [Detail could expose long secrets inline, such as a Bash command containing
  a token] → The full input is already one click away in the same entry, so
  the exposure is the same. Preferring the Bash description also reduces it.
- [CSS truncation inside `<summary>` needs the disclosure marker to remain
  visible] → Keep the default `list-item` display on `<summary>` and put the
  flex row in an inner wrapper, then confirm in the browser with the
  `dev-browser` skill.
