# Tasks

## 1. Handle derivation

- [ ] 1.1 Rewrite `src/client/components/chat/toolCallLabel.ts` to return one handle per call: drop `lineDelta` and `join` composition, switch Bash to `description` with fallback to `command`, and remove `toolResultDetail` — verify `src/client/__tests__/toolCallLabel.test.ts` covers every scenario of `Tool handles come from the tool's input` and `Bash shows its description with a command fallback`, and that no test still expects a delta or a result hint
- [ ] 1.2 Keep `relativeToProject` behavior unchanged and verify `toolCallLabel.test.ts` still asserts the four path cases (inside, outside, shared prefix, equal-to-project)

## 2. One entry per tool use

- [ ] 2.1 Group `tool_call` and `tool_result` events by `toolCallId` in `src/client/components/chat/ChatMessages.tsx`, render one `<details>` keyed on `toolCallId`, and expand to the input followed by the output — verify in `src/client/__tests__/chatComponents.test.tsx` that a call with a later result renders one entry and that expanding shows both blocks in order
- [ ] 2.2 Label the entry `<toolName>(<handle>)` with no `Tool: ` prefix, truncate the handle with an ellipsis and put the full value in the `title` — verify the component test asserts the exact label text for a handled and an unhandled tool
- [ ] 2.3 Render an entry for a `tool_result` whose `toolCallId` matches no earlier call, expanding to the output alone — verify the component test covers the orphan-result case

## 3. Failure mark

- [ ] 3.1 Mark the collapsed entry with `✗` when the paired result has `isError`, and render no mark otherwise — verify `chatComponents.test.tsx` asserts the mark's presence and absence, including that it is not truncated away with the handle

## 4. Integration

- [ ] 4.1 Adjust `src/server/chat/developmentFixture.ts` so fixture tool calls exercise a Bash description handle and a failed tool use, then run `bun run lint && bun run typecheck && bun run test` and verify the suite is green
- [ ] 4.2 Start the app with the development fixture and use the `dev-browser` skill to screenshot a chat transcript — verify one row per tool use, `Bash(...)`-style labels, project-relative paths, and `✗` on the failed entry
