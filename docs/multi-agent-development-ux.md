# Multi-agent software development: recommended Kawai UI/UX

Date: 2026-10-12. Status: Proposed product design, revised from the supplied architecture review; recommendations below are not implemented behavior.

## Outcome

Add **Product Strategy** as the durable, human-approved reference for purpose, primary users, and user outcomes above Plans. Make **Plan the central orchestration entity in Kawai**. A human and a Lead/Architect agree on intent, implementation strategy, 5–10 Changes, dependencies, constraints, and acceptance rules, validate the whole Plan, and authorize autonomous execution. In the morning, the human sees verified results, reproducible partial success, or specific decisions requiring involvement.

Each Plan revision pins an approved Product Strategy revision and explains the outcomes/use cases it advances when a strategy exists; standalone work can remain explicitly unassessed. Product Strategy has no execution attempt and grants no execution permissions. The [Product Strategy design](product-strategy.md) defines capture, approval, alignment, revision impact, proposed skills, and S01–S18 tests. A Plan’s **implementation strategy** explains that bounded effort and is distinct from Product Strategy. A **Plan Execution** is one attempt to execute a Plan revision; a **Task Execution** is one attempt to perform a task. An OpenSpec Change holds requirements/design artifacts and is an optional binding, not the orchestration container. Plans, attempts, checkpoints, and results survive session deletion. Standalone tasks remain supported.

Agents propose substantive decisions; a deterministic runtime enforces authority, revisions, leases, policy, and state transitions. Preserve asynchronous communication, durable tasks/mail, receipt recovery, and creator permissions until explicit grants are implemented. Local integration and PR readiness are the initial delivery boundary; production deployment requires a separate policy and stage.

## Evidence and current behavior

**Current:** the initial source review was made from this branch's implementation base, `90a34688410da4eb960d09966d6fba0aa776085b`. The original proposal is pinned at `63146fd3cd539cbe8192bb75e1c0dc2225bf9e8d` on `docs/multi-agent-development-ux`. Its 43 targeted tests passed, followed by lint, typecheck, and 2,564 tests when preparing the original PR. These are historical validation results, not evidence that the proposed capabilities exist.

**Upstream proposal:** the original document proposed task assignment, team supervision, threads, results, revision notifications, and sequential handoffs. Its E01–E14 cases are retained below, with terminology aligned to publication and stage-specific gates.

**Recommendation:** the supplied review extends that baseline to Plans, execution attempts, targeted publication, verifiable integration, recovery, and runtime safety. It cites a separate master snapshot, `6b3dff66d1db91ecf38a122edb24a45e5d6ae579`; that review boundary is distinct from this branch's implementation base. This revision does not reconstruct the unavailable earlier review artifact or claim continuity with its X01–X14 identifiers. Autonomous execution cases use R01–R24; the subsequent Product Strategy extension adds S01–S18 in its linked design and makes no claim of an already approved Kawai strategy.

This remains a documentation and selected-mechanism review, not a comprehensive audit, installed-version claim, or browser usability study. Relative source references identify the reviewed mechanisms; refresh them and the roadmap against implementation evidence when this proposal is merged. Specialized code/specifications do not by themselves establish complete autonomous orchestration.

Current implementation references:

- [Task list and creation](../src/client/components/chat/TeamTasksPanel.tsx): title, direction, acceptance, parent, manually entered worktree and OpenSpec change; no dispatch action.
- [Task detail](../src/client/components/chat/TeamTaskDetail.tsx): revisions, journal, subtasks, participants, messages, amendments, and status controls.
- [Chat integration](../src/client/components/chat/ChatView.tsx): Tasks, Mailbox, and Debug share one side slot; on narrow screens the panel hides the chat.
- [Mailbox](../src/client/components/chat/TeamMailboxPanel.tsx): delivery exceptions and pending mail; no delivered history or message composer.
- [Peer transcript](../src/client/components/chat/ChatMessages.tsx): sender IDs, priority, tags, origin, and expandable task context.
- [Staffing](../src/server/team/staffing.ts): group/task/worktree mail may spawn an agent; caps include one live spawned member per worktree across all groups.
- [Task permissions](../src/server/team/TaskService.ts): only creator or human amends direction; only creator or human closes; only human reopens.
- [OpenSpec visibility](../openspec/specs/openspec-visibility/spec.md), [receipt recovery](../openspec/specs/agent-mailbox/spec.md), and [profiles](claude-session-profiles.md): current display, delivery, and provider boundaries.

Creating a task does not dispatch it. Participants do not identify an accountable owner. A group message reaches one eligible member, not every member. Worktrees can be created elsewhere in Kawai, but staffing never creates one implicitly. Saving a task revision does not itself notify or interrupt agents already working.

A concrete visibility gap exists: the mailbox server includes `spawning` rows, but the panel has no category that renders them.

## Product principles

1. Ground Plans in human-approved Product Strategy revisions; organize execution around Plans and retain standalone tasks and supporting chats.
2. Show the next action and who is responsible for it.
3. Distinguish queued, received, acknowledged, completed, and accepted work.
4. Explain waiting with an actionable reason rather than a generic status.
5. Keep dispatch, interruptions, scope changes, and acceptance explicit.
6. Retain original records when sessions disappear or delivery is uncertain.
7. Pin inputs and verify exact results/candidates before acceptance; enforce restrictions through the runtime.

## Baseline UX priorities

**Upstream proposal:** these priorities describe the original supervision phase. The autonomy phases later in this document use a separate priority scale.

| Priority | Recommendation | Expected benefit |
| --- | --- | --- |
| P0 | Render spawning and expose staffing/delivery waiting reasons | Waiting work never silently disappears |
| P1 | Task assignment and dispatch; selectable worktrees and changes | Human can start work from a task |
| P1 | Team overview with ownership and attention queue | Human can supervise multiple agents |
| P1 | Named, navigable messages and full thread history | Handoffs can be traced without searching chats |
| P2 | Explicit review/QA handoffs and structured results | Completion and acceptance become inspectable |
| P2 | Publish revision with notification and acknowledgement | Agents receive changing requirements deliberately |
| P2 | Reviewer staffing and worktree release policy | Developer-to-reviewer pipelines avoid hidden stalls |
| P3 | Dependencies, team configuration, and overnight summary | Larger workflows require less manual coordination |

Baseline P1 capabilities should ship as a coherent supervision flow. Baseline P2 adds workflow semantics and requires backend changes. The Plan core can begin as a bounded vertical MVP alongside this baseline; autonomous readiness requires the later P0 gates.

## Expected UI/UX

### 1. Team overview (recommendation)

Add a **Team** entry at repository level in the navigator. It opens a full workspace view independent of the selected chat. Place **Product Strategy** at product/repository level above **Plans | Tasks | Messages | Members**. Its main view leads with purpose, users, outcomes, use cases, boundaries, and What we know / assume / have not decided; saving drafts and human approval are separate actions. Existing chat-side task access remains a shortcut; Tasks also contains work outside Plans.

```text
+------------------------------------------------------------------------+
| Product Strategy    Team: Plans | Tasks | Messages | Members           |
+------------------------------------------------------------------------+
| Attention: human decisions | agent-owned waits | results for acceptance  |
+----------------------------+-------------------------------------------+
| Plans / executions         | Selected Plan / execution                 |
| Auth modernization Running | Intent / strategy / revision / validation |
| Export improvements Paused | Policy / changes / ownership / stages     |
| Standalone tasks           | Holds / budgets / checkpoints / candidates |
+----------------------------+-------------------------------------------+
```

Plan detail shows its pinned Product Strategy revision, a short alignment statement and report, intent, non-goals, implementation strategy, constraints, success criteria, published revision, validation, policy, and Changes. Show Alignment unassessed when no approved strategy exists; never fabricate historical bindings. Execution detail shows selected Changes, exact inputs, owners, stages, meaningful progress, budgets, holds, checkpoints, candidates, and previous attempts. Aggregate labels such as Executing and Paused refer to the selected execution, not a replacement for the Plan's definition lifecycle.

Primary actions are **Create Plan**, **Explore**, **Generate proposals**, **Validate**, **Review policy**, **Start**, **Pause affected work**, **Publish and notify**, **Continue**, **Adapt**, **Restart task/plan**, **Accept candidate**, and **Archive eligible changes**. Availability follows server gates; disabled actions explain the blocker.

Task rows show title, task status, workflow stage, accountable session or role, worktree, waiting reason, and next action. Allow filters for active, blocked, awaiting human, awaiting acceptance, group, and worktree. Closed tasks remain searchable, but are excluded from the default active list.

Keep Kawai's existing task statuses. Display workflow stages such as Implementing, In review, and Ready for QA separately; do not infer that a task is done from a finished agent turn.

The attention queue consolidates approvals/questions, uncertain deliveries, staffing waits, holds, stalls, and pending acceptance. Each item shows cause, owner, deadline, impact scope, and next action, and links to the relevant execution/card/task/message. Separate human-required items from agent-owned waits. Counts reconcile after reconnect and do not produce duplicate notifications.

On mobile, use list/detail navigation with an explicit Back action. Opening a chat preserves the task selection and filters. All actions have keyboard access, visible focus, accessible names, and text labels for states.

### 2. Create, assign, and dispatch work

**Create Plan** captures intent, success criteria, non-goals, implementation strategy, Changes, relation graph, risks, constraints, and proposed topology. Select the product and approved strategy revision when available; map intended outcomes/use cases and run Plan Alignment independently of technical validation. Human and Lead/Architect resolve mandatory questions before Ready. Research and draft generation can be automated without authorizing publication or implementation.

**Validate** produces a report for pinned inputs. **Start** previews pinned Product Strategy revision/hash and alignment decision (or explicit unassessed status), selected Changes, report revision/hash, baseline, worktrees/provisioning, topology, effective permissions, budgets, acceptance/archive policy, and unresolved questions. The server rechecks report identity and grants before recording a policy snapshot and execution. Later settings changes do not rewrite that snapshot; restrictive revocation still takes effect immediately. Worktree provisioning is a separate previewed, authorized, idempotent operation, never an implicit effect of sending mail.

The task form retains title, direction, acceptance, and optional parent. Replace raw worktree and OpenSpec inputs with searchable choices scoped to the team. Show paths and branches for worktrees; show valid change names and their location. Permit advanced manual entry only with the same server validation.

Offer **Create task** and **Create and assign**. Assignment chooses a group or specific session and an initial instruction. Explain that group dispatch selects one eligible member. Preview the target worktree, role, effective profile, approval policy, and whether staffing is available.

A task may bind to a Plan revision and Change; its assignment creates a separate Task Execution with pinned inputs. A created task starts as unassigned until dispatch succeeds. Record assignment history separately from participants: the accountable agent, requested role, and assignment state must remain visible. A queued group assignment has a requested role but no claimed agent yet.

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
- Waiting for auth-api@3 or a stage-specific dependency gate.
- Integration held by Architect; revision barrier unresolved.
- Checkpoint unconfirmed; pause waits for an approval or process stop.
- Execution safety policy denies the requested action.
- Reconciling an unknown operation; automatic retry unavailable.
- Repeated fix without progress; strategy decision required.

Reasons must come from authoritative routing/staffing state rather than guesses based on session badges. Multiple constraints may apply; display the immediate blocker and allow expansion for the others. Link named agents and worktrees. Re-evaluate the reason when capacity or availability changes.

Separate **delivery problems** from **development blockers**. Receiving a message confirms a durable receipt, not successful implementation. A task can be active while a review request waits for staffing.

### 4. Messages and threads

Show session names with role badges; preserve IDs in expandable metadata. Clicking a sender or participant opens its chat. Killed sessions retain their recorded identity and a clear unavailable label.

The team Messages view includes delivered history and pending mail, with filters for task, thread, role, session, priority, and delivery state. Task detail embeds the relevant subset. Thread detail shows chronological messages, reply relationships, current recipient, and delivery state; task context states the revision carried at delivery.

Add a human message composer with recipient, optional task, body, and priority. Default to normal priority. Explain that urgent direct mail interrupts after pending requests resolve, while urgent group mail waits for an idle member. A reply remains in its thread and keeps its task unless explicitly changed. Execution controls use typed commands bound to execution, assignment generation, and lease epoch; conversational text does not itself authorize a transition.

Uncertain deliveries keep **Retry to same recipient** and **Discard**. Explain possible duplication before retry. Do not allow reassignment of uncertain mail as if it were undelivered. Retain cancel/retry/discard history in the thread.

### 5. Results and review/QA handoffs

Add a Results section to task detail. A submitted result includes summary, commit or diff reference, worktree, tests performed and outcomes, known limitations, task revision, and submitting agent. Evidence references remain readable after the session is removed. Do not treat an agent's claim of passing tests as independently verified evidence.

Offer **Request review**, **Request QA**, and **Return for fixes**. Each creates an explicit handoff with requested role, instructions, result reference, and expected response. The receiving agent submits findings; the requester decides the next stage within its grants. Each attempt and result has a separate identity and pinned manifest. Preserve earlier results when fixes produce a newer result.

Use **Accept result** as a distinct human or creator action. It closes a task only under existing closing rights or a valid explicit delegation grant. A contributor can submit work but cannot close another creator's task without a closing grant. A parent task does not auto-close when its children finish. Show unresolved acceptance criteria and child work before closure; allow an explicit human override with a journaled reason.

A result for an older task revision is labeled **Needs re-evaluation** after direction changes. Review and QA findings should identify the result/commit examined so later commits do not silently inherit approval.

### 6. Worktree release and reviewer staffing

The current one-spawned-member-per-worktree cap counts live spawned sessions, including idle sessions and all roles. Make this visible immediately.

First provide **Release worktree and hand off**: after the developer finishes its turn, pending requests resolve, and the runtime verifies writer/background stop, archive that developer, preserve its result and transcript, and dispatch the review request. Show the transition and refuse release while an operation is still in flight.

For a later phase, consider separate writer and read-only review staffing policies. A declared read-only role is not an enforcement mechanism by itself. Permit overlapping reviewer staffing only once write restrictions and lifecycle rules can be enforced. Until then, retain explicit sequential release.

Manual sessions can also write concurrently and are not covered by the spawned-session cap. Show other live sessions in the worktree before dispatch; do not claim the existing cap prevents all concurrent edits.

### 7. Changing direction

Separate **Save Draft**, **Publish Revision**, and **Publish and Notify**. Draft edits may refresh metadata without publishing or interrupting work. An authorized Lead/Architect decides materiality, affected scope, recipients, and required response; the graph suggests impact but does not establish complete semantic coverage.

Before reconsidering affected work, establish an **Impact Hold** on its acceptance/integration/archive gates. Publication records an immutable revision, rationale, compatibility classification, affected assignments/results, and notification plan. Notify each affected executor through a direct envelope bound to its assignment; group mail remains one-member dispatch. Notification failures neither undo publication nor create another revision on retry.

Publication detail separates Queued, Delivered, Acknowledged revision, and Checkpointed/Paused. Receipt is not revision acknowledgement; acknowledgement is not a confirmed writer stop. Replacement sessions must acknowledge current inputs. Historical peer rows retain their original revision.

The human can pause affected work, inspect checkpoints, and choose Continue, Adapt, Restart, or Cancel. A revision barrier checks exact result inputs at submission and before integration/acceptance/archive. Earlier results remain visible as Needs re-evaluation; unrelated results remain reusable. Releasing holds requires an explicit scoped decision. Deadline expiry raises attention, never approval.

### 8. Compatibility

Use typed, scoped relations rather than treating parent/subtask hierarchy as a dependency graph. `consumes-contract` permits parallel work against a published contract; `requires` blocks a named stage; `conflicts-with` requires a decision or serialization; `supersedes` accounts for existing consumers/results. Prevent blocking cycles and identify semantic conflicts even in an acyclic graph.

Candidate detail shows the exact baseline, results, contract versions, combined tree, gate evidence, and unresolved findings. A conflict-free merge or local test pass is insufficient. Preserve previous successful candidates when a newer one fails.

### 9. Policy and configuration

Members/settings show role descriptions, membership, current task-creation rights, effective profile/approval policy, capacity, grants, and their sources. Start with read-only inspection of file-backed settings. Prompt changes affect future starts; they cannot elevate runtime permissions. A role need not be a separate session.

Plan policy displays budgets, allowed actions/environments, mandatory gates, independent review, and separate result/Candidate/Plan acceptance and archive rules. Acceptance modes are `human-required`, `delegated-with-gates`, or `automatic-with-gates`; autonomous acceptance/archive requires a bounded valid authorization. Human overrides record bypassed criteria and rationale without overriding safety or identity checks. Tool approval policy is not a substitute for execution safety policy. Show who granted an exception, its scope, expiry, and revocation state.

### 10. Progress and stalls

Show last meaningful progress: verified result, resolved finding, acknowledged contract, or successful candidate gate. Runtime health and activity are separate indicators. Tokens, messages, commits, turns, and checked OpenSpec tasks do not establish success.

Stage-specific deadlines, recurring failures, missing evidence, and queue state inform stall detection. Capacity, approval, and rate-limit waits are named causes rather than agent failures. The Lead receives attempt/checkpoint history and chooses investigation, smaller scope, another profile/executor, serialization, or escalation within budgets. Switching provider does not reset findings or permissions.

### 11. Partial completion and morning summary

Group outcomes by Plan and exact Candidate: implemented, verified, integrated, accepted, archived, blocked, deferred, or failed. Avoid an unexplained percentage. Show dependency closure, fulfilled criteria, remaining impact, accepting actor/grant, and the next decision.

An independent subset can be accepted/archived when policy and relation closure permit it; accepted specs must match its selected commits. If blocked work is essential to intent, a partial Finished execution leaves the Plan partially fulfilled/NeedsAttention. Reducing scope requires a new revision; preserve the original promise. Final human acceptance is the default. Ordinary acceptance cannot override safety denial, invalid input identity, or cross-team isolation. Production release is a separate optional stage.

## Durable Plan and execution model

**Recommendation:** these objects extend current task/mail durability. ProductStrategy and immutable StrategyRevision are product-direction references, not orchestration attempts; [strategy bindings](product-strategy.md#data-model-and-revision-policy) pin direction without expanding authority. Additive migrations retain standalone tasks without inventing historical execution records.

| Object | Minimum identity and content |
| --- | --- |
| Plan | id, teamId, optional productId, title, currentRevision, lifecycle, owner, createdAt; durable intent container |
| PlanRevision | planId/revision, optional PlanStrategyBinding, intent, successCriteria, nonGoals, implementationStrategy, changeRefs, relationGraph, riskRegister, policyRef, topologyProposal, author, contentHash; published content immutable |
| ChangeBinding | planId/changeId, adapter, canonicalArtifactRef and revision/hash, worktreeRef, ownership; OpenSpec optional |
| Task | Existing fields plus optional planId/changeId, Plan revision binding, stage, accountableOwner, assignmentGeneration |
| PlanExecution | id, planId, initialRevision/revisionHistory, selectedChanges, baselineCommit, policySnapshot, status, timestamps, budget, outcome |
| TaskExecution | id, optional planExecutionId for standalone work, taskId/revision, attemptNo, assignmentId, agentSessionId, inputManifest, leaseEpoch, status, checkpointRef, outputResultId, timestamps |
| ContractRevision | contractId/revision, immutableRef/hash, schemaVersion, producers/consumers, compatibilityRules, publicationDecisionId |
| ValidationReport | id, inputHash, planRevision, optional pinned strategyBinding/alignmentReportRef, baselineCommit, adapterVersion, checks/findings/questions, decision; invalidated by input changes |
| Result | id, executionId, commit/treeHash, inputManifest, summary, evidenceRefs, limitations, optional supersedesResultId |
| IntegrationCandidate | id, baselineCommit, includedResults, contractSet, mergedTree/commit, validationEvidence, status, optional supersedesCandidateId |
| Decision / Event | Rationale and immutable actor/transition history; corrections append new records |

Start with exclusive active ownership of a canonical Change revision. Multiple Plan bindings require coordinated ownership; refuse conflicting concurrent executions without a shared coordinator. One active execution per Plan is the default. Explicit sandbox experiments may run in parallel but cannot publish the shared result.

```yaml
planId: authentication-modernization
planRevision: 3
productStrategy: { id: kawai-direction, revision: 2, hash: <sha256> }
planExecutionId: pe-002
baselineCommit: <git-sha>
policyRevision: 2
taskId: admin-ui
taskRevision: 4
taskExecutionId: te-007
changeArtifacts:
  admin-panel: { revision: 2, hash: <sha256> }
contracts:
  auth-api: { revision: 3, hash: <sha256> }
decisions: [adr-014, adr-018]
leaseEpoch: 9
```

Pin retrievable snapshots, not mutable latest references. Context includes intent, strategy, criteria, constraints, decisions, contracts, checkpoint, and findings. Full context remains available by reference; compaction/model handoff preserves mandatory restrictions and identities.

| Dimension | Proposed lifecycle |
| --- | --- |
| Plan definition | Draft → Validating → Ready → Completed → Accepted; NeedsAttention and Cancelled explicit |
| Plan Execution | Preparing → Running → Pausing → Paused → Running → Evaluating → Finished; Recovering, NeedsAttention, Cancelled explicit; outcome success/partial/failed |
| Task Execution | Queued → Claimed → Running → Checkpointing → Paused → Running → Submitted → Finished; Blocked, Recovering, Failed, Superseded, Cancelled explicit |
| Workflow stage | Explore / Propose / Implement / Review / QA / Integrate / Accept / Archive; separate from Task and session statuses |

Editing Ready content creates a Draft revision. Completed records fulfillment against a published revision; Accepted records the policy-governed acceptance decision. Finishing an attempt is neither state. An extension with unchanged intent creates the next revision of the same Plan. Continue resumes the same attempt from a safe checkpoint; Adapt records authorized new inputs within it; Restart Task/Plan creates a new attempt linked to history. Selected verified results may be reused only after current gates pass. Implementation strategy/dependency changes require affected-scope revalidation and an overall consistency check.

## OpenSpec adapter and lifecycle

**Current:** OpenSpec watchers refresh metadata and use canonical worktree discovery; they do not authorize execution. **Recommendation:** preserve that display behavior and add a version/capability-aware adapter. Explore/Propose/Apply/Verify/Sync/Archive here describe target operations, not assumed CLI command names. Inspect installed version, schema, supported operations, and artifact paths; pin adapter capabilities in execution/validation inputs. Missing operations block their gate, never produce fabricated success.

| Operation | Actor and gate |
| --- | --- |
| Explore | Human + Lead/Architect by default; automated research allowed by policy; unclear intent becomes a question |
| Propose | Lead/Architect prepares interactive or automated drafts; publication requires its own authority |
| Apply | Developer/runtime after Ready, fresh validation, and authorized policy snapshot |
| Review / Verify / QA | Independent roles/tools against an exact Result/Candidate under risk policy |
| Spec synchronization | Architect/Integrator, accepted compatible result, serialized overlapping spec hashes |
| Archive | Runtime adapter after quality/acceptance gates, matching specs, no holds/overlaps, valid archive authorization |

Apply may return to Explore/Propose through controlled revision work. Automated research/drafts do not imply Apply authorization. Archive is distinct from merge, human acceptance, and deployment. For partial outcomes archive only accepted independent Changes. Watcher refresh never publishes contracts, grants approval, sends execution notifications, or interrupts agents. Adapter upgrades during an attempt require an explicit compatibility decision/revalidation rather than silently replacing capabilities.

## Validate Plan

**Recommendation:** validate a consistent snapshot before Start. Separate mechanical checks from architectural assessment; LLM confidence cannot replace builds, schema checks, or test evidence.

| Check | Required scope |
| --- | --- |
| Product alignment | Pinned approved strategy/hash, outcome/use-case mapping, explicit alignment decision, constraints/non-goals, required experiments or unassessed status |
| Intent and implementation strategy | Observable criteria, non-goals, ambiguities, trade-offs, rationale/alternatives, migrations, backwards compatibility, coherent partial delivery |
| Scope and relations | Requirement-to-task/evidence mapping, duplicates/owners, blocking cycles, stage gates, semantic conflicts across API/schema/UI/config/specs |
| Contracts | Producers/consumers, versions/compatibility, available immutable snapshots, publication order |
| Readiness | Baseline/worktrees/provisioning, permissions/capacity/budgets, adapter/runtime capability, review/QA/integration environments |
| Delivery and recovery | Acceptance/merge/archive/deploy boundaries, partial policy, stop conditions, recovery |

Relations include type and scope: UI consumes auth-api@3, admin E2E requires a verified backend result at integration, legacy/token authentication conflicts within users-schema, and token authentication supersedes legacy with explicit consumer treatment. API/frontend may run in parallel against a published contract while migration blocks integration; conflicting schema Changes prevent Ready even without a graph cycle.

The report separates blocking errors, warnings, mandatory questions, evidence, and decisions. Resolve blockers/questions before Ready; warning acceptance requires authorized rationale. Changes to strategy binding/alignment decisions, scope, contract hash, baseline, policy, or adapter invalidate relevant checks. Strategy publication opens an explicit impact review; it does not silently rebind Plans or interrupt executions. Affected binding changes follow Plan revision/hold/notification protocols. Existing Plans using a superseded strategy require a recorded impact disposition at the next Validate/Start; historical records retain the original pin. Start compares inputHash and current identities atomically to reject a Validate/Start race.

## Authority and execution safety

**Current:** creator permissions and group task-creation settings do not grant an Architect authority over human-created tasks. **Recommendation:** server-enforced, revocable grants contain subject, scope, actions, validUntil, policyRevision, and grantedBy. Without a grant, an agent proposes and the human/creator applies. Organization/operator ceilings outrank Plan policy; prompts, repository content, or peer mail cannot elevate authority.

| Role | Responsibility and boundary |
| --- | --- |
| Human | Product direction/strategy approval, intent, constraints, delegation, acceptance policy; revoke grants and stop external actions |
| Lead | Decomposition, topology, owners, budgets, queues, escalation; cannot change intent/safety without authority |
| Architect | Contracts, cross-change decisions, impact, publication; silence never acknowledges a revision |
| Developer | Implementation/checkpoints/results and proposals; cannot publish canonical contracts independently |
| Reviewer / QA | Independent result-specific findings/evidence; cannot approve a different commit implicitly |
| Integrator | Reproducible candidates and incompatibility localization; semantic decisions return to Architect/owners |
| Runtime | Authorize tools, enforce transitions/gates/leases, reconcile effects; enforcement is not delegated to a prompt |

Enforce filesystem roots, Git/protected-branch actions, network destinations, secret scopes, database environments, commands/background processes, external APIs/spending, infrastructure, and destructive operations at tool/runtime boundaries. Project policy may narrow the ceiling, never expand it. Approval binds action/resource/environment/validity; staging approval does not authorize production. Auto tool approval and provider changes cannot override safety.

Sandbox/test data are the default. Apply does not imply release, deletion, irreversible migration, or production access. Denials are actionable/audited and cannot be evaded through another tool. Revocation blocks new actions and triggers inspection/containment of in-flight operations, preserving uncertainty where cancellation cannot be proven. Independent review/acceptance applies to risky work even if roles share a session elsewhere.

## Publication, holds, and checkpoint protocol

**Recommendation:** publish immutable snapshots with rationale, affected scope, compatibility classification, recipient response requirements, and a transactional notification outbox. A takeover assignment acknowledges current inputs. An Impact Hold has owner, rationale, scope, createdAt, and review deadline; expire to attention, not automatic release. Use a temporary whole-Plan hold when impact is unknown, then narrow it deliberately.

1. Record decision/scope and establish the hold before notification; stop scheduling new affected work.
2. Issue typed PauseRequested commands with stable ID, Task Execution, assignment generation, and lease epoch.
3. Request safe stop. Pending cards remain unresolved until answered; current urgent-direct semantics wait. Display Pausing and its cause, never a false Paused state.
4. Save a durable checkpoint: commit or stored patch including untracked files, baseline, manifest, unfinished actions, errors/tests, and next steps. A mutable current diff is insufficient.
5. Reconcile writer/background process stop or isolation, then acknowledge checkpoint and record Paused. Deadline expiry revokes lease, blocks publication, and escalates; forced termination follows policy and retains side-effect uncertainty.
6. Choose Continue with unchanged inputs, Adapt with retained-work/new-input decisions, Restart as a new attempt, or Cancel with reasons. Lost checkpoints or reimplementation/replacement after checkpoint loss require a new task attempt.
7. Revalidate affected relations and overall consistency, acknowledge new inputs, and issue a new fenced lease epoch before writes.
8. Re-evaluate affected results and release holds by scope; exceptions require explicit decisions.

Revision and checkpoint acknowledgement are independent. A stopped process without a checkpoint is not safely continuable. A replacement session receives an immutable handoff package; do not assume an SDK conversation can relocate across working directories. Barriers run at submission and immediately before integration/acceptance/archive; late old writers cannot pass. Compatibility of an older result requires a documented decision with new evidence.

## Worktrees and contract snapshots

**Recommendation:** independent writers use distinct worktrees and pinned baselines. Explicit Plan Execution provisioning validates team identity, baseline, permissions, capacity, disk budget, and dirty/untracked data; creation is idempotent and cleanup preserves retained results/checkpoints. Never provision through an incidental message.

A Contract Registry publishes immutable Git trees/commits, packages, or content-addressed snapshots with producers/consumers and retention. Drafts stay local. Preserve OpenSpec canonical-worktree discovery for display while pinning hashes for execution and warning about divergence. Shared mutable spec directories cannot silently replace inputs; new contracts require publication, selected notifications, and barriers.

Writer leases cover all managed writes and background tools, not just spawned sessions. Fence stale epochs at submission/promotion/archive and enforce tool access. Manual/external writers require detection/isolation; where guarantees are incomplete, disclose the limitation and refuse unsafe parallel operations. Keep sequential developer/reviewer/QA release until enforceable read-only review exists; reviewers may inspect separate immutable copies, but a role declaration alone is not a sandbox.

## Review, QA, and incremental integration

**Recommendation:** use Implement → Result → Review → Fix → New Result → QA → Fix → New Result → Candidate. Findings record severity, result/commit, violated criterion, reproduction/evidence, owner, and resolution. Respond to every blocking finding. New commits require new checks or an explicit scope decision; prior approval does not transfer automatically. Independent QA records actual logs/exit codes and reproducible scenarios; an agent claim is not verification.

Bound loops by attempts/time/cost. Repeated identical failures without new evidence trigger strategy review; exhaustion leaves work incomplete, never Accepted. Start topology from risk/scope: one developer for a small fix, developer/reviewer for a feature, contract work plus parallel writers for API/UI, lead/specialists/incremental integration for 5–10 Changes, or researchers followed by synthesis. Adapt with recorded rationale and hard caps; optimize costs only after mandatory gates exist.

Build exact Integration Candidates in a separate environment with baseline, included Result commits, contracts, combined tree/commit, and evidence. Preserve the previous successful candidate and integrate small compatible increments. Gates require current inputs/no holds, reproducible merge/build, combined unit/integration/risk regression, API/schema/config/UI and sandbox migration compatibility, aligned spec deltas, and resolved blockers.

Textual merge success is insufficient: separately passing auth/admin/audit Changes may disagree on user IDs or permissions. Failed candidates retain evidence; route corrections to owners and architectural changes to Architect, preserving unaffected results. Before target-branch promotion recheck head and all gates; a stale baseline requires a new candidate. Earlier tree evidence cannot approve a new tree. Acceptance, merge, archive, and deployment are separate authorized operations.

## Durable recovery and idempotency

**Recommendation:** extend durability to attempts, grants/leases, commands, checkpoints, candidates, and external operations. Use transactional state plus append-only audit and outbox; full event sourcing is optional. Events identify eventId, aggregateId/sequence, actor/time, type, causation/correlation/request IDs, expectedRevision, and payloadRef. Never store secrets or full sensitive payloads; retention/access policy applies. Add backups and versioned schema migrations.

Create/start/publish/dispatch/pause/accept/archive commands use unique idempotency keys. Same key/payload returns prior outcome; different payload is rejected. CAS/expectedRevision prevents competing amendments/starts. State and outbox writes are atomic; duplicate envelopes/commands are deduplicated logically. Mail receipts do not establish exactly-once side effects.

Leases have owner/expiry/epoch. Recovery enters Recovering, reconciles processes, worktrees, checkpoints, durable receipts, candidate commits, and actual external outcomes before scheduling. A busy UI or live process is not proof of a valid assignment; revoked writers cannot submit/promote/archive.

| Failure point | Recovery |
| --- | --- |
| Task exists; dispatch absent | Retain task/draft, retry same assignment identity |
| Publication durable; notification absent | Outbox resumes same envelope IDs |
| Pause sent; acknowledgement absent | Reconcile checkpoint/process/lease; no blind resume or false Paused |
| Result durable; QA handoff absent | Complete next transition once |
| Candidate created; promotion record absent | Inspect operation/ref state; never blindly merge twice |
| Archive interrupted during spec changes | Reconcile artifact/spec hashes; resume or safely roll back the local transaction |
| External API outcome unknown | Service idempotency/prepare-commit/operation inspection; otherwise NeedsAttention, no blind retry |

## Development scenarios

| Scenario | Human flow | Agent flow | Expected outcome |
| --- | --- | --- | --- |
| Bounded feature | Create and assign export task; inspect result; accept | Lead or developer receives task, implements, journals, submits result | One clear owner and an inspectable completion |
| Parallel feature | Parent task with API/UI subtasks in separate worktrees | Lead dispatches separately; agents agree on contract; integrator combines results | Independent execution with visible dependencies and integration task |
| Review pipeline | Inspect developer result; release worktree; request review and QA | Reviewer reports findings; developer fixes; QA examines latest result | Traceable handoffs with result-specific acceptance |
| Investigation | Create separate investigation subtasks; assign each; request synthesis | Investigators publish findings; lead synthesizes and proposes implementation | Fan-out is explicit; group dispatch is never mistaken for broadcast |
| Scope correction | Establish hold, publish and notify chosen assignments; inspect acknowledgements/checkpoints | Agents acknowledge latest revision and report obsolete work | No silent assumption that a saved revision redirected ongoing work |
| Overnight run | Agree a 5–10 Change Plan, validate, authorize Start, return to execution summary | Runtime enforces policy/leases; lead adapts within grants; tools verify incremental candidates | Verified success, dependency-closed partial delivery, or explicit human decisions |

## End-to-end testing plan

Use Playwright with isolated databases, temporary repository/worktree fixtures, isolated tmux state, and deterministic SDK-free agents. Extend existing [team browser coverage](../tests/e2e/chat-teams.spec.ts). Fake agents should expose controllable idle, busy, pending approval, receipt, startup failure, acknowledgement, and result events.

Exercise real WebSocket subscriptions and routing against the isolated backend. Do not seed away the operation being tested: create, assign, notify, and hand off through UI controls. Seed only prerequisite identities or exceptional recovery states. Browser fixtures cannot prove real CLI receipt handling or SDK interruption; retain server integration coverage and add a small isolated real-CLI smoke suite where credentials are available.

Use semantic selectors, deterministic clocks, fault injection, and observable state transitions instead of fixed sleeps. Capture screenshots for team overview, waiting details, thread recovery, handoff/results, and mobile detail. Verify DOM state, keyboard behavior, persistence, and server records; screenshots supplement assertions.

**Upstream proposal:** E01–E14 retain baseline coverage; their P-labels refer to baseline UX priorities. Publication terminology and dependency scope now follow the recommended model.

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

Amend a task while its developer is busy. Ordinary Save Draft must not publish or show acknowledgement. Use Publish and notify; assert revision increments once, historical peer context remains unchanged, and notification carries the latest revision. Delay acknowledgement and assert separate delivered/acknowledged states. Fail notification and retry without creating another revision.

**Coverage (task-revision-publication):** headless in `src/server/__tests__/taskRevisionE09.integration.test.ts` (busy fixture developer through the real dispatcher: draft writes nothing, publish-and-notify increments once and its notice is delivered after the turn with the latest revision while the instruction's peer row keeps revision 1, delivered ≠ acknowledged until `task_acknowledge`, dead-lettered notice retried with no new revision, reassignment starts unacknowledged); in the browser by `tests/e2e/chat-task-revision.spec.ts` (draft, publish, notify, retry through the UI — the fixture confirms no receipts, so there a notice settles Uncertain and is failed through the Mailbox's Discard before **Retry notification**).

### E10 — Results, acceptance, and permissions (P2)

Have a contributor without a closing grant submit a result for a human-created task. Assert the task stays open/active until human acceptance and the contributor cannot close it. Accept as human, then reopen. Amend after an earlier result and assert Needs re-evaluation. A completed child must not silently close its parent.

### E11 — Recovery and possible duplicates (P1)

Seed uncertain receipt, dead mail, and scheduled mail. Assert clear reasons and available actions. Retry uncertain mail to the same recipient with a possible-duplicate notice; assert no reassignment. Restart the isolated server and verify tasks, revisions, journal, assignments, and pending mail survive. Never display receipt confirmation as accepted development work.

### E12 — Dependencies and scope propagation (P3)

Block UI integration on API acceptance. Assert the integration stage cannot dispatch prematurely, becomes eligible after acceptance, and cycles are refused; independent implementation may start before that gate. Reopen/amend the API task; assert downstream results are flagged for review and no automatic duplicate integration work starts.

### E13 — Overnight summary (P3)

Prepare completed results, capacity waits, approvals, uncertain deliveries, and an agent with a finished turn but no result. Assert each appears in the correct category; the last is not counted as a completed feature. Resolve items and reconnect; assert counts converge and toasts do not duplicate.

### E14 — Mobile, keyboard, and team isolation (P1)

At a narrow viewport, create a task, navigate list/detail/chat/back, and assert drafts and selection survive. Use keyboard-only controls to assign and inspect attention. Verify labels, focus restoration, and text state indicators. Open a second repository and assert tasks, recipients, messages, attention counts, and worktree choices remain team-scoped; cross-team actions are refused server-side.

## Additional autonomous-execution acceptance tests

**Recommendation:** R01–R24 use independent identifiers and the same isolated UI/backend harness. Server integration tests establish enforcement and durability; browser tests establish understandable actions/state. Small isolated real-CLI smoke tests cover interruption, process containment, and receipts that fixtures cannot prove.

| ID / phase | Given / When | Required outcome |
| --- | --- | --- |
| R01 P0 — Durable Plan | Five Changes and a paused execution; restart server | Same Plan/revision/attempt/checkpoints/history; Continue creates no new attempt |
| R02 P0 — Restart | Failed task; Restart Task then Restart Plan | New IDs link old attempts; retain results; no duplicate closure/archive |
| R03 P0 — Intent validation | Ten Changes with ambiguous migration strategy | Mandatory question blocks Start; human decision/report retained |
| R04 P0 — Semantic compatibility | Acyclic graph with conflicting schema Changes | Conflict prevents Ready; agreed serialization/contract resolves it |
| R05 P0 — Contract parallelism | UI consumes published API; E2E requires backend | UI starts; E2E integration gate waits for verified backend |
| R06 P0 — Validation race | Contract/baseline changes after ready report | Server rejects stale inputHash; revalidation required |
| R07 P0 — Draft isolation | Architect repeatedly edits draft | Metadata may refresh; no publication/mail/interruption |
| R08 P0 — Targeted publication | Two of three assignments affected | Two direct envelopes; third continues; group mail not broadcast |
| R09 P0 — Acknowledgement | Delivered envelope without revision acknowledgement | Delivered only; affected revision barrier remains closed |
| R10 P0 — Result under hold | v1 result arrives before v2 publication | Preserve result; acceptance/integration/archive blocked pending decision |
| R11 P0 — Pause and approval | Pending approval receives pause request | Card not approved automatically; Pausing explains wait; durable checkpoint required |
| R12 P0 — Late writer | Revoked epoch submits/promotes | Refuse transition, preserve submitted data, authorize only current writer |
| R13 P0 — Adapt | v1 checkpoint partly compatible with v2 | Record retained work/new inputs; acknowledge; keep v1 history |
| R14 P0 — Fix loop | QA rejects A; fixes yield B | Findings bound to A; B checked anew; no silent approval transfer |
| R15 P0 — Integration conflict | Three individually passing results incompatible together | Candidate fails; correction tasks; no merge/archive |
| R16 P0 — Incremental candidates | Two ready Changes while others run | C1 verified; C2 pins exact set; C1 evidence does not approve C2 |
| R17 P0 — Publication crash | Commit transaction before outbox send; crash | Resume/deduplicate envelopes; command retry creates no revision |
| R18 P0 — Pause crash | Pause request durable; acknowledgement absent; crash | Reconcile writer/checkpoint; no blind resume/false Paused |
| R19 P0 — Unknown effect | External API acts; response lost | Reconcile operation ID or NeedsAttention; no duplicated effect |
| R20 P0 — Runtime safety | Forbidden secret/production access or prompt-based escalation | Deny/audit at runtime; unaffected sandbox work continues |
| R21 P1 — Stall | Three identical failures without new evidence | Alert Lead; bounded attempts and strategy decision; no false completion |
| R22 P1 — Partial success | Seven ready, three blocked including prerequisite | Accept dependency-closed subset only; blockers not archived; intent not falsely fulfilled |
| R23 P1 — Acceptance | Human-required/delegated policies; author attempts acceptance | Valid grants/gates/independence enforced; human-required stays human-only |
| R24 P1 — UX/isolation | Mobile/reconnect, deleted session, second repository | Drafts/focus/history retained, counts reconcile, cross-team references/commands refused |

Fault matrix for R17–R19 covers before/after writes, sends, receipts, checkpoints, candidate creation, merge, and archive. Also test duplicate commands, competing Start/amend, changed payload under same key, expired/revoked grants and leases, provider takeover without budget reset, unknown/changed adapter capabilities, untracked checkpoint files, dirty-worktree cleanup, hold deadline expiry, and overlapping spec synchronization. Test subprocess/background-tool bypass attempts and in-flight revocation, not merely disabled buttons. Capture desktop/mobile screenshots and conduct a real bounded workflow walkthrough.

## Delivery phases and release gates

**Recommendation:** autonomy P0/P1/P2 below are independent of the upstream baseline priority table. P0 establishes minimum trusted-autonomy invariants; it does not require every later UI capability first.

| Phase | Scope | Completion criterion |
| --- | --- | --- |
| Strategy documentation | Human-reviewed template and pinned references; no new execution layer | Purpose/users/outcomes and unknown evidence explicit; no fabricated product direction |
| Baseline UX | Visible states/waits, dispatch/owner, Team/Messages, results, sequential handoff; E01–E14 | Human assigns/follows/accepts work without raw IDs; standalone tasks remain usable |
| P0 Durable Plan core | Plans/revisions/attempts/manifests/policy snapshots/grants/CAS/idempotency/outbox | Start/restart/reconnect retain unambiguous identity and permissions |
| P0 Revision control | Publication, targeted notifications, holds/checkpoints/fencing/barriers | Stale or in-flight work cannot pass gates accidentally |
| P0 Validation/integration | Typed relations, intent/strategy reports, exact candidates, bounded QA/fix loops | Combined incompatibilities detected before acceptance |
| P0 Recovery/safety | Runtime tool enforcement, reconciliation, budgets, audit | Crash/retry cannot duplicate hazardous effects or elevate permissions |
| P1 Supervision | Plan UI/attention/meaningful progress/stalls/partial acceptance | Overnight work explained through specific decisions |
| P2 Efficiency | Adaptive topology/profile use/selective regression/metrics | Lower cost without weakened gates |

Start with one Plan, 2–3 Changes, one writer per worktree, automated QA/Candidate checks, and manual final acceptance. Expand to 5–10 Changes and bounded autonomous archive only after enabled-capability R01–R20 and applicable E-tests pass. R21–R24 plus a real desktop/mobile walkthrough are required before claiming complete overnight execution. Production deployment is excluded from the MVP.

Product Strategy delivery begins with documentation/manual approval, then guided discovery/synthesis, Plan alignment, explicit revision-impact review, and evidence-driven learning as specified in the [strategy implementation sequence](product-strategy.md#implementation-sequence). Strategy is not a prerequisite for every small task. Recommended future OpenSpec Changes: `product-strategy`, `durable-plans`, `revision-control`, `integration-candidates`, `execution-safety-recovery`, and `plan-supervision`. Agree shared schemas/contracts before parallel implementation. This document does not create these Changes or implement their capabilities. Migrate additively, preserve task/mail receipt recovery, and preserve creator rights until explicit grants exist.

## Metrics and decisions before implementation

Track alignment decision quality and strategy learning without treating activity as product value. Measure time to first verified candidate, blocker localization, navigation to resolve attention, stale-result rejection, recovery success, duplicate effects, fix iterations, cost per accepted Change, partial outcomes, and false stall alerts. Establish baselines; agent/message counts are not quality objectives.

| Decision | Proposed starting point / question to resolve |
| --- | --- |
| Plan storage/export | Durable runtime authority with versioned review exports; agent-writable files cannot bypass grants. Decide SQLite/Git/hybrid export mechanics. |
| Multi-Plan Change ownership | Exclusive active canonical ownership initially; define coordinated ownership before concurrency. |
| Material revisions/compatibility | Explicit decision schema and authorized decider; new evidence required for older results. |
| Contract retention | Choose immutable artifact store and retention preserving replay after worktree deletion. |
| Writer/background enforcement | Validate each CLI/runtime capability; sequential operation and accurate limits until isolation works. |
| Continue versus restart | Continue safe checkpoint; new task attempt for checkpoint loss/reimplementation; controlled handoff may preserve Plan attempt. |
| Acceptance/archive delegation | Human final acceptance by default; define risk classes, grants, and independence rules. |
| OpenSpec canonical copies | Preserve discovery display; define registry pinning, divergence, and serial overlapping spec sync. |
| Delivery boundary | Local candidates/PR-ready work first; merge and production release separate permissions. |
| Loops/deadlines/budgets | Configure by stage/risk; timeouts and silence never approve. |
| Revocation | Define containment of in-flight effects and uncertainty reconciliation per tool/provider. |
| Adapter versions/upgrades | Explicit supported versions/schemas/capabilities and revalidation on change. |
