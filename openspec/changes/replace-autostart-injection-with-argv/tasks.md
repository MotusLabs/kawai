## 1. Agent token resolution

- [x] 1.1 Extract the token walk in `inferAgentType` (`src/server/agentDetection.ts`) as an exported `resolveAgentToken(command)` returning the first meaningful basename, and rewrite `inferAgentType` to consume it; verify the existing `agentDetection` tests still pass unchanged
- [x] 1.2 Add `resolveAgentToken` unit tests covering runner prefixes (`npx`, `bunx`), `VAR=value` assignments, leading flags, absolute paths, `bash -lc` wrappers, and quoted commands; verify `bun run test` passes
- [x] 1.3 Add a shared prefix helper mapping a resolved token to `claude` / `codex` / none, with tests asserting `claude-glm`, `claude-glm-flash`, `codex-foo` map correctly and that `inferAgentType` itself still returns `undefined` for all three

## 2. Wire and server composition

- [x] 2.1 Add the selected agent to the `session-create` message in `src/shared/types.ts` alongside `autoStartChange`, and update its comment to describe launch-argument composition; verify `bun run typecheck` passes
- [x] 2.2 Move `applyCommandFor` out of `src/server/pendingAutoStart.ts` into its own module (or `agentDetection.ts`), keeping the `claude` / `claude-rp` / `codex` mapping; verify its existing mapping tests pass against the new location
- [x] 2.3 Compose the start command in the local `session-create` handler in `src/server/index.ts` — resolve the agent from the message, validate the change name with `isValidChangeName`, quote the prompt with `shellQuote`, append it to the command before `createWindow` — and verify a handler test asserts the composed command for Claude, Codex, an unrecognized agent, and an invalid change name
- [x] 2.4 Apply the same composition to `handleRemoteCreate`; verify a test asserts the remote path receives the composed command
- [x] 2.5 Assert in a test that the composed Codex command survives `sh -c` unexpanded — `$openspec-apply-change <change>` must reach the process argv intact rather than expanding to an empty string

## 3. Remove the injection machinery

- [x] 3.1 Delete `src/server/pendingAutoStart.ts` and `src/server/__tests__/pendingAutoStart.test.ts`, keeping the mapping coverage moved in 2.2; verify `bun run typecheck` reports no dangling imports
- [x] 3.2 Remove `sendAutoStartInput`, `reconcilePendingAutoStart`, the `pendingAutoStart` store, its `discard`/`retainAll` calls, and the auto-start `setForceWorking` call from `src/server/index.ts`; verify `bun run test` passes with the injection assertions in `src/server/__tests__/isolated/indexHandlers.test.ts` replaced by composition assertions
- [x] 3.3 Confirm no remaining caller depends on the first-sample `waiting` result of `inferSessionStatus` for auto-start; verify by grepping for `injectWaiting` and `auto_start_injected` and finding no hits

## 4. Resume safety

- [x] 4.1 Extend the flag extraction in `buildResumeCommand` (`src/server/index.ts`) to strip a quoted `/opsx:apply <change>` or `$openspec-apply-change <change>` positional, alongside the existing `--resume` / `resume` / `--session` stripping
- [x] 4.2 Add tests asserting that a session whose `launchCommand` is `claude --dangerously-skip-permissions '/opsx:apply add-x'` resumes as `claude --dangerously-skip-permissions --resume <id>` with no apply prompt, and that an unrelated quoted flag value such as `--append-system-prompt 'foo'` is preserved

## 5. Session form

- [x] 5.1 Replace the auto-start checkbox in `src/client/components/NewSessionModal.tsx` with a "Start with" dropdown offering Claude, Codex, and Nothing, each labelled with the literal prompt it would send; verify the rendered options in `src/client/__tests__/newSessionModal.test.tsx`
- [x] 5.2 Implement the default precedence — preset `agentType`, then the prefix rule, then Nothing — recomputing on command changes until the user selects explicitly; verify tests covering a preset-declared wrapper, a `claude-glm` custom command, an unrecognized command, and an explicit selection surviving a subsequent command edit
- [x] 5.3 Render the dropdown for remote hosts and unrecognized commands, removing the `!isRemoteHost` gate and passing the selected agent through `onCreate` and `src/client/App.tsx`; verify a test asserts the remote submission carries both the change name and the agent
- [x] 5.4 Update the e2e coverage under `tests/e2e/` that exercises the auto-start option to drive the dropdown instead of the checkbox, including its `data-testid`

## 6. Verification

- [ ] 6.1 Confirm Codex expands `$openspec-apply-change <change>` when passed as an argv positional on a machine with Codex authenticated; if it does not, adjust only the Codex entry in the apply-command mapping and update the design's Open Questions accordingly
- [x] 6.2 Run `bun run lint && bun run typecheck && bun run test` and confirm all pass
- [x] 6.3 Create a session from a change section in a freshly created worktree with Claude selected, and verify the agent clears the trust dialog and then begins the apply command — the failure mode this change exists to fix
