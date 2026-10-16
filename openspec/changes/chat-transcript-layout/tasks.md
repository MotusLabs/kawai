# Tasks

## 1. Recorded message times

- [x] 1.1 Change `applyChatEvents` to the D5 rule: an assistant event merges into the newest entry with its `(turnId, messageId)` only when no other event follows that entry, else it starts a new entry with a stable key. Add live-driver and replay regression fixtures for text → tool → text in one SDK message, verifying order, both texts kept, and the adjacent-text-block limitation documented in a test name or comment.
- [x] 1.2 Audit live assistant timestamp production, `applyChatEvents`, and transcript replay; preserve each entry's first valid content time through deltas, finalization, reconnect (live start kept), and replay (earliest transcript record time). Add store/replay regression coverage for a multi-delta response followed by its final event and reattachment, verifying the displayed start does not move.
- [x] 1.3 Remove the current-time fallback for undated historical rows, document the empty `at` on `ChatEventBase`, and add a shared `validTime()` helper. Audit the `at` consumers named in design D2 (`pendingRequests`, replay's cancelled-request events, new grouping/separator logic) to read through it. Verify replay fixtures with missing and invalid timestamps produce no fabricated message clock and generated current notices still render correctly.
- [x] 1.4 Add a shared local-time presentation helper using semantic time markup, full date/time/timezone hover and accessible descriptions, and day separators keyed on the previous dated row. Verify formatting with a fixed timezone, midnight rollover, invalid times, and an undated row between two days.

## 2. Responsive transcript

- [ ] 2.1 Introduce the shared metadata/body row layout in `ChatMessages`, aligning user/assistant/peer bodies and using a wide-container gutter with stacked metadata in narrow containers. Verify author identity (agent label from the session's agent kind, never the model string), peer links, timestamps, author-change separators, same-author spacing, and turn boundaries from `turn_started`/user/peer events in both live and replayed fixtures, in component fixtures and browser screenshots. Measure gutter author/time text and the user body surface against the chat contrast requirement.
- [ ] 2.2 Align tool/system rows and nested worker transcripts while preserving stable keys, paired tool expansion, and current task/worker components. Verify a streaming fixture keeps an expanded tool open and nested content reflows when its own container narrows.
- [x] 2.3 Add a mixed-event regression fixture covering tool input/output and errors, worker details, task outputs/outcomes/Stop, peer metadata/task context/revision notices/threads/duplicate warnings/handoff content, commands, triggers, request decisions, interruptions, and completion summaries. Verify every previously displayed value and eligible action remains available.
- [x] 2.4 Verify active and archived `ChatView` integration with streamed content, activity visibility, approvals/questions, composer actions, and Restore. Confirm archived Chats expose detail disclosures but no live request or task Stop controls; document the updated presentation in the relevant component comments.

## 3. Header hierarchy and wrapping

- [ ] 3.1 Rework `ChatHeader` into identity/actions, wrapping profile/model/project/context metadata, and a conditional wrapping task/paused row. Verify long labels and long unbroken paths remain readable, absent fields create no empty row, rename works, and task navigation preserves spawned provenance.
- [ ] 3.2 Recalibrate `useHeaderLayout` and context compaction for the actual action/metadata rows; retain Team's labelled/icon/menu steps and labelled Auto-approve at every width. Verify narrow containers and larger font sizes preserve status, name characters, context readings, keyboard access, and all controls without clipping or header horizontal scrolling.
- [ ] 3.3 Extend header integration coverage for Team/task navigation, rename broadcasts, approval state and amber styling, Debug, archive/kill confirmation, connection status, archived stored readings, and Restore. Verify usage and notification strips retain their information and dismissal behavior; reconcile `team-workspace-pages` and any landed provider-identity changes and update component layout comments.

## 4. Integrated validation

- [ ] 4.1 Exercise the combined header/transcript in a browser at wide and narrow container sizes, with a widened navigator, Debug open, long task/model/project labels, parked state, and larger chat font. Capture screenshots and verify metadata placement, wrapping, no overlap, and readable message bodies in live and archived Chats.
- [ ] 4.2 Run `bun run lint && bun run typecheck && bun run test`, the focused browser regression coverage, and `openspec validate chat-transcript-layout --strict`; record outcomes and any remaining limitations before marking the change ready for review.

## Workflow follow-up

- Archive this change only after the earlier `team-workspace-pages` header delta has been archived, reconciling requirement names so the old two-line restriction is not reintroduced.
