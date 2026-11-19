# Design

## Context

See proposal.md for the motivation. This design is necessary because the fix crosses navigator/chat layout and plan navigation.

The desktop capture establishes the failure independently of appearance:

| Measurement | Before | After attention navigation |
| --- | --- | --- |
| Viewport / app height | 758 px | 758 px |
| Document scrollTop | 0 | 190.4 px |
| App top / bottom | 0 / 758 px | -190 / 568 px |
| App's own scrollTop | 0 | 0 |
| Navigator scrollTop | 961.6 px | 961.6 px |
| Document scrollHeight | 6048 px | 3281 px |

The before capture was a chat and the after capture a Team plan. This is document scrolling, not resizing of the Team content. Long chat/navigator content includes absolutely positioned `.sr-only` spans whose static positions can escape the intended scroller when their containing block is outside it. The capture includes hidden sidebar labels far below the viewport and a chat copy-status span ending at the document's 6048 px extent.

An isolated browser experiment using the existing Team components, compiled app CSS, a standards-mode document, and a synthetic long sidebar reproduced a 191 px document scroll on attention navigation. The control with only the synthetic hidden labels omitted kept document height at the viewport and document scroll at zero. This supports the mechanism; the implementation regression must use actual navigator/chat components as well.

`attentionLinks.ts` requests a one-shot reveal before navigating to the plan. `PlanDecisionCard` and `PlanExecutionChangeRow` currently call unrestricted `scrollIntoView({ block: 'center' })` followed by `focus()`. `TeamPlansView` focuses the title when no rendered target wins. `TeamPlansView` already has one internal content scroller, so no page redesign or second scroll manager is needed.

## Goals / Non-Goals

**Goals:** contain accessibility metadata at its owners; confine explicit plan navigation to the owning pane; preserve visible keyboard focus, target selection, and routing; verify the document and app bounds through production browser composition.

**Non-Goals:** redesigning Team bands or tabs, changing plan commands or server protocols, changing the attention queue's remembered-focus lifecycle, or adding a global scroll-reset listener. No migration, recovery mechanism, exclusive slot, or new dependency is involved.

## Decisions

### D1 — Contain hidden labels locally

Establish local positioned containing blocks for the known hidden-label owners: the navigator's collapse trigger (`SectionHeader.tsx`), transcript row metadata, timestamps (`ChatTime.tsx`), and copy feedback (`MessageCopyButton.tsx` / `.chat-row-copy`). Preserve the existing text, semantic elements, accessible names, and live-region behavior. CSS changes can live in existing transcript styles where a host already has a stable class.

The implementation must verify the actual affected owners rather than applying `position: relative` indiscriminately throughout the app. Header/context labels can be checked in the same production regression; change their hosts only if those labels also escape. No label may be removed, hidden with `display: none`, or marked `aria-hidden` to satisfy a geometry assertion.

Alternatives considered: replacing `.sr-only` globally changes the accessibility utility's behavior for unrelated controls; a page-wide forced `scrollTop = 0` hides the cause and fights legitimate internal navigation; changing only plan focus leaves the document overflow present for other controls. Prefer local containment and a separate reveal boundary.

### D2 — Give plan reveals one explicit scroll boundary

Mark the existing `TeamPlansView` content scroller with a stable DOM attribute such as `data-plan-scroll-container`. Add `src/client/utils/scrollWithinContainer.ts` to reveal a connected target inside that marked ancestor. It must never fall back to scrolling `window`, the document, or an unmarked ancestor.

Use the target and scroller's measured rectangles, scroller `clientTop`, current scroll offset, and available client height. Center a target that fits; align the beginning of a taller target with the pane's visible top. Clamp the resulting offset to the scroller's legal range. Use immediate scrolling so initial focus and geometry do not depend on animation timing or reduced-motion preferences. Missing targets or boundaries produce no scroll.

Wire decision-card and change-row reveals through this helper, then call `focus({ preventScroll: true })`. Preserve the existing `revealed` transition and the parent's one-shot consumption; store snapshots must not re-run a consumed reveal. For ordinary plan opening and unknown-target fallback, explicitly reveal the title at the pane's start and focus it with `preventScroll: true`, preserving the current title-versus-target priority.

Alternatives considered: `scrollIntoView` with its current defaults walks all scrollable ancestors; relying on the newer nearest-container option would require a browser-support decision and still leaves the following default `focus()` unbounded. An explicit existing-pane boundary is small and testable without adding a dependency or prop threading through every plan section.

### D3 — Check geometry and accessibility through the production wiring

Add a focused `tests/e2e/team-document-scroll.spec.ts` using an isolated fixture server, database, configuration/home, and tmux socket, following `team-page.spec.ts` and its `ServerProcess` lifecycle. Use the built client (`bun run build` before the browser suite) and real Team routing. Seed a long navigator with real dirty/detached/stale headers, a long chat transcript, a long plan with an owner-addressed card and a stopped change, and a task detail. Test fixture records may be seeded only in that isolated database; never read or mutate a live development database or send to a real model provider.

Make the decision card and change row fit within the pane for the main regression, with enough preceding content that each starts outside it. Use a separate taller-target case. Drive the actual attention buttons, not only calls to the helper. Include mouse and keyboard activation, plan title fallback, repeated navigation, and opening/cancelling Answer and Retry forms. Existing unit tests in `planDecisionUi.test.tsx`, `teamPlansView.test.tsx`, and helper tests cover the one-shot/fallback branches without duplicating the full browser fixture.

Require `document.compatMode === 'CSS1Compat'`; a document without a doctype can mask this document-level overflow in browser experiments. After layout settles, independently inspect document and outer-container offsets, app top and bottom, target focus and visibility, and sidebar/attention scroll positions. Allow at most 1 CSS px for fractional rectangle/extent rounding; do not derive the expected bounds from the mutated app geometry. The document must have no extra scrollable height from hidden labels even before an attention action is clicked.

For the helper boundary test, deliberately give the isolated document extra scrollable space outside the app fixture so label containment cannot mask a regression to unrestricted ancestor scrolling. Keep this hostile boundary fixture separate from the production containment oracle, where document height must equal viewport height. The production navigation cases still exercise the real attention-to-plan-to-card wiring (oracle hazard M1).

### Acceptance oracles

Commit these rows verbatim as table-driven cases with the implementation. `*` means the input does not affect the row's outcome. Initial scroll positions of non-owning areas are fixed and recorded before activation. In navigation rows, `present` means the loaded plan actually renders the named target.

| Oracle | Input | Action | Observable result | Mutant that must fail |
| --- | --- | --- | --- | --- |
| O1 | Long actual navigator with hidden state labels, sidebar scrolled | Open Team | Labels retain accessible state text; document extent is within 1 px of viewport; app top 0 and bottom viewport | Remove local containment at the navigator label owner |
| O2 | Long actual chat with hidden timestamps, repeated authors, and copy status, transcript scrolled | Open Team and return to chat | Hidden metadata/live regions retained; no label-created document extent or app displacement before or after navigation | Remove containment at transcript metadata/time/copy hosts |
| O3 | Present decision card shorter than pane, initially outside it | Activate Answer the question by mouse and keyboard | Card fully inside pane and focused; document/app offsets 0; app fills viewport; sidebar and attention scroll unchanged | Remove the production card reveal wiring or replace bounded reveal with unrestricted scrolling in the hostile boundary fixture |
| O4 | Present stopped change shorter than pane, initially outside it | Activate Retry or stop execution | Change fully inside pane and focused; document/app offsets 0; app fills viewport; sidebar and attention scroll unchanged | Remove the production change reveal wiring or replace bounded reveal with unrestricted scrolling in the hostile boundary fixture |
| O5 | Present card or change taller than pane | Reveal target | Target beginning visible, target focused, remainder reachable by pane scroll; document/app offsets unchanged | Always center tall targets, clipping their beginning |
| O6 | Absent requested card or change | Follow attention link, then push plan update | Plan title focused at pane start; reveal consumed; update causes no second focus or scroll | Keep reveal pending until a later target appears, or omit title fallback |
| O7 | * surrounding content, selected task/plan detail | Open and cancel inline task action, Answer form, and Retry confirmation | Document/app offsets unchanged; app fills viewport; form reachable through owning pane; control names and keyboard operation retained | Omit action-form mounting or make its controls unreachable in the detail pane |
| O8 | Ordinary plan selection with no requested target | Open plan from list | Title visible at pane start and focused; document/app offsets unchanged | Omit title reveal/focus or restore unrestricted title scrolling in the hostile boundary fixture |

The browser cases must fail against the pre-fix implementation for O1/O3; report that observed red result rather than asserting that every named mutant has already been run. Redundant protections get separate seams: label-created document extent tests containment, and the deliberately overflowing helper fixture tests scroll isolation even when containment is otherwise correct.

Helper geometry cases supplement O3–O6/O8: target above, below, already in view, too tall, near either scroll limit, null target, and missing marked boundary. A missing target's fallback is the parent view's responsibility; the helper's null/boundary cases perform no document or ancestor scrolling.

Properties (no new generator dependency):

- P-I1: Plan navigation changes no non-owning scroll offset. Generate 32 fixed-seed cases (`0x51c011`) over two viewport sizes (1200×758 and 1024×600), varied preceding content lengths and sidebar/attention offsets, card/change selection, and repeated activations. Run through the real browser attention controls; assert the independently recorded non-owning offsets after each activation. This tests I1 alone.
- P-I2: Hidden accessibility metadata remains present. Use fixed seed `0x51c012`, 16 cases over dirty/stale/detached worktree states, repeated-author rows, valid timestamps, and idle/copied/copy-failed feedback. At the actual rendered owners, assert accessible state/name text, timestamp labels, and the copy status role/text appropriate to each generated input; assert visual hiding separately in O1/O2. This tests I2 alone.
- P-I3: A consumed reveal never replays from a data-only update. Use fixed seed `0x51c013`, 32 cases over missing/present card/change targets and updates that retain, add, or remove the named target. At the real plan view/store seam, consume one request, move focus to another control, update the detail, and assert focus remains there with no reveal scroll. This tests I3 alone.

This is a layout/focus correction, not a new durable state machine; crash/recovery modeling and exclusive-slot matrix additions do not apply.

## Risks / Trade-offs

- Positioning a label host could affect another absolute descendant → choose the smallest semantic owner and verify copy-control placement, timestamps, and existing navigator controls in browser coverage.
- Browser rounding and zoom can introduce fractional measurements → use CSS-pixel geometry with the 1 px tolerance, fixed viewport sizes, and a supplementary larger-text case; never accept a blank strip as rounding.
- A helper-only test could pass while production still uses native scrolling → O3/O4 must click actual attention actions and assert which DOM element is focused.
- A scoped reveal could hide the overflow regression → O1/O2 assert document extent independently before navigation, while a separate hostile fixture isolates D2.
- Other views still use native reveal behavior → this change contains the verified shared overflow source and bounds the affected plan reveals; it does not replace every unrelated scroll call.

## Migration Plan

Ship as a normal client build with no data migration or server protocol change. Browser tests use fresh documents rather than preserving a previously displaced page. Roll back by reverting the client change and its tests; no durable data needs repair. A user on the old build can temporarily reset document scroll, but that is not the implementation or an acceptance oracle.

## Implementation contract

### Acceptance
- A1: With the real long navigator/chat fixtures, hidden metadata does not extend document height beyond viewport height by more than 1 CSS px; the application top is 0 and bottom equals viewport height within that tolerance before and after Team navigation.
- A2: Actual attention actions reveal and focus the requested plan card/change inside the plan's own content pane; the document, app, sidebar, and attention list keep their scroll offsets, including when the document has test-owned overflow.
- A3: Targets taller than the pane expose their beginning; ordinary opening and missing-target navigation reveal/focus the title; a consumed reveal is not replayed by a later plan update.
- A4: Opening/cancelling task and plan inline actions, including Answer and Retry, leaves the application filling the viewport with controls reachable through the detail pane and operable by keyboard.
- A5: Hidden navigator state, transcript author/time labels, and copy feedback retain their accessible text and semantics.

### Invariants
- I1: Plan target reveal changes no scroll offset outside its owning plan content pane.
- I2: Layout containment preserves the accessible content and semantics of every affected hidden label/status region.
- I3: A consumed one-shot reveal cannot move focus again in response to a data-only plan update.

### Scope
- `src/client/components/SectionHeader.tsx`
- `src/client/components/chat/ChatRow.tsx`
- `src/client/components/chat/ChatTime.tsx`
- `src/client/components/chat/MessageCopyButton.tsx`
- `src/client/components/chat/ChatHeader.tsx`
- `src/client/components/chat/ChatContextMeter.tsx`
- `src/client/styles/index.css`
- `src/client/components/team/PlanDecisionCard.tsx`
- `src/client/components/team/PlanExecutionChangeRow.tsx`
- `src/client/components/team/TeamPlansView.tsx`
- `src/client/utils/scrollWithinContainer.ts`
- `src/client/__tests__/*scroll*.test.ts*`
- `src/client/__tests__/planDecisionUi.test.tsx`
- `src/client/__tests__/planExecutionUi.test.tsx`
- `src/client/__tests__/teamPlansView.test.tsx`
- `src/client/__tests__/transcriptLayout.test.ts`
- `src/client/__tests__/SectionHeader.test.tsx`
- `src/client/__tests__/chatTranscriptRows.test.tsx`
- `src/client/__tests__/chatMessageCopy.test.tsx`
- `tests/e2e/team-document-scroll.spec.ts`
- `tests/e2e/fixtures/teamDocumentScroll.ts`
- `tests/e2e/fixtures/planWalkthrough.ts`
- `docs/architecture/team-page.md`
- `docs/architecture/chat.md`
- `docs/architecture/plans.md`

### Verification
- V1: A standards-mode Playwright regression on the built client records O1–O8, checks app/document geometry and target focus, and fails for the original document-shift reproduction before the fix.
- V2: Table-driven helper/view tests cover boundary and one-shot cases; P-I1, P-I2, and P-I3 run with the seeds, case counts, and seams above; the result maps oracle ids to test titles and actually observed killed mutants or states an unrun mutant explicitly.
- V3: `openspec validate fix-team-document-scroll --strict`, the focused client tests, the isolated browser regression, and `bun run check` pass; the browser regression is run after `bun run build` with no live server/database or real provider use.

### Excluded
- X1: No server protocol, persistence schema, plan decision/execution behavior, or authorization changes.
- X2: No Team workspace redesign, global scroll-reset listener, global replacement of the accessibility hiding utility, or removal of accessibility labels.
- X3: No change to the attention queue's stale-focus ownership lifecycle, whose independent behavior was observed during exploration.
