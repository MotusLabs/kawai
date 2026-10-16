# Tasks

## 1. Establish the deployed baseline and reproduction

- [x] 1.1 Use a working baseline containing the shipped `chat-transcript-layout` implementation (present in v1.0.0-1769), preserving unrelated edits and planning files; verify `ChatRow`, `ChatTime`, `chatTimeFormat`, and `transcriptLayout` are present and record the baseline commit.
- [x] 1.2 Add a deterministic long-conversation fixture to the existing isolated browser chat harness with at least 500 dated messages, Markdown, and tool calls/results; capture empty-versus-long idle and streaming input-to-next-paint measurements and a baseline trace as described in design D3, and document the reproducible command/environment with the fixture.

## 2. Isolate composer interactions

- [x] 2.1 Extract `ChatComposer` with the session draft subscription and caret/slash-menu state, leaving attach/detach and command-aware submission/clear bookkeeping in `ChatView`; add focused tests proving typing, deletion, paste, caret movement, and slash navigation do not reprocess unchanged transcript content after mount, and verify a subsequent genuine event still renders.
- [x] 2.2 Memoize `ChatMessages` with complete stable props and preserve existing row keys; verify expanded disclosures remain open and participant-name, archive, connection, and project-path changes still reach affected content, including worker/task rows.
- [x] 2.3 Run and, where needed, extend the existing draft and command tests for session switching, reconnect, archive/restore, submission, caret insertion, and `/clear` success/failure; verify only the submitting session's draft clears and no stale session id is used.

## 3. Reduce repeated rendering costs

- [x] 3.1 Reuse bounded date formatters keyed by formatting context and memoize timestamp labels; add tests proving constructor count does not scale with message count for an unchanged context, while explicit/default timezone, invalid timestamps, and local-day changes still produce correct labels.
- [x] 3.2 Memoize tool pairing and transcript layout using all relevant inputs, and memoize unchanged shared Markdown content; add tests showing edits skip this work, streaming updates parse changed content without reparsing older bodies, and existing Markdown formatting still passes for chat and terminal previews.

## 4. Verify integrated performance and compatibility

- [x] 4.1 Run the long-history browser fixture against a fresh production bundle, idle and with scheduled output updates; verify per-character editing, slash selection, draft selection/focus, session switches, submission, and expanded tools, then record median/p95 input-to-next-paint latency and before/after traces on the same environment. Assess the diagnostic p95 target of 50 ms after warmup and resolve any remaining history-dependent input blocking before completion.
- [x] 4.2 Run `bun run lint && bun run typecheck && bun run test`, the focused browser draft/performance checks, and `openspec validate fix-chat-typing-performance --strict`; record outcomes and any environment limitations in the change's validation notes.
