# Validation

Baseline: `dda00698` (master), containing deployed `v1.0.0-1769` transcript layout. Implementation worktree: `/home/coder/kawai/.worktrees/fix-chat-typing-performance`, branch `fix/chat-typing-performance`. Original checkout and unrelated edits preserved.

## Browser baseline

Fresh production client from dda00698; Chromium 143 (Playwright build 1200), 49 per-character keydown-to-two-animation-frame samples per case, default 1280x720 viewport, same workspace. Long fixture contains 500 dated messages plus 25 paired tools. Synthetic streaming updates one assistant message at 10 Hz.

| History | State | Median ms | p95 ms |
| --- | --- | ---: | ---: |
| Empty | Idle | 24.9 | 32.5 |
| Empty | Streaming | 26.0 | 32.6 |
| 500 messages | Idle | 122.0 | 128.4 |
| 500 messages | Streaming | 240.0 | 798.3 |

Baseline long-streaming check also failed focus preservation; three other baseline cases passed. Traces/screenshots: `/tmp/kawai-typing-baseline/`; streaming measurement and trace: `/tmp/kawai-typing-baseline-stream/`. Logs: `/tmp/kawai-typing-baseline.log`, `/tmp/kawai-typing-baseline-stream.log`.

Reproduction (in implementation worktree): `bun run build`, then `PLAYWRIGHT_BROWSERS_PATH=/home/coder/.cache/ms-playwright NODE_ENV=development AGENTBOARD_CHAT_FIXTURE=1 E2E_PORT=4191 bunx playwright test tests/e2e/chat-typing-performance.spec.ts tests/e2e/chat-drafts.spec.ts --workers=1 --trace=on --output=/tmp/kawai-typing-optimized`. The cache-path override selects the already installed Chromium; it is environment-specific. The configured default `/opt/playwright` is absent. Fixture commands and histories are injected on the test socket; no real agent/model calls.

## Optimized browser result

Fresh optimized production bundle, same Chromium/fixture/viewport, 49 samples per case:

| History | State | Median ms | p95 ms |
| --- | --- | ---: | ---: |
| Empty | Idle | 24.4 | 31.9 |
| Empty | Streaming | 26.0 | 32.1 |
| 500 messages | Idle | 27.7 | 34.6 |
| 500 messages | Streaming | 26.4 | 33.8 |

All 6 browser checks passed (four performance cases plus two existing draft lifecycle cases). The long cases meet the proposed 50 ms diagnostic target and remain close to empty-chat latency. Focus/selection, command insertion, session switching, submission, and expanded tool disclosures pass; the baseline streaming focus failure no longer occurs. Visually inspected the long-streaming screenshot: message gutters, Markdown, live output, and selected draft text remain intact. Traces and screenshots: `/tmp/kawai-typing-optimized/`; log: `/tmp/kawai-typing-optimized.log`.

Measurements use keydown to two animation frames as a paint-opportunity proxy, not the browser Event Timing API or a portable CI threshold. The repeatable render-work tests provide the deterministic gate. Focused suite: 158 tests passed across six files (render-work, time formatting, existing chat components/transcript rows, Markdown, and transcript layout).

## Required checks

- `bun run build`: passed for baseline and optimized client.
- `bun run lint && bun run typecheck && bun run test`: exited 0. Full runner reported 4,255 passing tests in total (3,804 in its main batch plus 451 across isolated batches), zero failures. Log: `/tmp/kawai-typing-full-tests.log`.
- Lint: zero errors, three existing warnings in unchanged `ChatTaskRow.tsx` and `chatTaskStore.ts`; no new warnings.
- `openspec validate fix-chat-typing-performance --strict`: passed.
- `git diff --check`: passed.
- Implementation commit: `1acfb10c` (`fix: keep chat typing independent of transcript history`).

The repository requests a dev-browser skill which is unavailable in the installed skill locations. Used the existing Playwright harness instead, including a real isolated server, DOM assertions, screenshots, and traces. No deployment or external publication performed.
