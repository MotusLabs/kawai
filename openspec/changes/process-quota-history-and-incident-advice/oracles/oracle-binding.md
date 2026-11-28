# Oracle binding — Tables S and F (A2)

Task 0.1. The inputs are in `blind-inputs.md` (A1, commit `c2fb33ea`). The
other-family outputs are in `blind-reading-sol.md`. The author's outputs are
the "→" columns of Tables S and F in `design.md`, "Acceptance oracles",
unchanged since the reviewed proposal.

## Diff

The reading agrees with the author's output on every row S1–S14 and F1–F6,
and on the completeness claim: periodic dispatch needs a standalone reader
and a reason; `none` has no armed timer; `agent-only` has no tick; a
subscribe on an armed key only adds a reason. No output changes.

The reading raised the ambiguities below. Each is resolved here without
changing any output. These resolutions bind the executable tables.

## Resolutions

- **B1 (S1, S12, S14).** A worker subscription for a key that had no worker
  reason triggers one request now, whether or not a report is held. That
  subscription comes from a startup, a configuration change, or a newly
  listed worker. A subscription to a key that already has a worker reason
  adds only the team (S13).
- **B2 (S4, S5).** Backoff delays after consecutive failures are exactly 1,
  2, 4, 8 and 16 minutes, then 30 minutes from the sixth failure on. They are
  not jittered. Jitter (±10%) applies only to the ordinary cadence.
- **B3 (S7).** A request already in flight when the last reason goes is
  drained, not aborted. Its settlement is recorded with its original reason
  and time. No later request starts and nothing is rescheduled.
- **B4 (S11).** Shutdown cancels every timer but does not abort transport. A
  settlement after shutdown publishes nothing and records nothing.
- **B5 (S14).** The effective key includes an in-memory hash of the
  credential, so a changed credential is always a new key, polled once when
  it is idle. A configuration trigger on a busy key starts nothing (S3). A
  settlement for the old key keeps the old key's identity and time. The
  persisted account alias is `provider@host` and carries no credential.
  Writer resolution (Sol re-check note-d5b9f0e9): a request spans two
  instants, so its recipients are captured under its key, at start and at
  each joining session. A settlement adds later recipients only while they
  still hold the key. No live path (worker settlement, spawn pull, session
  tick) publishes a key the provider no longer holds. Every pull has the
  target's own credentials redacted before any caller sees it
  (decision-1e654933). This covers every nonempty token and balance key,
  matched case-insensitively:
  - Approved kinds keep their key, and keep their label unless it carries a
    credential; then they take the table label.
  - Any other credential-bearing window becomes the opaque
    `<prefix>unknown#n`, numbered past every key the report holds.
  - Credential-bearing free text becomes `[redacted]`.
- **B6 (S8, S10).** The session reason keeps today's fixed per-provider
  cadence and spawn pull (A2: the session tests stay unchanged). A worker key
  whose provider's session cadence resolves to the same key is served by
  that cadence and issues no request of its own. When the session reason
  goes, the worker schedule resumes on the same key.
- **B7 (F1).** A window shows room when its percent used is below 100. An age
  of exactly 10 minutes is fresh (`≤`).
- **B8 (F3).** A reset at or before the cutoff has passed.
- **B9 (F4).** "Applicable" means the same provider and account alias.
  - A `failed`, `auth-refused` or `unavailable` observation vetoes every window
    of that account when it is at or after the window's observation time and
    at or before the cutoff.
  - A final limit event of the provider in the same interval vetoes in the
    same way. A model-scoped limit (`seven_day_opus`, `seven_day_sonnet`)
    vetoes only the window with that key.
  - Ties veto.
  - A failure or limit on another provider or account never vetoes.
- **B10 (F5).** An observation whose basis is `host-login` never establishes
  headroom for a routed provider. Its source stays recorded.
- **B11 (F6).** Window age is the window's own observation time. A status-only
  observation stores no windows and never changes a window's age.

## Clarifications recorded with the binding

The Lead recorded Tables S and F as binding in decision-760c0f6f (task note
`note-a0493f93`), adding two clarifications:

- **(a) The B3 drain transient is reachable.** It is the state with no
  reasons left, a standalone reader, and a request in flight. It then sees a
  timeout, a settlement or a shutdown. B3, B4 and S11 govern it. The
  completeness test classifies it as covered, not unreachable.
- **B12 (F1).** Headroom needs a window that this process observed under the
  candidate's effective key, including its in-memory credential identity, as
  it stood at the cutoff.
  - A window observed with another or an unknown credential at the same
    `provider@host` never establishes headroom. Capacity stays unknown until
    a poll runs under that key.
  - Vetoes stay alias-wide (B9).
  - The in-memory hash falls under I2/P4.
  - It is persisted only as an HMAC under a per-process salt, the
    `account_scope` column.

## Completeness ruling (decision-ed5e5e77, note-db07f142)

Option A. The domain keeps all 176 combinations. Each one falls in exactly
one class of `src/server/__tests__/quotaReaderTableSCompleteness.test.ts`:
a literal row S1–S14, a bound rule applied through a stated equivalence, or
an unreachable claim with its reason. Each reachable class names the exact
tests that exercise it. The test fails on a gap, an ambiguous match, a
literal row outside its own class, or a named test that does not exist.

- **Pre-event versus settled.** The axes are pre-event. The exception is the
  two settlement events: their in-flight axis is the settled state, as rows
  S5 and S6 record it. "Yes" there can only be a late answer to an attempt
  abandoned at the bound while a new current request runs. That answer is
  dropped (S4, P1).
- **Repeated subscriptions.** A repeated subscription on an armed key adds
  only the team (B1, S13), and an in-flight settlement reaches the new team.
  A subscription during the B3 drain joins the drained request.
- **Drain and shutdown.** B3 drains and B4 shutdown apply even when no new
  request starts.
- **Credential change.** B5 keeps an old-key settlement under its own
  identity and out of the live report.
- **Session cadence.** B6 serves a worker key only from a session cadence
  whose target resolves to the same effective key.
- **Agent-only keys.** S9 and S10 semantics hold, and lifecycle changes
  still record: a second team, removal and re-add, a restart and a
  configuration change each record one `unsupported` observation.
- **Count.** 100 combinations are reachable and 76 unreachable. S1–S14
  outputs and the bound rules are unchanged.
