# Tasks

## 1. Track the agent's working directory in the chat driver

- [ ] 1.1 Register an observational `CwdChanged` hook on the chat SDK query in `src/server/chat/ChatSessionDriver.ts` and surface `new_cwd` through a new driver callback; verify with a unit test in `src/server/__tests__/chatSessionDriver.test.ts` that a hook input with `old_cwd`/`new_cwd` invokes the callback with the new directory and never blocks the agent
- [ ] 1.2 Ignore cwd changes that belong to a subagent — the hook input carries `agent_id` only when it fires from within a subagent (`BaseHookInput`; absent for the main thread) — and verify with a unit test whose fixture mirrors the real hook shape (`hook_event_name`, `old_cwd`/`new_cwd`, and `agent_id` on the subagent firing; the same fields without `agent_id` on the main-thread firing) that only the main session's cwd reaches the callback

## 2. Persist and publish the updated session path

- [ ] 2.1 Handle the driver's cwd callback in `src/server/chat/ChatSessionManager.ts` by patching `project_path` via `updateChatSession`, re-publishing the session through the registry, and skipping no-op updates when the path is unchanged; verify with a unit test in `src/server/__tests__/chatSessionManager.test.ts` that the stored row and the published `Session.projectPath` both show the new directory
- [ ] 2.2 Confirm clients see the move without a reload by asserting the `sessions` broadcast carries the updated `projectPath` (extend `chatSessionManager.test.ts` or the registry test)

## 3. Recover the cwd from the transcript

- [ ] 3.1 Capture the newest non-empty `cwd` (falling back to `attachment.snapshot.workingDirectory`) while parsing in `src/server/chat/transcriptReplay.ts` and return it from the replay helper without changing emitted `ChatEvent`s; verify with a unit test in `src/server/__tests__/chatTranscriptReplay.test.ts` covering a transcript whose cwd changes mid-file and one with no cwd field
- [ ] 3.2 On `restorePersisted` and on attach/history replay, sync `project_path` to the transcript's last cwd when it differs and re-publish the session; verify with a unit test that a restored session whose transcript moved into a worktree comes back with the worktree path

## 4. Keep workspace discovery in step

- [ ] 4.1 After a path change, request a scoped `workspaceCoordinator.requestRefresh(newPath)` (debounced) so a newly entered worktree is discovered without a reload; verify with a unit test that a cwd update issues exactly one refresh for the new path even when several hook events arrive together

## 5. Navigator placement

- [ ] 5.1 Add grouping tests in `src/client/__tests__/workspaceView.test.ts` (and `sessionListGrouped.test.tsx` if a rendering assert is needed) for: a chat created in a worktree lands in that worktree section; a chat whose path changes to another worktree moves sections; a chat whose path leaves Git lands in `Workspace`
- [ ] 5.2 Verify the started-in-a-worktree path end-to-end against a live server: create a Claude Code Chat with a discovered worktree as its project path and confirm the left menu lists it under that worktree section, not `Workspace` (headless WS check is enough; fix `workspaceSnapshot`/`repositoryResolution` if placement is wrong despite a correct `projectPath`)

## 6. Regression pass

- [ ] 6.1 Run `bun run lint && bun run typecheck && bun run test` and verify all three pass with no new failures
