# Author outputs (sealed; A2 draft) for owner-publication-handoff A1 @ 16fe6097

Not on any branch until the cross-model advisor has recorded its blind
output. Rows copied from design.md's tables keep design's Result text
verbatim (Table H, DF, W, F, S, U lists); only the extra A1 rows are new.
Open cases K1-K5 (task journal CASES 1/2) are marked where they bear.

## H common
H4: same not-found as an unknown id; nothing written. H16: not found; nothing written.

## H-REQ: as design Table H-REQ (H10..H1 Result column verbatim).
Combined-failure rows:
- authorized, closed, behind -> H3 (status before base).
- new key, group cannot create, closed -> H5.
- replay-same, task closed since -> H10 (returns current state; nothing written).
- malformed contract + oversized rationale -> H7, naming the contract parse problem (field order: contract parse before rationale/size).
K5: H10 returns H to any session replaying same key+payload (key per task); pending Lead decision.

## H-PUB: as design Table H-PUB.
Classification: healthy (R,state) pairs = R0 x {open, stale, declined, withdrawn, superseded, closed}, R2 x published, R3 x published -> 8 pairs x 4 (right x extras) = 32 tuples; 108 excluded.
Excluded reasons: R0 published {U1}; R1 non-published {U6}; R1 published {U1,U6}; R2 non-published {U1}; R3 non-published {U1}; R4 published {U6}; R4 non-published {U1,U6}.
Witnesses: R3 pub -> {} H16b (names linked revision); R0 pub -> {U1}, no row; R2 pub -> {} H14; R0 open -> {} H12; R1 open -> {U6}, no row (DF6); R4 pub -> {U6}, no row, orphan never returned (DF6p); R3 open -> {U1}; R4 open -> {U1,U6}.
K2: order key(H14) before right(H13) per design; pending Lead decision. K3: extra fields = direction/acceptance/contract per D3; pending decision on rationale/notify.

## H-DRAFT: as design Table H-DRAFT.
Whitespace H33d variants: all four refused naming the reserved key; nothing written; draft unchanged; H open.
Traces: linked then prepared -> H16b refused naming published + linked revision; prepared then linked -> H38s stale-base refusal, no second revision; linked with derived key -> H33d refused (nothing written), then prepared -> H12 publishes N+1 normally.
K4: U7 reachable via draft rebase/base-changing save; author proposes save keeps link at same base, rebase/base change clears it.

## H-OTHER: as design. Whitespace: four reserved variants refused, H open, after restart H open (H29), no mail. Padded ordinary key -> published stored trimmed; resend with other padding -> replay returns that revision (H39).
K1: prefix check before team/id (author reading).

## H-SETTLE, H-CLOSE, H-NEUTRAL: as design tables (H23..H24, H27/H40, H28/H28b).

## H-RESTART
H29 tuples: assoc false, orphan false, task open, (open,current) or (stale,current) or (stale,behind) -> 3 tuples. Others: reasons from U1 (assoc true with pending), U3 (open,behind), U5 (closed), U6 (orphan true), all kept together.
Witness (1): {} H29, nothing written/sent. (2): {U6}, no row, sweep writes/sends nothing.
Scenarios: crash after publish commit -> published, exactly one message dispatched after start (wakeup queued in txn); refused reserved key then restart -> H open, no mail; open+declined restart -> unchanged, no mail; stale H restart -> stays stale.

## U table: as design "Unreachable, with reasons" and the claim/observation table. All "Reachable: no" EXCEPT U7: author finds it reachable today via rebase (K4) unless the draft link rule is bound. W-U1 = U5.

## DF: as design Table DF (U_reasons and Result verbatim); matching row: none for each.
CP3: DF3 fixture -> stale naming newest revision, one wakeup mail dispatched; healthy open -> open, no mail.

## Wakeups
published/live -> 1, requester session; published/archived -> 1, requester group; declined/live -> 1 session; stale/archived -> 1 group, none to archived session; closed/context-exhausted -> 1 group; superseded -> 0; withdrawn -> 0; replay or second sweep -> 0 more; dead-letter -> transition kept, mail visible as dead in Mailbox.

## W, F, S: as design tables.
Published-phase outputs: W5 task-closed none; W6 acknowledged none; W7 no-holder Kawai "Wait for Kawai"; W8 no-holder human "Hand off the task"; W12d delivered-awaiting-ack holder wait naming delivered/acknowledged; W9 notice-uncertain human Mailbox link; W12 notice-queued holder wait; W10 notice-failed human Retry notification; W11 not-notified human Notify. W13 none.
History rows: (a) W6, none, neither offered; (b) W12d, holder wait, neither; (c) W6, none, neither; (d) W9, Mailbox, neither; (e) W12, holder wait, neither; (f) W5, none, neither (no Hand off item); (g) W11, human Notify, Notify.
Parity: notify writes a new row exactly in W10 and W11 among live-claimant open below-ack rows; offered exactly there. In W5/W6 notify may still write (P7a) but nothing is offered.
F: as design F1-F5; cause names submitter archived (F2-F5) and no session running the task (F3-F5).
S: as design S1-S6, S7-S10. Limits: both count; third waits on parallel limit; dependents still wait; slot holder unchanged.

## Agent reads
task_get while open: handoff row (open, base, requester, payload hash), direction = published revision's. Foreign handoff_id: not found. Delivered context: revision 1's direction, one line naming pending handoff. Draft unchanged by a request.
