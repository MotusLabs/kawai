# Design

## Context

The Team page today (`src/client/components/team/TeamWorkspaceView.tsx`) is
mounted by `App.tsx` in place of the chat pane whenever the URL hash is a
team location (`#/team/<key>/<tab>[/<sub>][/<id>]`, parsed by
`src/client/utils/teamLocation.ts`). The left column (`Header` +
`SessionList`) stays mounted. The page renders a header with a one-line
strategy status, `TeamWorkspaceBands` (attention queue + morning summary,
fed by the `team-workspace-snapshot` read model from
`src/server/team/workspaceRead.ts`), an eight-tab strip, and the active
tab's view. Each tab view owns its own wire subscription; view state lives
per team in `teamWorkspaceStore`.

The read model is deliberately read-only (architecture: "the workspace has
no write path, every action navigates to the control that already owns
it"). Attention items carry `cause`, `owner`, `impact`, `nextAction`, and a
`link`, but not the data an inline control needs (an approval's request id
and command, a question's text).

Task rows (`TeamTaskRow`) carry `stage` but not when the task entered it,
and nothing counts how often review sent a task back. Process metrics count
fix iterations per done task, over a window, not per open task.

The design canvas (Team View Redesign) is the visual reference: Today,
Tasks, Plan, Conversations, Strategy, Agents, Insights, Outbound audit, and
four phone screens. This document fixes the decisions needed to build it.

This revision (planning package, task f588bc17 r2) keeps the change whole —
one executable change, one serialized writer, five ordered implementation
groups (`tasks.md` §1–§5) — refreshes its facts against f52963d0, re-derives
its MODIFIED blocks on the current main specs (after slow-link-resilience and
unify-approval-defaults archived), replaces the forbidden `bun run test:e2e`
close-out with the private fixture path, and adds the implementation contract.
Nothing is implemented; no box is ticked.

## Current inventory at f52963d0

Static, grep-verified; nothing of this change is implemented.

| Area | Current fact (file:line) | What this change does |
|---|---|---|
| Location grammar | `src/client/utils/teamLocation.ts:12` `WorkspaceTab` = strategy, tasks, messages, mailbox, members, plans, metrics, audit; `:15` `WORKSPACE_TABS`; `:24` `RENDERED_WORKSPACE_TABS`; `:27` `DEFAULT_WORKSPACE_TAB = 'tasks'`; 82 lines | group 1 replaces it with `TeamArea`, default `today`, legacy mapping |
| Route hook | `src/client/hooks/useTeamLocation.ts:94` `useTeamPageRoute()` | group 1 adds the one-shot legacy `replaceState` |
| App shell | `src/client/App.tsx` 1110 lines; `:9` imports `SessionList`, `:12` `TeamWorkspaceView`; `:176` `useTeamPageRoute()`; `:505`, `:530`, `:605` `if (teamLocation) return` (selection-fallback deferral while a team route shows — slow-link CX1 "Team deferral"); `:967` `<Header`, `:974` `<SessionList`, `:1010` `teamLocation ? <TeamWorkspaceView` | group 1 splits into `SessionsShell` / `TeamShell` under `src/client/components/shell/` and keeps the deferral |
| Team page | `src/client/components/team/TeamWorkspaceView.tsx` 339 lines; `:35` imports `TeamWorkspaceBands`, `:263` renders it, `:265` maps `RENDERED_WORKSPACE_TABS` to the tab strip | becomes the area router (group 1), bands fold into Today (group 2) |
| Team views | `components/team/`: `TeamTasksView`, `TaskTree`, `TeamTaskDetail`, `TeamMessagesView`, `TeamMailboxView`, `TeamMembersPanel`, `TeamApprovalDefaultControl`, `TeamPlansView` + `Plan*Section`/`PlanWorkspace*`, `ProductStrategyView`, `StrategyImpactReview`, `TeamAuditView`, `metrics/MetricsView`, `TeamAttentionQueue`, `TeamMorningSummary` | recomposed per area (group 4) |
| Absent | no `TeamShell`, `TodayView`, `flowStrip`, `reworkStuck`, `team_settings`, `rework_acks`, `reworkAlertRounds` anywhere in `src/` or `packages/` (grep empty) | added by groups 1–3 |
| Read model | `src/shared/teamWorkspace.ts:75` `AttentionItem`, `:131` `TeamTaskRow`; `src/server/team/workspaceRead.ts` 420 lines | group 2 adds `detail`; group 3 adds row fields and `rework-stuck` |
| Commands | `src/server/chat/chatConnectionTypes.ts:88-90` `team-workspace-open`/`-close`/`-approval-default-set`; every D3 command (`chat-approval`, `chat-answer`, `team-plan-decide`, `team-task-accept-result`, `team-task-handoff`, `team-task-open`, `team-mailbox-retry`/`-discard`/`-hand-off`, `team-plan-execution-retry`/`-stop`, `team-plan-promote`, `team-message-send`) is registered there today; the registration list is typed `satisfies readonly ChatConnectionMessage['type'][]` (`:136`), derived from `ClientMessage` | group 3 registers the two rework commands |
| Wire contract | `src/shared/types.ts` `ServerMessage` `:574-579` (`team-workspace-snapshot`/`team-workspace` carry `TeamWorkspaceSnapshot`; `team-workspace-approval-default-result` ok/refusal variants) and `ClientMessage` `:919-925` (`team-workspace-open`/`-close`, `team-workspace-approval-default-set`); `TeamWorkspaceSnapshot` at `src/shared/teamWorkspace.ts:317` | group 3 adds the `team-workspace-rework-threshold-set` and `team-workspace-rework-ack` `ClientMessage` variants and their `-result` `ServerMessage` variants (shaped like the approval-default pair), and `reworkAlertRounds` on the snapshot; without the `ClientMessage` variants the guarded registration does not typecheck |
| Approval default | `src/server/team/teamApprovalDefaults.ts:12` `team_approval_defaults`; `workspaceConnections.ts:128,158` setter | unchanged; shown in Agents |
| Migrations | `src/server/dbSafety/migrations.ts`, highest version 22 (`team-approval-defaults`, `:118`) | group 3 adds one migration, number taken at implementation |
| View state | `src/client/stores/teamWorkspaceStore.ts` 155 lines, memory only (`:3`) | gains `lastLocation`, `returnTo` (memory only) |
| Entry points | `SessionList.tsx:83-84` `onOpenTeam`; `components/chat/ChatHeader.tsx` Team button | open Team mode (group 1) |
| Existing tests | client: `teamLocation.test.ts`, `teamWorkspaceView.test.tsx`, `teamWorkspaceStore.test.ts`, `teamAttentionQueue.test.tsx`, `teamMessages.test.tsx`, `teamMessagesHost.test.tsx`, `teamMailbox.test.tsx`, `teamTasks.test.tsx`, `teamTasksWorkflow.test.tsx`, `teamPlansView.test.tsx`, `teamPlansMount.test.tsx`, `teamMembersPanel.test.tsx`, `teamApprovalDefaultControl.test.tsx`, `teamAuditView.test.tsx`, `metricsTab.test.tsx`, `metricsReports.test.tsx`, `productStrategy.test.tsx`, `strategyImpactReview.test.tsx`, `app.test.tsx` (all under `src/client/__tests__/`); server: `teamWorkspaceRead.test.ts`, `teamWorkspaceConnections.test.ts`, `teamApprovalDefaults.test.ts`, `teamApprovalDefault.integration.test.ts` | preserved-behavior evidence; expectations naming old tabs change only in area names |
| e2e | fixture-gated `tests/e2e/chat-team-workspace.spec.ts:16` (`test.skip(process.env.AGENTBOARD_CHAT_FIXTURE !== '1', …)`); main-suite `tests/e2e/team-page.spec.ts`, `chat-team-approval-default.spec.ts`; the fixture lister `scripts/e2e-fixture-specs.ts:14` `FIXTURE_VAR` (landed #418) feeds CI's "Run chat fixture e2e tests" step (`.github/workflows/ci.yml:170-172`) | new checks go in a fixture-gated `tests/e2e/team-mode.spec.ts`; existing specs update area selectors only |

Preserved-behavior evidence that exists now (literal titles, `src/client/__tests__/app.test.tsx`):
- `src/client/__tests__/app.test.tsx` › `CX1: pending archived selection owns later lists and unrelated local kills until authoritative resolution`
- `src/client/__tests__/app.test.tsx` › `CX1: unknown termination owns an immediate later list and preserves mobile initial selection`
- `src/client/__tests__/app.test.tsx` › `a filtered live selection still falls back to the first visible live session`
- `src/client/__tests__/app.test.tsx` › `the Team entry opens the Team page without changing the selection; selecting a chat leaves it; Back returns`
- `src/client/__tests__/app.test.tsx` › `a reload restores the location: a team hash on mount renders the Team page`

Changed behavior that an existing test pins: `src/client/__tests__/teamLocation.test.ts` › `a bare key opens the default tab and other hash content is not a team route` (default Tasks → Today; L1).

Everything in the oracle tables below is a **planned** test; only the titles listed above exist today.

## Goals / Non-Goals

**Goals**

- Team is a mode with its own shell; the session navigator and session
  header are not mounted in Team mode.
- The owner can finish every human-required attention item from Today
  without leaving it.
- Where work piles up, and which task is stuck in a review loop, is visible
  at a glance.
- Every existing deep link keeps working.
- The Team shell works one-handed on a phone.

**Non-Goals**

- No new write path for agents, no change to chat, mail delivery, plan
  execution, or outbound observation semantics.
- No per-model metrics or task kinds (follow-up `team-metrics-by-model`).
- No push notifications (follow-up `team-push-notifications`).
- No change to the Sessions shell beyond the mode switch, the attention dot,
  and the **Back to Team** pill.
- No light theme for Team mode in this change.

## Decisions

### D1 — The mode is the route

Team mode is exactly "the hash is a team location". There is no separate
mode setting to fall out of sync with the URL.

- `App.tsx` splits into `SessionsShell` (today's left column + chat pane)
  and `TeamShell` (new). It renders `TeamShell` full width when
  `useTeamPageRoute()` yields a location, else `SessionsShell`. Only the
  rendered shell is mounted; `SessionList` and `Header` are not mounted in
  Team mode.
- Both shells share one `TopBar` with the **Sessions | Team** switch. Team
  opens the last team location (kept per browser tab in
  `teamWorkspaceStore.lastLocation`; first visit: Today of the selected
  chat's team, else of the first discovered repository). Sessions clears the
  team route and restores `selectedSessionId`, which Team mode never
  changes (team-workspace D10 stays true).
- ⌘. toggles the mode; it is ignored while focus is in a text field.
- The mode switch carries the markers: Team shows the count of
  human-required attention items for the last team (from the workspace
  snapshot, kept subscribed while in Sessions mode for that one team);
  Sessions shows a dot when any chat that is not a member of that team has a
  pending approval or question (from the session list's existing pending
  flags). The counts do not overlap: a team member's approval counts only on
  Team.
- Opening a chat from Team (agent row, approval "Open chat", any
  `openParticipantChat` call) pushes the chat location and sets
  `returnTo = <team location>`; the Sessions header shows **Back to Team**
  while `returnTo` is set, and activating it navigates to it. Selecting a
  chat any other way clears `returnTo`.

### D2 — Areas replace tabs; the location grammar keeps old links

`WorkspaceTab` becomes `TeamArea`:
`today | plans | tasks | conversations | strategy | agents | insights | audit`.
The hash keeps its shape: `#/team/<key>/<area>[/<sub>][/<id>]`.

- `sub` exists on `strategy` (unchanged sub-views), `conversations`
  (`threads` default, `delivery`), and `insights` (the window, as Metrics
  today).
- Legacy tab segments map to areas when parsed, and the router replaces the
  hash (no extra history entry):

  | legacy | becomes |
  |---|---|
  | `messages[/<thread>]` | `conversations/threads[/<thread>]` |
  | `mailbox` | `conversations/delivery` |
  | `members` | `agents` |
  | `metrics/<window>[/<report>]` | `insights/<window>[/<report>]` |

- The default area becomes `today` (was `tasks`). The header Team button and
  the navigator Team entry open the team's last area, else Today.
- `parseTeamHash` and `teamHashOf` stay pure and round-trip every canonical
  location (property P1).

### D3 — Today embeds the owning control; the read model carries what it needs

Today lists the snapshot's human-required items (Needs you) and the agent
waits (Waiting on agents, folded). Expanding an item mounts the control
that already owns its action, never a new one:

| id | attention kind | inline control | command sent | data source |
|---|---|---|---|---|
| TD1 | `approval` | command + Approve once / Deny | `chat-approval` | new `item.detail.approval` |
| TD2 | `question` | question form | `chat-answer` | new `item.detail.question` |
| TD3 | `decision-question` | answer + options | `team-plan-decide` | plan detail (open on expand) |
| TD4 | `pending-acceptance` | result summary + Accept / Request fixes | `team-task-accept-result`; Request fixes = `team-task-handoff` back to the builder, as the task view does | task detail (`team-task-open` on expand) |
| TD5 | `uncertain-delivery` | Retry / Discard / Hand off | the Mailbox's existing commands (`team-mailbox-retry`, `team-mailbox-discard`, `team-mailbox-hand-off`) | mailbox row (open on expand) |
| TD6 | `plan-stop`, `plan-promotion` | Retry / Stop / Promote again | `team-plan-execution-retry`, `team-plan-execution-stop`, `team-plan-promote` | plan detail (open on expand) |
| TD7 | `plan-condition`, `plan-fix`, `plan-stall` | summary + **Open plan** | none (navigates) | snapshot |
| TD8 | `rework-stuck` (D5) | decision note + Send / Take over in chat / Let it continue | `team-message-send` to the task's thread; `team-workspace-rework-ack` (D5) | snapshot |
| TD9 | `outbound-violation` | **Open audit** | none (navigates) | snapshot |
| TD10 | unknown kind | raw kind + **Open** | none (navigates) | snapshot |

- `AttentionItem` gains an optional `detail` union filled by the sources
  that raise `approval` and `question` items (session id, request id, tool
  name, redacted command or question text). Nothing else in the item
  changes; a client that ignores `detail` still works.
- The detail subscriptions opened on expand are the same ones the area
  views use, through the same stores, so a reply from either place updates
  both.
- When an item resolves, focus moves to the next item (the existing queue
  rule), and the expanded slot moves with it.
- Today also shows the Task flow strip (D4), plans in flight (from the plan
  list store), agents now (snapshot members), and the last 24 hours (the
  morning summary's buckets, as counts linking to their items).

### D4 — Task flow strip is a pure projection of task rows

`flowStrip(rows, now, settings)` in `src/shared/flowStrip.ts` maps open rows
to five stages:

| row stage | strip stage |
|---|---|
| `unstarted` | Planning |
| `implementing`, `fixes-requested` | Writing |
| `in-review` | Review |
| `ready-for-qa` | QA |
| `awaiting-acceptance` | Accept |
| `null` (closed) | not counted |

Each stage reports `count`, `oldestSince` (min `stageSince`), and for Accept
`waitingOnYou` (rows with `requiresHuman`). The **bottleneck** is one of
Planning…QA (Accept is never a bottleneck; it is flagged as "You" instead):
the stage with the highest count among those with `count ≥ 2`; ties go to
the older `oldestSince`, then the earlier stage. No stage qualifies → no
bottleneck. The strip also reports `stuck`: rows with a currently raised `rework-stuck`
attention item, using D5's stage and acknowledgement rules (shown red,
linking to the task). `rework` is every other open row with
`reworkRounds > 0` (shown neutrally). Acceptance, QA, and acknowledged tasks
therefore never remain marked stuck after their attention item clears.

- `TeamTaskRow` gains `stageSince: string` (ISO time the row entered its
  current projected stage, from the status/handoff event that produced it)
  and `reworkRounds: number` (D5). It also gains `planId: string | null`
  (from the task's existing plan link) for the plan picker and
  `reworkStuck: boolean` from D5's attention predicate. All are projected in `workspaceRead.ts`;
  nothing new is stored. `stageSince` is the start of the current contiguous
  run of the projected stage, replaying task status, assignment/mail state,
  result, findings, and handoff events through the existing `teamTaskStage`
  precedence. A comment, new findings, or assignment update that leaves the
  stage unchanged must not reset the clock. Creation is the initial boundary;
  closed rows use their closing event time and are excluded from the strip.
- On Tasks, each stage is a filter (`aria-pressed`); on Today, a link to
  Tasks with that filter. A plan picker narrows rows to one plan's tasks.

### D5 — Stuck in rework

- `reworkRounds(task)` = the number of the task's results whose single newest
  findings record has verdict `fail`, across review and QA together, using
  the store's `(created_at, rowid)` order (the same rule as `reviewVerdict`).
  No findings means no round; repeated failures on one result count once.
  Projected at read time from result and finding stores, including superseded
  results; a later pass on the same result can reduce the count.
- Team setting `reworkAlertRounds`: integer 2–10, default 3, stored per team
  beside the approval default (schema migration: `team_settings` table
  keyed by team id, holding `rework_alert_rounds`; the approval default may
  move into it in a later change). Set only by the human, through
  `team-workspace-rework-threshold-set` (shaped like
  `team-workspace-approval-default-set`), from Agents or from the strip's **Flag at N+ rounds**
  control; refusals render inline; disabled while disconnected.
- Attention kind `rework-stuck`, source id = task id, raised when the task is
  open, its stage is `implementing`, `fixes-requested`, or `in-review`,
  `reworkRounds ≥ reworkAlertRounds`, and no acknowledgement covers its
  current round count. Owner: the human; `requiresHuman: true`; next action
  **Make the call**; link: the task.
- **Let it continue** records `rework_acks(task_id, rounds)` through
  `team-workspace-rework-ack` (human-only, command id, replay returns the
  prior ack, a different payload under the same id is refused naming the
  field). An ack covers the item while the
  task's `reworkRounds` is at most the highest acknowledged count; the item
  returns only when the count exceeds it. A later passing re-review must not
  resurface an acknowledgement by reducing the count.
- `rework_acks` is an append-only command ledger keyed by `(team_id, command_id)`;
  each row retains the original task id, rounds, optional note, timestamp, and
  response. Replays return that response even after later acknowledgements;
  payload comparisons include the task id. The handler checks team ownership,
  a currently raised item, and that the submitted rounds still match the
  projected count before recording a new ack. Stale submissions refuse and
  refresh the view. Both commands publish a fresh workspace snapshot to all
  subscribers. The threshold setter is an absolute set, matching the existing
  approval-default command; only acknowledgement uses a replay ledger.

### D6 — Conversations composes Messages and Mailbox

`ConversationsView` hosts two sub-views: **Threads** (`TeamMessagesView`'s
list, search, composer, and thread view) and **Delivery** (the Mailbox's
sections, routing state, and Reload routing rules). In Threads, each message
shows its delivery state as text (Delivered, Pending, Uncertain, Dead
letter); an unsettled message shows the mailbox actions that apply to it
(Retry, Discard, Hand off, Cancel), sent through the existing mailbox
commands. A **Delivery issues** filter keeps threads with an unsettled
held, dead-lettered, or uncertain message. Both stores stay as they are;
the view only composes them.

### D7 — Area layouts

- **Plans**: the rail lists open plans under Plans. Plan detail leads with
  open decision cards (answer inline, same command as D3), then a change
  pipeline (Plan › Build › Check › Land per change, owner, state), with
  intent, usage by provider (tokens only, providers never summed), and
  health beside it. The existing sections (Changes, Decisions, Workspace,
  Validation, Report, Revisions) become in-page section links.
- **Tasks**: Board (stage columns, from D4's mapping), List (today's
  filtered list), Tree (today's `TaskTree`); selecting a card opens the task
  in a side sheet (`TeamTaskDetail`) that can expand to the full page.
- **Strategy**: the pending revision is a banner (Review changes / Approve);
  the approved strategy reads as a document with an outline; changed lines
  of the pending revision are highlighted; impact on plans and revision
  history sit beside it. Sub-views and their actions are unchanged.
- **Agents**: group cards; the selected group's live members (Open chat),
  workers by provider, warnings, settings with sources, and the file that
  defines it (read-only, as Members today); the team approval default and
  the rework threshold in the header.
- **Insights** and **Outbound audit**: today's data and controls in the
  shared layout (headline tiles, grouped tables, side column).

### D8 — Visual system and tokens

Team mode uses its own CSS custom properties (`--team-bg`, `--team-panel`,
`--team-border`, `--team-text`, `--team-text-2`, `--team-attention`,
`--team-agent`, `--team-done`, `--team-stopped`), declared on the
`TeamShell` root and exposed as Tailwind theme colors under `team-*`. The
four state colors are never the only signal: every state has a text label.
Text meets 4.5:1 on its surface (3:1 at 24 px and above); focus rings are
visible on every control.

### D9 — Narrow viewports

Below 768 px `TeamShell` replaces the rail with a bottom bar (Needs you,
Plans, Task flow, Messages; the rest under the team switcher's menu) and the
top bar with a compact header. Today renders as the phone inbox: a banner
naming the plans paused on the human, then **Unblocks a plan** (decisions,
stuck rework, stopped changes), then **Quick yes or no** (approvals,
acceptances, deliveries). Decisions open as a full-screen answer view with
**Send** pinned at the bottom and a 10-second **Undo** after sending (the
send is delayed client-side for those 10 seconds). The pending answer lives
outside the mounted view in a per-browser-tab store; navigating to another
area or chat keeps the deadline and a visible Undo control. At the deadline,
revalidate connection and card state, then send once with the original command
id; a resolved card or disconnected transport cancels the pending send and
keeps the draft with a notice. Closing or reloading the browser tab cancels an
unsent answer; the UI states this while Undo is available. Every action target
is at least 44 by 44 px.


## Acceptance oracles

### L — location grammar (`parseTeamHash`, legacy redirect)

| id | hash | parsed location | redirect |
|---|---|---|---|
| L1 | `#/team/k` | area `today` | none |
| L2 | `#/team/k/today` | area `today` | none |
| L3 | `#/team/k/tasks/t_1` | area `tasks`, id `t_1` | none |
| L4 | `#/team/k/messages/th_1` | `conversations`, sub `threads`, id `th_1` | replace |
| L5 | `#/team/k/messages` | `conversations`, sub `threads` | replace |
| L6 | `#/team/k/mailbox` | `conversations`, sub `delivery` | replace |
| L7 | `#/team/k/members` | `agents` | replace |
| L8 | `#/team/k/metrics/7d/r_2` | `insights`, window `7d`, id `r_2` | replace |
| L9 | `#/team/k/conversations/delivery` | `conversations`, sub `delivery` | none |
| L10 | `#/team/k/conversations/th_1` | `conversations`, sub `threads`, id `th_1` | none |
| L11 | `#/team/k/nonsense/x` | `today`, no id | none |
| L12 | `#/team/%E0%A4/tasks` | no route | none |
| L13 | `#/team/k/strategy/review/3` | `strategy`, sub `review`, id `3` | none |
| L14 | `#/team/k/plans/p_9` | `plans`, id `p_9` | none |

Unreachable: a legacy tab with a Strategy sub-view (Strategy is not a
legacy-only tab).

### F — flow strip (`flowStrip`)

Rows are written `stage×count (oldest age)`; threshold 3 unless stated.

| id | rows | bottleneck | Accept "You" | rework / stuck |
|---|---|---|---|---|
| F1 | none | none | 0 | 0 / 0 |
| F2 | implementing×1 | none (count < 2) | 0 | 0 / 0 |
| F3 | implementing×3 (6h), in-review×1 | Writing | 0 | 0 / 0 |
| F4 | unstarted×2 (1d), implementing×2 (6h) | Planning (tie on count, older) | 0 | 0 / 0 |
| F5 | in-review×2 (3h), ready-for-qa×2 (3h) | Review (full tie, earlier stage) | 0 | 0 / 0 |
| F6 | awaiting-acceptance×4, 2 requiresHuman | none (Accept excluded) | 2 | 0 / 0 |
| F7 | fixes-requested×2 | Writing (fixes count as Writing) | 0 | rows' rounds |
| F8 | in-review×1, reworkRounds 2 | none | 0 | 1 / 0 |
| F9 | in-review×1, reworkRounds 3 | none | 0 | 0 / 1 |
| F10 | in-review×1, reworkRounds 3, threshold 4 | none | 0 | 1 / 0 |
| F11 | a closed row (stage null) | not counted anywhere | 0 | 0 / 0 |
| F12 | awaiting-acceptance×1, reworkRounds 3 | none | rows' requiresHuman | 1 / 0 |
| F13 | in-review×1, reworkRounds 3, ack 3 | none | 0 | 1 / 0 |
| F14 | ready-for-qa×1, reworkRounds 3 | none | 0 | 1 / 0 |

### S — stuck rework (`reworkStuckItems`)

| id | open | stage | rounds | threshold | ack rounds | item |
|---|---|---|---|---|---|---|
| S1 | yes | `in-review` | 3 | 3 | — | raised |
| S2 | yes | `in-review` | 2 | 3 | — | none |
| S3 | yes | `fixes-requested` | 4 | 3 | — | raised |
| S4 | yes | `awaiting-acceptance` | 5 | 3 | — | none (converged) |
| S5 | no | `*` | 5 | 3 | — | none (closed) |
| S6 | yes | `implementing` | 3 | 3 | 3 | none (acked) |
| S7 | yes | `implementing` | 4 | 3 | 3 | raised (new round) |
| S8 | yes | `unstarted` | 3 | 3 | — | none |
| S9 | yes | `ready-for-qa` | 3 | 3 | — | none |
| S10 | yes | `in-review` | 2 | 2 | 3 | none (count fell after ack) |

`reworkRounds` counting:

| id | results (newest findings) | rounds |
|---|---|---|
| R1 | none | 0 |
| R2 | r1 fail | 1 |
| R3 | r1 fail, r2 fail, r3 pass | 2 |
| R4 | r1 fail then pass (re-review of r1) | 0 (newest findings pass) |
| R5 | r1 no findings, r2 fail | 1 |
| R6 | r1 review fail then QA pass | 0 (single newest record wins) |
| R7 | r1 fail then fail | 1 (one result, one round) |

### M — mode switch (`TeamShell` / `SessionsShell`)

| id | start | action | result |
|---|---|---|---|
| M1 | Sessions, chat c1, last team location T | Team | T shown; `selectedSessionId` still c1 |
| M2 | Sessions, no last location, c1 in team A | Team | A / Today |
| M3 | Team at T | Sessions | chat c1 shown; no team route; one history entry |
| M4 | Team at T | Open chat c2 from an agent row | c2 shown; **Back to Team** visible |
| M5 | M4 state | **Back to Team** | T shown with its selection |
| M6 | M4 state | select c3 in the navigator | c3 shown; no **Back to Team** |
| M7 | Team, focus in a textarea | ⌘. | stays in Team; the key goes to the text |
| M8 | Team | browser Back after M3 | T shown |

### Properties

- **P1 (location round-trip)**: for every canonical location `l`,
  `parseTeamHash(teamHashOf(l)) = l`. Generator: seeded LCG (seed `0x7ea3`,
  500 cases) over areas, sub-views valid for the area, windows, and ids drawn
  from a pool including `/`, `%`, spaces, and non-ASCII. Seam: the two pure
  functions.
- **P2 (strip conservation)**: for any rows, the sum of stage counts equals
  the number of rows with a non-null stage, and `rework + stuck` equals the
  number of open rows with `reworkRounds > 0`. Generator: seeded LCG (seed
  `0xf10e`, 400 cases) over stages, ages, rounds 0–6, `requiresHuman`, and
  thresholds 2–10. Seam: `flowStrip`.


### Added oracle tables (this revision)

These give every task an observable oracle. Rows are planned tests.

**H — legacy redirect history (`useTeamPageRoute`)**

| id | navigation | `replaceState` | `pushState` |
|---|---|---|---|
| H1 | open a legacy hash (`#/team/k/messages`) | 1 | 0 |
| H2 | open a canonical hash | 0 | 0 |
| H3 | Back onto a page whose redirect already ran | 0 (no loop) | 0 |

**SH — shell mount (`App`)**

| id | route | mounted | not mounted |
|---|---|---|---|
| SH1 | team hash | `TeamShell` | `SessionList`, `Header`, `SessionsShell` |
| SH2 | no team hash, chat selected | `SessionsShell` | `TeamShell` |
| SH3 | team hash while the selected chat is filtered out | `TeamShell`; the selection fallback is deferred (`App.tsx:505/530/605` behavior) | no fallback selection change |

**RL — rail**

| id | input | result |
|---|---|---|
| RL1 | Team mode on any area | that rail link has `aria-current="page"`, the others do not |
| RL2 | rail renders | Today; Work: Plans, Tasks, Conversations; Direction: Strategy; Team: Agents, Insights, Outbound audit |
| RL3 | `#/team/<key>/mailbox` | Conversations › Delivery with the Mailbox sections |

**K — tokens** — K1: every text/surface token pair ≥ 4.5:1; K2: pairs used only at ≥ 24 px ≥ 3:1.

**MK — mode switch markers**

| id | pending items | Team count | Sessions dot | text |
|---|---|---|---|---|
| MK1 | one member approval | 1 | none | — |
| MK2 | one non-member question | 0 | shown | — |
| MK3 | both | 1 | shown | — |
| MK4 | any marker shown | — | — | each marker has an accessible name naming the count or "chat needs you" |

**CP — command palette** — CP1: typing a task id and Enter selects it on Tasks; CP2: Esc closes and returns focus to the trigger; CP3: opening and searching sends no server message (results from loaded stores); the list is a labelled listbox navigable with arrows.

**E — entry points**

| id | entry | first time | later |
|---|---|---|---|
| E1 | navigator Team entry | Today of that repository's team | the team's last area |
| E2 | chat header Team button | Today | the team's last area |
| E3 | chat task chip | Tasks with that task selected | same |

**AD — attention detail** — AD1: an approval item carries session id, request id, tool name, redacted command; AD2: a question item carries session id, request id, questions; AD3: an item without `detail` renders with its link on a client fixture.

**TY — Today composition** — TY1: Needs you holds exactly the snapshot's human-required items, Waiting on agents (folded) the agent waits; TY2: resolving an item moves focus to the next one; TY3: a reconnect replaying unchanged items raises no toast (existing rule).

**C — convergence** — C1: an approval answered through Today, then the same `chat-approval` sent again, is refused and resolves once; the item leaves both views on the next push.

**ST — stage clock** — ST1: unstarted row: `stageSince` = creation; ST2: handoff to review: `stageSince` = handoff event time; ST3: a comment or same-stage assignment update after ST2 leaves `stageSince` unchanged.

**MG — migration** — MG1: from version N−1 the migration creates `team_settings` and `rework_acks`; MG2: absent `team_settings` row reads threshold 3; MG3: `team_approval_defaults` rows are untouched.

**RC — rework commands**

| id | command | input | result |
|---|---|---|---|
| RC1 | threshold-set | 1 or 11 | refused inline, unchanged |
| RC2 | threshold-set | 4 | stored; a second subscribed client shows 4 |
| RC3 | ack | replay of an earlier command id after a later ack | the original response |
| RC4 | ack | same command id, different payload | refused naming the field |
| RC5 | ack | task of another team | refused |
| RC6 | ack | rounds ≠ projected count | refused; view refreshed |
| RC7 | either | from an agent connection | refused, nothing changed |
| RC8 | either | sent by the real client store over the real connection | the server handler receives the typed message (registered in `CHAT_CONNECTION_TYPES`, a `ClientMessage` variant) and the store applies the matching `-result` `ServerMessage`; the snapshot's `reworkAlertRounds` follows |

**CV — Conversations** — CV1: each thread message shows its delivery state as text; CV2: Retry/Discard on a held message in a thread sends the Mailbox's existing command; CV3: **Delivery issues** keeps only threads with a held, dead-lettered, or uncertain message.

**AH — area hosts** — AH1: selecting a Board card sets the URL id and Back closes the sheet; AH2: a plan with two providers' turns shows two usage rows and no total; AH3: the Strategy banner's Approve sends the existing approval message; AH4: Agents shows the approval default control and the rework threshold; AH5: Insights keeps the window segment and Outbound audit its filters.

**DC — docs** — DC1: `docs/architecture/team-page.md`'s Team page bullet names the shell and areas; no doc names the bands as current.

**N — narrow viewport (390×844)**

| id | action | result |
|---|---|---|
| N1 | any action target | ≥ 44×44 px |
| N2 | send a decision | `team-plan-decide` sent once at 10 s with the original command id |
| N3 | Undo within 10 s | nothing sent; the view returns with the choice kept |
| N4 | open a chat after 2 s | Undo visible for the remaining 8 s; nothing sent early |
| N5 | disconnect, or another client resolves the card, before the deadline | pending send cancelled, draft kept, notice shown |
| N6 | close or reload the tab | unsent answer cancelled, as the pending view states |

**AX — accessibility** — AX1: keyboard-only M flows and one D3 action per kind with visible focus at each step; AX2: every interactive element on Today, Tasks, and the phone views has an accessible name.

## Source partition

Every requirement and scenario of the delta maps to exactly one group. The 65
scenarios this change introduced or rewrote are marked *orig*; the 35 marked
*carried* are current main scenarios re-stated under MODIFIED blocks so no
requirement keeps a former tab name (previously deferred to archive time).

| Group | Requirement (spec) | Scenarios |
|---|---|---|
| 1 | ADDED Team mode has its own shell | 5 orig |
| 1 | ADDED The mode switch shows where the human is needed | 2 orig |
| 1 | ADDED Opening a chat from Team offers a way back | 2 orig |
| 1 | MODIFIED A Team workspace opens at repository level, independent of the selected chat | 4 orig |
| 1 | MODIFIED The Team page location is in the URL | 4 orig |
| 1 | MODIFIED Team views open from one Team button (chat-header) | 5 orig |
| 1 | MODIFIED A Team entry opens the team workspace at repository level (workspace-navigation) | 3 orig |
| 1 | MODIFIED Team views are mounted only on the Team page | 2 carried |
| 1 | MODIFIED Each tab keeps its view state while the page is open | 2 carried |
| 2 | ADDED Today lists what needs the human and acts in place | 6 orig |
| 2 | MODIFIED The morning summary groups the interval's outcomes | 5 orig |
| 2 | MODIFIED The attention queue lists exhausted sessions | 2 carried |
| 3 | ADDED The task flow strip shows where work piles up | 5 orig |
| 3 | ADDED Task rows report time in stage and rework rounds | 3 orig |
| 3 | ADDED A task stuck in rework needs the human | 8 orig |
| 3 | ADDED The rework threshold is a team setting | 2 orig |
| 4 | ADDED Conversations holds threads and delivery operations | 4 orig |
| 4 | ADDED The strategy status is shown in the rail and on Strategy | 2 orig (the rail marker is built in 1.5, the requirement completes with 4.4) |
| 4 | REMOVED The Team page header shows the strategy status | — |
| 4 | REMOVED Mailbox is a tab of delivery operations | — |
| 4 | MODIFIED Members is a read-only inspection of group settings | 8 carried |
| 4 | MODIFIED Product Strategy is a tab with full-width sub-views | 4 carried |
| 4 | MODIFIED Mailbox rows collapse to one line and can be searched | 3 carried |
| 4 | MODIFIED Messages rows group by thread and collapse | 3 carried |
| 4 | MODIFIED Messages search covers the whole history | 3 carried |
| 4 | MODIFIED Tasks search and collapse | 3 carried |
| 4 | MODIFIED The Members tab sets the team's default approval policy | 5 carried |
| 5 | MODIFIED The workspace supports one-handed list and detail navigation | 5 orig |

Totals: group 1 25 orig + 4 carried, group 2 11 + 2, group 3 18, group 4 6 + 29,
group 5 5; 65 orig + 35 carried = 100. Main requirements that still read
correctly in Team mode stay untouched (task-row stage and filter rules, the
attention queue's item rules, stable identity, reconnect counts, Members source
file, keyboard access, team-scoped reads, live updates, failed turns).

Held, not in this change: plan-workspace's unlanded 7.x (route selectors in
`teamLocation.ts`, sizing and narrow navigation, `tests/e2e/plan-workspace.spec.ts`,
the 100-change scale check), its human pilot task-efdf3b9c, and the cancelled G
refs stay exactly as they are (X1). The Plans area recomposes only the landed
`TeamPlansView` sections.

## Source task map

| Original (f52963d0) | New | Disposition |
|---|---|---|
| 1.1–1.10 | 1.1–1.10 | kept; Verify bullets gain oracle ids (H, SH, RL, K, MK, CP, E) and mutants; 1.5's Playwright step moves to checkpoint 1.11 |
| — | 1.11 | new checkpoint |
| 2.1–2.4 | 2.1–2.4 | kept; oracle ids AD, TY, TD, C |
| — | 2.5 | new checkpoint |
| 3.1–3.6 | 3.1–3.6 | kept; ST, MG, RC ids; 3.3's migration number serialized; 3.6's Playwright step fixture-gated |
| — | 3.7 | new checkpoint |
| 4.1–4.7 | 4.1–4.7 | kept; CV, AH, DC ids; 4.3 limited to landed plan-workspace UI |
| — | 4.8 | new checkpoint |
| 5.1–5.2 | 5.1–5.2 | kept; N, AX ids; Playwright fixture-gated |
| — | 5.3 | new checkpoint |
| 6.1 | 5.4 | **replaced**: `bun run test:e2e` → fixture-gated specs via the CI fixture lister or a disposable checkout; plus citation preflight, build, pinned full-properties check, verify-result |
| 6.2 | 5.5 | kept (archive after acceptance) |

31 original tasks map once each; 5 checkpoints are new.

## Implementation contract

### Acceptance
- A1: Group 1 — a team hash renders `TeamShell` without `SessionList` or `Header`; the mode switch, ⌘., team switcher, palette, rail, markers, and Back to Team behave as rows L1–L14, H1–H3, SH1–SH3, RL1–RL3, K1–K2, MK1–MK4, M1–M8, CP1–CP3, and E1–E3 state, and every legacy tab link opens its area with one `replaceState`.
- A2: Group 2 — Today lists Needs you and folded Waiting on agents from the snapshot; each D3 kind's inline control sends exactly the existing command of rows TD1–TD10, disables while disconnected, renders refusals inline, and a second answer is refused (C1); rows AD1–AD3 and TY1–TY3 hold.
- A3: Group 3 — task rows project `stageSince`, `reworkRounds`, `planId`, and `reworkStuck` (R1–R7, ST1–ST3); `flowStrip` satisfies F1–F14 and P2; one migration creates `team_settings` and `rework_acks` (MG1–MG3); the two human-only commands behave as RC1–RC8; `rework-stuck` items follow S1–S10.
- A4: Group 4 — Conversations, Tasks, Plans, Strategy, Agents, Insights, and Outbound audit render through their area hosts with rows CV1–CV3, AH1–AH5, and DC1, and every existing view test listed in "Current inventory" passes through the new hosts.
- A5: Group 5 — below 768 px the bottom bar, phone Today, and full-screen decision view satisfy N1–N6; keyboard and accessible-name checks AX1–AX2 pass.
- A6: Every scenario in the delta (100: 65 orig, 35 carried) has an `@covers` test, and the coverage map names a literal test title and killed mutant for every oracle id.

### Invariants
- I1: Team mode never changes `selectedSessionId`; switching to Sessions restores it (M1, M3).
- I2: No new write path besides `team-workspace-rework-threshold-set` and `team-workspace-rework-ack`; every inline control sends a command that exists at f52963d0.
- I3: A legacy hash maps to a canonical area with at most one `replaceState` and never redirects again (L4–L8, H1, H3); `parseTeamHash(teamHashOf(l)) = l` (P1).
- I4: `rework_acks` is append-only; a replay returns its original response; only the human may set the threshold or acknowledge (RC3, RC7).
- I5: The slow-link selection rules (CX1 kept selection, Team deferral, filtered-live fallback) and the approval-default semantics and wording rules behave as before.
- I6: No browser check runs through `bun run test:e2e` or against live data; new browser specs are fixture-gated and selected by `scripts/e2e-fixture-specs.ts`.
- I7: `App.tsx` and every new or touched source file stay under 500 lines.

### Scope
- `src/client/App.tsx`
- `src/client/components/shell/**`
- `src/client/components/team/**`
- `src/client/components/chat/ChatHeader.tsx`
- `src/client/components/SessionList.tsx`
- `src/client/utils/teamLocation.ts`
- `src/client/hooks/useTeamLocation.ts`
- `src/client/stores/team*.ts`
- `src/client/styles/index.css`
- `tailwind.config.js`
- `src/shared/teamWorkspace.ts`
- `src/shared/flowStrip.ts`
- `src/shared/types.ts`
- `src/server/team/**`
- `src/server/chat/chatConnectionTypes.ts`
- `src/server/dbSafety/migrations.ts`
- `src/client/__tests__/**`
- `src/server/__tests__/**`
- `tests/e2e/**`
- `docs/architecture/team-page.md`
- `docs/architecture/database.md`
- `docs/recovery-matrix.md`
- `AGENTS.md`

### Verification
- V1: Each oracle family (L, H, SH, RL, K, MK, M, CP, E, AD, TY, TD, C, R, ST, F, S, MG, RC, CV, AH, DC, N, AX) and properties P1–P2 run as table-driven or seeded tests committed next to the code; at least one test per guarded seam runs through the real `App`/stores/connection composition, and its named mutant from `tasks.md` fails it.
- V2: The preserved tests named in "Current inventory" pass on the final head; changed expectations change only area names or the documented default (L1).
- V3: `tests/e2e/team-mode.spec.ts` is listed by `scripts/e2e-fixture-specs.ts` and passes in CI's fixture step (or a disposable checkout and database on a spare port with CI's fixture setup).
- V4: Literal citation preflight reports zero unresolved citations; the clean committed tree passes pinned Bun 1.4.3 `bun run check --full-properties`; `bun scripts/verify-result.ts --commit <head>` exits 0; `openspec validate team-workspace-redesign --strict` passes.

### Excluded
- X1: plan-workspace 7.x (route selectors, sizing and narrow navigation, its e2e spec, scale check), its human pilot task-efdf3b9c, and the cancelled G refs stay held and unchanged; nothing here revives them.
- X2: revision-control's hold/pause visibility and Continue UI and plan-revision-apply's Apply UI are not built here; they land in their own changes on whichever shell is current.
- X3: The follow-ups `team-metrics-by-model` and `team-push-notifications`, a light theme, and moving the approval default into `team_settings`.
- X4: No change to chat sessions, mail delivery semantics, plan execution, or the outbound observer.
- X5: No live data, live cutover, `bun run test:e2e`, or package publication.

## Execution checkpoints

Each group ends with its checkpoint task (1.11, 2.5, 3.7, 4.8, 5.3): one
production path through the real composition to an observable result, one
failure path, the named mutant run, and a task note with base/head, paths, and
results before the next group starts. A checkpoint is advisory evidence, not a
result submission; the change submits one result per group only if the Lead
splits landing that way, else one result at the end. Group 3 (persistence and
commands) is the risky one: its MG/RC/S tables are binding before code, and its
checkpoint runs before any group-4 work that reads `reworkStuck`.

## Dependencies and serialization

- Hard prerequisites: none outstanding. The fixture lister (#418,
  `scripts/e2e-fixture-specs.ts`) and the approval-default work are landed.
- Shared main spec `team-workspace`: held `delivery-outcome-metrics` also
  modifies it; whichever archives second re-derives its blocks. No order edge.
- Shared files, serialize writers (not a hard edge):
  `src/client/utils/teamLocation.ts`, `TeamPlansView.tsx`, and
  `src/client/stores/teamPlanStore.ts` with revision-control's UI remainder
  (6.1–6.2, 7.x) and plan-workspace's held 7.1 route selectors; `App.tsx`
  and client stores with rename-agentboard-to-kawai group 2 (client storage
  keys; `teamWorkspaceStore` itself is memory-only); `chatConnectionTypes.ts`
  with any change registering WS types.
- Schema migrations: group 3 takes the next free number at implementation
  time, serialized with every other change adding a migration.
- Fixture variable: the specs gate on `FIXTURE_VAR` from
  `scripts/e2e-fixture-specs.ts`, so rename-agentboard-to-kawai's env rename
  needs no edit here.

## Risks / Trade-offs

- **Inline actions duplicate surfaces.** The same approval can be answered on
  Today, in the chat, or on the phone. Mitigation: all three send the same
  command with the same request id; the server already refuses a second
  answer, and the item disappears from every view on the next push.
- **Snapshot subscription in Sessions mode** for the Team badge adds one
  standing subscription. It is one team's snapshot, already coalesced; no
  per-chat cost.
- **Legacy hash redirects** could loop if a mapping produced a legacy
  segment. The mapping only produces canonical areas (L4–L8), and the router
  redirects at most once per navigation.
- **Big-bang UI change.** Phased tasks (see `tasks.md`) keep the old tab
  views mounted inside the new shell first, so each phase ships alone.


## Migration Plan

1. Group 1: ship the shell and the location grammar with the existing tab
   views mounted as areas. Old links redirect.
2. Group 2: ship Today and remove the bands.
3. Group 3: ship the stuck-rework server parts and the flow strip.
4. Group 4: recompose Conversations and restyle the remaining areas.
5. Group 5: ship the narrow-viewport layout, then the final validation.

No data migration beyond the new `team_settings` and `rework_acks` tables
(created empty; absent rows mean defaults; no startup reconciliation, so no
recovery-matrix row).

Requirements that named the Members, Mailbox, Messages, Strategy, or Metrics
tab are re-stated now as MODIFIED blocks (see "Source partition"), not at
archive time.

## Open Questions

Resolved for this revision (Local, journaled by the planning task):

- The approval default stays in `team_approval_defaults` (X3).
- **Stuck in rework** stays human-only; no Lead notification.
