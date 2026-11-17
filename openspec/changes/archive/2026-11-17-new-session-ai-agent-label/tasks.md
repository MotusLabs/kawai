# Tasks

The design adds an implementation contract and automated acceptance for the unchanged three scenarios. All tests described here are future work, not run evidence.

## 1. Dialog copy and supporting instructions

- [x] 1.1 Change the agent-backed Session kind option text to exactly `AI agent` in `NewSessionModal.tsx`, preserving `value="chat"` and existing handlers. Update directly related test comments/descriptions. Verify UI1 by inspecting the rendered selector with Claude and Codex profiles: the label stays `AI agent`, Terminal stays available, and profile controls remain present; this must catch a regression to either prior label (`Claude chat` or the committed base `Chat`) or a profile-dependent label mutant. Work on an isolated future implementation branch and preserve unrelated edits on main; extend the existing TestRenderer pattern in the small new newSessionAgentLabel.test.tsx file with UI1/UI3 assertions and exact @covers annotations.
- [x] 1.2 Update the opening selection instructions in `docs/claude-session-profiles.md` to tell users to choose `AI agent`. Verify DOC1 with an automated assertion on the opening selection paragraph (declare @reads), paired with rendered UI1; this must catch documentation still directing users to the removed `Claude chat` label. Keep the document's runtime-specific technical details scoped as they are.

## 2. Integration verification

- [x] 2.1 Run the existing NewSessionModal tests and relevant existing profile/runtime-selection tests; inspect the final diff to confirm the option value and creation handlers did not change. Verify UI2 (generic opens still select `chat`, change-section opens select Terminal) and UI3 (Claude/Codex profile selection still creates the chosen runtime); these must catch a changed option value, altered default-kind behavior, or forced-Claude runtime mutant. Commit design table rows verbatim as automated tests, including UI2 reopen transitions and properties I1/I2. Record exact titles and killed mutants for UI1–UI3/DOC1; run new-behavior tests on the base or remove protections to establish failures. Use disposable browser fixtures for required UI verification, never bun run test:e2e or live data. Run the required repository checks on the final implementation tree and `openspec validate new-session-ai-agent-label --strict` before submitting the implementation result.
