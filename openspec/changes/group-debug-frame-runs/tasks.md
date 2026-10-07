# Tasks

## 1. Grouping helper

- [ ] 1.1 Add `groupFrames(frames)` and the transparent-label set (`system · thinking_tokens`) to `src/client/utils/chatWireFrames.ts`, returning ordered single-frame and group entries keyed by direction + `frameLabel`, and update the file's header comment; verify with `chatWireFrames.test.ts` cases for: a run of 20 deltas → one group; a lone frame → single entry; same label with different direction → separate; delta/thinking_tokens alternation → one delta group with absorbed count; trailing thinking_tokens stays in the run; a thinking_tokens frame with no open run starts its own group; a different label closes the run and later same-label frames start a new group; non-JSON stderr lines group as `text`
- [ ] 1.2 Verify that grouping a frame list then flattening its members gives back the input exactly, with the same frames in the same order, and add that as a test in `chatWireFrames.test.ts`

## 2. Panel rendering

- [ ] 2.1 Render `groupFrames(view.frames)` (memoized on `view.frames`) in `ChatDebugPanel.tsx`: ungrouped entries use the existing row; group rows show direction, first–last time, `#first–#last`, label `×N`, and `+M thinking_tokens` when M > 0, with `aria-expanded`; update the header comment; verify with a `chatComponents.test.tsx` case that 20 delta frames render one group row with the count and ranges
- [ ] 2.2 Expand a group to list its members as existing frame rows (each still expands to pretty JSON and copies `raw`), with "Copy all" copying members' `raw` joined by `\n`; verify with component tests for expansion, member JSON expand/copy, and Copy all's clipboard text
- [ ] 2.3 Store group expansion as member seqs (expanded if any member is in the set; toggle adds or removes all current members); verify with component tests that an expanded group stays expanded after a live frame joins it and after an older page prepends members, and that a different-type live frame starts a new row

## 3. Integration

- [ ] 3.1 Run `bun run lint && bun run typecheck && bun run test` and confirm they pass
- [ ] 3.2 With the `dev-browser` skill, open the Debug panel on a chat session that streamed a thinking + text response, and confirm by screenshot that the deltas render as collapsed groups, that a group expands to its frames, and that live deltas grow the newest group in place

## Workflow follow-up

- Archive the change once implemented and reviewed, syncing the `chat-debug` delta into the main spec.
