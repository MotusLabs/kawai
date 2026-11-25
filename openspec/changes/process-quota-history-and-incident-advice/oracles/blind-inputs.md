# Blind second reading — inputs only (A1)

Task 0.1 of this change. This file holds the inputs of Tables S and F with
every output `?`. The reader fills each `?` from the specifications alone:

- `openspec/specs/chat-usage-limits/spec.md` (main; the background quota
  requirement and its scenarios "Eligible alternative without a live chat",
  "Background provider configuration", "Unused alternative stays observable",
  "No standalone reader", "Pulls stop without live sessions");
- the delta specs under `specs/` in this change directory.

Do **not** read `design.md` "Acceptance oracles" or `tasks.md` of this change
before writing the outputs: they hold the author's reading. Design D2's
numeric parameters are given below as inputs, since the specs state the
mechanism (timeout, jitter, bounded backoff) without numbers.

Given parameters (design D2): ten-minute cadence; one poll at startup and on
configuration change for standalone readers; at most one request in flight
per effective account key; ten-second request timeout; jitter ±10% of the
cadence; backoff 1, 2, 4, … minutes after consecutive failures, bounded at
30 minutes, reset on success; shutdown cancels timers. Headroom freshness
bound: 10 minutes.

## Table S — scheduler per account key

Axes. Reasons: `none`, `session`, `worker`, `both`. Reader: `standalone`
(a quota endpoint Kawai can call itself), `agent-only` (usage only through a
running agent, e.g. a host-login SDK pull). In flight: whether a request for
the key is outstanding.

| id | reasons | reader | in flight | event | → requests / state |
|----|---------|--------|-----------|-------|---------------------|
| S1 | none→worker | standalone | no | subscribe | ? |
| S2 | worker | standalone | no | tick | ? |
| S3 | worker | standalone | yes | tick | ? |
| S4 | worker | standalone | yes | timeout (10 s) | ? |
| S5 | worker | standalone | no | 3rd consecutive failure | ? (state the next delay) |
| S6 | worker | standalone | no | success after failures | ? |
| S7 | worker→none | standalone | * | unsubscribe | ? |
| S8 | both→session | standalone | * | worker removed | ? |
| S9 | worker | agent-only | no | subscribe | ? |
| S10 | session | agent-only | * | spawn pull | ? |
| S11 | * | * | yes | shutdown | ? |
| S12 | worker | standalone | no | restart | ? (state of the in-memory latest report and of history) |
| S13 | worker (two teams, one key) | standalone | no | tick | ? |
| S14 | worker | standalone | * | config change of credential | ? |

Completeness: also state which combinations of reasons × reader × in-flight
× event you consider unreachable, and why: `?`

## Table F — headroom evidence

Output: may the value establish headroom for the routed provider?

| id | age | reset passed | later failure/limit | account | → evidence |
|----|-----|--------------|---------------------|---------|------------|
| F1 | ≤ 10 min | no | no | routed provider | ? |
| F2 | > 10 min | * | * | * | ? |
| F3 | * | yes | * | * | ? |
| F4 | * | * | yes | * | ? |
| F5 | * | * | * | unrelated host login | ? |
| F6 | status-only push, windows 20 min old | no | no | routed | ? |
