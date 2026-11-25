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
