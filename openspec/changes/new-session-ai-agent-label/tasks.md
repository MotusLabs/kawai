# Tasks

The optional design document is omitted: this is a display-copy change with no new logic, dependency, or migration. The spec delta defines the complete behavior.

## 1. Dialog copy and supporting instructions

- [ ] 1.1 Change the agent-backed Session kind option text to exactly `AI agent` in `NewSessionModal.tsx`, preserving `value="chat"` and existing handlers. Update directly related test comments/descriptions. Verify UI1 by inspecting the rendered selector with Claude and Codex profiles: the label stays `AI agent`, Terminal stays available, and profile controls remain present; this must catch the old `Claude chat`/interim `Chat` label or a profile-dependent label mutant. Preserve unrelated working-tree edits; no new test harness is needed for this copy-only edit.
- [ ] 1.2 Update the opening selection instructions in `docs/claude-session-profiles.md` to tell users to choose `AI agent`. Verify DOC1 by comparing those instructions with the rendered dialog; this must catch documentation still directing users to the removed `Claude chat` label. Keep the document's runtime-specific technical details scoped as they are.

## 2. Integration verification

- [ ] 2.1 Run the existing NewSessionModal tests and relevant existing profile/runtime-selection tests; inspect the final diff to confirm the option value and creation handlers did not change. Verify UI2 (generic opens still select `chat`, change-section opens select Terminal) and UI3 (Claude/Codex profile selection still creates the chosen runtime); these must catch a changed option value, altered default-kind behavior, or forced-Claude runtime mutant. Record existing test titles and manual UI1/DOC1 evidence against their oracle ids. Run the required repository checks on the final implementation tree and `openspec validate new-session-ai-agent-label --strict` before submitting the implementation result.
