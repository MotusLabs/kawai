# Product Strategy above Plans

Date: 2026-10-12. Status: Recommendation; no Product Strategy capability or approved Kawai strategy is established by this document.

## Purpose and boundaries

A **Product Strategy** is a durable, explicit account of whom a product serves, which problems it addresses, which outcomes matter, and which choices guide development. It connects product purpose to decisions. “Build an AI productivity platform” is an aspiration; useful direction identifies users/situations, important needs, intended outcomes, boundaries, and trade-offs that distinguish competing Plans.

Product Strategy is a stable, human-approved reference above Plans, not a backlog, a promise to implement every idea, or another execution layer. It remains understandable without implementation specifications. It guides prioritization and alignment; it is not a tool permission, safety policy, budget grant, or approval to start work.

This companion extends the [multi-agent development design](multi-agent-development-ux.md). **Current:** the reviewed mechanisms concern tasks, mail, and worktrees; the design makes no claim of existing Product Strategy support. **Upstream proposal:** Plans provide durable bounded intent and separate execution attempts. **Recommendation:** add a product-direction reference, pinned bindings, human approval, alignment reports, and explicit impact review while preserving standalone work.

## Recommended contents

| Element | Decision guidance |
| --- | --- |
| Purpose | Why the product exists and which problem merits solving |
| Primary users | Who uses, buys, operates, benefits from, or is affected by it; who benefits first |
| User needs | What people are trying to accomplish and current obstacles |
| Main use cases | Concrete situations, triggers, goals, and desired experiences |
| Desired outcomes | What improves for users when the product succeeds |
| Product approach | Chosen approach, current alternatives, differentiation, and rationale |
| Principles and trade-offs | Ordered priorities and scoped choices when objectives conflict |
| Boundaries and non-goals | Excluded users, problems, environments, and behaviors |
| Success measures | Evidence of progress/failure; baseline/target only when known/agreed |
| Assumptions and uncertainties | Beliefs to test, evidence limitations, and open decisions |

Distinguish owner preference, explicit user statements, agent interpretation, proposed choices, hypotheses, and validated observations. Record source, observation context/date, limitations, and required validation. Human approval of direction does not validate a market claim. Missing baselines/targets are Unknown, not invented values.

## Relationship to Plans and execution

```text
Product Strategy (human-approved revision; no execution attempt)
  --> Plan (pinned strategy revision and alignment statement)
       --> Changes (requirements/design artifacts; optional OpenSpec)
            --> Tasks

Plan Execution = an attempt to execute a Plan
Task Execution = an attempt to perform a Task
```

The diagram describes direction and decomposition, not a new rigid ownership hierarchy: standalone tasks remain supported and existing Change-binding rules still apply. A Plan's **implementation strategy** explains how its bounded effort achieves an objective; **Product Strategy** describes product direction.

Example: Product Strategy helps small teams delegate development while controlling risk and acceptance; a Plan delivers reliable overnight work for three compatible Changes; a Change adds durable checkpoints; a Task implements persistence and recovery validation.

Research/discovery may be a Plan. Its evidence can support a proposed Strategy revision, but completing research never approves that revision. Technical Plan validation remains necessary even when alignment is strong.

Start with one active approved strategy per product. A product may bind several repositories; multiple products in a repository may have distinct strategies. Competing directions are draft alternatives, not simultaneously authoritative direction. Superseded approved revisions remain accessible and immutable. Product/repository bindings must respect access scopes; shared product identity does not expand execution-team permissions.

## Default strategy template

Use this template for discovery and review. Early fields may be optional when their absence is explicit and does not prevent a direction decision. An initial strategy may be two or three pages; completeness means useful decisions rather than speculative field filling.

```markdown
# Product Strategy: <product name>

Status: Draft | In review | Approved | Superseded
Revision: <number>
Owner: <human owner>
Decision horizon: <period or conditions for review>

## Purpose
<Problem and reason for addressing it.>

## Primary users and context
<Users, roles, operating conditions, and current alternatives.>

## Needs and desired outcomes
<What users want to achieve and what should improve.>

## Main use cases
<Trigger, user goal, current difficulty, desired experience, success signal.>

## Product approach
<Chosen approach and rationale; alternatives considered.>

## Principles and trade-offs
<Ordered priorities and examples of decisions they guide.>

## Boundaries and non-goals
<Explicit exclusions for this revision.>

## Success measures
<Outcome, proposed measure, known baseline, and agreed target; otherwise Unknown.>

## Assumptions and evidence
<Claim, kind, source, confidence, limitations, and validation needed.>

## Open questions
<Question, owner, consequence, and next step.>

## Decisions and revision history
<What changed, why, who approved, and affected Plans.>
```

Each use case identifies user/situation, trigger, wanted outcome, current obstacle/workaround, desired experience, observable success signal, and constraints/failure cases. Describe intent before features: “A lead delegates agreed work before leaving and assesses its outcome next morning” is a use case; “a button to start agents” is a feature.

## Illustrative draft strategies

All three examples are hypothetical drafts. They demonstrate decision guidance, not validated demand, approved direction, or agreed targets. In particular, Example A must not be installed as Kawai's approved strategy merely because it appears in this repository.

### A. Kawai: supervised autonomous software development

**Purpose/users:** help individual developers and small teams delegate software development to agents across a repository and linked worktrees while retaining control over intent, risk, and acceptance.

**Needs/outcomes:** agree work without repeated context; understand ownership; redirect requirements safely; distinguish activity from verified progress; recover interruptions; inspect a coherent integrated result.

**Use cases:** interactive API/UI supervision; bounded overnight delegation returning a verified Candidate or exceptions; a shared contract change redirecting affected executors; recovery without blindly repeating uncertain effects. Each needs fuller trigger/obstacle/success/constraint detail during discovery.

**Approach:** Strategy, Plans, pinned inputs, explicit handoffs, and inspectable evidence, with chats/terminals supporting the workflow. **Principles:** human ownership of intent, runtime permissions, evidence before acceptance, explicit shared publication, understandable partial outcomes. **Trade-off:** recovery/integration reliability before maximum agent concurrency.

**Non-goals:** unrestricted production deployment, automatic product direction, and replacement of every development tool. **Proposed measures:** blocker comprehension time, time to verified Candidate, recovery success, duplicate effects, cost per accepted Change; baselines/targets Unknown pending measurement/agreement.

**Hypotheses:** coherent supervision helps more than additional sessions; bounded overnight work reduces coordination without increasing rework. **Aligned Plan:** checkpoints/recovery and integration gates for a small overnight run. **Misaligned Plan:** more concurrent agents without ownership, recovery, or verification.

### B. Customer support knowledge assistant

**Purpose/users:** help support staff accurately resolve routine questions using maintained company knowledge; knowledge maintainers and customers benefit from consistency and speed.

**Needs/use cases:** find authoritative/fresh sources during a ticket, teach procedures to new staff, identify conflicting articles, and escalate uncertainty. **Approach:** retrieve approved knowledge, show sources, draft for staff review, and expose gaps.

**Principles/trade-off:** traceable accuracy before speed; visible uncertainty; defined approval before customer-facing action. A supported “cannot confirm” is preferable to an unsupported complete answer. **Non-goals:** account changes, refund commitments, or replacing exceptional-case human handling.

**Proposed measures:** supported-case resolution time, correction rate, source coverage, escalation quality; targets Unknown. **Hypotheses:** knowledge covers enough routine cases and staff review efficiently. **Aligned Plan:** freshness signals/source-specific review. **Misaligned Plan:** send all generated answers before source quality and approval rules exist.

### C. Field service coordination tool

**Purpose/users:** help small maintenance businesses coordinate appointments and equip technicians to complete visits; dispatchers/technicians use it, customers need predictable visits/status.

**Needs/use cases:** know who goes where, handle urgent schedule changes, retain instructions offline, and synchronize visit completion after reconnect. **Approach:** shared scheduling, concise job records, offline access, explicit sync status.

**Principles/trade-off:** assignments/offline reliability before advanced optimization; changes visible to affected people. Predictable manual adjustment comes before opaque route optimization. **Non-goals:** payroll, purchasing, or financial commitments.

**Proposed measures:** missed appointments, coordination time, complete visit records, synchronization failures; baselines/targets Unknown. **Hypotheses:** frequent offline need justifies complexity and dispatchers maintain shared schedules. **Aligned Plan:** offline details/reliable completion sync. **Misaligned Plan:** payroll before core scheduling works.

## Strategy capture workflow

Treat capture as collaborative elicitation, not extraction of a hidden definitive answer. The user may be discovering direction. Use authorized context first, then ask a few concrete questions at a time.

| Phase | Expected behavior and reviewable output |
| --- | --- |
| 1. Collect context | Inventory authorized documents/decisions/use cases; classify current, historical, aspirational, contradictory statements and gaps. Existence/newer timestamp does not establish approval. |
| 2. Purpose/users | Ask who benefits first, what they do today, current difficulty, and meaningful improvement. Trace features back to problems without inventing motives. |
| 3. Use cases | Walk through a recent/plausible situation; capture trigger/goal/obstacle/outcome/constraints, one difficult case, and one deliberate exclusion. |
| 4. Trade-offs | Compare verification versus speed, dependable core versus breadth, autonomy versus control; record chosen priority and its scope. Testing autonomy is not production permission. |
| 5. Draft/review | Show a concrete synthesis in the user's language with statements, interpretations, proposals, hypotheses, and open decisions labeled. Check contradictions, vague users, feature-only goals, and unverifiable claims. |
| 6. Approve/publish | Human owner inspects exact revision/hash, impact, and allowed unresolved questions; record approval scope. Publishing does not create Plans, dispatch work, or grant tools. |
| 7. Learn/revise | Link Plan evidence to assumptions/measures; propose material revisions and affected-Plan decisions. Human approval remains required for direction changes. |

Kawai discovery prompts may ask what should happen after overnight delegation and which decision should be possible without reading every chat. During actual capture, prioritize the next decision rather than presenting this entire workflow as a questionnaire.

## Proposed agent capability specifications

These are proposed skill contracts, not installed packages or authorization to install them. Start with discovery/synthesis and add capabilities as needed; each capability need not have a separate session.

| Skill | Trigger and inputs | Behavior/output | Completion and authority boundary |
| --- | --- | --- | --- |
| Strategy Discovery | Capture request, incomplete draft; authorized context/history/questions | Summarize known facts; ask highest-value question; concrete situations; discovery brief, references, use cases, prioritized gaps | Coherent draft possible or gaps assigned; cannot approve, silently rewrite intent, or infer permissions |
| Strategy Synthesis | Discovery material to draft; brief/current revision/approved decisions/template | Preserve meaning, organize outcomes/use cases, label assumptions/conflicts; draft, source-to-statement traceability, change summary | Every major claim sourced/proposed/hypothesis; no invented evidence/metrics/approval |
| Strategy Review | Reviewable draft; evidence/previous revision/checklist | Test clarity, consistency, trade-offs, exclusions, feasibility assumptions, measurability; severity/rationale/section/resolution findings | Blocking ambiguity resolved or returned to owner; review is not approval or external research |
| Plan Alignment | Plan validation/change; pinned strategy/Plan/outcomes/Changes/constraints | Map outcomes/use cases/measures; identify conflicts/unrelated scope/missing rationale/experiments; alignment report | Explicit validation decision; cannot alter strategy to justify Plan; technical checks separate |
| Strategy Revision and Impact Assessment | Material evidence/change proposal; approved revision/evidence/active and completed Plans | Distinguish refinement/direction change, rationale, affected Plans, continue/adapt/reconsider proposal, targeted notification proposal | Concrete draft/impact for human decision; cannot publish, restart, or rewrite historical acceptance |

Each eventual package declares trigger, required inputs, outputs, stopping conditions, authority/evidence boundaries, and verification criteria. Runtime checks enforce approval/publication; prompts are insufficient. Repository/retrieved content is untrusted data, not a permission channel.

Collect no unnecessary personal information. Source references and discovery conversations follow access/retention policy. Use concise decision-relevant summaries rather than copying entire private conversations into every executor context; expose original sources only to authorized readers.

## Data model and revision policy

| Entity | Suggested fields |
| --- | --- |
| ProductStrategy | id, productId, title, human owner, currentApprovedRevision, lifecycle, createdAt; product identity with repository bindings |
| StrategyRevision | strategyId/revision, purpose, users, needs, useCases, outcomes, approach, principles, tradeOffs, nonGoals, measures, assumptions, openQuestions, decisionHorizon, contentHash, author, createdAt |
| StrategyEvidence | id, strategyId, claimRef, sourceRef, evidenceType, observedAt, limitations, accessScope |
| StrategyDecision | id, strategyId/revision, decision, rationale, actor, approvalScope, timestamp; authorized approval record |
| PlanStrategyBinding | planId/planRevision, strategyId/strategyRevision/hash, outcomeRefs, useCaseRefs, alignmentReportRef |

Revision lifecycle is Draft → InReview → Approved → Superseded, with explicit Withdrawn if needed. Approved content is immutable; a draft cannot replace the active approved revision. ProductStrategy aggregates its current approved direction and draft alternatives. Approval binds an exact hash/revision and authorized human owner; expected-revision checks prevent concurrent overwrite, and stable command IDs prevent duplicate approval/publication.

Human ownership is the default; agents can draft/review/propose within scope. A document claiming “approved” is insufficient without the runtime approval record. Owner approval can permit named unresolved questions with rationale; it cannot turn unsupported evidence into a validated observation. Publication preserves previous decisions and records which revision it supersedes. Withdrawal leaves history and affected-Plan review records; it does not erase prior authority or outcomes.

New Plans select the current approved strategy for their product and pin it with an alignment report. Existing Plans retain the exact strategy used for validation/acceptance. No strategy means no fabricated binding; standalone tasks/Plans remain permitted under existing execution policy, labeled Alignment unassessed. Strategy need not gate every small task. Existing records migrate without invented strategic provenance.

Strategy publication creates an explicit impact-review item for the responsible Lead/Architect. It does not silently replace Plan inputs, dispatch notifications, interrupt writers, or reinterpret completed acceptance. The Lead/Architect reviews affected and unaffected Plans, proposes targeted reactions, and obtains any required owner decision. New or changed bindings and required impact decisions invalidate relevant Plan validation checks. Plans with superseded bindings require a recorded disposition at their next Validate/Start; active executions use the Plan hold/publication/checkpoint protocols only after an explicit affected-scope decision.

## Plan alignment and trade-offs

An alignment report pins strategy/Plan revision/hash, maps intended outcomes/use cases/measures, identifies applicable constraints and assumption tests, cites evidence/rationale, and records findings/conditions/deciding actor. It is separate from technical validation and never authorizes tools.

| Assessment | Meaning and default readiness treatment |
| --- | --- |
| aligned | Explicit contribution within approved direction; proceed subject to technical/policy gates |
| aligned-with-conditions | Contribution depends on specified conditions; mandatory conditions must resolve before their declared gate |
| exploratory | Bounded research tests a strategic assumption; record experiment criteria and human-authorized scope |
| conflicting | Violates a priority/non-goal; blocks Plan Ready until the owner approves a strategy revision or a scoped, recorded experiment exception |
| insufficient-information | Missing decision/evidence prevents assessment; resolve mandatory questions or authorize a bounded exploratory Plan |

Alignment unassessed is a UI state for work with no approved strategy, not a fabricated sixth positive assessment. An approved experiment may test a non-goal; it does not silently remove that non-goal or grant execution permissions. Product/strategy approval authority is distinct from creator/Plan execution grants. Human overrides record the conflict, scope, rationale, and deciding owner; safety and technical identity checks remain mandatory.

Trade-off example: an increased concurrency Plan may conflict with a strategy prioritizing recoverable verified results. A report should explain the lost outcome and offer a bounded measurement experiment or a reliability-focused alternative, not rewrite the strategy to label every Plan aligned.

Start rechecks the binding/hash, alignment decision, unresolved mandatory questions, applicable impact dispositions, and technical report identity. A strategy-publication race returns a clear review-required response where disposition is missing, without rebinding existing attempts. Product direction is stable reference material; only an authorized Plan transition changes execution inputs.

## Expected UI/UX

Add **Product Strategy** at product/repository level above Plans. First show purpose, primary users, outcomes, use cases, ordered trade-offs, and key boundaries. Put revision/hash/approval metadata in supporting detail without hiding owner or status.

| Action/view | Expected experience |
| --- | --- |
| Capture strategy | Guided conversation, known context/sources/gaps; focused questions and visible draft material |
| Draft strategy | Editable synthesis with hypotheses and traceability; save distinct from approval |
| Review strategy | Findings, contradictions, unresolved decisions, and What we know / assume / have not decided |
| Approve revision | Exact diff/hash, changed direction, evidence limitations, named open questions, affected-Plan impact proposal; human decision |
| View aligned Plans | Product-scoped Plans, pinned strategy revisions, outcome/use-case mappings, alignment findings and decisions |
| Propose revision | New evidence/rationale and proposed impact; approved reference remains visible and unchanged |
| Evidence/history | Claim kind/source/limitations and approval/revision history; source access follows permissions |

A Plan shows a concise statement: “Advances overnight delegation by making interrupted work recoverable,” with pinned revision and report link. If direction has evolved, show its old pin and impact-review status rather than making it appear validated against the new revision. No strategy shows Alignment unassessed with optional Capture strategy, never a forced setup wizard.

Strategy changes open an owner/Lead impact-review card, not a mass-interruption dialog. After explicit affected-Plan decisions, link to normal Plan adaptation/notification actions. Completing a discovery/research Plan exposes evidence and Propose revision; it cannot auto-approve direction.

Drafts survive navigation/reconnect. On mobile use list/detail/back with restored selection/focus; keyboard actions have visible focus, accessible labels, and textual status. Concurrent edits show a conflict with both drafts preserved; approved content cannot be overwritten. Sensitive sources display authorized summaries or restricted placeholders rather than leaking across product/repository boundaries.

## Approval readiness

Approve only when purpose/users are understandable; main use cases can guide Plan choices; outcomes differ from features; trade-offs/non-goals are explicit; measures are usable or unknown values acknowledged; unsupported assumptions/open decisions are visible; directional contradictions are resolved or explicitly accepted by the owner; and the human can inspect the exact revision and impact.

Readiness checks produce findings, not market validation. A confidence score cannot substitute for evidence or approval. Record the owner’s scope and allowed open questions; return blocking ambiguity for resolution rather than filling it with speculative prose.

## Acceptance scenarios and testing

S01–S18 extend the main document's E01–E14/R01–R24 without changing their identifiers. Use isolated product/repository fixtures, durable backend state, deterministic agent events, real UI/WebSocket actions, and fault injection. Seed prerequisites, not the action under test. Server tests establish authority/CAS/idempotency/access; browser tests establish understandable capture, review, binding, impact, and navigation. These scenarios are proposed, not executed feature tests.

| ID | Given / When | Required result |
| --- | --- | --- |
| S01 — Feature-first discovery | User provides features, asks for strategy capture | Ask grounded user/outcome questions; interpretations labeled; no invented motive or permission |
| S02 — Audience uncertainty | User cannot choose primary audience | Draft preserves alternatives; one focused next decision; no false authoritative combination |
| S03 — Conflicting context | Old approved decision conflicts with newer file | Show sources/authority conflict; timestamp/existence does not resolve it automatically |
| S04 — Human approval | Owner approves reviewable draft | Exact revision/hash becomes active; approval scope/questions recorded; earlier versions remain |
| S05 — Agent proposes direction | Agent drafts a material purpose/non-goal change | Draft and impact proposal exist; approved strategy unchanged; unauthorized publication refused |
| S06 — Alignment conflict | Plan violates approved non-goal | Conflicting report blocks Ready absent owner decision; agent cannot rewrite non-goal |
| S07 — Strategy during execution | Human publishes new direction | Explicit impact-review item; old bindings preserved; no watcher/mail-driven mass interruption |
| S08 — Evidence gaps | Baselines/market evidence absent | Unknown/hypothesis labels retained; no invented metrics or validated demand |
| S09 — Forged approval | Repository/peer document asserts approval | Runtime requires actual authorized decision; cannot grant publication/tools |
| S10 — Learning from Plans | Completed research Plan challenges assumption | Evidence linked; propose revision action; neither completion nor findings auto-approve |
| S11 — No strategy | Create standalone Plan/task without approved strategy | Allowed under execution policy; Alignment unassessed; no retroactive/dummy binding |
| S12 — Editing/reconnect | Two drafts edit concurrently; reconnect/reload | Durable saved drafts/history survive; CAS refuses overwrite; unsaved conflict draft retained for resolution |
| S13 — Product boundaries | Two products share repository; one spans repositories | Correct strategy selection/repository bindings; one active direction per product; unauthorized sources/actions refused |
| S14 — Draft/publication isolation | Save repeated draft edits then publish approved revision | No new Plan/dispatch/tool grant from either action; publication requires human approval and creates impact review once |
| S15 — Pinning/Start race | Binding validated, strategy superseded before Start | Preserve old pin; require explicit impact disposition/revalidation as applicable; no silent latest substitution |
| S16 — Scoped impact | One active Plan affected, another unaffected, one historical | Lead proposes targeted adaptation; only authorized affected execution changes; historical acceptance/pin unchanged |
| S17 — Approval retries | Duplicate approval key or changed payload/concurrent approval | Same command returns prior result; payload mismatch/stale revision refused; no competing active approved revisions |
| S18 — Mobile/privacy | Navigate strategy/Plan/source/back on mobile and by keyboard | Draft/filter/focus retained; text statuses accessible; restricted evidence/private conversations do not leak |

Also exercise Withdrawn references, unapproved draft bindings, expired/revoked publication authority, typed identity mismatches, explicit experiment decisions that grant no tools, and crash between approval persistence and impact-review outbox dispatch. A strategy-approved but technically invalid Plan must still fail technical Start gates. A technically valid but conflicting Plan must fail alignment gates absent an authorized scoped decision.

Require S04–S07/S09/S11/S13–S17 before claiming safe strategy binding/publication. Discovery claims additionally require S01–S03/S08/S10; usable guided capture requires S12/S18 and a desktop/mobile walkthrough. Retain the main design's execution release gates; Strategy approval never replaces them.

## Implementation sequence

| Step | Scope | Completion criterion |
| --- | --- | --- |
| 1. Documentation/manual review | Agree vocabulary/template; pinned approved references | Human-reviewed direction usable for Plan decisions; optional work stays possible |
| 2. Discovery/synthesis | First two proposed skills, traceability, drafts/review/approval | Claims sourced/proposed/hypothesis; exact human approval and saved drafts |
| 3. Plan alignment | Bindings and separate alignment checks in Validate/Start | Exact strategy pin, outcomes mapping, conflicts/experiments/unassessed states enforced |
| 4. Revision impact | Explicit owner/Lead review, targeted Plan transitions | No automatic rebinding/interruption; historical acceptance preserved |
| 5. Evidence-driven learning | Plan outcomes linked to measures/assumptions | Material evidence supports proposals without redefining direction automatically |

This is additive to the main Plan roadmap, not another execution scheduler. Do not make Strategy mandatory for every small task. Its value grows when several Plans need shared direction, agents interpret ambiguity, or initiatives compete. Implement proposed packages only after agreeing their contracts; this document installs no skills and creates no approved product direction.

## Open decisions

| Question | Starting recommendation / decision needed |
| --- | --- |
| Scope/identity | Product identity with repository bindings; define cross-repository read/approval scopes without expanding execution teams |
| Vision versus strategy | Start together; split only if audience/update cadence demands it |
| Competing drafts | Show alternatives and explicit human choice; one active approved reference |
| Ownership/multiple humans | Define product owner and quorum/delegation rules; initial approval requires designated human owner |
| Evidence threshold | Identify claims needing external research versus owner preferences; approval does not validate market hypotheses |
| Review horizon | Store time/conditions; expiry requests review, never approves a new direction |
| Alignment exceptions | Define blocking conflicts and bounded experiment authority; no silent scope expansion |
| Sensitive discovery | Summarization, source access/retention, and restricted evidence references |

Human ownership of product direction and exact Strategy-to-Plan provenance are the invariants. Plans execute bounded work; evidence informs learning; the human approves direction.
