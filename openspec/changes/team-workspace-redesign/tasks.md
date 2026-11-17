# Tasks

One executable change, one serialized writer, five ordered groups. Each group
ships on its own: at the end of every group the committed tree passes the
pinned `bun run check --full-properties`, the group's checkpoint task records
production-path evidence through the real `App` composition plus one failure
path, and the old views still work inside the new shell. Oracle rows from
`design.md` are committed verbatim as table-driven tests next to the code they
cover, with `// @covers:` annotations for the spec scenarios they prove. Every
Verify bullet names its oracle ids and the mutant it must kill; the result maps
each oracle id to a literal test title and the killed mutant. Historical
scenario titles kept in the deltas (e.g. "First open lands on Tasks") keep
existing coverage references valid; the scenario body defines the new
behavior.

Browser checks are fixture-gated Playwright specs (`test.skip` unless the chat
fixture variable is `1`, the name `scripts/e2e-fixture-specs.ts` exports as
`FIXTURE_VAR`), so the landed fixture lister selects them. They run in CI's
fixture step, or locally only in a disposable checkout with its own database,
a spare `E2E_PORT`, and CI's fixture setup after `bun run build`. Never run
`bun run test:e2e`; never point a test server at live data.

The source task map (original id → new id) is in `design.md`, "Source task
map".

## 1. Shell and routes (D1, D2, D8)

- [ ] 1.1 Replace `WorkspaceTab` with `TeamArea` in `src/client/utils/teamLocation.ts`: the area list, `today` as default, `conversations` sub-views (`threads`, `delivery`), `insights` window, and the legacy mapping. `parseTeamHash` returns the canonical location plus a `legacy: true` flag when it mapped a legacy segment. Update `src/client/__tests__/teamLocation.test.ts` › "a bare key opens the default tab and other hash content is not a team route" to expect Today (changed behavior).
  - Verify: table L rows L1–L14 as one table-driven test; property P1 (seed `0x7ea3`, 500 cases). L4 kills "legacy messages keeps its tab"; L11 kills "unknown area is an error"; L12 kills "malformed key throws"; L1 kills "default area stays tasks".
- [ ] 1.2 `useTeamPageRoute` replaces the hash (no history entry) when the parsed location is legacy, at most once per navigation.
  - Verify: table H rows H1–H3 as a hook test asserting `replaceState`/`pushState` counts. H1 kills "legacy hash pushes a history entry"; H3 kills "redirect re-fires on Back (loop)".
- [ ] 1.3 Split `App.tsx` into `SessionsShell` (today's left column, resize handle, and chat pane) and `TeamShell`, rendered by route (D1). `TeamShell` does not mount `Header` or `SessionList`. Keep `App.tsx` under 500 lines by moving the shells to `src/client/components/shell/`. The selection-fallback deferral while a team route is shown (`App.tsx:505`, `:530`, `:605` at f52963d0) moves with the shells unchanged.
  - Verify: table SH rows SH1–SH3 as App component tests. SH1 kills "TeamShell still mounts SessionList"; SH3 kills "Team route no longer defers the selection fallback". Preserved: `src/client/__tests__/app.test.tsx` › "CX1: pending archived selection owns later lists and unrelated local kills until authoritative resolution", "CX1: unknown termination owns an immediate later list and preserves mobile initial selection", "a filtered live selection still falls back to the first visible live session", "the Team entry opens the Team page without changing the selection; selecting a chat leaves it; Back returns", and "a reload restores the location: a team hash on mount renders the Team page" pass unchanged in meaning (only area names in their expectations may change).
- [ ] 1.4 Add `TopBar` with the **Sessions | Team** switch, team switcher (discovered repositories; switching keeps the area), ⌘K button, and connection state. ⌘. toggles the mode outside text fields. `teamWorkspaceStore` keeps `lastLocation`.
  - Verify: table M rows M1–M3, M7, M8 as component tests over the router seam. M1 kills "switching to Team changes the selected chat"; M7 kills "shortcut fires inside a textarea"; M3 kills "Sessions adds two history entries".
- [ ] 1.5 Add `TeamRail` (areas grouped Work / Direction / Team, per-area counts from existing stores, the strategy revision-in-review badge, the unacknowledged-violation badge) and route areas to today's views (`TeamWorkspaceView` becomes the area router; Today temporarily renders the existing bands).
  - Verify: table RL rows RL1–RL3 as component tests (each rail link sets `aria-current`; `#/team/<key>/mailbox` lands on Conversations › Delivery with the Mailbox sections). RL2 kills "rail omits Outbound audit"; RL3 kills "mailbox redirect lands on Threads".
- [ ] 1.6 Team-mode tokens (`--team-*`) on the `TeamShell` root and Tailwind `team-*` colors; contrast check of every text/surface pair in a unit test over the token table.
  - Verify: table K rows K1–K2. K1 kills "`--team-text-2` lowered below 4.5:1 on `--team-panel`".
- [ ] 1.7 Mode switch markers: Team count from the last team's snapshot (kept subscribed in Sessions mode); Sessions dot from non-team chats with a pending approval or question. Both have text for screen readers.
  - Verify: table MK rows MK1–MK4 as store tests. MK1 kills "a member approval also sets the Sessions dot"; MK4 kills "markers have no accessible text".
- [ ] 1.8 **Back to Team**: `openParticipantChat` from Team sets `returnTo`; the Sessions header shows the pill; selecting a chat any other way clears it.
  - Verify: table M rows M4–M6. M5 kills "Back to Team drops the selection"; M6 kills "returnTo survives navigator selection".
- [ ] 1.9 Command palette (⌘K): areas, tasks, plans, agents, threads by title, plus commands New task and Message team. Results come from stores already loaded; no new server query.
  - Verify: table CP rows CP1–CP3. CP1 kills "typed task id does not select it"; CP2 kills "Esc leaves focus in the palette"; CP3 kills "palette sends a server query".
- [ ] 1.10 Update `workspace-navigation` and `chat-header` behaviour: the navigator Team entry, the header Team button, and the task chip open Team mode (last area, else Today; the chip opens Tasks with the task).
  - Verify: table E rows E1–E3 and the scenarios of the MODIFIED requirements in `specs/workspace-navigation` and `specs/chat-header`. E1 kills "Team entry opens Tasks first time"; E3 kills "task chip opens Today".
- [ ] 1.11 Checkpoint 1: one production path — from a chat in the real `App`, the navigator Team entry renders `TeamShell` on Today with no `SessionList`; failure path — a legacy `#/team/<key>/members` link replaces (no push) into Agents, and a malformed key (L12) renders no route without throwing. A fixture-gated Playwright spec (`tests/e2e/team-mode.spec.ts`, planned) walks M1, M3, M4–M5 and L6 under the CI fixture step.
  - Verify: SH1, M1, M5, L6, L12 through `App`; mutant "TeamShell mounted beside SessionsShell" must fail SH1. Record base/head, paths, and results in a task note before group 2.

## 2. Today inline controls (D3)

- [ ] 2.1 Add `detail` to `AttentionItem` in `src/shared/teamWorkspace.ts` (`approval`: session id, request id, tool name, redacted command; `question`: session id, request id, questions) and fill it in the sources that raise those kinds.
  - Verify: table AD rows AD1–AD3 in `workspaceRead` tests. AD1 kills "approval item lacks request id"; AD2 kills "question text omitted"; AD3 kills "client throws on an item without detail".
- [ ] 2.2 `TodayView`: headline, Needs you (filters by kind), Waiting on agents (folded), Plans in flight, Agents now, Last 24 hours (the morning summary's buckets as counts with links). Remove `TeamWorkspaceBands` from the shell; keep `TeamAttentionQueue`'s identity, toast, and focus rules by moving them into Today.
  - Verify: table TY rows TY1–TY3. Preserved: `src/client/__tests__/teamAttentionQueue.test.tsx` and the E13 bucket tests pass against Today. TY2 kills "focus does not move to the next item"; TY3 kills "a reconnect re-toasts unchanged items".
- [ ] 2.3 Inline controls per the D3 table, each sending the existing command through the existing store: approval, question, decision card, pending acceptance, uncertain delivery, plan stop and promotion. Items without an inline control show their link.
  - Verify: table TD rows TD1–TD10, one component test per row asserting the exact message sent; a refusal renders inline; every control is disabled while disconnected. TD1 kills "approval sends a new command type"; TD10 kills "unknown kind is dropped"; TD3 kills "decision sent without its card id".
- [ ] 2.4 Answering from Today and from the chat converge: the second answer is refused by the server and the item leaves both views on the next push.
  - Verify: table C row C1 as an integration test answering an approval through Today, then sending the same `chat-approval` again, asserting the refusal and a single resolution. C1 kills "the server accepts the second answer".
- [ ] 2.5 Checkpoint 2: production path — a fixture-seeded pending approval renders in Needs you on the real `TeamShell`; **Approve once** sends `chat-approval` for that request id and the item leaves; failure path — the same approval answered from a stale view shows the refusal inline (C1). Fixture-gated spec step in `tests/e2e/team-mode.spec.ts`.
  - Verify: TD1, C1 through the real stores and connection; mutant "inline control wired to a test double instead of the store" must fail. Note before group 3.

## 3. Flow strip and stuck rework (D4, D5)

- [ ] 3.1 Project `stageSince`, `reworkRounds`, `planId`, and `reworkStuck` on `TeamTaskRow` in `workspaceRead.ts`.
  - Verify: table R rows R1–R7; table ST rows ST1–ST3 (`stageSince` equals the time of the event that produced the current stage in three fixtures: unstarted, handoff to review, failing findings; events that leave the stage unchanged preserve its clock). R4 kills "every failing record counts"; ST3 kills "a comment resets stageSince".
- [ ] 3.2 Pure `flowStrip` in `src/shared/flowStrip.ts`.
  - Verify: table F rows F1–F14; property P2 (seed `0xf10e`, 400 cases). F4 kills "tie broken by stage order before age"; F6 kills "Accept can be the bottleneck"; F7 kills "fixes-requested counted apart from Writing".
- [ ] 3.3 One schema migration (the next free number at implementation time, serialized with every other change adding a migration): `team_settings` (`team_id`, `rework_alert_rounds`, `updated_at`) and `rework_acks` (append-only, primary key `team_id` + `command_id`, retaining `task_id`, `rounds`, `note`, `created_at`, original response). No startup reconciliation: absent rows are defaults, so no `docs/recovery-matrix.md` row is added; if implementation finds one is needed, add its matrix row in the same commit.
  - Verify: table MG rows MG1–MG3; the migration test creates both tables from the previous schema; `docs/architecture/database.md` lists the migration. MG2 kills "absent row reads as threshold 0"; MG3 kills "migration rewrites team_approval_defaults".
- [ ] 3.4 `team-workspace-rework-threshold-set` (human-only, 2–10, refusal inline, every open view follows) and `team-workspace-rework-ack` (command id, replay returns the prior ack, a different payload is refused naming the field). Register both in `CHAT_CONNECTION_TYPES`.
  - Verify: table RC rows RC1–RC7. RC1 kills "1 and 11 accepted"; RC3 kills "replay returns the latest ack"; RC7 kills "agent connection accepted".
- [ ] 3.5 Attention kind `rework-stuck` raised by `reworkStuckItems` in `src/server/team/`, wired into the attention sources.
  - Verify: table S rows S1–S10. S4 kills "converged task stays stuck"; S6/S7 kill "ack hides forever"; S10 kills "ack compared to the current count".
- [ ] 3.6 `FlowStrip` component on Today (links) and Tasks (filters, plan picker, **Flag at N+ rounds** control); the stuck row and the Today inline control for `rework-stuck` (D3 row TD8).
  - Verify: TD8 and F3/F9 rendered; fixture-gated step in `tests/e2e/team-mode.spec.ts`: a stuck task shows on the strip and in Needs you; **Let it continue** removes it until the next failing findings (S6→S7). Mutant "strip counts stuck rows as rework" must fail F9.
- [ ] 3.7 Checkpoint 3: production path — a seeded task with three failing results raises `rework-stuck` through the real `workspaceRead` attention sources and appears on the real strip; failure path — a stale-round ack is refused (RC6) and the view refreshes.
  - Verify: S1, RC6, F9 through the real connection; mutant "reworkStuckItems not wired into the attention sources" must fail S1. Note before group 4.

## 4. Area screens (D6, D7)

- [ ] 4.1 `ConversationsView` with Threads and Delivery; delivery state as text on each message; inline mailbox actions on unsettled messages; **Delivery issues** filter.
  - Verify: table CV rows CV1–CV3. Preserved: `src/client/__tests__/teamMessages.test.tsx`, `teamMessagesHost.test.tsx`, and `teamMailbox.test.tsx` pass through the new host. CV2 kills "thread Retry sends a new command"; CV3 kills "filter keeps queued-only threads".
- [ ] 4.2 Tasks: Board (stage columns from D4's mapping), List, Tree; side sheet with expand-to-page; the strip above.
  - Verify: table AH row AH1; preserved `teamTasks.test.tsx` and `teamTasksWorkflow.test.tsx` pass. AH1 kills "card selection does not set the URL id".
- [ ] 4.3 Plans: rail plan list; detail led by open decisions, then the change pipeline; usage by provider (never summed); section links. Only the already-landed plan-workspace UI (`TeamPlansView` and its `Plan*Section`/`PlanWorkspace*` components) is recomposed; plan-workspace 7.x is not implemented here (design X-row PW).
  - Verify: table AH row AH2; preserved `teamPlansView.test.tsx` and `teamPlansMount.test.tsx` pass. AH2 kills "provider usage summed into a total".
- [ ] 4.4 Strategy: banner, document view with outline, highlighted pending changes, impact and history beside.
  - Verify: table AH row AH3; preserved `productStrategy.test.tsx` and `strategyImpactReview.test.tsx` pass. AH3 kills "banner Approve sends a new message type".
- [ ] 4.5 Agents: group cards, selected group detail, workers by provider, approval default, rework threshold.
  - Verify: table AH row AH4; preserved `teamMembersPanel.test.tsx` and `teamApprovalDefaultControl.test.tsx` pass through Agents (approval-default wording and notice rules of unify-approval-defaults unchanged). AH4 kills "approval default control missing from Agents".
- [ ] 4.6 Insights and Outbound audit in the shared layout; no data change.
  - Verify: table AH row AH5; preserved `teamAuditView.test.tsx`, `metricsTab.test.tsx`, and `metricsReports.test.tsx` pass through the new hosts. AH5 kills "Insights drops the window segment".
- [ ] 4.7 Update `docs/architecture/team-page.md` (shell, areas, Today, Conversations, flow strip, stuck rework) and the `AGENTS.md` structure list.
  - Verify: table DC row DC1: `grep -rn '^- Team page' docs/architecture/` names the new shell; no doc mentions the bands as current. DC1 kills "doc still names the eight-tab strip as current".
- [ ] 4.8 Checkpoint 4: production path — a held message in a thread shows Retry and Discard on the real Conversations host and sends the Mailbox's command; failure path — a refused retry renders inline. Fixture-gated step in `tests/e2e/team-mode.spec.ts`.
  - Verify: CV2 through the real `teamMailboxStore`; mutant "Threads composes a copy of the mailbox actions" must fail CV2. Note before group 5.

## 5. Narrow layouts (D9) and close-out

- [ ] 5.1 Below 768 px: bottom bar, compact header, phone Today (banner, Unblocks a plan, Quick yes or no), full-screen decision view with pinned Send and 10-second Undo.
  - Verify: table N rows N1–N6; fixture-gated Playwright at 390×844 in `tests/e2e/team-mode.spec.ts`. N2 kills "answer sent immediately"; N3 kills "Undo still sends"; N4 kills "navigation shortens the deadline"; N5 kills "pending send survives disconnect".
- [ ] 5.2 Keyboard and screen-reader pass over every new control (visible focus, names, state text).
  - Verify: table AX rows AX1–AX2: keyboard only, completes the M flows and one D3 inline action per kind with visible focus at each step; every interactive element on Today, Tasks, and the phone views has an accessible name (`getByRole` with a name finds each). No new dependency. AX2 kills "icon button without a name".
- [ ] 5.3 Checkpoint 5: production path — at 390 px the real `TeamShell` renders the bottom bar and the phone inbox; a decision is sent once after 10 s (N2); failure path — another client resolving the card cancels the pending send with a notice (N5).
  - Verify: N2, N5 through the real stores; mutant "pending answer kept in component state" must fail N4.
- [ ] 5.4 Final validation (replaces the original 6.1's `bun run test:e2e` recipe): literal citation preflight of the coverage map; `bun run build`; the fixture-gated specs through CI's fixture step (or a disposable checkout and database on a spare port with CI's fixture setup); clean committed pinned Bun 1.4.3 `bun run check --full-properties`; `bun scripts/verify-result.ts` on the exact head.
  - Verify: zero unresolved citations; the CI fixture job lists `tests/e2e/team-mode.spec.ts` (lister output); no command in the result invokes `bun run test:e2e` or a live database.
- [ ] 5.5 Archive the change after acceptance; add `@covers` annotations for every ADDED or MODIFIED scenario left in the main specs.
  - Verify: `openspec validate team-workspace-redesign --strict` before archive; `scripts/__tests__/specCoverageGuard.test.ts` passes after it.
