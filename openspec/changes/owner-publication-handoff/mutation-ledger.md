# owner-publication-handoff — mutation ledger

One row per named mutant (design "Mutation controls", V3) and per extra control the
findings asked for. Each was applied once to the clean head named in its row, alone,
through `bun run test <cited files>` with the pinned Bun at the reduced case profile;
the file was restored by copy and re-hashed against its HEAD blob. `Killed by` lists
the literal titles that failed. Rows marked *survived* or *equivalent* are not kills.

MU14 (design: "the replay check compares only the unique key, not the
surrounding rows") is applied as the key-only replay the oracle hazard "An
idempotence oracle observing only the uniquely constrained row" names: the
replay matches by the unique key and rewrites the surrounding row from the
redelivered call (MU14a: the request's handoff row takes the resending
session and a new time; MU14b: the prepared publish's revision row a new
time), so only a whole-row snapshot sees it (H10, H14). Removing the replay
lookup is a different control, recorded under its own heading.

## MU1

- **Oracle.** H14, P1
- **Edit.** `src/server/team/taskHandoffService.ts`: `const key = preparedKey(found.id)⏎` → `const key = `handoff-random-${crypto.randomUUID()}`⏎`
- **Pin.** HEAD `e4f01859540522143ce6d8ec83f9102534e1c8ae`; `src/server/team/taskHandoffService.ts` blob `026a0f0c94261ef106ea2ca3a405e1632332a503`
- **Ran.** `src/server/__tests__/taskHandoffCommands.test.ts`, `src/server/__tests__/taskHandoffProperties.test.ts` (exit 1)
- **Killed by** (3): `H12/H14/H35/H13: the owner publishes with task_amend, extras are refused, and a former owner gets nothing`; `P1: seed 0x0A11CE01, 400 cases — at most one associated revision, published iff associated, one wakeup per transition, no stray reserved key`; `P3: seed 0x0A11CE03, 200 cases — neutral events interleaved change no handoff, event or revision row`
- **Observed.** error: The publication handoff is published as revision 2 through its linked draft; nothing was published.
- **Status.** killed; restored to the HEAD blob: yes

## MU1b-sweep

- **Oracle.** DF4a, DF4b (sweep)
- **Edit.** `src/server/team/taskHandoffHooks.ts`: `const associated = ctx.handoffs.associatedRevision(task.id, handoff.id)⏎` → `const associated = ctx.handoffs.preparedKeyRevision(task.id, handoff.id)?.revision ?? null⏎`
- **Pin.** HEAD `e4f01859540522143ce6d8ec83f9102534e1c8ae`; `src/server/team/taskHandoffHooks.ts` blob `706ae3473d09236be20d2f60bc9033297bbc2b74`
- **Ran.** `src/server/__tests__/taskHandoffDefensive.test.ts` (exit 1)
- **Killed by** (6): `DF1 with its published wakeup already written sends nothing more (the wakeup key)`; `DF1 {U1}: an associated revision makes the pending handoff published with that revision and its wakeup`; `DF4a {U6}: an orphan reserved key with a current base is never fulfillment; nothing changes or is sent`; `DF4b {U3, U6}: stale only because the task advanced, one wakeup; a second restart reads {U6} and writes nothing`; `DF5 {U1, U3, U5}: the association wins — published once, one published wakeup, no closed or stale`; `DF5o {U1, U3, U5, U6}: published with the associated revision, never the orphan, which is kept`
- **Observed.** error: expect(received).toEqual(expected)
- **Status.** killed; restored to the HEAD blob: yes

## MU1b-publish

- **Oracle.** DF6 (prepared publish)
- **Edit.** `src/server/team/taskHandoffService.ts`: `if (keyRow && keyRow.handoffId !== handoff.id) {` → `if (false) {`
- **Pin.** HEAD `e4f01859540522143ce6d8ec83f9102534e1c8ae`; `src/server/team/taskHandoffService.ts` blob `026a0f0c94261ef106ea2ca3a405e1632332a503`
- **Ran.** `src/server/__tests__/taskHandoffDefensive.test.ts` (exit 1)
- **Killed by** (2): `DF6 {U6}: an orphan reserved-key revision (R1) refuses the publish naming it; the handoff is unchanged`; `DF6p {U6}: published through its linked revision plus an orphan (R4); the orphan is never returned; nothing written`
- **Observed.** error: expect(received).rejects.toThrow(expected)
- **Status.** killed; restored to the HEAD blob: yes

## MU1c

- **Oracle.** H33, H33d, P4 collision traces
- **Edit.** `src/server/team/TaskService.ts`: `if (!link && isReservedRequestKey(requestKey)) throw new Error(RESERVED_KEY_REFUSAL)⏎` → (removed)
- **Pin.** HEAD `e4f01859540522143ce6d8ec83f9102534e1c8ae`; `src/server/team/TaskService.ts` blob `ff2c3142632d4b1cedb571691b4ed7fec6bc611e`
- **Ran.** `src/server/__tests__/taskHandoffRestart.integration.test.ts`, `src/server/__tests__/taskHandoffPublish.integration.test.ts` (exit 1)
- **Killed by** (2): `P4: seed 0x0A11CE04, 200 cases — a crash at any transaction boundary, then SessionMailbox.start(), leaves exactly the model state`; `a Lead requests a publication, W2 asks the human, a reserved key is refused with and without a linked draft, the human publishes once with one delivered notice and wakeup, and resends replay`
- **Observed.** error: expect(received).toEqual(expected)
- **Status.** killed; restored to the HEAD blob: yes

## MU1d

- **Oracle.** H33d
- **Edit.** `src/server/team/TaskService.ts`: `if (!link && isReservedRequestKey(requestKey)) throw new Error(RESERVED_KEY_REFUSAL)⏎` → `if (!link && isReservedRequestKey(requestKey) && !(input.fromDraft && this.store.drafts.get(taskId)?.handoffId)) throw new Error(RESERVED_KEY_REFUSAL)⏎`
- **Pin.** HEAD `e4f01859540522143ce6d8ec83f9102534e1c8ae`; `src/server/team/TaskService.ts` blob `ff2c3142632d4b1cedb571691b4ed7fec6bc611e`
- **Ran.** `src/server/__tests__/taskHandoffRestart.integration.test.ts`, `src/server/__tests__/taskHandoffPublish.integration.test.ts` (exit 1)
- **Killed by** (2): `P4: seed 0x0A11CE04, 200 cases — a crash at any transaction boundary, then SessionMailbox.start(), leaves exactly the model state`; `a Lead requests a publication, W2 asks the human, a reserved key is refused with and without a linked draft, the human publishes once with one delivered notice and wakeup, and resends replay`
- **Observed.** error: expect(received).toBe(expected)
- **Status.** killed; restored to the HEAD blob: yes

## MU1e

- **Oracle.** H16b, H17r
- **Edit.** `src/server/team/TaskService.ts`: `...(requestKey ? { requestKey } : {}),` → `...(requestKey ? { requestKey: input.fromDraft && this.store.drafts.get(taskId)?.lineageId ? `handoff:${this.store.drafts.get(taskId)!.handoffId}` : requestKey } : {}),`
- **Pin.** HEAD `e4f01859540522143ce6d8ec83f9102534e1c8ae`; `src/server/team/TaskService.ts` blob `ff2c3142632d4b1cedb571691b4ed7fec6bc611e`
- **Ran.** `src/server/__tests__/taskHandoffDrafts.test.ts` (exit 1)
- **Killed by** (3): `H17m: a linked publish reusing a key refuses a different payload and, with the same payload, a different linked handoff`; `H38s: after a prepared publish of the same handoff, the linked draft meets the stale-base check; no second revision`; `trace: load, save at the same base (H41), publish (H17), resend after the discard and after a replacement load (H17r), prepared publish refused (H16b)`
- **Observed.** error: expect(received).toEqual(expected)
- **Status.** killed; restored to the HEAD blob: yes

## MU1f

- **Oracle.** H33/H33d whitespace variants
- **Edit.** `src/server/team/TaskService.ts`: `if (!link && isReservedRequestKey(requestKey)) throw new Error(RESERVED_KEY_REFUSAL)⏎` → `if (!link && isReservedRequestKey(input.requestKey ?? '')) throw new Error(RESERVED_KEY_REFUSAL)⏎`
- **Pin.** HEAD `e4f01859540522143ce6d8ec83f9102534e1c8ae`; `src/server/team/TaskService.ts` blob `ff2c3142632d4b1cedb571691b4ed7fec6bc611e`
- **Ran.** `src/server/__tests__/taskHandoffRestart.integration.test.ts`, `src/server/__tests__/taskHandoffPublish.integration.test.ts` (exit 1)
- **Killed by** (2): `P4: seed 0x0A11CE04, 200 cases — a crash at any transaction boundary, then SessionMailbox.start(), leaves exactly the model state`; `a Lead requests a publication, W2 asks the human, a reserved key is refused with and without a linked draft, the human publishes once with one delivered notice and wakeup, and resends replay`
- **Observed.** error: expect(received).toEqual(expected)
- **Status.** killed; restored to the HEAD blob: yes

## MU2

- **Oracle.** H20, P2
- **Edit.** `src/server/team/taskStore.ts`: `this.handoffHooks?.published(this.get(id)!, next, input.handoffId ?? claimed?.handoffId, author, now)⏎` → (removed)
- **Pin.** HEAD `e4f01859540522143ce6d8ec83f9102534e1c8ae`; `src/server/team/taskStore.ts` blob `e1c050946809c52bc99281854fab698349ddbe47`
- **Ran.** `src/server/__tests__/taskHandoffDispositions.test.ts`, `src/server/__tests__/taskHandoffAttentionProperties.test.ts` (exit 1)
- **Killed by** (4): `H20: an ordinary publication turns the open handoff stale naming its revision, with one wakeup, and it cannot be published`; `H21: a further publication leaves a stale handoff stale with no second wakeup`; `H27: an open or stale handoff closes in the status transaction with one closed wakeup and no revision`; `P2: seed 0x0A11CE02, 400 cases — after every command the items are exactly Table W's prediction from the rows`
- **Observed.** error: expect(received).toMatchObject(expected)
- **Status.** killed; restored to the HEAD blob: yes

## MU3

- **Oracle.** P4
- **Edit.** `src/server/team/TaskService.ts`: `link?.within(revision, current)⏎` → (removed)
- **Edit.** `src/server/team/TaskService.ts`: `if (!outcome) throw new Error(`Task not found in this team: ${taskId}`)⏎` → `if (!outcome) throw new Error(`Task not found in this team: ${taskId}`)⏎    if (!outcome.replay && link) this.store.atomically(() => link.within(outcome.revision, outcome.task))⏎`
- **Pin.** HEAD `e4f01859540522143ce6d8ec83f9102534e1c8ae`; `src/server/team/TaskService.ts` blob `ff2c3142632d4b1cedb571691b4ed7fec6bc611e`
- **Ran.** `src/server/__tests__/taskHandoffRestart.integration.test.ts` (exit 1)
- **Killed by** (1): `P4: seed 0x0A11CE04, 200 cases — a crash at any transaction boundary, then SessionMailbox.start(), leaves exactly the model state`
- **Observed.** error: expect(received).toEqual(expected)
- **Status.** killed; restored to the HEAD blob: yes

## MU4

- **Oracle.** H13
- **Edit.** `src/server/team/taskHandoffService.ts`: `if (actor.kind === 'agent' && taskOwner(task) !== actor.sessionId) {⏎      throw new Error("Only the task's owner or the human can publish a prepared revision; nothing was published.")` → `if (false) {⏎      throw new Error("Only the task's owner or the human can publish a prepared revision; nothing was published.")`
- **Edit.** `src/server/team/TaskService.ts`: `if (actor.kind === 'agent' && taskOwner(task) !== actor.sessionId) {⏎      throw new Error(`Only the task's owner or the human can amend its direction.` → `if (false) {⏎      throw new Error(`Only the task's owner or the human can amend its direction.`
- **Pin.** HEAD `e4f01859540522143ce6d8ec83f9102534e1c8ae`; `src/server/team/taskHandoffService.ts` blob `026a0f0c94261ef106ea2ca3a405e1632332a503`, `src/server/team/TaskService.ts` blob `ff2c3142632d4b1cedb571691b4ed7fec6bc611e`
- **Ran.** `src/server/__tests__/taskHandoffCommands.test.ts` (exit 1)
- **Killed by** (2): `H12/H14/H35/H13: the owner publishes with task_amend, extras are refused, and a former owner gets nothing`; `H13: an unrelated agent and Kawai are refused, for an open and for a published handoff`
- **Observed.** error: expect(received).rejects.toThrow(expected)
- **Status.** killed; restored to the HEAD blob: yes

## MU5

- **Oracle.** H28, P3
- **Edit.** `src/server/plans/decisions/DecisionService.ts`: `const decision = insert()⏎      within?.()⏎` → `const decision = insert()⏎      within?.()⏎      for (const t of [card.taskId, ...(decision.affected ?? [])]) { const svc = (this.deps as any).tasks; const h = t && svc?.handoffs?.store.pendingOf(t); if (h) svc.handoffs.store.transition(h.id, 'published', { actor: { kind: 'human', sessionId: null }, revision: 9 }, 'x') }⏎`
- **Pin.** HEAD `e4f01859540522143ce6d8ec83f9102534e1c8ae`; `src/server/plans/decisions/DecisionService.ts` blob `61dc6809c025b74496fd3473c6c7258925de5bf0`
- **Ran.** `src/server/__tests__/taskHandoffProperties.test.ts` (exit 1)
- **Killed by** (3): `H28: every neutral event, in every handoff state, leaves every handoff row and the revision unchanged`; `P1: seed 0x0A11CE01, 400 cases — at most one associated revision, published iff associated, one wakeup per transition, no stray reserved key`; `P3: seed 0x0A11CE03, 200 cases — neutral events interleaved change no handoff, event or revision row`
- **Observed.** error: expect(received).toEqual(expected)
- **Status.** killed; restored to the HEAD blob: yes

## MU6

- **Oracle.** W3, W4
- **Edit.** `src/server/team/handoffAttention.ts`: `if (handoff.state !== 'open' && handoff.state !== 'stale') return []` → `if (handoff.state !== 'open') return []`
- **Pin.** HEAD `e4f01859540522143ce6d8ec83f9102534e1c8ae`; `src/server/team/handoffAttention.ts` blob `9740188e5c5a6c74eca880be70ae474602050bf5`
- **Ran.** `src/server/__tests__/taskHandoffAttention.test.ts`, `src/server/__tests__/taskHandoffAttentionProperties.test.ts` (exit 1)
- **Killed by** (3): `P2: seed 0x0A11CE02, 400 cases — after every command the items are exactly Table W's prediction from the rows`; `W3 and W4: a stale handoff waits on its live requester, then on its group once the requester is gone`; `every pending tuple matches exactly one of W1–W4 and yields its item`
- **Observed.** error: expect(received).toEqual(expected)
- **Status.** killed; restored to the HEAD blob: yes

## MU7

- **Oracle.** W2, D6 recipient rows
- **Edit.** `src/server/team/taskHandoffFacts.ts`: `!!record && !record.archivedAt && !record.contextExhausted` → `true`
- **Pin.** HEAD `e4f01859540522143ce6d8ec83f9102534e1c8ae`; `src/server/team/taskHandoffFacts.ts` blob `ee8748795afe196776f911fb4789de1fb3b3e485`
- **Ran.** `src/server/__tests__/taskHandoffAttention.test.ts`, `src/server/__tests__/taskHandoffWakeups.test.ts` (exit 1)
- **Killed by** (6): `F1–F5 read the session records: archival and context exhaustion make a party gone`; `W1 and W2: a live agent owner publishes; an archived owner or none hands it to the human`; `W3 and W4: a stale handoff waits on its live requester, then on its group once the requester is gone`; `W7 and W8: with the claimant gone, Kawai dispatches an execution-owned task, else the human hands it off`; `a gone requester without a group keeps the wakeup row and sends no mail`; `a gone requester's group gets the message as group mail, and the session none, for every transition`
- **Observed.** error: expect(received).toEqual(expected)
- **Status.** killed; restored to the HEAD blob: yes

## MU8

- **Oracle.** S1
- **Edit.** `src/shared/planSupervision.ts`: `if (handoff !== null) waits.push(` → `if (false as boolean && handoff !== null) waits.push(`
- **Pin.** HEAD `e4f01859540522143ce6d8ec83f9102534e1c8ae`; `src/shared/planSupervision.ts` blob `4b12ec307e1a30acc60240422f6c722780f8db68`
- **Ran.** `src/server/__tests__/supervisionOwnerPublication.test.ts` (exit 1)
- **Killed by** (7): `S1 through the loader: the archived holder's change reads owner-publication with the human as next actor`; `S1: a pending handoff and no other wait reads owner-publication naming its next actor; no stall; the handoff item only`; `S2: another named wait stays the cause, owner-publication also applying, and both items stand`; `S3: a convergence stall awaiting the amended revision keeps its precedence; the handoff item stands for Publish a task revision`; `S6: a repeating failure keeps its precedence over the handoff, which is listed as also applying`; `S9: another publication makes it stale; the wait stays, naming the live requester, then its group once the requester is gone`; `the wait's label names every next actor`
- **Observed.** error: expect(received).toBe(expected)
- **Status.** killed; restored to the HEAD blob: yes

## MU9a (first edit: the allowlist, not the registration)

- **Oracle.** CP1 (tool registration)
- **Edit.** `src/server/team/taskTools.ts`: `'task_transfer_owner', 'task_request_publication',` → `'task_transfer_owner',`
- **Pin.** HEAD `e4f01859540522143ce6d8ec83f9102534e1c8ae`; `src/server/team/taskTools.ts` blob `a87709d0395f788a6d9fd9992366a8e9934c89f6`
- **Ran.** `src/server/__tests__/taskHandoffPublish.integration.test.ts` (exit 0)
- **Status.** survived — wrong seam; see MU9a (registration); restored to the HEAD blob: yes

## MU9b

- **Oracle.** CP1 (WS whitelist)
- **Edit.** `src/server/chat/chatConnectionTypes.ts`: `'team-task-handoff-publish',⏎` → (removed)
- **Pin.** HEAD `e4f01859540522143ce6d8ec83f9102534e1c8ae`; `src/server/chat/chatConnectionTypes.ts` blob `8420c09368e4604f47d1f76f63d57c37dd6169be`
- **Ran.** `src/server/__tests__/taskHandoffPublish.integration.test.ts` (exit 1)
- **Killed by** (1): `a Lead requests a publication, W2 asks the human, a reserved key is refused with and without a linked draft, the human publishes once with one delivered notice and wakeup, and resends replay`
- **Observed.** error: Timed out waiting for the answer to team-task-handoff-publish
- **Status.** killed; restored to the HEAD blob: yes

## MU10

- **Oracle.** taskHandoffWakeups second-write row
- **Edit.** `src/server/team/taskHandoffWakeups.ts`: `INSERT OR IGNORE INTO team_task_handoff_wakeups` → `INSERT OR REPLACE INTO team_task_handoff_wakeups`
- **Pin.** HEAD `e4f01859540522143ce6d8ec83f9102534e1c8ae`; `src/server/team/taskHandoffWakeups.ts` blob `b79095ac186965a3a711dd2ba96fb2c91ba6c509`
- **Ran.** `src/server/__tests__/taskHandoffWakeups.test.ts` (exit 1)
- **Killed by** (1): `a second write of a transition is a no-op: no second row and no second message`
- **Observed.** error: expect(received).toBeNull()
- **Status.** killed; restored to the HEAD blob: yes

## MU11

- **Oracle.** P5
- **Edit.** `src/server/plans/execution/executionSnapshot.ts`: `state: row.state,⏎        step: row.step,` → `state: row.taskId && (executions as unknown as { db: import('bun:sqlite').Database }).db.prepare("SELECT 1 FROM team_task_handoffs WHERE task_id = ? AND state IN ('open', 'stale')").get(row.taskId) ? 'waiting' as const : row.state,⏎        step: row.step,`
- **Pin.** HEAD `e4f01859540522143ce6d8ec83f9102534e1c8ae`; `src/server/plans/execution/executionSnapshot.ts` blob `07ca16fd4d4038e306987d43d298e694fff16698`
- **Ran.** `src/server/__tests__/supervisionOwnerPublicationProperties.test.ts` (exit 1)
- **Killed by** (1): `P5: seed 0x0A11CE05, 200 cases — the scheduler, parallel counts, dependency and slot waits are identical with handoffs`
- **Observed.** error: expect(received).toEqual(expected)
- **Status.** killed; restored to the HEAD blob: yes

## MU12

- **Oracle.** S3
- **Edit.** `src/server/team/planAttention.ts`: `if (prepared.has(change.taskId)) return []⏎` → (removed)
- **Pin.** HEAD `e4f01859540522143ce6d8ec83f9102534e1c8ae`; `src/server/team/planAttention.ts` blob `fd2e8436a565b5fad5aaa83992d1279516f990d1`
- **Ran.** `src/server/__tests__/supervisionOwnerPublication.test.ts`, `src/server/__tests__/supervisionOwnerPublicationAmend.integration.test.ts` (exit 1)
- **Killed by** (2): `S3: a convergence stall awaiting the amended revision keeps its precedence; the handoff item stands for Publish a task revision`; `S8: Amend plus a handoff shows one item; publishing it as revision N closes the diagnosis and dispatches one fix against revision N, backstop zero`
- **Observed.** error: expect(received).toEqual(expected)
- **Status.** killed; restored to the HEAD blob: yes

## MU13a

- **Oracle.** H27
- **Edit.** `src/server/team/taskStore.ts`: `if (before.status !== status && (status === 'done' || status === 'cancelled')) this.handoffHooks?.closed(this.get(id)!, actor, now)` → `void 0`
- **Pin.** HEAD `e4f01859540522143ce6d8ec83f9102534e1c8ae`; `src/server/team/taskStore.ts` blob `e1c050946809c52bc99281854fab698349ddbe47`
- **Ran.** `src/server/__tests__/taskHandoffDispositions.test.ts`, `src/server/__tests__/taskHandoffPaths.test.ts` (exit 1)
- **Killed by** (4): `H27: an open or stale handoff closes in the status transaction with one closed wakeup and no revision`; `H28 then H28b: an override closing no handoff's task changes no handoff; one cancelling the earlier fix task closes its handoff only`; `a fault at the handoff update, the wakeup insert or the mailbox insert rolls the close back whole`; `traces: publish then close stays published with one wakeup; close then publish reads H15 naming closed`
- **Observed.** error: expect(received).toEqual(expected)
- **Status.** killed; restored to the HEAD blob: yes

## MU13b

- **Oracle.** H28b (override cancellation)
- **Edit.** `src/server/team/taskStore.ts`: `if (before.status !== status && (status === 'done' || status === 'cancelled')) this.handoffHooks?.closed(this.get(id)!, actor, now)` → `if (before.status !== status && (status === 'done' || status === 'cancelled') && actor.kind !== 'system') this.handoffHooks?.closed(this.get(id)!, actor, now)`
- **Pin.** HEAD `e4f01859540522143ce6d8ec83f9102534e1c8ae`; `src/server/team/taskStore.ts` blob `e1c050946809c52bc99281854fab698349ddbe47`
- **Ran.** `src/server/__tests__/taskHandoffPaths.test.ts` (exit 1)
- **Killed by** (1): `H28 then H28b: an override closing no handoff's task changes no handoff; one cancelling the earlier fix task closes its handoff only`
- **Observed.** error: expect(received).toMatchObject(expected)
- **Status.** killed; restored to the HEAD blob: yes

## MU14a

- **Oracle.** H10 whole-row snapshot
- **Edit.** `src/server/team/taskHandoffService.ts`: `return { handoff: keyed, replay: true, superseded: null }⏎` → `this.tasks.store.db.prepare('UPDATE team_task_handoffs SET requester_session = ?, updated_at = ? WHERE task_id = ? AND request_key = ?').run(sessionId, nowIso(), taskId, requestKey)⏎      return { handoff: this.store.byKey(taskId, requestKey)!, replay: true, superseded: null }⏎`
- **Pin.** HEAD `e4f01859540522143ce6d8ec83f9102534e1c8ae`; `src/server/team/taskHandoffService.ts` blob `026a0f0c94261ef106ea2ca3a405e1632332a503`
- **Ran.** `src/server/__tests__/taskHandoffCommands.test.ts` (exit 1)
- **Killed by** (1): `H10: the requester side replays its key with the current state, even after the task closed`
- **Observed.** error: expect(received).toEqual(expected)
- **Status.** killed; restored to the HEAD blob: yes

## MU14b

- **Oracle.** H14 whole-row snapshot
- **Edit.** `src/server/team/taskHandoffService.ts`: `return { replay: true, task, revision, handoff }⏎` → `this.tasks.store.db.prepare('UPDATE team_task_revisions SET created_at = ? WHERE task_id = ? AND request_key = ?').run(new Date().toISOString(), task.id, preparedKey(handoff.id))⏎      return { replay: true, task, revision, handoff }⏎`
- **Pin.** HEAD `e4f01859540522143ce6d8ec83f9102534e1c8ae`; `src/server/team/taskHandoffService.ts` blob `026a0f0c94261ef106ea2ca3a405e1632332a503`
- **Ran.** `src/server/__tests__/taskHandoffCommands.test.ts` (exit 1)
- **Killed by** (1): `H12/H14/H35/H13: the owner publishes with task_amend, extras are refused, and a former owner gets nothing`
- **Observed.** error: expect(received).toEqual(expected)
- **Status.** killed; restored to the HEAD blob: yes

## MU15 (failed before acknowledged)

- **Oracle.** W5, W6
- **Edit.** `src/shared/taskHandoffs.ts`: `if (facts.claimant !== null && (facts.acknowledgedRevision ?? 0) >= facts.publishedRevision) return 'acknowledged'` → `if (facts.notices.length > 0 && facts.notices.every(notice => notice.state === 'failed')) return 'notice-failed'⏎  if (facts.claimant !== null && (facts.acknowledgedRevision ?? 0) >= facts.publishedRevision) return 'acknowledged'`
- **Pin.** HEAD `e4f01859540522143ce6d8ec83f9102534e1c8ae`; `src/shared/taskHandoffs.ts` blob `6b06b7e4cd733472d303f79aacb85c55260dd3d7`
- **Ran.** `src/server/__tests__/taskHandoffAttention.test.ts` (exit 1)
- **Killed by** (3): `W11 then W10 then W6: published without notify offers Notify; a failed notice Retry notification; an acknowledgement after it ends the follow-up`; `W12d: a failed notice followed by ordinary task mail delivering the revision is the holder's wait, with no Retry notification`; `every published tuple matches exactly one of W5–W12d and yields its item, in handoffPhase's order`
- **Observed.** error: expect(received).toEqual(expected)
- **Status.** killed; restored to the HEAD blob: yes

## MU15 (task-closed omitted)

- **Oracle.** W5, W6
- **Edit.** `src/shared/taskHandoffs.ts`: `if (facts.taskClosed) return 'task-closed'⏎` → (removed)
- **Pin.** HEAD `e4f01859540522143ce6d8ec83f9102534e1c8ae`; `src/shared/taskHandoffs.ts` blob `6b06b7e4cd733472d303f79aacb85c55260dd3d7`
- **Ran.** `src/server/__tests__/taskHandoffAttention.test.ts` (exit 1)
- **Killed by** (1): `every published tuple matches exactly one of W5–W12d and yields its item, in handoffPhase's order`
- **Observed.** error: expect(received).toEqual(expected)
- **Status.** killed; restored to the HEAD blob: yes

## MU15b

- **Oracle.** W12d, P7b
- **Edit.** `src/shared/taskHandoffs.ts`: `if ((facts.deliveredRevision ?? 0) >= facts.publishedRevision) return 'delivered-awaiting-ack'⏎  if (facts.notices.some(notice => notice.state === 'uncertain')) return 'notice-uncertain'⏎  if (facts.notices.some(notice => notice.state === 'queued')) return 'notice-queued'⏎` → `if (facts.notices.some(notice => notice.state === 'uncertain')) return 'notice-uncertain'⏎  if (facts.notices.some(notice => notice.state === 'queued')) return 'notice-queued'⏎  if (facts.notices.some(notice => notice.state === 'failed')) return 'notice-failed'⏎  if ((facts.deliveredRevision ?? 0) >= facts.publishedRevision) return 'delivered-awaiting-ack'⏎`
- **Pin.** HEAD `e4f01859540522143ce6d8ec83f9102534e1c8ae`; `src/shared/taskHandoffs.ts` blob `6b06b7e4cd733472d303f79aacb85c55260dd3d7`
- **Ran.** `src/server/__tests__/taskHandoffAttention.test.ts`, `src/server/__tests__/taskHandoffAttentionProperties.test.ts` (exit 1)
- **Killed by** (3): `P2: seed 0x0A11CE02, 400 cases — after every command the items are exactly Table W's prediction from the rows`; `W12d: a failed notice followed by ordinary task mail delivering the revision is the holder's wait, with no Retry notification`; `every published tuple matches exactly one of W5–W12d and yields its item, in handoffPhase's order`
- **Observed.** error: expect(received).toEqual(expected)
- **Status.** killed; restored to the HEAD blob: yes

## MU15c

- **Oracle.** P7a, W6
- **Edit.** `src/shared/taskHandoffs.ts`: `if (facts.taskClosed) return 'task-closed'⏎` → `if (facts.claimant !== null && facts.claimant.live && (facts.deliveredRevision ?? 0) < facts.publishedRevision && !facts.notices.some(notice => notice.state === 'uncertain' || notice.state === 'queued')) return facts.notices.length > 0 ? 'notice-failed' : 'not-notified'⏎  if (facts.taskClosed) return 'task-closed'⏎`
- **Pin.** HEAD `e4f01859540522143ce6d8ec83f9102534e1c8ae`; `src/shared/taskHandoffs.ts` blob `6b06b7e4cd733472d303f79aacb85c55260dd3d7`
- **Ran.** `src/server/__tests__/taskHandoffAttentionProperties.test.ts` (exit 1)
- **Killed by** (1): `P7: seed 0x0A11CE07, 200 cases — suppression over every history (P7a) and notice parity with the real notify (P7b)`
- **Observed.** error: expect(received).toEqual(expected)
- **Status.** killed; restored to the HEAD blob: yes

## MU16

- **Oracle.** W9
- **Edit.** `src/server/team/taskHandoffFacts.ts`: `if (state === 'uncertain') return 'uncertain'` → `if (state === 'uncertain') return 'failed'`
- **Pin.** HEAD `e4f01859540522143ce6d8ec83f9102534e1c8ae`; `src/server/team/taskHandoffFacts.ts` blob `ee8748795afe196776f911fb4789de1fb3b3e485`
- **Ran.** `src/server/__tests__/taskHandoffAttention.test.ts` (exit 1)
- **Killed by** (1): `W9 and W12: an uncertain notice goes to the Mailbox linked to its message; a queued one is the holder's wait`
- **Observed.** error: expect(received).toEqual(expected)
- **Status.** killed; restored to the HEAD blob: yes

## MU16b

- **Oracle.** P7b, W9 later-failed row
- **Edit.** `src/server/team/taskHandoffFacts.ts`: `AND revision >= ? ORDER BY created_at, rowid`` → `AND revision >= ? ORDER BY created_at DESC, rowid DESC LIMIT 1``
- **Pin.** HEAD `e4f01859540522143ce6d8ec83f9102534e1c8ae`; `src/server/team/taskHandoffFacts.ts` blob `ee8748795afe196776f911fb4789de1fb3b3e485`
- **Ran.** `src/server/__tests__/taskHandoffAttention.test.ts`, `src/server/__tests__/taskHandoffAttentionProperties.test.ts` (exit 1)
- **Killed by** (2): `P2: seed 0x0A11CE02, 400 cases — after every command the items are exactly Table W's prediction from the rows`; `W9 and W12: an uncertain notice goes to the Mailbox linked to its message; a queued one is the holder's wait`
- **Observed.** error: expect(received).toEqual(expected)
- **Status.** killed; restored to the HEAD blob: yes

## MU17

- **Oracle.** CP3
- **Edit.** `src/server/team/sessionMailbox.ts`: `this.tasks.handoffs.reconcile()⏎` → (removed)
- **Pin.** HEAD `e4f01859540522143ce6d8ec83f9102534e1c8ae`; `src/server/team/sessionMailbox.ts` blob `3dee5479171ceae07bc971264a58ef90b80d27df`
- **Ran.** `src/server/__tests__/taskHandoffRecovery.integration.test.ts` (exit 1)
- **Killed by** (1): `CP3: a boot sweeps before dispatch — DF3 stale with one wakeup, the healthy handoff untouched, the queued wakeup sent once by its id, DF5o and DF2 to a live group member — and a later boot sends nothing`
- **Observed.** error: expect(received).toMatchObject(expected)
- **Status.** killed; restored to the HEAD blob: yes

## MU18

- **Oracle.** task 2.1 migration rows
- **Edit.** `src/server/dbSafety/migrations.ts`: `taskHandoffMigration,⏎` → (removed)
- **Edit.** `src/server/dbSafety/baseline.ts`: `ensureTurnEndSchema(db)⏎}` → `ensureTurnEndSchema(db)⏎  ;(require('../team/taskHandoffSchema') as typeof import('../team/taskHandoffSchema')).taskHandoffMigration.up(db)⏎}`
- **Pin.** HEAD `e4f01859540522143ce6d8ec83f9102534e1c8ae`; `src/server/dbSafety/migrations.ts` blob `946aff5378aefd25ae0f9f3654ddcaf44442f49a`, `src/server/dbSafety/baseline.ts` blob `634dfad3b355b98a1f8b682d781d68a517fc8169`
- **Ran.** `src/server/__tests__/taskHandoffMigration.test.ts` (exit 1)
- **Killed by** (4): `a database at the previous version upgrades keeping its rows, with no handoff backfilled`; `a failing up rolls back to the previous version and names its pre-migration backup`; `a fresh database reaches the version with the handoff tables and columns`; `the migration follows result-author-profile and is never part of the baseline`
- **Observed.** error: expect(received).toBe(expected)
- **Status.** killed; restored to the HEAD blob: yes

## MU19-negative

- **Oracle.** completeness (H/U overlap)
- **Edit.** `src/server/__tests__/helpers/handoffClassifier.ts`: `{ id: 'H29',` → `{ id: 'DF3', match: t => t.associationPresent === 'false' && t.unassociatedReservedKeyPresent === 'false' && t.status === 'open' && t.base === 'behind' && t.state === 'open' },⏎    { id: 'H29',`
- **Pin.** HEAD `e4f01859540522143ce6d8ec83f9102534e1c8ae`; `src/server/__tests__/helpers/handoffClassifier.ts` blob `4dd752b4ee82388035526dac9c99aebc5601cc8f`
- **Ran.** `src/server/__tests__/taskHandoffCompleteness.test.ts` (exit 1)
- **Killed by** (2): `H-RESTART: each tuple of the full product is exactly one row or one excluded classification`; `the DF fixtures classify excluded with their complete reason sets`
- **Observed.** error: expect(received).toEqual(expected)
- **Status.** killed; restored to the HEAD blob: yes

## MU19-positive

- **Oracle.** DF5 / DF4b reason sets
- **Edit.** `src/server/__tests__/helpers/handoffClassifier.ts`: `return partition.claims.filter(claim => claim.holds(tuple)).map(claim => claim.id)` → `return partition.claims.filter(claim => claim.holds(tuple)).slice(0, 1).map(claim => claim.id)`
- **Pin.** HEAD `e4f01859540522143ce6d8ec83f9102534e1c8ae`; `src/server/__tests__/helpers/handoffClassifier.ts` blob `4dd752b4ee82388035526dac9c99aebc5601cc8f`
- **Ran.** `src/server/__tests__/taskHandoffCompleteness.test.ts`, `src/server/__tests__/taskHandoffDefensive.test.ts` (exit 1)
- **Killed by** (5): `DF4b {U3, U6}: stale only because the task advanced, one wakeup; a second restart reads {U6} and writes nothing`; `DF5 {U1, U3, U5}: the association wins — published once, one published wakeup, no closed or stale`; `DF5o {U1, U3, U5, U6}: published with the associated revision, never the orphan, which is kept`; `paired witnesses: R3/R0 published, R2 published, R0 open, R1 open, R4 published, R3 and R4 open`; `the DF fixtures classify excluded with their complete reason sets`
- **Observed.** error: expect(received).toEqual(expected)
- **Status.** killed; restored to the HEAD blob: yes

## MU20

- **Oracle.** H29 witnesses, DF4a, DF4b, DF5o
- **Edit.** `src/server/__tests__/helpers/handoffClassifier.ts`: `associationPresent: String(!!associated), unassociatedReservedKeyPresent: String(!!orphan),` → `associationPresent: String(!!associated), unassociatedReservedKeyPresent: 'false',`
- **Pin.** HEAD `e4f01859540522143ce6d8ec83f9102534e1c8ae`; `src/server/__tests__/helpers/handoffClassifier.ts` blob `4dd752b4ee82388035526dac9c99aebc5601cc8f`
- **Ran.** `src/server/__tests__/taskHandoffDefensive.test.ts`, `src/server/__tests__/taskHandoffRestart.integration.test.ts`, `src/server/__tests__/taskHandoffCompleteness.test.ts` (exit 1)
- **Killed by** (4): `DF4a {U6}: an orphan reserved key with a current base is never fulfillment; nothing changes or is sent`; `DF4b {U3, U6}: stale only because the task advanced, one wakeup; a second restart reads {U6} and writes nothing`; `DF5o {U1, U3, U5, U6}: published with the associated revision, never the orphan, which is kept`; `H29: open with a current base and stale (behind, and the tolerated current) are unchanged with no mail; witnesses (1) and (2) classified first`
- **Observed.** error: expect(received).toEqual(expected)
- **Status.** killed; restored to the HEAD blob: yes

## MU21

- **Oracle.** H-PUB witnesses, U fact table
- **Edit.** `src/server/__tests__/helpers/handoffClassifier.ts`: `const associated = db.prepare('SELECT request_key FROM team_task_revisions WHERE task_id = ? AND handoff_id = ?').get(handoff.task_id, handoffId)` → `const associated = db.prepare('SELECT request_key FROM team_task_revisions WHERE task_id = ? AND handoff_id = ? AND request_key = ?').get(handoff.task_id, handoffId, preparedKey(handoffId))`
- **Pin.** HEAD `e4f01859540522143ce6d8ec83f9102534e1c8ae`; `src/server/__tests__/helpers/handoffClassifier.ts` blob `4dd752b4ee82388035526dac9c99aebc5601cc8f`
- **Ran.** `src/server/__tests__/taskHandoffCompleteness.test.ts` (exit 1)
- **Killed by** (1): `the observation reads the task-scoped association, not the prepared-key row: R3 and R0 published stay apart`
- **Observed.** error: expect(received).toEqual(expected)
- **Status.** killed; restored to the HEAD blob: yes

## Replay lookup removed (the prepared publish; a different control from MU14)

- **Oracle.** H14 replay lookup removed: the store replays the same key
- **Edit.** `src/server/team/taskHandoffService.ts`: `if (keyRow) {⏎      const revision` → `if (false && keyRow) {⏎      const revision`
- **Pin.** HEAD `e4f01859540522143ce6d8ec83f9102534e1c8ae`; `src/server/team/taskHandoffService.ts` blob `026a0f0c94261ef106ea2ca3a405e1632332a503`
- **Ran.** `src/server/__tests__/taskHandoffCommands.test.ts`, `src/server/__tests__/taskHandoffDrafts.test.ts`, `src/server/__tests__/taskHandoffScenarios.test.ts` (exit 1)
- **Killed by** (1): `H12/H14/H35/H13: the owner publishes with task_amend, extras are refused, and a former owner gets nothing`
- **Observed.** error: The publication handoff is published as revision 2 through its linked draft; nothing was published.
- **Status.** killed; restored to the HEAD blob: yes

## MU9a (registration)

- **Oracle.** CP1 (tool registration)
- **Edit.** `src/server/team/mailboxTools.ts`: `...mailboxSchemas, ...(management ? managementSchemas : {}), ...(tasks ? taskSchemas : {}),` → `...mailboxSchemas, ...(management ? managementSchemas : {}), ...(tasks ? (({ task_request_publication: _omit, ...rest }) => rest)(taskSchemas) : {}),`
- **Pin.** HEAD `e4f01859540522143ce6d8ec83f9102534e1c8ae`; `src/server/team/mailboxTools.ts` blob `bf201ab0711216fd72ec3877ceacbe357bcd3431`
- **Ran.** `src/server/__tests__/taskHandoffPublish.integration.test.ts` (exit 1)
- **Killed by** (1): `a Lead requests a publication, W2 asks the human, a reserved key is refused with and without a linked draft, the human publishes once with one delivered notice and wakeup, and resends replay`
- **Observed.** error: "tool task_request_publication needs a Zod object input schema"
- **Status.** killed; restored to the HEAD blob: yes

## H17r probe: claim before the key replay (equivalent)

- **Oracle.** H17r
- **Edit.** `src/server/team/taskStore.ts`: `const prior = this.resolveKey(id, input)⏎        if (prior) return prior⏎        const current = this.get(id)` → `input.claim?.(this.get(id)!)⏎        const prior = this.resolveKey(id, input)⏎        if (prior) return prior⏎        const current = this.get(id)`
- **Pin.** HEAD `e4f01859540522143ce6d8ec83f9102534e1c8ae`; `src/server/team/taskStore.ts` blob `e1c050946809c52bc99281854fab698349ddbe47`
- **Ran.** `src/server/__tests__/taskHandoffDrafts.test.ts`, `src/server/__tests__/taskHandoffScenarios.test.ts`, `src/server/__tests__/taskHandoffProperties.test.ts` (exit 0)
- **Status.** equivalent; restored to the HEAD blob: yes
- **Why equivalent.** A claim that throws before the key replay aborts the publish transaction, and the D2 arbiter's catch path (`TaskStore.publish`, `resolveKey` after the rollback) resolves the same key as its replay; a claim that does not throw is never acted on, because the replay returns before the claim's `within` runs. No input distinguishes the two orders, so no oracle can kill it.

## Fix controls for findings-c3e4ff8d (F6–F9)

Applied once each at the head named, restored by copy and re-hashed.

- **F9-ctl** (A8 delivered context (F9)). Edit: src/server/team/sessionMailbox.ts taskContext callback: delete pendingHandoff from buildTaskContext's result. Pin: HEAD e097a40d blob 3dee5479. Test: src/server/__tests__/taskHandoffPublish.integration.test.ts › a Lead requests a publication, W2 asks the human, a reserved key is refused with and without a linked draft, the human publishes once with one delivered notice and wakeup, and resends replay. Observed: 0 pass 1 fail: expected header to contain 'Pending publication handoff <H> (open) prepared on revision 1'. Restored: blob 3dee5479 re-hashed.
- **F8-ctl-a** (P6 published phase via task_get (F8)). Edit: src/server/team/taskHandoffRead.ts:65 phase: handoffPhase(...) replaced by 'acknowledged' as const. Pin: HEAD b304c949 blob 9672a830. Test: src/server/__tests__/supervisionOwnerPublicationProperties.test.ts › P6: seed 0x0A11CE06, 200 cases — attention, the supervision loader and task_get derive pending next actors and published phases alike. Observed: 1 fail: expected phase "task-closed", received "acknowledged". Restored: blob 9672a830 re-hashed.
- **F8-ctl-b** (P6 loader absence for published H (F8, S7)). Edit: src/server/team/taskHandoffFacts.ts pendingHandoffFact SQL h.state IN ('open', 'stale', 'published'). Pin: HEAD b304c949 blob aa61462a. Test: src/server/__tests__/supervisionOwnerPublicationProperties.test.ts › P6: seed 0x0A11CE06, 200 cases — attention, the supervision loader and task_get derive pending next actors and published phases alike. Observed: 1 fail: loader waits listed an owner-publication wait for a published handoff, expected []. Restored: blob aa61462a re-hashed.
- **F6-ctl** (H-DRAFT publish U7 exclusion (F6)). Edit: src/server/__tests__/helpers/handoffClassifier.ts H_DRAFT_PUBLISH claims [U7] -> []. Pin: worktree on 4ff1e2af, blob 4dd752b4. Test: src/server/__tests__/taskHandoffCompleteness.test.ts › ${partition.name}: each tuple of the full product is exactly one row or one excluded classification (H-DRAFT publish); publish: 8064 tuples, 3456 healthy and 4608 excluded {U7}, every row in check order; U7 witnesses: .... Observed: 20 pass 3 fail: U7 tuples became gaps. Restored: blob 4dd752b4 re-hashed.
- **F7-ctl-a** (P1 linked-draft fulfilment (F7)). Edit: src/server/team/taskHandoffDrafts.ts linkedDraftPublish claim.within -> no-op (no fulfil). Pin: HEAD c0bdf0c9 blob 0fcf775c. Test: src/server/__tests__/taskHandoffProperties.test.ts › P1: seed 0x0A11CE01, 400 cases — at most one associated revision, published iff associated, one wakeup per transition, no stray reserved key. Observed: 1 fail at the step: '<H>: open on revision 1 of 2 (U3)' (before the U3 invariant only the end-of-run reachability failed: linkedFulfilled false). Restored: blob 0fcf775c re-hashed.
- **F7-ctl-b** (P1/P2 Adapt path (F7)). Edit: src/server/team/taskStore.ts publish: skip handoffHooks.published when requestKey starts with 'pause:'. Pin: HEAD c0bdf0c9 blob e1c05094. Test: P1: seed 0x0A11CE01, 400 cases — at most one associated revision, published iff associated, one wakeup per transition, no stray reserved key; P2: seed 0x0A11CE02, 400 cases — after every command the items are exactly Table W's prediction from the rows. Observed: P1 1 fail '<H>: open on revision 1 of 2 (U3)'; P2 1 fail 'adapt: <H> is open, the model expects stale' (P2 survived before the transition model and the Adapt opening history). Restored: blob e1c05094 re-hashed.
- **F7-ctl-c** (P4 durable stale wakeup (F7; survived H29 and P4 at e097a40d)). Edit: src/server/team/taskHandoffHooks.ts:45 stale(): drop writeHandoffWakeup(..., 'stale', ...). Pin: HEAD 70d6f66d blob 706ae347. Test: src/server/__tests__/taskHandoffRestart.integration.test.ts › P4: seed 0x0A11CE04, 200 cases — a crash at any transaction boundary, then SessionMailbox.start(), leaves exactly the model state. Observed: 1 fail: model wakeups ['0:stale'], stored []. Restored: blob 706ae347 re-hashed.
- **F7-ctl-d** (P4 healthy sweep makes no writes (F7)). Edit: src/server/team/taskHandoffHooks.ts reconcileHandoffs: UPDATE updated_at for a healthy pending handoff. Pin: HEAD 70d6f66d blob 706ae347. Test: P4: seed 0x0A11CE04, 200 cases — a crash at any transaction boundary, then SessionMailbox.start(), leaves exactly the model state; H29: open with a current base and stale (behind, and the tolerated current) are unchanged with no mail; witnesses (1) and (2) classified first. Observed: 2 fail: 'the sweep wrote' updated_at differs. Restored: blob 706ae347 re-hashed.
- **F7-ctl-e** (DF sweep faults roll back whole (F7)). Edit: src/server/team/taskHandoffHooks.ts reconcileHandoffs association branch: try { writeHandoffWakeup(...) } catch {}. Pin: HEAD 70d6f66d blob 706ae347. Test: src/server/__tests__/taskHandoffSweepFaults.integration.test.ts › DF1: a fault at each sweep write rolls the repair back; the next boot repairs once with one wakeup and mail; a later boot writes nothing (and DF5). Observed: 2 fail (DF1, DF5): expected 'sweep fault', received 'started'. Restored: blob 706ae347 re-hashed.
