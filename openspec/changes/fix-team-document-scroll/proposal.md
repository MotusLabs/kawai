# Proposal

## Why

Opening a plan question through the Team page's **Answer the question** attention action can scroll the entire document upward, clipping the app's header and leaving a blank strip below it. The reported desktop capture shows a 758 px app moved upward by 190.4 px; a browser reproduction traced the document overflow to visually hidden labels escaping internal scroll containers, followed by an unrestricted plan reveal.

## What Changes

- Keep the Team page and app shell anchored to the viewport during attention navigation, task navigation, and plan actions.
- Contain the overflow of visually hidden labels in the navigator and chat transcript while retaining their accessible content.
- Reveal plan changes and decision cards within their owning content scroller, then transfer focus without additional ancestor scrolling.
- Preserve existing selected-plan routing, one-shot reveal consumption, unknown-target fallback, and keyboard access.
- Add real-browser regression coverage for the reported document shift, hidden-label overflow, and task/plan action controls.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `team-workspace`: Require Team navigation and controls to preserve the app's viewport bounds and keep intentional reveals inside the owning pane, including when surrounding navigator or chat content is long.

## Impact

- Client layout: `SectionHeader.tsx`, chat transcript metadata and copy-status hosts, and their styles as needed to contain hidden labels.
- Plan navigation: `PlanDecisionCard.tsx`, `PlanExecutionChangeRow.tsx`, `TeamPlansView.tsx`, and a small shared reveal helper under `src/client/utils/`.
- Verification: existing client plan tests and isolated Playwright fixtures, plus a focused browser regression file and architecture documentation.
- No server API, database, routing format, dependency, plan execution, or decision authorization changes.
- The attention queue's separate stale-focus behavior and the pending Team workspace redesign are outside this fix.
