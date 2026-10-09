# Tasks

## 1. Detail helper

- [x] 1.1 Add `src/client/components/chat/toolCallLabel.ts` with a header comment, the per-tool detail table, and `toolCallDetail`: the field rule (first non-blank string per field, or every usable field joined when `join` is set), `Bash` composed as `description — command` dropping unusable parts, the `TaskUpdate` (`Task <id> → <status>`) and `AskUserQuestion` (`<header> · <n> questions`) formatters, and newline collapsing; verify with a new `src/client/__tests__/toolCallLabel.test.ts` covering each mapped tool, the three Bash cases, both formatters (including the single-question and missing-half cases), an unknown/MCP tool, and missing, blank and non-string fields (no detail only when every part is unusable)
- [x] 1.2 Add project-relative path handling for path fields (inside → relative, path and project equal after removing trailing slashes → `.` for all four `/repo`/`/repo/` combinations and never an empty string, outside → unchanged, `/repo-other` vs `/repo` → unchanged, no project path → unchanged); verify with cases for each scenario in the spec's "Tool-call paths are shown relative to the project" requirement in the same test file
- [x] 1.3 Add the line-count helper and git-style delta rendering (`+12 −3` with U+2212, zero side omitted, no delta when both sides are zero, `Write` additions only from `content`, `Edit` from `old_string`/`new_string`, per-replacement for `replace_all`); verify single-line replacement, multi-line replacement, a trailing newline in the counted text, deletion-only, empty `Write` content, both-zero, and a `replace_all: true` call in the spec's "Edit and Write show a line delta" requirement
- [x] 1.4 Add `toolResultDetail(output)`: the first non-blank line of the output, collapsed to one line, `null` when the output has no non-blank line; verify a leading-blank-lines case, an error's first line, a single-line output, and empty output

## 2. Transcript rendering

- [x] 2.1 Render the detail in the `tool_call` summary in `ChatMessages.tsx` as `Tool: <name> (<detail>)` on one line with CSS ellipsis truncation and a `title` holding the full detail, keeping the expanded JSON body unchanged; add an optional `projectPath` prop and pass `session.projectPath` from `ChatView.tsx`; update the existing assertion in `src/client/__tests__/chatComponents.test.tsx` and add tests for a relative Read path, the title attribute, an Edit with a `+5 −3` delta, a TaskUpdate formatter label, and an unknown tool rendering exactly `Tool: <name>`
- [x] 2.2 Update the `ChatMessages.tsx` and `toolCallLabel.ts` header comments if their descriptions change, and verify `bun run lint && bun run typecheck && bun run test` pass
- [x] 2.3 Render the result hint in the `tool_result` summary as `Tool result (<hint>)` / `Tool failed (<hint>)` with the same one-line truncation and `title`, keeping the expanded output body unchanged; add tests for the hint, its `title`, an error hint, and empty output rendering the plain label
- [x] 2.4 Give the development fixture's Bash input a `description` alongside its `command` (`src/server/chat/developmentFixture.ts`), so the browser check exercises the composed label rather than the command fallback

## 3. Integration check

- [x] 3.1 Using the `dev-browser` skill against `bun run dev` (development chat fixture or a real chat), confirm a Read entry shows its relative path, a Bash entry shows `description — command`, an Edit shows `+N −M`, a result entry shows its first-line hint, a long detail truncates with an ellipsis while the disclosure marker stays visible, hovering shows the full value, and expanding still shows the JSON input or full output; save a screenshot as evidence
