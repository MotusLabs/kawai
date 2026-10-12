# Multi-agent software development: recommended Kawai UI/UX

Date: 2026-10-12

Status: Proposed product design; features below are recommendations, not implemented behavior.

## Outcome

Make Kawai convenient for a human supervising a lead, developers, reviewers, and QA agents. The human should be able to create and dispatch work, understand ownership and waiting reasons, follow handoffs, change direction, and accept results without reconstructing progress from multiple chats.

Start with small teams working in one repository and its linked worktrees. Communication remains asynchronous. Preserve durable tasks, revision history, journals, receipt-based delivery recovery, per-session approval policy, and human control over task closure.

## Evidence and current behavior

This proposal follows a source/specification review and 43 passing targeted tests for task UI, mailbox UI, staffing, and dispatch. It is not based on a live browser usability study.

Current implementation references:

- [Task list and creation](../src/client/components/chat/TeamTasksPanel.tsx): title, direction, acceptance, parent, manually entered worktree and OpenSpec change; no dispatch action.
- [Task detail](../src/client/components/chat/TeamTaskDetail.tsx): revisions, journal, subtasks, participants, messages, amendments, and status controls.
- [Chat integration](../src/client/components/chat/ChatView.tsx): Tasks, Mailbox, and Debug share one side slot; on narrow screens the panel hides the chat.
- [Mailbox](../src/client/components/chat/TeamMailboxPanel.tsx): delivery exceptions and pending mail; no delivered history or message composer.
- [Peer transcript](../src/client/components/chat/ChatMessages.tsx): sender IDs, priority, tags, origin, and expandable task context.
- [Staffing](../src/server/team/staffing.ts): group/task/worktree mail may spawn an agent; caps include one live spawned member per worktree across all groups.
- [Task permissions](../src/server/team/TaskService.ts): only creator or human amends direction; only creator or human closes; only human reopens.

Creating a task does not dispatch it. Participants do not identify an accountable owner. A group message reaches one eligible member, not every member. Worktrees can be created elsewhere in Kawai, but staffing never creates one implicitly. Saving a task revision does not itself notify or interrupt agents already working.

A concrete visibility gap exists: the mailbox server includes `spawning` rows, but the panel has no category that renders them.

## Product principles

1. Organize supervision around tasks, with chats accessible as supporting detail.
2. Show the next action and who is responsible for it.
3. Distinguish queued, received, acknowledged, completed, and accepted work.
4. Explain waiting with an actionable reason rather than a generic status.
5. Keep dispatch, interruptions, scope changes, and acceptance explicit.
6. Retain original records when sessions disappear or delivery is uncertain.

## Priorities

| Priority | Recommendation | Expected benefit |
| --- | --- | --- |
| P0 | Render spawning and expose staffing/delivery waiting reasons | Waiting work never silently disappears |
| P1 | Task assignment and dispatch; selectable worktrees and changes | Human can start work from a task |
| P1 | Team overview with ownership and attention queue | Human can supervise multiple agents |
| P1 | Named, navigable messages and full thread history | Handoffs can be traced without searching chats |
| P2 | Explicit review/QA handoffs and structured results | Completion and acceptance become inspectable |
| P2 | Save revision with notification and acknowledgement | Agents receive changing requirements deliberately |
| P2 | Reviewer staffing and worktree release policy | Developer-to-reviewer pipelines avoid hidden stalls |
| P3 | Dependencies, team configuration, and overnight summary | Larger workflows require less manual coordination |

P1 capabilities should ship as a coherent supervision flow. P2 adds workflow semantics and requires backend changes, not only presentation changes.

## Expected UI/UX

### 1. Team overview

Add a **Team** entry at repository level in the navigator. It opens a full workspace view independent of the selected chat. Existing chat-side task access remains a shortcut to the same task.

Desktop layout:

```text
+--------------------------------------------------------------------+
| Team: kawai       Tasks | Messages | Members       New task          |
+--------------------------------------------------------------------+
| Attention: 2 approvals, 1 staffing wait, 1 result awaiting acceptance |
+---------------------------+----------------------------------------+
| Tasks                     | Selected task                          |
| Export API   Implementing | Direction / revision / acceptance      |
| Export UI    Waiting      | Assignment and current handoff         |
| Export QA    Ready for QA | Results / journal / messages           |
+---------------------------+----------------------------------------+
```

Task rows show title, task status, workflow stage, accountable session or role, worktree, waiting reason, and next action. Allow filters for active, blocked, awaiting human, awaiting acceptance, group, and worktree. Closed tasks remain searchable, but are excluded from the default active list.

Keep Kawai's existing task statuses. Display workflow stages such as Implementing, In review, and Ready for QA separately; do not infer that a task is done from a finished agent turn.

The attention queue consolidates approvals/questions, uncertain deliveries, staffing waits, and pending acceptance. Items link to the relevant card, task, or message. Show whether an item needs the human or is waiting on another agent. Counts reconcile after reconnect and do not produce duplicate notifications.

On mobile, use list/detail navigation with an explicit Back action. Opening a chat preserves the task selection and filters. All actions have keyboard access, visible focus, accessible names, and text labels for states.

### 2. Create, assign, and dispatch work

The task form retains title, direction, acceptance, and optional parent. Replace raw worktree and OpenSpec inputs with searchable choices scoped to the team. Show paths and branches for worktrees; show valid change names and their location. Permit advanced manual entry only with the same server validation.

Offer **Create task** and **Create and assign**. Assignment chooses a group or specific session and an initial instruction. Explain that group dispatch selects one eligible member. Preview the target worktree, role, effective profile, approval policy, and whether staffing is available.

A created task starts as unassigned until dispatch succeeds. Record assignment history separately from participants: the accountable agent, requested role, and assignment state must remain visible. A queued group assignment has a requested role but no claimed agent yet.

Dispatch should have a stable request identity so reconnect or repeated clicks do not send duplicate instructions. If creation succeeds but dispatch fails, retain the task and the assignment draft, show the error, and offer **Retry assignment**. Never silently erase form input on refusal.

Expose **Assign / send task** in task detail. Reassignment is an explicit handoff; it does not cancel a previous recipient's work automatically. Show any outstanding assignment and require the human to choose whether to notify or stop it.

Worktree creation remains a deliberate existing workflow. Offer a link into that flow and return to the task form after success; never create a worktree merely because mail was sent.

### 3. Waiting reasons and staffing controls

Show every pending message state, including **Starting agent** for `spawning`. Suggested waiting labels:

- Recipient is working; normal mail will arrive when idle.
- Recipient needs an approval or answer.
- No eligible member exists in the target worktree.
- Group capacity reached: 2 of 2 live members.
- Team capacity reached: 5 of 5 spawned members.
- Worktree occupied by a spawned developer.
- Agent startup failed; retry scheduled.
- Target worktree is missing.
- Delivery receipt is uncertain; human review required.

Reasons must come from authoritative routing/staffing state rather than guesses based on session badges. Multiple constraints may apply; display the immediate blocker and allow expansion for the others. Link named agents and worktrees. Re-evaluate the reason when capacity or availability changes.

Separate **delivery problems** from **development blockers**. Receiving a message confirms a durable receipt, not successful implementation. A task can be active while a review request waits for staffing.

### 4. Messages and threads

Show session names with role badges; preserve IDs in expandable metadata. Clicking a sender or participant opens its chat. Killed sessions retain their recorded identity and a clear unavailable label.

The team Messages view includes delivered history and pending mail, with filters for task, thread, role, session, priority, and delivery state. Task detail embeds the relevant subset. Thread detail shows chronological messages, reply relationships, current recipient, and delivery state; task context states the revision carried at delivery.

Add a human message composer with recipient, optional task, body, and priority. Default to normal priority. Explain that urgent direct mail interrupts after pending requests resolve, while urgent group mail waits for an idle member. A reply remains in its thread and keeps its task unless explicitly changed.

Uncertain deliveries keep **Retry to same recipient** and **Discard**. Explain possible duplication before retry. Do not allow reassignment of uncertain mail as if it were undelivered. Retain cancel/retry/discard history in the thread.

### 5. Results and review/QA handoffs

Add a Results section to task detail. A submitted result includes summary, commit or diff reference, worktree, tests performed and outcomes, known limitations, task revision, and submitting agent. Evidence references remain readable after the session is removed. Do not treat an agent's claim of passing tests as independently verified evidence.

Offer **Request review**, **Request QA**, and **Return for fixes**. Each creates an explicit handoff with requested role, instructions, result reference, and expected response. The receiving agent submits findings; the requester decides the next stage. Preserve earlier results when fixes produce a newer result.

Use **Accept result** as a distinct human or creator action. It closes a task only under existing closing rights. A contributor can submit work but cannot close another creator's task. A parent task does not auto-close when its children finish. Show unresolved acceptance criteria and child work before closure; allow an explicit human override with a journaled reason.

A result for an older task revision is labeled **Needs re-evaluation** after direction changes. Review and QA findings should identify the result/commit examined so later commits do not silently inherit approval.

### 6. Worktree release and reviewer staffing

The current one-spawned-member-per-worktree cap counts live spawned sessions, including idle sessions and all roles. Make this visible immediately.

First provide **Release worktree and hand off**: after the developer finishes its turn and pending requests are resolved, archive that developer, preserve its result and transcript, and dispatch the review request. Show the transition and refuse release while an operation is still in flight.

For a later phase, consider separate writer and read-only review staffing policies. A declared read-only role is not an enforcement mechanism by itself. Permit overlapping reviewer staffing only once write restrictions and lifecycle rules can be enforced. Until then, retain explicit sequential release.

Manual sessions can also write concurrently and are not covered by the spawned-session cap. Show other live sessions in the worktree before dispatch; do not claim the existing cap prevents all concurrent edits.

### 7. Changing direction

Add **Save revision and notify** beside ordinary **Save revision**. Preview affected assigned agents, choose normal notification or urgent direct interruption, and explain pending-request behavior.

Store notification and acknowledgement per assignment/revision. **Delivered** means receipt; **Acknowledged revision N** requires an explicit agent acknowledgement. Saving the revision succeeds independently of notification; failed notifications remain visible and retryable without creating another revision.

Old peer rows retain their historical revision. The current task detail shows the latest revision. Agents receiving new mail get fresh task context as today. An amendment alone must never be presented as proof that an in-flight agent has changed course.

### 8. Dependencies, configuration, and overnight summary

Add explicit **Blocked by** dependencies separately from parent/subtask hierarchy. Prevent dependency cycles. A dependant becomes eligible only when its dependencies are accepted/done; changing a prerequisite later flags downstream results for review rather than silently restarting work.

Members/settings show role descriptions, membership, task-creation rights, effective profile, approval policy, and group/team capacity. Start with a read-only view of file-backed settings and explain their source and when changes take effect. Role changes apply to future agent starts, not silently to running agents.

An overnight summary groups completed results, pending acceptance, blocked work, delivery exceptions, and human requests by task. Link to evidence and the next action. Activity counts and turn completion must not be reported as completed features.

## Development scenarios

| Scenario | Human flow | Agent flow | Expected outcome |
| --- | --- | --- | --- |
| Bounded feature | Create and assign export task; inspect result; accept | Lead or developer receives task, implements, journals, submits result | One clear owner and an inspectable completion |
| Parallel feature | Parent task with API/UI subtasks in separate worktrees | Lead dispatches separately; agents agree on contract; integrator combines results | Independent execution with visible dependencies and integration task |
| Review pipeline | Inspect developer result; release worktree; request review and QA | Reviewer reports findings; developer fixes; QA examines latest result | Traceable handoffs with result-specific acceptance |
| Investigation | Create separate investigation subtasks; assign each; request synthesis | Investigators publish findings; lead synthesizes and proposes implementation | Fan-out is explicit; group dispatch is never mistaken for broadcast |
| Scope correction | Save revision and notify chosen agents; inspect acknowledgements | Agents acknowledge latest revision and report obsolete work | No silent assumption that a saved revision redirected ongoing work |
| Overnight run | Dispatch work, set approval policy, return to summary | Agents work within caps, hand off results, escalate exceptions | Human can identify required interventions without opening every chat |

## End-to-end testing plan

Use Playwright with isolated databases, temporary repository/worktree fixtures, isolated tmux state, and deterministic SDK-free agents. Extend existing [team browser coverage](../tests/e2e/chat-teams.spec.ts). Fake agents should expose controllable idle, busy, pending approval, receipt, startup failure, acknowledgement, and result events.

Exercise real WebSocket subscriptions and routing against the isolated backend. Do not seed away the operation being tested: create, assign, notify, and hand off through UI controls. Seed only prerequisite identities or exceptional recovery states. Browser fixtures cannot prove real CLI receipt handling or SDK interruption; retain server integration coverage and add a small isolated real-CLI smoke suite where credentials are available.

Use semantic selectors and observable state transitions instead of fixed sleeps. Capture screenshots for team overview, waiting details, thread recovery, handoff/results, and mobile detail. Verify DOM state, keyboard behavior, persistence, and server records; screenshots supplement assertions.

### E01 — Create and dispatch to one group member (P1)

Given two idle developer members, create and assign a task through the Team view. Assert one task, one dispatch, exactly one recipient, visible owner after claim, and task context in its peer row. Reconnect during submission and retry the same request; assert no duplicate task or mail.

### E02 — Partial failure retains useful work (P1)

Make task creation succeed and assignment fail. Assert the task remains, the instruction remains editable, and an inline error offers Retry assignment. Retry successfully; assert the existing task is used. Separately refuse an invalid worktree and assert creation form fields are retained.

### E03 — Parallel worktree routing (P1)

Create API and UI subtasks targeting two real linked worktrees. Assert matching recipients receive only their assigned task, sessions appear in correct worktree sections, and the parent lists both children. An idle developer in the main checkout must not take either worktree-specific message.

### E04 — Starting and capacity waits are visible (P0)

Hold agent startup open. Assert its message remains visible as Starting agent. Then exercise group cap, team cap, and occupied worktree independently. Assert the correct reason and counts. Free the blocking slot; assert the reason updates and exactly one agent receives the message.

### E05 — Approval attention and urgent delivery (P1)

Give a spawned developer a pending approval, then send urgent direct mail. Assert the approval remains open, the message reports its wait, and the attention item opens the right card. Resolve it; assert interruption precedes delivery. Urgent group mail must leave a busy agent uninterrupted and wait for an eligible idle member.

### E06 — Thread navigation and history (P1)

Send task-linked mail and reply through different sessions. Assert named senders, chronological thread order, task filtering, delivered history, and clickable sender/participant navigation. Reload and kill one sender; assert retained identity and history without broken navigation.

### E07 — Sequential developer/reviewer/QA handoff (P2)

Submit a developer result in a worktree occupied by its spawned session. Request review and assert the occupancy reason. Release and hand off after the turn finishes; assert the developer is archived, its result persists, and one reviewer receives the result reference. Return findings for fixes, submit a new result, and request QA against that result. Assert old review findings do not imply approval of the new commit.

### E08 — Release refuses active operations (P2)

Attempt worktree release while a developer is busy or awaiting approval. Assert an actionable refusal and no archive or review dispatch. After resolving the request and ending the turn, retry and assert one successful transition.

### E09 — Revision delivery versus acknowledgement (P2)

Amend a task while its developer is busy. Ordinary Save revision must not show acknowledgement. Use Save revision and notify; assert revision increments once, historical peer context remains unchanged, and notification carries the latest revision. Delay acknowledgement and assert separate delivered/acknowledged states. Fail notification and retry without creating another revision.

### E10 — Results, acceptance, and permissions (P2)

Have a contributor submit a result for a human-created task. Assert the task stays open/active until human acceptance and the contributor cannot close it. Accept as human, then reopen. Amend after an earlier result and assert Needs re-evaluation. A completed child must not silently close its parent.

### E11 — Recovery and possible duplicates (P1)

Seed uncertain receipt, dead mail, and scheduled mail. Assert clear reasons and available actions. Retry uncertain mail to the same recipient with a possible-duplicate notice; assert no reassignment. Restart the isolated server and verify tasks, revisions, journal, assignments, and pending mail survive. Never display receipt confirmation as accepted development work.

### E12 — Dependencies and scope propagation (P3)

Block UI integration on API acceptance. Assert integration cannot dispatch prematurely, becomes eligible after acceptance, and cycles are refused. Reopen/amend the API task; assert downstream results are flagged for review and no automatic duplicate integration work starts.

### E13 — Overnight summary (P3)

Prepare completed results, capacity waits, approvals, uncertain deliveries, and an agent with a finished turn but no result. Assert each appears in the correct category; the last is not counted as a completed feature. Resolve items and reconnect; assert counts converge and toasts do not duplicate.

### E14 — Mobile, keyboard, and team isolation (P1)

At a narrow viewport, create a task, navigate list/detail/chat/back, and assert drafts and selection survive. Use keyboard-only controls to assign and inspect attention. Verify labels, focus restoration, and text state indicators. Open a second repository and assert tasks, recipients, messages, attention counts, and worktree choices remain team-scoped; cross-team actions are refused server-side.

## Delivery acceptance

P0 is complete when every pending state is visible and capacity waits explain their cause. P1 is complete when a human can create, assign, follow communication, resolve attention, and accept existing task status changes through a team-scoped UI without typing session IDs or worktree paths.

P2 is complete when developer/reviewer/QA handoffs, result evidence, revision acknowledgements, and explicit worktree release work end to end and survive reconnect/restart. P3 is complete when dependencies and summaries reduce supervision effort without claiming that message receipt or agent idleness proves development completion.

Measure time and navigation steps to dispatch a task, identify a waiting reason, locate a result, and complete a review handoff. Establish baselines before implementation; validate the proposed improvements with a live desktop/mobile walkthrough in addition to automated tests.
