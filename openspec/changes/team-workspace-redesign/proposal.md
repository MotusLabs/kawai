# Proposal

## Why

The Team page grew one tab per subsystem: Strategy, Plans, Tasks, Messages,
Mailbox, Members, Metrics, and Audit, all with equal weight, under two bands
(attention queue and morning summary) that sit above every tab. It is mounted
inside the Sessions shell, so the chat navigator, the session header, and the
terminal chrome stay on screen while the owner directs the team. Three
problems follow:

- **The owner's job is buried.** What the owner actually does on the Team
  page is decide: answer a decision card, approve a command, accept a result,
  retry a stopped change. The attention queue lists those items, but every
  item only *navigates* to the tab that owns the control, so finishing one
  item costs a tab switch, a scroll, and a way back.
- **Tabs mirror the code, not the work.** Messages and Mailbox are two views
  of the same mail; Members, Metrics, and Audit are inspection surfaces that
  sit beside daily work with the same weight. Nothing answers "where is work
  piling up?" at a glance, and nothing flags a task that review keeps
  sending back.
- **Two workspaces share one frame.** Sessions is "talk to one agent"; Team is
  "direct many". Sharing the session navigator makes Team feel like a side
  panel of a chat, and makes neither fit a phone, where the owner most often
  wants to unblock a plan while away from the desk.

The redesign was explored as a design canvas (Team View Redesign, eleven
desktop and phone screens). This change turns it into an implementable plan.

**Current state (f52963d0).** Nothing is implemented: the eight-tab
`WorkspaceTab` grammar (default Tasks) and `TeamWorkspaceBands` are current,
and no shell, Today, flow strip, or rework code exists (`design.md`, "Current
inventory"). The change stays one executable change with one serialized
writer and five ordered implementation groups, because the groups share
`App.tsx`, `teamLocation.ts`, the team stores, and `TeamWorkspaceView`:

1. **Shell and routes** — Team shell, mode switch, rail, palette, location
   grammar with legacy redirects, Back to Team, entry points.
2. **Today inline controls** — Needs you / Waiting on agents with the owning
   controls, replacing the bands.
3. **Flow strip and stuck rework** — row projections, `flowStrip`, one
   migration, two human-only commands, the `rework-stuck` item.
4. **Area screens** — Conversations, Tasks, Plans (landed plan-workspace UI
   only), Strategy, Agents, Insights, Outbound audit.
5. **Narrow layouts** — bottom bar, phone Today, decision view with Undo;
   then the final validation and archive.

Each group ends with a production-path checkpoint; browser checks are
fixture-gated Playwright specs selected by the landed CI fixture lister
(`scripts/e2e-fixture-specs.ts`), never `bun run test:e2e`.

## What Changes

- **Team becomes a mode with its own shell.** A **Sessions | Team** switch in
  a shared top bar (⌘. toggles) chooses the shell. Team mode hides the session
  navigator, the session header, and the terminal; it shows a team switcher,
  a ⌘K command palette, connection state, and a left rail of areas. Each side
  of the switch carries an attention marker: Team shows the count of items
  that need the human; Sessions shows a dot when a chat outside the team
  needs the human. Opening a chat from Team crosses into Sessions with a
  **Back to Team** pill that restores the exact Team location.
- **Areas replace tabs, grouped by intent.** **Today** (new home), then Work:
  **Plans**, **Tasks**, **Conversations**; Direction: **Strategy**; Team:
  **Agents**, **Insights**, **Outbound audit**. Messages and Mailbox merge
  into Conversations; Members becomes Agents; Metrics becomes Insights. Old
  URLs keep working and redirect to the new location.
- **Today replaces the two bands.** One **Needs you** inbox of human-required
  attention items, each expanding in place to its owning control (answer,
  approve, accept, retry, discard), plus a folded **Waiting on agents** list,
  a **Task flow** strip, plans in flight, agents now, and the last 24 hours.
  The inbox embeds the controls that already own each action; it adds no new
  write path.
- **Task flow strip and stuck-rework flag.** Today and Tasks show counts per
  stage (Planning › Writing › Review › QA › Accept) with the oldest wait per
  stage, the bottleneck named in words, and normal rework shown neutrally. A
  task sent back by review at least N times (team setting, default 3) raises a
  new human-required attention item, **Stuck in rework**.
- **Area screens reworked.** Tasks gets a stage board with a side sheet (List
  and Tree keep today's views). Plans gets a plan list in the rail and a
  detail page led by open decisions and a per-change pipeline. Conversations
  shows delivery state on each message with its delivery actions inline and a
  **Delivery issues** filter; the Mailbox's section view and routing state
  remain as a **Delivery** sub-view. Strategy reads as a document with the
  pending revision as a banner. Agents holds groups, live members, workers by
  provider, settings, and the team approval default. Insights and Outbound
  audit keep their data and gain the shared layout.
- **One visual language.** Amber means "needs a human", blue "agents
  working", green "done", red "stopped or failed"; every state also carries a
  text label. Team mode uses its own dark design tokens and is not bound to
  the Sessions look.
- **Narrow viewports.** Below 768 px the rail becomes a bottom bar (Needs
  you, Plans, Task flow, Messages), Today becomes the phone inbox ("Unblocks a
  plan" first, then "Quick yes or no"), and a decision opens as a full-screen
  answer view. All actions keep 44 px targets.

### Follow-up changes (outlined here, specified separately)

- **`team-metrics-by-model`** — a `model` slice for process metrics and an
  optional task **kind** tag (feature, bug fix, refactor, tests) set at task
  creation, feeding the Insights **Models** grid (model × task kind or model
  × role). Needs a task-record field and slice plumbing.
- **`team-push-notifications`** — Web Push from the kawai server to the
  owner's phone over HTTPS (Tailscale Serve), a service worker, per-event
  delivery (Now / Summary / Off), quiet hours, "only when away", and
  actionable notifications that call the same commands as Today. Needs
  subscription storage, VAPID keys, and a delivery loop.

## Capabilities

### Modified Capabilities

- `team-workspace` — the Team page becomes Team mode: areas instead of tabs,
  Today instead of the bands, Conversations instead of Messages + Mailbox,
  the strategy status moves from a header line to the rail and the Strategy
  banner, the location grammar gains areas with legacy redirects, the
  narrow-viewport behaviour becomes the phone layout, and requirements that
  named former tabs name their areas.
- `workspace-navigation` — the navigator's **Team** entry opens Team mode;
  the mode switch is the primary way across.
- `chat-header` — the header's Team button opens Team mode; a Sessions view
  reached from Team shows **Back to Team**.

### New Capabilities

- None. Flow strip, task-row timing, and stuck rework are requirements of
  `team-workspace`.

## Impact

- Client: `App.tsx` shell split (Sessions shell vs Team shell); new
  `src/client/components/team/shell/` (top bar, mode switch, rail, team
  switcher, command palette, bottom bar); `TeamWorkspaceView` becomes the
  Team shell's area router; new `today/` components; `TeamWorkspaceBands`,
  `TeamAttentionQueue`, `TeamMorningSummary` are folded into Today;
  `TeamMessagesView` and `TeamMailboxView` are composed by a new
  `ConversationsView`; Members, Metrics, Audit, Strategy, Plans, and Tasks
  views are restyled and partly recomposed. `utils/teamLocation.ts` gains the
  area grammar and legacy mapping.
- Shared: `TeamTaskRow` gains `stageSince`, `reworkRounds`, `planId`, and
  `reworkStuck`; new pure
  `flowStrip` model; new attention kind `rework-stuck`; new team setting
  `reworkAlertRounds`.
- Server: `workspaceRead.ts` projects the row fields and the new
  attention kind; a `team_settings` row stores the threshold with a human-only set
  message. The same migration adds the append-only `rework_acks` command ledger;
  acknowledgements retain replay responses. One schema migration.
- No change to chat sessions, mail delivery, plan execution, or the outbound
  observer. Existing Today actions reuse their commands; only the rework threshold and acknowledgement add human-only commands.
- Tests: table-driven tests for every oracle family in `design.md` (location
  grammar, redirects, shell mount, markers, Today controls, stage clock, flow
  strip, stuck rule, migration, rework commands, area hosts, phone flows),
  each guarded seam exercised once through the real `App`/store/connection
  composition with a named mutant; a fixture-gated Playwright spec
  (`tests/e2e/team-mode.spec.ts`) run by CI's fixture step or a disposable
  checkout, database, and spare port — never `bun run test:e2e` or live data.
- Specs: the MODIFIED blocks are re-derived on the current main text (after
  slow-link-resilience and unify-approval-defaults), and every main
  requirement that named a former tab (Members, Mailbox, Messages, Strategy,
  approval default, view state, task chip, exhausted-session links) is
  re-stated now instead of at archive time.

## Holds and dependencies

- **Held, unchanged:** plan-workspace's unlanded 7.x, its human pilot
  task-efdf3b9c, and the cancelled G refs. The Plans area recomposes only the
  landed plan-workspace UI; nothing here revives the held work.
- **Not built here:** revision-control's hold/pause/Continue UI and
  plan-revision-apply's Apply UI; they rebase onto whichever shell is current.
- **Serialize, no hard edge:** `teamLocation.ts`, `TeamPlansView`, and
  `teamPlanStore` with revision-control's UI remainder and plan-workspace 7.1;
  the `team-workspace` main spec with held delivery-outcome-metrics (second to
  archive re-derives); the group-3 migration number with every other
  migration; `App.tsx`/client stores with rename-agentboard-to-kawai's client
  storage group.
