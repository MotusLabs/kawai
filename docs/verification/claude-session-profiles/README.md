# Claude session profiles verification

Verified on 2026-10-05 with the installed SDK 0.3.289 and Bun 1.4.2.
Implementation commit: 5b523fd.

- `bun run lint`: zero errors or warnings.
- `bun run typecheck`: passed.
- `bun run test`: 1,595 tests passed, zero failures, including isolated client,
  WebSocket-handler, and real-tmux integration tests.
- `bun run build`: passed.
- `openspec validate claude-sdk-session-profiles --strict`: passed.
- `bun scripts/verify-claude-profile-settings.ts`: conflicting user/project
  routing and model settings were overridden; GLM Sonnet alias reached the
  loopback provider and the unrelated Explanatory output style loaded.
- `bun scripts/verify-claude-profile-resume.ts`: concurrent GLM/MiniMax
  sessions used distinct loopback routes/models, produced approval requests,
  excluded the synthetic credential from metadata, and resumed the same SDK
  conversation IDs after manager shutdown/recreation with persisted SQLite.
- `NODE_ENV=development AGENTBOARD_CHAT_FIXTURE=1 E2E_PORT=4288 bunx playwright
  test tests/e2e/chat-profiles.spec.ts --workers=1`: two tests passed.

The dev-browser skill was searched for locally and was unavailable.
Playwright served as the planned fallback. Its isolated development fixture
exercised real UI and WebSocket behavior; the separate SDK scripts exercised
actual subprocess configuration and resume. All provider traffic in the SDK
checks was routed to loopback, with synthetic credentials.

Retained browser evidence:

- [Named-profile selector](profile-selection.png)
- [Chat profile display](profile-chat.png)
- [Profile retained after reconnect](profile-reconnect.png)
- [Catalog failure and retry controls](catalog-error.png)
- [Terminal form regression](terminal-regression.png)

Initial verification caught an exhaustive Session-field fixture missing the
new profile field. Final review also caught client snapshot equality omitting
profile identity; both were corrected and covered before the final full suite.
