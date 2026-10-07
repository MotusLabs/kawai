# Tasks

## 1. Detail helper

- [ ] 1.1 Add `src/client/components/chat/toolCallLabel.ts` with a header comment, the per-tool field table (Read/Write/Edit `file_path`, NotebookEdit `notebook_path`, Bash `description` → `command`, Glob/Grep `pattern`, WebFetch `url`, WebSearch `query`, Agent/Task `description`, Skill `skill`), and newline collapsing; verify with a new `src/client/__tests__/toolCallLabel.test.ts` covering each mapped tool, the Bash fallback, an unknown/MCP tool, and missing, empty and non-string fields (all return no detail)
- [ ] 1.2 Add project-relative path handling for path fields (inside → relative, equal to the project with or without a trailing slash → `.`, outside → unchanged, `/repo-other` vs `/repo` → unchanged, no project path → unchanged); verify with cases for each scenario in the spec's "Tool-call paths are shown relative to the project" requirement in the same test file

## 2. Transcript rendering

- [ ] 2.1 Render the detail in the `tool_call` summary in `ChatMessages.tsx` as `Tool: <name> (<detail>)` on one line with CSS ellipsis truncation and a `title` holding the full detail, keeping the expanded JSON body unchanged; add an optional `projectPath` prop and pass `session.projectPath` from `ChatView.tsx`; update the existing assertion in `src/client/__tests__/chatComponents.test.tsx` and add tests for a relative Read path, the title attribute, and an unknown tool rendering exactly `Tool: <name>`
- [ ] 2.2 Update the `ChatMessages.tsx` header comment if its description changes, and verify `bun run lint && bun run typecheck && bun run test` pass

## 3. Integration check

- [ ] 3.1 Using the `dev-browser` skill against `bun run dev` (development chat fixture or a real chat), confirm a Read/Bash entry shows its detail, a long Bash command truncates with an ellipsis while the disclosure marker stays visible, hovering shows the full value, and expanding still shows the JSON input; save a screenshot as evidence
