# Blind second reading — other-family outputs (Codex Sol)

Reader: Codex Sol session `chat-c0a4f521-c8f4-450a-b0a9-0a90d515f3fd`
(`reviewers-sol`), advisory task `task-2f3b917a-4d4d-404f-a696-6d5f09d72634`
r1, reading the inputs-only packet `blind-inputs.md` at commit
`c2fb33ead6336d83c87e6e313f81ceba34f1ba62` from the specifications alone. The
reader states every row and citation was recorded before any author reading,
design, tasks or parent journal was opened. Copied verbatim from its journal
notes `note-5e6ec39e-e47f-4507-979a-f49114d827d5` (Table S),
`note-99fa81a5-ebe0-4033-90da-d09003c5a4b0` (S completeness and Table F) and
`note-32d166d6-5042-47c8-9df9-05e18a5eea41` (ambiguities).

Source key: I = `oracles/blind-inputs.md`, M = `openspec/specs/chat-usage-limits/spec.md`,
Q = this change's `specs/chat-usage-limits/spec.md`, O = this change's
`specs/process-observations/spec.md`, R = this change's
`specs/process-recommendations/spec.md`.

## Table S

- S1 — One standalone pull when the newly eligible key has no report (or the subscribe is its startup/configuration trigger), with the recurring schedule active while the worker remains. Resolve from the worker's effective config. No agent/model request. I:17–22; M:70–71,101–103,136–138,159–160.
- S2 — One standalone pull on a due tick, only if the key is idle. Use the ten-minute cadence with ±10% jitter in normal operation. I:17–20; M:159–160,186–188; Q:5–6.
- S3 — Zero additional requests. Keep the outstanding pull as the sole request for that effective key. I:18–19; Q:5–6.
- S4 — At 10 s the attempt times out and releases the logical slot. Record the failed attempt, preserve held window values and timestamps, and schedule the next attempt under failure backoff. Zero immediate replacement requests. I:19–21; M:159–160,293–295; Q:5–6,12–14; O:5–6,12–14.
- S5 — Third consecutive failure makes the next nominal delay 4 minutes (1, 2, 4). Keep held window times and apply the 30-minute ceiling to the backoff progression. Zero immediate requests. I:19–21; Q:12–14.
- S6 — Clear the failure streak/backoff. Resume the ordinary ten-minute cadence with jitter. Record the successful observation and apply matching, newer window data to the live report. Zero immediate requests. I:17–21; M:159–160,178–180; O:5–6.
- S7 — Zero further polls. Drop future scheduling when the last reason is removed. This result covers idle and in-flight forms; disposition of an already-started request is a separate ambiguity below. M:159–160,166–168; Q:5–6,16–18.
- S8 — Keep one active schedule for the key and let the live session continue to qualify it. Worker removal issues zero immediate requests by itself. An active request still occupies the key's slot. M:159–160,166–172; Q:5–6; I:18–19.
- S9 — Zero requests and no agent start. Report the missing standalone reader; capacity is unknown or stale in the absence of a running agent. M:159–160,190–192; Q:5–6.
- S10 — An already-started agent may perform the on-demand usage pull when the matching report is absent. Issue one pull if idle and zero additional pulls if one is already in flight. No recurring standalone polling for the agent-only reader. Keep the host-account provenance where applicable. M:70–87,159–160,190–192; O:5–10; I:18–19.
- S11 — Cancel timers and stop scheduling. Zero new requests and suppress publication from the in-flight attempt after shutdown. I:21; M:182–184.
- S12 — Start with no in-memory latest report or usage bar. Keep persisted historical observations with their original identity and ages, subject to ordinary retention. A qualified standalone reader makes one startup pull. I:17–22; M:55–56,66–68,174–176; O:5–6,23–28.
- S13 — One request for the shared effective key. Both team histories receive its observation. I:18–19; Q:8–10.
- S14 — Re-resolve the effective configuration and make one configuration-triggered pull using the new credential, subject to one in flight per effective key. Move the worker reason to the new key if the credential changes effective identity. With no remaining reason on the old key, stop future old-key polls. Preserve old observations under their original identity and do not persist credentials. I:17–21; M:105–106,136–138; Q:5–6,16–22; O:5–6.

## Table S completeness

Read the axes as scheduler events on a single effective key, with pre/post snapshots distinguished where the row gives a reason transition.

- Periodic standalone dispatch requires standalone reader + worker/session/both. With none there is no armed scheduler after reconciliation, and with agent-only there is no standalone timer or request. A stale timer callback, if delivered, cannot dispatch. A session-only or both standalone key can exercise the same idle tick, busy tick, timeout and settlement edges as a worker-only key. I:24–29,31–46; M:159–172,186–192; Q:5–6,16–18.
- Agent-only spawn pulls require a started session (session/both), with the absent-report and one-pull guards. From worker-only or none, a real session start changes the reasons before its pull; the worker reason by itself can never launch an agent. Agent-only in-flight under worker/none cannot be initiated in that state. A session pull issued before a reason disappears may transiently remain pending if the implementation drains it. M:70–87,190–192; Q:5–6.
- A request timeout requires an outstanding request. Failure/success settlement requires a request that was outstanding, although S5/S6 show in-flight=no after release, and a late result from an already-ended attempt cannot be a second settlement. A third consecutive failure requires two prior failures on that same key since success. I:18–21,35–38; Q:5–6,12–14.
- A fresh process cannot restart with an inherited in-flight request, even if the prior process shut down with one. Shutdown itself can occur idle or busy. After shutdown, requests and publication are disallowed. I:17–21,43–44; M:174–184.
- Subscription transition none→worker requires the first worker reason and no session reason. The specified worker→none and both→session removal edges require the last worker reason; worker removal cannot take a session-only key to none. Removing only one of two same-key team subscriptions leaves the worker reason. Credential/config changes can occur idle or busy; a background poll from that event still requires a qualifying standalone key and the one-in-flight guard. I:17–21,26–29,33,39–46; M:136–138,159–172; Q:5–10,16–18.
- 'None + in flight' is unreachable as a fresh dispatch or stable scheduled state; a pre-existing attempt at or just after removal is distinct. Do not exclude it as a transient solely from the specs. I:39,48–49; Q:5–6,16–18; M:166–168.

## Table F

- F1 — Yes, the window is admissible headroom evidence if the actual usage shows room and the window applies to the routed account/model. At exactly 10 min it passes the age bound. I:21–22,53–57; O:5–6,16–17; R:12–14,20–25.
- F2 — No. The window is older than ten minutes at the evidence cutoff. Keep its original age for explanation. I:21–22,58; O:5–6,16–17; R:12–18.
- F3 — No. A reset that has passed makes the old window insufficient to infer current capacity, including where the old age is within ten minutes. Require new evidence for the new window. I:53–59; M:159–164; O:5–6,16–17; R:12–18,20–21.
- F4 — No for the affected account/window as presented in the row. A later applicable failure leaves the old value visible without evidencing current headroom; an applicable limit supplies evidence of constraint, not of headroom. Consider only events available at the evidence cutoff. I:53–60; O:5–6,12–17; R:16–25. The generic-failure reading is an inference described in the separate ambiguity note.
- F5 — No. The unrelated host login can appear with its own source, but does not establish routed-provider capacity. I:53–61; M:70–71,85–91; O:5–10.
- F6 — No. Age follows the window's own observation time (20 minutes), even if the status-only receipt is current. I:21–22,62; M:20–22; O:5–6.

## Ambiguities

- S1: Fresh subscription alone is not listed among the immediate D2 triggers (blind-inputs.md:17–18). The main chat-usage-limits spec :70–71 requires an on-demand pull if a newly eligible provider has no report, but S1 does not state whether a report is already held or whether subscription is a startup/reconfiguration transition. With an already-held report and no startup/config trigger, maintaining the cadence is the explicit requirement.
- S5 (including S4's retry): D2 gives the nominal delay sequence and jitter as a percentage of cadence, but does not say whether jitter also applies to retries, or how it would interact with the 30-minute bound. The exact unjittered third delay is 4 min (blind-inputs.md:19–21; chat-usage-limits delta :12–14).
- S7/S11/S14: The main spec :166–168 and chat-usage-limits delta :16–18 prohibit new requests after the last reason disappears, while the main spec :182–184 explicitly suppresses publication on shutdown. Transport abort versus drain on last-reason removal and physical abort on shutdown are not specified. S14 also does not state if credential changes always produce distinct effective keys or how to handle a config trigger arriving while the same key remains busy. No old-key response may be relabeled as new-key data (process-observations delta :5–6). S8 assumes, as its reason transition implies, that the remaining session qualifies the same key.
- S10: One-pull behavior is explicit for the same provider (main chat-usage-limits spec :70–83); cross-provider agent/SDK coalescing on shared host login is not explicitly given by that scenario. D2's per-effective-key cap applies to Table S as posed.
- F3/F4: The expired-window interpretation follows from the reset denoting a new window and the need for fresh capacity. F4 combines a failed observation and an actual limit. The process-observations delta :5–6,12–17 explicitly preserves the failed attempt and original window time, but does not itself state that every later refresh failure invalidates a still-fresh matching window. The conservative 'no' in F4 treats the failure as withdrawing affirmative headroom for that same scope, with capacity unknown; an applicable limit instead supports a limited state (process-recommendations delta :12–25). A failure on an unrelated account or model scope supplies no such veto. The input does not define the exact reset-time equality boundary or tie ordering for a failure and window with equal timestamps.
