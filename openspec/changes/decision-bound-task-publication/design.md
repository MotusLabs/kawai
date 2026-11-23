# Design

## Context

See [proposal.md](proposal.md). Source observations are from `9f8962586961788ef220cd62582b51803bf0090a`, which ships `owner-publication-handoff`. These are code reads. The production and fault witnesses below are for the implementation wave.

| Shipped mechanism | Source evidence |
|---|---|
| Preparation returns a durable, normalized handoff while the published task stays at its base. Only the task's owner or the human publishes. The request's optional Git commit is validated as evidence at preparation. | `src/server/team/taskTools.ts` (`taskSchemas`, `taskHandlers`), `taskHandoffService.ts` (`request`, `publish`), `taskHandoffValidation.ts`, `taskHandoffRead.ts` |
| Prepared publish reserves `handoff:<id>`. The associated revision proves fulfillment. The store transaction includes the revision, handoff transition, finding remaps, direct holder notice and requester wakeup. The service announces the revision fact and restores archived notice recipients after commit. | `src/server/team/TaskService.ts` (`publish`), `taskStore.ts` (`publish`, `resolveKey`), `taskHandoffService.ts` (`fulfill`, `replayOrRefuse`), `taskNotices.ts`, `taskHandoffWakeups.ts` |
| A mailbox enqueue can invoke subscribers synchronously inside the caller's transaction. A queued task notice can trigger task/plan detail reads before that transaction commits. | `src/server/team/mailboxStore.ts` (`enqueue`, `changed`), `taskStore.ts` (mailbox subscription), `sessionMailbox.ts` (`start`), `src/server/chat/ChatSessionManager.ts` (task subscriptions) |
| Decisions resolve from the calling session's task, fix/correction task, or the plan's Lead role naming a plan. Routing uses the current approved Lead group. Answer and Override are keyed human connection commands. The first decision and each command key are unique in the plan decision store. | `src/server/plans/decisions/decisionScope.ts` (`cardScope`, `leadOf`), `DecisionService.ts` (`ask`, `record`), `ownerDecisions.ts`, `decisionStore.ts`, `decisionConnections.ts` |
| A non-spawned session's `taskId` follows its last delivered task mail. This is ordinary decision context and can move between preparing a handoff, asking and replaying the ask. | `src/server/team/dispatcher.ts:510` (`push`), `src/server/chat/ChatSessionManager.ts:1183` (`associateTask`) |
| Production uses one DB and the same `TaskService` on decision, task and execution paths. Claude MCP and Codex dynamic tools use one session-bound registry. Task-bound mail can associate a recipient with its task when delivered. | `src/server/chat/ChatSessionManager.ts` (`composePlanServices` call), `src/server/plans/planComposition.ts` (`DecisionService` construction), `src/server/team/sessionMailbox.ts`, `mailboxTools.ts`, `dispatcher.ts` (`push`) |
| Execution identity is stored independently of the latest approved plan. Start writes execution revision seq 1. Attempts, generations, holds and pause targets are read separately. A pause target exists during drain, before `paused_at`. Shipped Adapt publishes in its resolution transaction and does not take a task-base CAS from the form. | `src/server/plans/execution/ExecutionService.ts` (`start`, `retry`, `stopAs`), `executionStore.ts`, `src/server/plans/revisionControl/executionRevisionStore.ts`, `pauseStore.ts`, `pauseResolve.ts` (`ResolveInput`, `adaptAttempt`) |

The unlanded `execution-task-amendment-authority` at `26521f9b471b24731e126b4db79f2dc61fef193d` is prior art for execution and pause comparisons. Its request, authorization and grant tables are proposal artifacts. This design needs neither those tables nor a plan revision Apply implementation. It uses the shipped human publisher.

## Goals / Non-Goals

- Record one human decision and the exact prepared revision it publishes as one durable intent, with a receipt the human can recover after reconnect or restart.
- Keep plan decision routing authoritative and publish within the current task's scope. The approval covers only the named immutable handoff. A fresh decision can review a new handoff after the task or scope changes.
- Leave delegation, ownership transfer, plan approval, execution controls, result acceptance and historical backfill outside the change. The implementation task is standalone and manually assigned. The feature can target an eligible plan change's manual or execution-created task.

## Decisions

### D1. Attach the request to an owner-addressed question

Add `publication_handoff_id?: string` to `decision_ask`. Accept the exact `handoff-<uuid>` form emitted by `task_request_publication`, with surrounding whitespace trimmed. A supplied null, empty or malformed id is invalid. Keep `question`, `options`, `context`, and optional `plan_id` and their existing limits. Calls omitting the field retain the ordinary schema, routing, result, and replay behavior. Both runtime tool registries use the same declared argument. Other arguments carry no authority or amendment input. An id in question text, context, a note or mail has no meaning for publication.

In the typed branch, resolve the live caller and its team from the registered session, then resolve the named handoff, its persisted task and the plan named by that task in the authenticated team. Return identical not-found results for missing and foreign resolved records. A present same-team task lacking a persisted `planId` or `planChange` is forbidden. An optional nonblank `plan_id` must match the target plan. Refuse a mismatch as forbidden without looking up the supplied plan. The live caller's `taskId` plays no part in typed scope, even when mail leaves it pointing to an unlinked task, a sibling change or another plan. Calls without the typed argument continue to use `cardScope` for ordinary questions, including fix/correction questions.

- Require the exact original `requesterSession` of the handoff and the current owner route of the target plan. Read the Lead group from that plan's current approved revision. The caller's current group must match when a Lead group is configured. A readable approved revision without a Lead group routes to the owner. Missing or unreadable current routing facts are forbidden before both bind and replay. An ask that would go to the Lead is refused with guidance to use an ordinary question or the task handoff. These checks run before comparing an existing binding or checking D2 eligibility for a fresh one.
- After asynchronous team resolution, recheck the live caller and its project path and read its current group for routing. Resolve persisted target, routing and mutable binding facts in the same synchronous transaction as a fresh card/link write. A fresh binding requires D2. Set `card.taskId` and `card.change` to the verified target and `card.revision` to the task's work revision (execution pin when applicable, approved revision otherwise). Leave question mail empty. The existing decision attention item opens the card.

Use one card per handoff, with a permanent unique handoff id even after disposition. Use that id as the typed ask's intent key. After D1's current team, persisted target, requester and owner-route checks, compare the normalized question, options and context, resolved plan, and original asker against the existing card. Exact matches replay even after unrelated task mail moves the caller's focus, the handoff ends, or other D2 facts move. Refuse a difference under the same handoff id and name the differing field. For a fresh binding, refuse an ineligible base, handoff, execution or pause with its D2 reason. A replacement or amendment to the prepared edit requires a new handoff id. There is no general change to ordinary ask idempotency.

Bound ask success extends `{ card_id, addressed_to: 'owner', guidance }` with `{ publication: { handoff_id, task_id, base_revision, payload_hash }, replayed: boolean }`. Use the full stored payload hash. Return an MCP error for a refusal. The guidance points to the owner action and `plan_get` for the receipt, and to `task_get { task_id, handoff_id }` for the existing prepared payload and disposition. Preparation and named/bounded task reads keep their shipped input and result shapes. No approve, publish-as-owner or authorize tool is added.

### D2. Derive and compare the binding from trusted records

Use the following tuple for a fresh bind and again for a fresh approval. The read-only review uses the same comparison for availability. Read all mutable facts under the transaction for the write in question. Read them by the stored task, plan and handoff link, independent of a caller's displayed base or submitted review identity.

| Fact | Source and comparison |
|---|---|
| Team, plan, change and active plan revision | Same canonical team, plan id, exact task id and `planChange`. The plan must be open and its current approved revision and full `contentHash` must resolve. Use that revision for routing and pin it in the binding. Drafts and in-review revisions do not enter the tuple. |
| Task and exact published base | Task status must be open, active or blocked. Resolve its current revision row and the handoff's `baseRevision` and `baseContractHash`. They must agree by number and full nullable contract hash. Independently hash the base row's exact direction, nullable acceptance, parsed canonical contract or null, and full nullable contract hash using canonical JSON with an explicit version. Verify contract/hash consistency. Keep number and full base content hash. `rN#…` is a display label and is not an exact content digest when a contract exists. |
| Prepared handoff | Require `open`, mandatory `notify: true`, no prior associated revision and no revision holding the reserved `handoff:<id>` key. Require normalized valid prepared fields. Bind the handoff id, original requester session/group, the full stored payload hash verified against the prepared fields (`handoffPayloadHash`), the nullable `baseCommit`, and ordered `evidenceRefs`. The payload hash includes direction, acceptance, contract text, rationale and notify. Git evidence is shown as recorded. Branch movement does not itself change the task base. |
| Manual task | Require no execution-change row for the task, a non-system task creator, and no owning execution row for this team/change, even an owner row for another plan or one still provisioning without a task. Require the change in the current approved revision. Store explicit null execution context. |
| Execution task | Resolve the row by `task_id` across execution history. Require one consistent change/execution association, the task's persisted system origin and the same team/plan/change and `owns = 1`. Require a running execution and the change in `implementing` or `gating`. Verify the execution's plan revision and full content hash against both the pinned plan revision containing the change and the latest execution revision record. Bind execution id, revision, content hash, revision history seq, execution base commit, change generation, stage, step, baseline commit, and the latest attempt id and manifest hash (`latestAttemptForChange`). For an eligible execution change, baseline and attempt must resolve. The execution revision can differ from the current approved revision. |
| Affected pause history | For an execution task join `plan_pauses` and `plan_pause_targets` on `pause_id`, scoped by execution, team, plan and exact change. Reject any target with null decision, including one still draining. Pin all matching tuples `{ pauseId, decision, decisionCommandId }` ordered by `pauseId`, including resolved targets, and require a consistent scope and decision record. A pause which enters and resolves after binding changes the snapshot even if the task content is identical. Ordinary holds and unrelated pauses do not enter this tuple. |

Missing or inconsistent scoped facts refuse, including an orphan prepared key, broken execution reference or malformed persisted payload. An execution change entering landing, stopping, losing ownership, or changing its bound generation/attempt refuses a fresh approval. An unrelated execution or unrelated change's pause alone has no effect. Holder identity is resolved at publication time through `TaskNotices`, and it does not enter the binding. The human's authority does not depend on who owns the task or whether the requester is still online at approval. An ordinary task owner keeps the existing ability to publish independently.

Persist a versioned canonical snapshot of these trusted facts and its SHA-256 `bindingHash` when creating the card. Include the new card id in the hash and store the task and handoff ids as explicit link columns. The content hashes represent the immutable rows, never take the place of resolving the rows, validating the payload, and comparing the typed snapshot. A stale card cannot be rebound. To make another combined request, prepare a fresh handoff and ask from the eligible scope. Earlier ordinary handoffs can be explicitly bound while eligible. Nothing scans or backfills cards or handoffs.

### D3. Human review and wire contract

Expose an optional `publication` on `PlanDecisionCardView` for bound cards in `plan_get` and `team-plan-detail`. It carries the binding identifiers, base revision, payload and binding hashes, and the historical receipt if there is one. Keep full review content out of the plan-wide projection. The card can open the task and open a read-only review for the exact link. Use the normal `teamScopes` team resolution and human connection route for both messages below.

```typescript
type PublicationReviewRequest = {
  type: 'team-plan-publication-review'
  teamPath: string
  requestId: string
  planId: string
  cardId: string
}

type ApprovePublicationRequest = {
  type: 'team-plan-approve-publication'
  teamPath: string
  requestId: string
  planId: string
  cardId: string
  expectedHandoffId: string
  expectedBindingHash: string
  rationale?: string | null
  commandId: string
}

type PublicationBindingRef = {
  taskId: string
  handoffId: string
  baseRevision: number
  payloadHash: string
  bindingHash: string
}

type PublicationContent = {
  direction: string
  acceptance: string | null
  contract: ImplementationContract | null
}

type PublicationReview = {
  link: PublicationBindingRef
  planId: string
  change: string
  approvedPlanRevision: number
  execution: {
    id: string
    revision: number
    revisionSeq: number
    changeGeneration: number
    attemptId: string
  } | null
  taskTitle: string
  baseIdentity: string
  baseContentHash: string
  before: PublicationContent
  after: PublicationContent
  requester: { sessionId: string; groupId: string | null }
  preparedRationale: string
  notify: true
  baseCommit: string | null
  evidenceRefs: string[]
  availability: 'ready' | 'stale' | 'decided'
  unavailableReason: string | null
}

type DecisionPublicationReceipt = {
  planId: string
  cardId: string
  decisionId: string
  commandId: string
  handoffId: string
  taskId: string
  baseRevision: number
  publishedRevision: number
  payloadHash: string
  bindingHash: string
  publishedAt: string
  noticeMessageIds: string[]
  wakeupMessageId: string | null
}

type DecisionPublicationView = PublicationBindingRef & {
  receipt: DecisionPublicationReceipt | null
}
```

Both requests respond with `team-plan-result`, `teamPath` and `requestId`. A review success adds `publicationReview` with link and scope, requester, task id/title, base number, display identity and full hash, `before` and `after` values of `{ direction: string, acceptance: string | null, contract: ImplementationContract | null }`, prepared rationale, notify, Git evidence and references, and availability (`ready`, `stale` or `decided`, with a reason when unavailable). Read the historical base by its exact revision number. Resolve omitted fields against that row with the same carry-forward and contract parsing rules as prepared publication. Show the exact before/after text and clauses, including unchanged content. If the stored inputs cannot be read consistently, refuse the review instead of showing a substitutable diff. Review by card works even if its named handoff has left a task's recent list.

The human must confirm **Approve and publish** in that review. The button sends the observed handoff id and full binding hash, a stable `commandId` and optional owner rationale (trimmed via the existing answer limits, blank becomes null). `requestId` correlates a transport response and may change on a retry. Require a nonblank string command id and the emitted id and SHA-256 forms. Reject malformed values, including malformed echoes, and unknown fields on the new write message as `invalid`. A well-formed echo that differs from the persisted link on a fresh open bound card is `stale`. There is no editable payload, `choice`, `optionIndex`, `taskId`, `baseRevision`, `notify`, draft or caller identity field. Approval success adds `decision: { card, decision }`, `publication: DecisionPublicationReceipt`, and `replayed: boolean`. Refusals add `error` and `reason` (`invalid`, `forbidden`, `not-found`, `state`, `stale`, or `replay-mismatch`) and carry no success fields. Resolve the trusted human/team and card/plan scope before revealing a receipt. Approval uses the ordinary authenticated owner connection, with no agent registration or mailbox shortcut.

Disable confirmation while disconnected, missing its review, processing its request, or unavailable. Bind dialog state to team path, plan and card, and discard late reviews for a previously selected scope. Keep the original command id and normalized intent for a transport retry. After reload the plan detail can recover the receipt from history. After a stale refusal the owner can inspect the stale reason, answer without publishing, or use a fresh handoff/card. No automatic refresh submits a write.

### D4. One fresh commit and one durable replay

Add a decision-domain `plan_decision_publications` table, keyed by `card_id` with unique `handoff_id`. Store the binding snapshot and full hash with team/plan/task scope. The nullable `decision_id` (unique) and receipt fields are filled once inside the combined write. Keep ordinary first-decision `seq = 1` and `(plan_id, command_id)` constraints. Store `action: 'approve-publication'` and the normalized compared fields (`cardId`, `expectedHandoffId`, `expectedBindingHash`, `rationale`) in the decision command payload. A receipt is fixed by the actual decision, revision association and original notice/wakeup ids, never the live task's current revision, current holder, mutable delivery state or a key alone.

1. After authenticating and validating shape and scope, resolve `(team, plan, commandId)` before fresh eligibility. A complete matching combined receipt returns the original answer and receipt with `replayed: true`, even after an override, newer task revision, pause, closure or restart. Another action or changed compared field refuses `replay-mismatch` naming the first difference (action before input fields). For a stored combined command, verify that its receipt identifies that card/link and first human decision, and that the historical revision is `baseRevision + 1`, authored by the human and holds both the prepared key and the server-written handoff association. Compare the saved ids and hashes, independent of current mail state or assignment. Refuse inconsistent receipt evidence with `state`, an error identifying the inconsistency, and zero repair writes. Use a symmetric action check in ordinary Answer/Override so they cannot replay combined commands through the old field comparison. Preserve replay of pre-existing ordinary command payloads.
2. For fresh approval require an open owner-addressed bound card and equality with the observed handoff id and binding hash. A plain card returns `state` with a missing binding error, and a settled bound card returns `state` with an already decided error. Prepare the existing task publication under the resolved human actor and use the stored handoff's fields, `baseRevision`, and `handoff:<id>` key. No extra decision-answer mail is prepared for this action. The existing published-handoff wakeup tells the requester to follow up. It carries no task attachment that could move the requester's session or assignment.
3. Extend the internal `PublicationLink` between `TaskHandoffService` and `TaskService.publish` with a synchronous fresh guard and a completion hook. Thread the guard through `TaskStore.publish` after its key lookup and before the revision write. It rechecks the command key, open card, exact handoff and D2 tuple, human/team scope and observed review comparison in the same writer transaction. Use the shared SQLite DB and acquire the writer before taking the fresh snapshot for this path. Keep the existing task-store base CAS. The existing prepared fulfillment, finding remaps and notices still execute in that transaction. After fulfillment, append the first decision (human, `choice: 'Approve and publish'`, `optionIndex: null`, optional owner rationale, affected task id), and finish the receipt with the resulting revision, initial notice ids and requester wakeup id. Copy the notice/wakeup ids from this transaction, including an empty notice list when there is no holder. The prepared rationale remains the task revision rationale. No draft is loaded, saved or removed. A throw at any write rolls all of these back. The decision store writes its own rows on the same connection. Do not wrap an async call or an announcing store method in an outer transaction.
4. The prepared key fast path can skip the fresh guard when another publisher already won. On any replay/constraint race or ambiguous post-commit error, read and validate the combined receipt before returning success. Fulfillment by an independent prepared or draft publish, a key-only row, or an ordinary answer cannot manufacture a receipt. With the same command and payload two clicks return the same receipt. With different command ids only the first successful decision wins. A concurrent independent publish may win the handoff or move the task base and leave the card open. A concurrent nonpublishing answer may win the card and leave the handoff open. Losing commands write nothing. An observable write rollback after fresh checks returns `state` with a write failure error and leaves that attempt's command key unused. For a transient failure, give guidance to retry the same intent. A busy writer with no matching receipt also returns a retryable `state` when a response is available. An interruption can lose the response. Recovery as A06 requires a complete matching committed receipt.
5. The combined write must never publish a provisional result to observers. Add a scoped, synchronous buffer for `MailboxStore` change/enqueued notifications around this write's transaction. Keep message rows and events in the transaction. Collect affected ids across nested writes, discard the buffer on rollback, and notify with committed rows only after the outer commit. Keep ordinary callers and the existing dispatcher, task and plan subscribers. The bound answer-only write likewise defers its new task-less reply's observer notification until commit. Observe rollback and success on subscribed mailbox/task/plan connections. The receipt and mailbox rows remain authoritative if a callback fails or the process stops before a push. Replays need no announcements or new writes.
6. A crash before commit leaves both the card and handoff as they were. A crash after commit is recovered from immutable rows and existing mailbox startup/receipt reconciliation, with no second approval or auto-publication on boot. The mail's delivered/failed/uncertain state stays in the mailbox. Add a recovery-matrix row for this combined replay key and cite the restart test.

### D5. Independent workflows and side effects

- **Answer without publishing** uses the normal human answer and wins the first decision on a bound card, including a stale one. For this new card variant, write the human `decision-answer` with the card's id and no task attachment in the decision transaction. Send to the live requester or use the requester's group when the session is gone and a group is available, following the handoff wakeup pattern. There is no pre-commit recipient restoration. Any choice text, including `Approve and publish`, remains an answer only. Ordinary unbound cards retain their task-bound answer mail, Lead response, replies, answer and override rules. Keep Override for an answered bound card as the ordinary forward-fix action, preserving the earlier receipt and published revision.
- Standalone prepared publish and publish from a linked draft retain their own behavior and can settle the handoff before the card. The standalone prepared endpoint can return its existing task-only replay after a combined publication under the same prepared key. This is the shipped prepared-revision replay, with no new decision, receipt, notice or revision. Combined approval after standalone publication has no combined receipt and refuses. Keep ordinary publish, decline, withdraw, replacement and existing handoff attention semantics. No pending card is a reservation on the task or handoff.
- `TaskNotices` follows the outstanding assignment claim/forward chain at the committing publication. Write one normal-priority direct revision notice per resolved holder, using existing dead-letter/archived-recipient behavior. An unclaimed assignment needs no notice and receives the current revision in its normal instruction. A failed or uncertain delivery after commit follows existing Notify/Retry and mailbox recovery. The requester wakeup uses the existing liveness rules. Delivery and wakeup never advance ACK. Old delivered messages, results and attempt manifests keep their revision pins.
- Existing runtime reads the published fact and performs its normal re-evaluation. This command does not resolve a diagnosis, move a stage, reopen an execution, release a hold or pause, retry, accept a result or grant a right. A held change still waits before dispatch. A later human Adapt can supersede an already committed publication under its own rules. The new command supplies no CAS to Adapt and does not acquire a landing slot. OpenSpec artifacts and plan approval still govern execution work.

## Acceptance oracles

These tables describe proposed observations. Build executable copies and derive the expected result from input fixtures and independent state, without importing the guard or using the product's response as model state. `Ø` means no writes for the attempted command. Snapshot the keys, rows, bodies and recipients, including drafts, tasks, handoff events and wakeups, decisions, receipts, finding remaps, revisions, assignments, notices, mail and ACKs. Separate the competing winner's writes from the losing command.

### B. Binding

`Access` is the first applicable partition: ordinary (absent field), invalid typed input, not found (missing or foreign resolved record), forbidden (caller/requester/persisted task scope/supplied plan/current owner route), allowed. Under `allowed`, `Link` compares the normalized question, options and context, resolved plan, and original asker after D1 authorization. `Fresh` is D2 eligibility, independent of whether a link already exists. Current routing authorization is an `Access` prerequisite for both bind and replay.

| Oracle | Access | Link | Fresh | Observable result |
|---|---|---|---|---|
| B00 | ordinary | * | * | existing ask result, routing and mail |
| B01 | invalid | * | * | invalid, Ø and no ordinary fallback |
| B02 | not found | * | * | not found, Ø, identical for missing and foreign resolved records |
| B03 | forbidden | * | * | forbidden, Ø, including a same-team task without persisted plan/change scope, a borrowed handoff, a mismatched nonblank `plan_id` without lookup of the supplied plan, and missing, unreadable or ineligible current owner routing |
| B04 | allowed | exact | * | original card and link, replayed, Ø, including after delivery changes task focus |
| B05 | allowed | different | * | replay mismatch naming the differing field, Ø |
| B06 | allowed | absent | unavailable | fresh D2 base, context or handoff reason after current authorization, Ø |
| B07 | allowed | absent | ready | one owner card and link for the persisted handoff target, zero mail, publications or notices |

### A. Approval

`Access` is the first of invalid shape, forbidden caller, not found team/plan/card, or allowed. `Prior` is the command-id relation (exact complete combined, different action/fields, inconsistent stored evidence, or unused). `Card` is plain, settled bound, or open bound. `Review` compares supplied values, persisted link and current D2 facts independently. `Write` is a successful or refused transaction after those checks (missing mandatory composition or injected write refusal). A pre-commit crash is separately W08.

| Oracle | Access | Prior | Card | Review | Write | Observable result |
|---|---|---|---|---|---|---|
| A01 | invalid | * | * | * | * | invalid, including malformed echoes, Ø |
| A02 | forbidden | * | * | * | * | forbidden, Ø |
| A03 | not found | * | * | * | * | not found, Ø, no receipt disclosure |
| A04 | allowed | different | * | * | * | replay mismatch naming the differing action or field, Ø |
| A05 | allowed | inconsistent | * | * | * | state, inconsistent receipt evidence, Ø |
| A06 | allowed | exact | settled | * | * | original decision and receipt, replayed, Ø |
| A07 | allowed | unused | plain | * | * | state, missing publication binding, Ø |
| A08 | allowed | unused | settled | * | * | state, already decided, Ø |
| A09 | allowed | unused | open | stale | * | stale reason for a well-formed mismatched echo or moved binding facts, Ø |
| A10 | allowed | unused | open | current | refused | state, write failure, Ø and key unused; retry guidance for transient failure |
| A11 | allowed | unused | open | current | successful | one human decision and receipt, one exact prepared revision, fulfillment and existing notices/wakeup |

Completeness uses the Cartesian axes for B (5 × 3 × 2 = 30) and A (4 × 4 × 3 × 2 × 2 = 192). Axes after an earlier refusal remain don't-care. Every tuple matches one row or U1. U1 is `Access=allowed`, `Prior=exact` with `Card=plain` or `open` (8 tuples). A complete receipt can only refer to a bound card with its first decision. Fabricated contradictions are `Prior=inconsistent`, with explicit A05 fixtures. A requester's group peer without the exact originating session is B03 even when an old card exists. Pin these multiplicities in row order: B `6, 6, 6, 6, 2, 2, 1, 1` and A `48, 48, 48, 12, 12, 4, 4, 4, 2, 1, 1`, plus U1. Exercise concrete fixtures for each D2 subcase and each mismatch field, including changes that leave the task revision intact.

### W. Workflow and recovery witnesses

Each row starts from its stated observation fixture, with the normal shipping behavior as the baseline for unchanged paths.

| Oracle | Stimulus | Observable result |
|---|---|---|
| W01 | Registered request/read on an execution task. Deliver task-bound mail for an unrelated task to the non-spawned Lead, observe the changed `taskId`, then bind and confirm through the real owner connection. | The card and review use the handoff's exact task and plan, with its diff and both plan pins. Task and plan reads agree on ids, base and published revision. Holder receives real direct notice, requester receives task-less wakeup, task draft stays untouched. Explicit ACK advances only after separate tool call. |
| W02 | A well-formed echoed handoff id or hash differs on the same base, the handoff is closed, stale, superseded, declined, withdrawn or published, or task content changes with an unchanged contract | Refuse as stale with Ø and inline reason. Stable review cannot silently reopen or use the replacement. |
| W03 | Move one scope/context fact after review including current approval, execution pin/ownership, attempt, change generation, or runtime Stop/Retry | Refuse with Ø even if the task base still matches. Binding with unrelated task focus and a manual task without competing execution are positive controls. |
| W04 | Insert an affected undecided draining or paused target after review preparation, then resolve it with Continue. Separately publish with shipped Adapt. | Both undecided and newly resolved histories refuse a fresh combined write. Adapt wins through its existing path and publishes no decision receipt. Unrelated change/execution pauses and ordinary holds permit eligible approval, with existing hold waits preserved. |
| W05 | Claimant forwarded/replaced before commit, or assignment unclaimed | Notice targets only the resolved successor. An unclaimed assignment gets no notice. The receipt keeps original ids when a new holder later takes over. Old result/message pins and new-holder ACK behavior stay intact. |
| W06 | Notice is delivered, dead-lettered or uncertain, then owner retries through existing operations | Original publication and receipt stand. Delivery, failure management, retry and ACK have existing effects and write no additional revision or combined decision. |
| W07 | Race same-key and different-key approvals with each other, with Answer, and with standalone prepared, linked-draft or ordinary human publication based on the same revision. Exercise both winner orders. | Only the serialized winner's effects exist. An exact combined retry replays. Competing publication can leave an open card with no receipt. Competing Answer can leave an open handoff. A task-only replay of a combined prepared revision carries no new effects. Later eligible ordinary publication from the new base is still possible. |
| W08 | Interrupt before binding or approval commit and boot. Separately lose the response after each commit and boot. Before retrying the ask, deliver unrelated task-bound mail that moves the Lead's task focus. | Before commit no partial rows or provisional mailbox/task/plan pushes. After commit the exact authorized ask returns the original card despite the focus change, and the exact approval returns its receipt. Neither replay adds rows. Startup reuses persisted notice/wakeup and does not synthesize an approval. |
| W09 | Exercise unbound Lead/owner ask, answer, answer replay, override, diagnosis and dispute. Try a bound Answer with approval-like text and a bound override after publication. | Ordinary mail, recorded decision, fix behavior and existing gates hold. Bound Answer makes no publication and cannot attach the requester to target work. Bound override leaves the historical receipt and revision intact. |
| W10 | Stale form, delayed review from another team/card, disconnect, and approval response lost in the Plans view | Complete review only for the selected card, no enabled confirmation without a ready review and connection, no automatic write. An exact retransmission has stable intent. Later plan detail can recover its receipt. |

Run both pre-commit rollback and post-commit response-loss controls for the bind and combined writes. In the combined transaction independently inject failures after revision, handoff association/event, wakeup, direct notice, finding remap, decision and receipt writes. Exercise actual settlement/sweep on reopen. Compare the durable projection after every modeled command, including notice ids, task association, handoff state and receipt, before using delivered state as an assertion. Use deterministic fixtures for scope corruptions and misses, since healthy generation alone cannot reach them. This addresses the independent-input, incomplete enumeration, hand-built seam, and durable-side-row restart hazards in `docs/oracle-hazards.md`.

### Properties

| Invariant | Property, generator and seams | Fixed run |
|---|---|---|
| I1 | Model current team/scope and immutable published base independently. Vary supplied review identity separately from stored binding and vary delivered-mail focus separately from the handoff target. Generate ready manual/execution cases, authorization denials and mutations of each trusted fact after observe. Pass through registered asks and actual owner connection approvals. Only the exact currently eligible review can add a human publication. | `0xDEC10001`, 160 cases |
| I2 | Model B/A/W transitions with an independent ledger. Generate 12–20 commands from prepare, ask, review, approve, answer, override, plain and linked-draft publish, replace, withdraw/decline, close, pause/Continue/Adapt, Stop/Retry, duplicate with same/different keys and crash/reopen. Execute actual task/decision paths including the new connection command. Compare complete effects and replay results at every step. Seed opening histories for both winners of each race, stale and post-success states, and each named boundary at the reduced profile. | `0xDEC10002`, 200 sequences |
| I3 | Generate original, unclaimed, forwarded, killed and archived holder fixtures, ordinary-hold and sibling-pause variants, prior message/result pins, delivery states and explicit ACK. Compare the real notice writer and actual dispatch/connection evidence to the independently resolved commit-time recipient, plus pre/post gate/ownership snapshots. Only explicit ACK changes ACKs. | `0xDEC10003`, 160 cases |

Use `propertyCases` and the existing test runner with no new dependency. Pin coverage of each command, partition, write fault and opening history at reduced and full profiles. Keep an exact test title and failing mutant assertion per oracle, including the production wiring omissions. A uniquely constrained row count without the other durable effects is insufficient.

## Risks / Trade-offs

- Higher review staleness during execution transitions → name the stale fact and let the owner return to the exact prepared-publish or Adapt workflow, subject to their existing rules. Keep Git evidence distinct from the database revision guard.
- Two publication surfaces can compete → one immutable association, one keyed human action and explicit receipt arbitration. The handoff stays independently readable and the card can be answered without publishing.
- Task-bound answer mail could attach a requester to the reviewed task → the bound card uses a task-less publication wakeup for success and task-less answer mail for answer only.
- Copying prepared text onto cards would duplicate payloads and fan out large plan detail frames → store one typed link, pin immutable content hashes and resolve the diff on demand. The historical receipt survives subsequent publications and overrides.

## Migration Plan

Add the next numbered, additive migration to `src/server/dbSafety/migrations.ts` for the link/receipt table. Keep the existing baseline and applied migrations frozen. `taskHandoffMigration.test.ts` currently asserts that the handoff migration is last. Retain its exact migration-version and previous-version upgrade checks while allowing the new successor. No updates of historical cards, revisions, drafts or handoffs. Phase in server readers and writers with the UI and declared tool argument. Fixed older Codex catalogues use the new argument in a fresh session. Disable new entry points for a rollback while retaining existing history and schema compatibility. Do not undo published task revisions or start a server against a schema it cannot read.

## Implementation contract

### Acceptance
- A1: B00–B07 bind one owner-addressed card to a permitted exact handoff through the existing tools, with no publication, and expose its ids and receipt through same-team plan reads.
- A2: A01–A11 and W01–W04 implement exact human review and atomic decision/prepared publication with a receipt. Every stale or unauthorized attempt adds zero effects.
- A3: W05–W09 preserve prepared/draft/ordinary paths, notice and ACK behavior, old revision pins and execution gates, and prove race/restart behavior for the combined intent.
- A4: W10 shows exact before/after review, stable intent, stale/refusal handling and recovery of published history in the Plans view.

### Invariants
- I1: A fresh combined publication requires an authenticated human and a matching eligible immutable binding. Agents and prose alone never publish through a card.
- I2: The first decision, prepared revision, fulfillment, audit and initial notice intents commit together once or have no effect. A receipt replay cannot create or substitute one of them.
- I3: Publication retains holder resolution, distinct delivery and ACK, ownership, old pins and all protected execution and human gates.

### Scope
- `src/server/plans/decisions/**`
- `src/server/plans/planComposition.ts`
- `src/server/plans/supervision/planSupervisionDetail.ts`
- `src/server/team/TaskService.ts`
- `src/server/team/taskStore.ts`
- `src/server/team/taskPublication*.ts`
- `src/server/team/taskHandoff*.ts`
- `src/server/team/mailboxStore.ts`
- `src/server/team/mailboxCommitObservers.ts`
- `src/server/team/taskTools.ts`
- `src/server/team/teamPrompt.ts`
- `src/server/dbSafety/migrations.ts`
- `src/server/chat/chatConnectionTypes.ts`
- `src/shared/planDecisions.ts`
- `src/shared/planMessages.ts`
- `src/client/components/team/PlanDecision*.tsx`
- `src/client/stores/teamPlanStore.ts`
- `src/server/__tests__/decision*.test.ts`
- `src/server/__tests__/taskHandoffMigration.test.ts`
- `src/server/__tests__/helpers/decisionPublication*.ts`
- `src/client/__tests__/planDecision*.test.tsx`
- `src/client/__tests__/teamPlanStore.test.ts`
- `tests/e2e/decision-publication*.spec.ts`
- `tests/e2e/fixtures/decisionPublication*.ts`
- `docs/architecture/plan-supervision.md`
- `docs/architecture/tasks.md`
- `docs/recovery-matrix.md`

### Verification
- V1: Verify one real MCP preparation/bind, routed human approval and actual holder delivery, plus an intervening-base refusal with complete before/after write snapshots before expanding implementation.
- V2: Commit the oracle tables verbatim with tests, including completeness, full-profile seeded recovery and named kills. Cite exact titles for every scenario, oracle and contract clause.
- V3: Run a disposable browser fixture for review, approve, lost response and stale handling. Run strict OpenSpec validation, affected checks and the full clean committed check with the pinned Bun and result verifier.

### Excluded
- X1: Delegation, grants, owner transfer, historical linking, prose triggers, new task data stores or mutation tools for agents.
- X2: Changes to plan/strategy approval, execution Apply, pause/Adapt, Stop/Retry, hold and landing semantics or result acceptance.
- X3: Live task publication as proof, changes to other OpenSpec changes or spec archive work.
