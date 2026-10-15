# Spec Delta

## Purpose

Give the human a repository-level workspace for designing plans and understanding their execution through dependencies, OpenSpec work breakdowns, supporting documents, and existing planning and coordination chats.

## ADDED Requirements

### Requirement: Plans have a dependency-oriented workspace
The repository's Plans tab SHALL offer plan selection, an expandable work breakdown, a dependency map, a document reader, and an optional conversation panel. Dependencies SHALL determine sequence; independent changes SHALL be visibly parallel. Position and size SHALL NOT imply dates, estimates, or duration.

#### Scenario: Parallel branches converge
- **WHEN** changes A and B have no prerequisites and C depends on both
- **THEN** A and B appear as parallel work preceding C, with both dependency edges shown

#### Scenario: Repository without a plan
- **WHEN** Plans opens for a repository with no plan records
- **THEN** it shows an empty state and access to the Architect conversation for planning without inventing a plan or starting execution

### Requirement: The displayed plan version is explicit
The workspace SHALL identify the displayed approved revision, proposed revision, or draft and separately identify any selected execution and its pinned revision. Switching the displayed version SHALL NOT modify running work. Changes outside the displayed version SHALL remain discoverable separately when linked execution work exists.

#### Scenario: Planning during execution
- **WHEN** execution follows revision 2 while the human inspects proposed revision 3
- **THEN** both identities are visible, outcomes are attributed to their execution revision, and viewing revision 3 changes no execution inputs

### Requirement: OpenSpec checklists expand beneath changes
Expanding a change SHALL show headings and task checkboxes from its canonical tasks artifact, preserving order and checked state. Checklists SHALL be read-only in this view. Missing, unsupported, or unreadable artifacts SHALL have explicit states rather than fabricated items or zero completion.

#### Scenario: Expand work breakdown
- **WHEN** tasks.md contains two sections with checked and unchecked task items
- **THEN** expanding the change shows those sections and items in source order with their checked states and document links

#### Scenario: External update
- **WHEN** the canonical tasks artifact changes externally
- **THEN** the workspace refreshes its checklist without a page reload and retains valid change selection

### Requirement: Checklist completion and execution outcomes stay distinct
The workspace SHALL label task-checkbox counts separately from authoritative execution outcomes and stages. Checkbox completion, agent idleness, and turn completion SHALL NOT establish review success, landing, or plan completion. Plan summaries SHALL use execution outcome counts rather than a fabricated overall completion percentage.

#### Scenario: All boxes checked before review
- **WHEN** a change has 12 of 12 task boxes checked and its execution is in review
- **THEN** it shows both facts and does not label the change landed

### Requirement: Assignments are shown at change level
Each change SHALL show its linked work's actual assignment holders and requested groups, stages, and waiting causes. An unclaimed assignment SHALL show its group without claiming an agent owns it. Multiple holders SHALL remain distinguishable. Checklist items SHALL NOT have individual assignments in this version.

#### Scenario: Group assignment awaits staffing
- **WHEN** a change's instruction targets Developers and has no claimant
- **THEN** the change shows Developers, an unclaimed state, and the available waiting reason with no invented agent

#### Scenario: Review handoff
- **WHEN** the outstanding assignment passes from an implementer to a reviewer
- **THEN** the current holder shows the reviewer and previous participation remains inspectable without appearing as current ownership

### Requirement: Agent health is compact and explainable
Assigned agents SHALL have an accessible green, yellow, red, or unknown indicator summarizing known context pressure and profile quota. Inspection SHALL distinguish the two readings and expose available token counts, threshold approximation, quota source, measurement times, and reset times. Unknown or stale readings SHALL NOT imply available capacity.

#### Scenario: Shared quota constraint
- **WHEN** two assigned agents share a profile reporting a current limited status
- **THEN** both show the quota constraint and inspection explains that the reading is shared by profile

#### Scenario: Incomplete telemetry
- **WHEN** an agent has a fresh low context reading and no applicable quota reading
- **THEN** inspection identifies quota as unknown and the combined indicator does not claim all capacity is healthy

#### Scenario: Stale measurements
- **WHEN** a reading exceeds the workspace's documented freshness interval or its quota reset has passed without a replacement
- **THEN** it is marked stale and cannot establish a green indicator

### Requirement: Health observation does not start workers
Opening the workspace or inspecting assigned-agent health SHALL read already available telemetry without attaching to worker chats, starting or restoring their agents, sending prompts, or initiating new provider polling. Opening the selected Architect or Lead conversation SHALL retain ordinary chat attachment behavior.

#### Scenario: Worker has no running process
- **WHEN** Plans opens with a linked worker whose process is stopped
- **THEN** its available readings are shown with their freshness and its process remains stopped

### Requirement: Plan documents render with provenance
The reader SHALL render a selected change's available OpenSpec artifacts and associated supporting Markdown and image documents. It SHALL show the source worktree/path, current-file identity, and whether it matches a selected execution's artifact pin when known. Missing or changed files SHALL NOT be presented as exact historical execution inputs.

#### Scenario: Design changed since execution began
- **WHEN** the current design file differs from the selected execution's recorded artifact identity
- **THEN** the reader labels it as current content differing from that execution's input

#### Scenario: Canonical worktree lacks an artifact
- **WHEN** a change's canonical worktree exists but lacks design.md
- **THEN** the reader shows the missing state rather than silently substituting the main checkout's copy

### Requirement: Supporting document associations are durable
The human SHALL be able to add and remove labelled document references at plan or change scope. Supported local references SHALL identify a repository worktree and relative path; external references SHALL be explicit links. Associations SHALL survive restart and SHALL NOT modify source files or plan approval. Broken references SHALL remain visible as broken until removed.

#### Scenario: Attach architecture and mockup
- **WHEN** the human associates architecture.md with a plan and a PNG mockup with one change
- **THEN** each is available at its respective scope after restart

### Requirement: Document reading respects repository boundaries
Document and asset reads SHALL be scoped to the selected repository's known worktrees and supported file types with bounded size. Traversal and symlink escapes SHALL be refused. Raw HTML and executable mockups SHALL NOT run; external references SHALL open as links rather than being fetched or embedded by the server.

#### Scenario: Relative image in Markdown
- **WHEN** a supported Markdown document references a supported image within the same permitted worktree
- **THEN** the image renders through the same scoped reader and relative document links navigate within it

#### Scenario: Reference escapes the worktree
- **WHEN** a document or image reference resolves outside its permitted worktree through traversal or a symlink
- **THEN** the read is refused without exposing the target file

### Requirement: Architect and Lead reuse distinct repository chat sessions
Each repository SHALL hold durable bindings for Architect and Team Lead to two distinct same-team chat sessions shared across plans. The human SHALL choose the existing coordination chat for Lead and SHALL be able to select or create an ordinary chat for an empty role. Binding or opening Plans SHALL NOT automatically create or replace a session or grant tools or rights.

#### Scenario: Reuse the coordination session
- **WHEN** the human binds the existing Team Lead chat and opens two different plans
- **THEN** both use that chat's same identity, history, tools, and approval policy

#### Scenario: Separate Architect
- **WHEN** the Lead chat is already bound and the human selects it for Architect
- **THEN** the duplicate binding is refused and the existing bindings remain intact

#### Scenario: Binding is unavailable
- **WHEN** a bound chat is archived or killed
- **THEN** the panel shows its read-only history or unavailable state respectively and offers ordinary restore or explicit replacement without silently starting another session

### Requirement: The conversation panel preserves ordinary chat behavior
The panel SHALL switch between Architect and Lead conversations and open the same conversation full-screen. Streaming, questions, tool approvals, interruption, drafts, background work, slash commands, and archive/restore SHALL keep their existing behavior. Switching role SHALL preserve the map and document selection and SHALL NOT stop either session's work.

#### Scenario: Lead awaits an answer
- **WHEN** the bound Lead has a pending question and the human opens its panel
- **THEN** the existing question is shown and answering settles the same request seen in the full-screen chat

### Requirement: Workspace messages explicitly carry plan context
Each ordinary message sent from a selected plan's workspace SHALL carry a visible attachment naming the repository, plan, and exact displayed revision/hash or draft/hash; optional change and document references refine it. The server SHALL validate these references, record the accepted context, and deliver it with the user's text. Ordinary chat messages outside the workspace SHALL remain usable without attachments.

#### Scenario: Shared Lead receives plan-specific messages
- **WHEN** the human sends one message about Plan A revision 2 and later one about Plan B draft X
- **THEN** the same Lead receives each with its own explicit context, preserved on transcript replay and restart

#### Scenario: Context changed before sending
- **WHEN** a referenced draft changes after the composer captured its hash
- **THEN** sending is refused with an explanation, the text and attachment remain, and the human can explicitly refresh the attachment

#### Scenario: Cross-repository reference
- **WHEN** a workspace message targets a bound chat or plan belonging to another repository
- **THEN** the server refuses it without sending a prompt or persisting a user turn

### Requirement: Navigation cannot silently retarget a message
A nonempty composer SHALL retain its captured plan context when the user changes plan, version, role, or selected work. A differing visible selection SHALL be explained before send and offer explicit context replacement. Local conversation-reset commands SHALL retain their ordinary semantics and SHALL NOT become contextual agent prompts.

#### Scenario: Switch plans while drafting
- **WHEN** the human drafts a message attached to Plan A and selects Plan B
- **THEN** the draft stays attached to Plan A with a visible mismatch and is not silently sent as Plan B

#### Scenario: Reset bound conversation
- **WHEN** a successful local new-chat command replaces a bound session
- **THEN** ordinary creation/archive semantics apply and the repository role follows the successfully created replacement without changing the other role

### Requirement: The workspace preserves access and reconnect state
Plan/version/change/document selection SHALL be addressable and restorable through reload and browser navigation. Expansion, filters, and pane sizing SHALL survive navigation within the client. Narrow screens SHALL offer map/list, document, and conversation navigation with an explicit return path. State and health SHALL have text alternatives; keyboard users SHALL reach every selection and control.

#### Scenario: Return from a full-screen conversation
- **WHEN** the human opens the Lead full-screen and returns to Plans
- **THEN** the previously selected plan, change, document, expansion and map position remain available

#### Scenario: Reconnect during work
- **WHEN** the connection drops and returns while a change runs
- **THEN** last-known data is visibly stale while offline, mutations are disabled, and fresh subscriptions reconcile outcomes, holders, health and the selected conversation without duplicating turns
