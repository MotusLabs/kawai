# Design

## Context

For motivation, see proposal.md › Why. Its figures and the per-repository counts that follow were supplied by the original author and are unverified: no live database, backup, or timing was read for this design, and none may be until a separate authorization (D9).

Today's metrics pipeline works like this:
- `loadMetricsInputs` (`src/server/metrics/metricsQuery.ts`) reads SQLite inside one read transaction. Its cohorts come from in-range events (first `done`, status events, results, findings), and its projections carry no `openspec_change`, `plan_change`, or `commit_ref`.
- `computeMetrics` derives every family purely, for the window and for the preceding window, at `inputs.end`.
- `MetricsReader` caches one read per (team, window, slice) for 30 s, always ending at the read time, and returns the stored `ProcessMetrics` as is on a hit (`computeMetrics.ts`). Nothing re-derives any state at return time today.
- The Metrics tab, `team_metrics`, and report snapshots all share that reader.
- Definitions, guards, and the sample threshold are constants in `src/shared/processMetrics.ts`. `tokens_total` is a sum whose `n` is the usage rows: with no rows it reads value 0 with `n` 0, and `docs/operations/process-observability.md` states that missing usage is excluded rather than zero.

There is no git input and no push path to the attention queue. `WorkspaceRead.snapshot` (`src/server/team/workspaceRead.ts`) is synchronous and folds the `ATTENTION_SOURCES` over one `AttentionInput`. `WorkspaceConnections` owns the workspace subscriptions and coalesces `publish(teamId)`.

Git: `runGitAsync` (`src/server/git/gitCommand.ts`) is the read-only runner. It kills a call at its timeout and resolves it as a non-success with a null exit code, and it clips a successful stdout at `maxOutputBytes` (1 MiB by default) without saying so. Result checks already treat `refs/remotes/origin/HEAD` as the base "as last fetched".

Export: `registerMetricsRoute` and the Prometheus families are unchanged by this landing; delivery export is follow-up work (proposal › Follow-up).

## Goals / Non-Goals

**Goals:**
- Delivery facts become one derivation from one pinned head, consumed by the metrics read, the Metrics tab, `team_metrics`, and the attention queue alike (oracle hazard "several readers disagreeing on derived state").
- Metric computation stays pure and synchronous. Git runs only in a refresh step outside the SQLite read.
- A fact Kawai cannot establish reads unavailable or unknown, never 0, never landed.
- Currentness is decided once, by the return-time projection over the live ref state (D2), on every live return including cache hits; identity never stands in for it.
- A delivery count that cannot be established is excluded and counted by reason, never hidden; existing metrics keep their legacy semantics (D3a).
- Missing delivery evidence reaches the human through one attention item (D4).

**Non-Goals:**
- No delivery metric is sliceable. All are team-side.
- No per-PR identity from GitHub. Integrations are first-parent commits, read without `gh`.
- No claim about when an observer learned a fact. Committer time is a proxy for arrival.
- No change to `process-observability`'s contracts, its acceptance cohorts, or its pending integrations (D8).

## Decisions

### D1 — Facts come from one pinned head, read whole

**Head.** The dormant `DeliverySourceResolver.resolveHead(location, now)` resolves H without a process. Its explicit location names the common directory and main checkout; it does not invoke repository discovery. Canonicalize both paths anew per resolution, allowing symlinked host ancestors. Pin the physical common directory by an open descriptor; walk inner metadata using non-following directory/file opens. Relevant leaves must be regular files. Close all owned descriptors; unsafe/unreadable/changing metadata fails closed. Physical identity is location evidence, not liveness or currentness.
- Origin HEAD contains a lowercase full literal id of the actual object format, or `ref: <name>`. Validate the entire ref name before joining paths. Follow at most five symbolic edges; reject loops, a sixth edge, malformed text or missing targets. Fresh loose refs win; only missing loose consults `packed-refs`, validating comments/peels and rows. Missing common directory or origin HEAD gives `no-default-branch` with `git remote set-head origin --auto` guidance; other unsafe/unreadable metadata gives `default-branch-unreadable`.
- Ref text is capped at 4 KiB; config and packed text at 64 MiB bytes. Never accept a truncated prefix. Strict local config supports versions 0/1, absent format defaults to sha1, and explicit sha1/sha256 requires version 1. Includes, malformed/conflicting values, unsupported extensions or ref storage fail closed. Keys on section-header lines and `extensions.worktreeConfig` remain conservatively unsupported; no broader allowlist or 1.1 parser change is implied. Reuse the accepted pure object-format validator.
- `shallow` gives `history-incomplete:shallow`; `info/grafts` gives `history-incomplete:grafts`. Any partialclone, true remote promisor, present remote partialclonefilter or regular `objects/pack/*.promisor` gives `history-incomplete:partial`, without process, repair or fetch.
- Fresh snapshots require bigint dev/ino/size/mtimeNs/ctimeNs before consuming data AND after reading; missing precision refuses, never ms-only or undefined equality. Every packed lookup opens/validates and READS the complete bounded raw-byte snapshot, including parse-cache hits. Reuse requires physical repository/identity/format, trusted metadata token AND matching SHA256 of those bytes; hash and parser consume the SAME per-open snapshot, never two versions. Changed digest reparses even when all token fields collide; null token always reparses. Read/change/UTF8/parse/hash failures invalidate, never fall back. No timer/lease/generation or timestamp-distinction assumption: parsing can be saved, I/O repeats. Native capabilities and cost remain unmeasured; no RAM-bound claim.

**Implementation boundary.** P's dormant process-free helpers and supplied-text validation are committed; the existing `deliveryHead.test.ts` passed 26 tests on committed `5d9019f2`. S1's codec is committed. S2's per-operation anchor-bootstrap source, isolated bootstrap unit tests and small checkpoint commit are released only by the current task direction; all other runtime and activation holds remain. `prepareAnchorStartup()` constructs one `{argv,env,cwd,dispose}` handle immediately after root acquisition. Later setup failure attempts its disposal once: successful disposal rethrows the original setup error; double failure throws native `AggregateError` with those same setup/disposal errors in order, `cause` equal to the setup error, and an own readonly nonenumerable `startup` property holding that same handle. Pre-root failure carries no handle. The future context must adopt a failed-disposal handle into its existing operation record before returning failure and never spawn incomplete bootstrap data. Its physical root stays pending JOIN or failed disposal; retained logical evidence alone does not keep a disposed root. Remaining F0 runtime, repository-gate implementation/tests, the reader, CP1 and task 1.2 completion stay held on actual D11 startup/on-taken/lifetime acceptance; an empty startup map is not recovery. No product caller, cache/controller or activation follows this subset. Actual 1.3/2.3 composition checkpoints remain mandatory.

**Reads.** Every git call names the literal object id H, never a ref, so a fetch during a refresh cannot mix heads. Each runs at the main checkout through `runGitAsync` with `cleanGitEnv`, `git --no-replace-objects -c log.showSignature=false`, a 10 s timeout, and `maxOutputBytes = DELIVERY_READ_BOUND` (64 MiB). There are two reads:
1. **Graph.** `git log --format=%H %ct %P H` loads H's whole history. There is no `--since` and no horizon: `--since` stops a walk at an old-dated commit and would hide newer ancestors behind it.
2. **Archives.** `git log --first-parent --no-renames --diff-filter=A --name-only --format=@%H H -- 'openspec/changes/archive/*/proposal.md'`. `--first-parent` implies first-parent diffs for merges. `--no-renames` makes an archive done by `git mv` read as an addition whatever `diff.renames` says.

The lifetime integration count is the first-parent chain length derived from read 1, so it is pinned with the rest. No `rev-list --count` and no `merge-base` runs.

**Completeness (Table F).** A read is accepted only when:
- it exits 0;
- UTF8 stdout byte length is below `DELIVERY_READ_BOUND` on both reads, so clipped output is never read as history; both future runner calls explicitly receive the bound, and post-buffer code-unit clipping is not a memory cap;
- rows have canonical full ids and safe integer seconds converted once to milliseconds; unique rows/parents form a DAG wholly reachable from H;
- read 1's first row is H, and every named parent has a row. Validate this before read 2; a missing parent is `history-incomplete`. Truncation always drops some commit whose children remain, so this closure check detects a lost tail or missing object;
- read 2's canonical headers lie on the complete first-parent chain; every path matches the accepted single-directory archive grammar. Empty archive history is valid; malformed/nested/stray input fails the whole parse as `archive-malformed`. Reuse 1.1 landing/archive derivations.

Any other outcome fails the refresh with a named reason. A non-zero exit, a null exit (timeout or kill), and a spawn failure are all failures; none means "not contained". A history past the bound is `history-exceeds-bound`, never a partial answer. Raising the bound is a reviewed constant change.

**Commit refs** (`resolveResultCommit`, pure) accept only a canonical full literal object id. Its length is set by the repository's actual object format, read as text from the common directory's `config`: 64 hex digits when `extensions.objectformat = sha256`, else 40. Then:
- A literal in H's graph has a known identity and the landing of its position (D3).
- A literal not in H's graph has a known identity only when the same result has corroborating check evidence. That means a `team_task_result_checks` row of the same team, task, and result with `status = 'done'` and `facts.version = 1`, whose `facts.commit.status` is `'pass'`, whose `facts.commit.given` equals the literal `commit_ref`, and whose `facts.commit.sha` equals the same full id. Every field consumed is validated by the metrics read itself, because `ResultCheckStore.parseFacts` only tests the version and casts. The evidence records the check's id, `seq`, and `finished_at`. Such a commit is known and not landed.
- Everything else is **unresolvable**:
  - an abbreviation or symbolic text, even when a check later resolved it;
  - a literal of the wrong length;
  - an off-graph literal with no such check, or with a pending, unavailable, failed, malformed, partial, or other result's check;
  - a literal with two contradictory checks.

  It is never counted as landed, never as known-not-landed, and is excluded from `landed_result_share` and counted in its coverage counts.

No prefix search, no read-time ref resolution, and no new checker run happen for a metric read. A metric read never treats a passing commit fact as an accepted result or passing tests.

Alternative considered: keep a 98-day `--since` graph with a `merge-base --is-ancestor` fallback. It loses in-window integrations behind old-dated commits, adds an exit-code ambiguity (exit 1 = not an ancestor, other non-zero = error), and reports "landed, time unknown", which cannot answer "contained by T". The whole graph is bounded by the closure check and the byte bound instead. Its size and time on any real repository are Unknown until measured under D9.

Alternative considered: resolve abbreviations by a unique prefix among H's ancestors, or through the earliest check that resolved them. A prefix unique in H's graph can still be ambiguous in the repository (commit C landed, an unmerged D shares the prefix), and a later check can resolve a moved name. Both were rejected.

### D2 — Immutable facts, live ref state, and one return-time projection

Three kinds of state are kept apart. Identity never stands in for currentness.

**G, an accepted facts generation (immutable).** Its identity is (team's repository, actual object format, H, `DELIVERY_READER_VERSION`). It holds read 1's graph and read 2's archives for H. The facts depend on H alone, so the fetch stamp is not part of it. `DeliveryFactsCache` (`delivery/factsCache.ts`) holds per team at most one accepted G, and consumers never see a half-built one.

**S, the live ref state.** `refState(team)` re-reads S on every call by bounded, synchronous, process-free file reads in the common directory (D1's head resolution plus a stat of `FETCH_HEAD`). It holds:
- `hNow`: a full id, or `unreadable` / `shallow` with the reason. It is freshly resolved, never a cached pending fallback;
- `fetchAt`: ONLY common-directory/main-worktree `FETCH_HEAD` mtime, or unknown. Convert captured BEFORE bigint mtimeNs by integer division by 1000000n BEFORE Number, with no second double stat. Negative/missing precision or missing/nonregular/symlinked/unreadable evidence is unknown. Floor finite nonnegative supplied `now`; normalized future evidence is unknown, no tolerance or `Date.now` fallback. This is timestamp provenance, not repository-wide fetch success/coverage. Linked-only or `--no-write-fetch-head` fetches may leave it stale; timestamp failure does not discard valid H;
- `lastAttempt`: the head, outcome, reason, and time of the most recent NONOBSOLETE completed attempt (Z3 or Z4). Its current relevance is still filtered by its target head.

**M, a materialization (cached numbers).** This is a computed `ProcessMetrics`. M carries its provenance (G's identity, the end T, `materializedAt`, and its evidence, D3a) and its `maxAge`: 30 s for metrics reads. M holds no live header.

**The recovery controller** (Tables Q, Z, and CT; the canonical model of Lead note-44b3a9d2).

Invariant: one accepted immutable G, at most one flight, and all new flight decisions go through ONE reconcile function using a fresh ref read. A matching accepted G is reused, never re-read just because an obsolete flight completed or a fetch stamp changed. A transient failure of a NEEDED current head has an explicit retry path without an unrelated ref move or restart. Only a successful nonobsolete complete read publishes facts or clears that head's failure; failed/partial/obsolete reads never create a G.

State: stopped flag; accepted G or none; flight {id, target} or none; retry record {head, failureCount, dueAt} or none; `lastAttempt` for the most recent NONOBSOLETE completed attempt. Backoff = 30 s, 120 s, 600 s capped; a failure for the same retry head increments its chain, a different failed head begins 1. A successful accepted attempt clears its retry. Keep no queue of stale pending heads; when an event needs dispatch, resolve the actual ref again. A backoff record for a head is irrelevant to another head and never blocks reuse of accepted matching facts. One owned retry wake re-enters reconcile with a fresh ref at due; a ref change or check may re-arm it for the actually needed target. `stop()` cancels owned timers and ignores all later completions.

`check(team)`, the retry wake, and every completion's follow-up run the reconcile table Q (rows disjoint, first match). A completion is classified by the completion partition Z. Both tables are in the acceptance oracles.

- A same-head fetch updates live `fetchAt` and re-arms the freshness wake only; it cannot mint facts or bypass these rows.
- A user Metrics refresh may recompute M; it does not re-read immutable matching-H facts.
- A `DELIVERY_READER_VERSION` change is a new identity and a cold controller, not a hidden same-identity revalidation.
- Facts are never patched with partial results.

**Reachability.** Q3 prevents starting a flight for an already accepted matching G, and G cannot change while a different sole flight runs. A flight starts only for an identity that differs from the accepted G. If its completion's target matches the current ref and fails (Z4), that target still differs from G. If the ref reverted to G, the completion is obsolete and discarded (Z2), and Q3 reuses G. If a target that failed earlier is later accepted, its accepting completion records success (Z3). Therefore, in valid controller states, a FAILED nonobsolete `lastAttempt` for the SAME identity as the accepted matching G is unreachable. Failures stay visible:
- no G → `unavailable` plus the refresh-failed reason for the named head;
- G at A, current ref B, and B failed → `behind` plus the refresh-failed reason until B succeeds.

A failed B record does not poison a returned accepted A after the ref reverts.

**The projection.** `view(M, G, S, now)` (`delivery/view.ts`, pure) runs on every live return: Metrics tab reads, `team_metrics`, and workspace snapshots, including the delivery-evidence item's predicate (D4). It runs on cache hits too. Its `state` is the first match:
1. `unavailable` — no accepted G, `hNow` unreadable or shallow, or M was made under no G;
2. `behind` — `hNow` ≠ the H of M's G, or M's G is no longer the accepted one;
3. `stale` — `fetchAt` unknown, or `now − fetchAt ≥ 24 h` (inclusive boundary);
4. `refresh-failed` — `lastAttempt` is for `hNow`, matches M's G, and failed. This is a pure defensive fail-closed branch for invalid or synthetic input only. It is unreachable from the controller (Reachability above), and no real-data promise depends on reaching it;
5. `expired` — `now − M.materializedAt > M.maxAge`. The caller recomputes rather than serve it as current;
6. `current`.

Every applicable condition is also listed in `reasons`, so a behind generation whose needed head failed shows `behind` with the refresh-failed reason, and a cold failure shows `unavailable` with it. Every state other than `current` returns the numbers with the marker and its reasons, and lists the delivery-evidence item (D4). Unknown is never current.

`DeliveryRuntime` (D4) owns one freshness wake at `fetchAt + 24 h`, exactly the boundary at which `stale` becomes true. With an otherwise fresh M, 1 ms before it the view is current; at it, the view is stale and the delivery-evidence item is published; 1 ms after it, the view stays stale without another event. A later same-H fetch cancels and re-arms the owned wake. A stale old callback must re-read the actual `fetchAt` and its owner token, and never acts for a superseded fetch. Unknown `fetchAt` is immediately stale. This is the freshness clock only; event membership (D3) stays half-open.

A stored report snapshot is not a live return. It keeps whatever header it was frozen with and is never re-projected.

**Derived caches** key on (G's identity, query). The projection, not the key, decides currentness. A cache hit after a ref move therefore returns `behind`, and a hit after the stale crossing returns `stale`, both without recomputing.

This is new behavior, not a property of the base cache, which returns stored values directly.

The cache is memory only. A restart starts cold (Q5 with no G), and nothing is persisted or recovered.

Alternative considered: make `MetricsReader.read` async and run git inline. `WorkspaceRead.snapshot` and the attention fold are synchronous and push often, so every snapshot would wait on git. That was rejected.

### D3 — Landing is a pure walk by first-parent position

`landingPositions(graph, H)` (`delivery/landing.ts`, pure) derives the first-parent chain F₁…Fₙ from H (oldest first). For k = 1…n, a breadth-first walk from Fₖ through all parents stops at commits already reached and stamps each newly reached commit with **position k**. A commit is landed exactly when it has a position. Its landing carries:
- `at = ct(Fₖ)`, the committer time of its position, as a timestamp proxy. It is never a minimum over other chain commits' times;
- `bound = max(ct(F₁…Fₖ))`, the latest committer time at or before its position.

The landing's time is uncertain within **U = [at, bound]**, with `at ≤ bound` always. Committer time is a stated proxy. Nothing here proves when a commit actually arrived.

Two questions are answered separately, for result commits, integrations (Fₖ itself), and change landings alike.

**Contained by T** (inclusive, for result landings):
- `bound ≤ T` → contained;
- `at > T` → not contained;
- otherwise unknown.

**Member of an event interval [a, b)** (half-open, for every count in a window):
- `a ≤ at` and `bound < b` → in;
- `bound < a` or `at ≥ b` → out;
- otherwise unknown.

For span d at end T, the current interval is [T − d, T) and the baseline is [T − 2d, T − d). Containment never supplies membership: an event can be contained by T yet of unknown membership.

**No double count:** membership in [a, b) needs `bound < b`, and membership in [b, c) needs `at ≥ b`. With `at ≤ bound`, no event is in two adjacent intervals.

Witnesses, with t = at = bound for a monotonic chain (Table I):
- t = T − d is in the current interval and out of the baseline.
- t = T is out of the window ending T, though contained by T, and in the window ending T + d.
- t = T − 2d is in the baseline.

A backdated F₂ at T − 3d after F₁ at T − d + 1 h has U = [T − 3d, T − d + 1 h]. Its membership is unknown in both the current interval and the baseline, while its containment by T is known.

An unknown is excluded from the count, which keeps the legacy-style value, and is recorded per side in the evidence (D3a). There it makes that side's evidence incomplete.

**Change landings** come from read 2. The directory `<date>-<name>` gives the name, and its first chain position (the oldest `@<sha>`) wins, with that position's `at` and `bound`.

### D3a — Facts enter the metrics as an input

`MetricsInputs` gains `delivery: DeliveryView | null`, where the view holds the accepted generation's landings and chain with its identity, and no live ref state (D2). `computeMetrics` stays pure and gains `deliveryObservations(ctx)` (`delivery/observations.ts`), which emits:
- `changes_landed` and `integrations` (sum), in the new `delivery` family;
- `landed_result_share`, which is in the coverage family.

**Load.** `loadMetricsInputs` keeps its cohorts and its one read transaction. `MetricResult` gains `commitRef`, and the load also reads the `team_task_result_checks` rows that `resolveResultCommit` (D1) consumes for the results it already loads. No linked-task history phase is added in this landing; it belongs to the follow-up convergence work.

**`landed_result_share`.** Its cohort is the tasks first done in the window. For each, it takes the newest result created before T. A task is **eligible** when that result's identity is known (D1) and its containment by T is known (D3); the share is the contained-by-T commits over the eligible tasks, and `n` is the eligible count. Every other cohort task is excluded and counted by reason in `coverage: { cohort, eligible, noResult, unresolvable, unknown }`, where `cohort = eligible + noResult + unresolvable + unknown` always. The counts travel beside the value, baseline, and legacy flags, so a high share cannot hide missing evidence.

**Unavailable.** When `delivery` is null or unavailable, every delivery metric and `landed_result_share` has `value: null`, `n: 0`, and a new optional `unavailable: string` on `MetricValue`, never 0.

**Cold coverage.** With no accepted G (a cold start, an unreadable or unknown object format, or no default branch), each side's coverage is still a full partition of its cohort, with explicit bucket precedence. `noResult` is counted first, from the existing SQLite cohort. Every remaining, result-bearing task is source-unclassifiable and counts as `unknown` until accepted facts exist. So each side reads `{ cohort: C, eligible: 0, noResult: N, unresolvable: 0, unknown: C − N }` with `n = eligible = 0`. Here `unresolvable: 0` is the precedence rule, since classification waits for a source; it is not a claim that the results' commit text is valid. With an accepted G, D1 resolution and D3 containment classify as above, and a retained G is projected by D2. This adds no load phase and no field. `ProcessMetrics` gains `delivery: { head, objectFormat, readerVersion, readAt, materializedAt, unknownAtEnd, unresolvable }`, the identity and provenance only.

The live header `{ state, reasons, fetchedAt }` is added by the projection at return (D2). It is never stored in M, and a stored report keeps the header it was frozen with.

**Legacy semantics are unchanged.** Every existing metric keeps its cohort, value, `n`, `baseline`, `insufficient`, `approximate`, and `partial`, including the existing `usageHorizon` (`max(end − 90 d, first team turn)`, `metricsQuery.ts`). The only exception is the guard change below. Table K8 holds byte for byte at `end = now`.

**Evidence (additive, delivery metrics only).** Each delivery metric gains `evidence: { current, baseline }`, each side `{ complete: boolean | 'unknown', unknown: number, reasons: string[] }`. A side is incomplete when an event it counts has unknown membership in that side's interval (D3), or, for `landed_result_share`, when its cohort has an unresolvable identity or an unknown containment. Evidence never rewrites a legacy flag. No token or limit metric gains evidence here: their coverage needs the `SourceCoverage` input (D3b), which is follow-up work.

`METRIC_FAMILIES` gains `delivery`, listed first. The guard of `lead_time_p50/p90` changes to `landed_result_share`; `accepted_result_share` stays in the coverage family with an unchanged definition. No existing metric's definition changes.

The determinism requirement now holds per (team, window, slice, end, G's identity), with the projection applied at the same S and `now`. The tab, `team_metrics`, and workspace snapshots read the same generation through the same reader, so they still agree.

### D3b — Source coverage is deferred

Whether a usage or limit source recorded continuously over a span is not established by any current producer. The original plan's `SourceCoverage` input, its producer contract (old task 0.1), and every token- or limit-dependent measure it gates (tokens per landed change, the token rules, token trend marks) are non-blocking follow-up work (proposal › Follow-up). Nothing in this landing reads or needs `SourceCoverage`, and it gates nothing here.

### D4 — DeliveryRuntime and the delivery-evidence item

`DeliveryRuntime` (`src/server/metrics/delivery/runtime.ts`) is one per manager. It owns the facts cache (D2) and is the one lifecycle owner of delivery refresh:
- `ChatSessionManager` starts it after boot, as it starts the supervision monitor, and stops it at shutdown. Stopping clears every timer and discards later completions (Q0, Z0).
- `check(team)` runs on a Metrics tab or workspace open, on a Metrics refresh, on every `MetricsReader` read and workspace snapshot (synchronous: it only reconciles, D2), and on an unref'd 60 s timer armed only while the team has at least one subscriber. `WorkspaceConnections` open, close, and disconnect, and the metrics subscriptions, report reference counts to the runtime; at zero subscribers only that 60 s poll is cleared.
- The owned retry wake (Q4, Z4) and the freshness wake (D2) do not depend on subscribers: a needed head that failed during a tool-only read, with no subscriber, is retried once at its due time and never earlier, and the freshness boundary still fires and re-arms (Table O). `stop()` clears every owned timer (poll, retry, and freshness) and ignores every later completion and callback.
- It owns the freshness wake at `fetchAt + 24 h`, cancelled and re-armed whenever `fetchAt` moves; an old callback re-reads the actual `fetchAt` and its owner token and never acts on a superseded wake (D2). It publishes `WorkspaceConnections.publish(teamId)` on a generation change, at the wake, and whenever the item's fingerprint below changes.
- `MetricsReader` reads take the accepted generation from it and pass every return through `view` at the live S.

**The item.** `deliveryEvidenceItems` joins `ATTENTION_SOURCES`, fed by a new `AttentionInput.deliveryEvidence`: for a team **expected to be Git-backed**, the runtime's projected 7d read at the snapshot time. Kind and identity `delivery-evidence`, owner the human, impact "team delivery", next action Open metrics, link `{ kind: 'metrics', id: '7d' }`, a new `AttentionLink` kind the client opens as `#/team/<key>/metrics/7d`. It is listed, first match:
1. when the projected state is not `current`: cause the state with every reason and the fetch age, and no delivery value;
2. when the state is `current` and the 7d `landed_result_share` coverage has `cohort > 0` and `noResult + unresolvable + unknown > 0`: cause the five coverage counts;
3. otherwise not listed.

Its fingerprint is (state, reasons, counts); a change publishes once and keeps the identity, so the client raises at most one toast per session. **Applicability.** A team is expected to be Git-backed when the manager's existing team repository binding names a git common directory, or when its Git source was positively identified earlier in the same manager lifetime. Expectation does not depend on the current resolution succeeding: when an expected team's common directory is missing or unreadable, its projection reads `unavailable` with that reason, and the same `delivery-evidence` item is listed. Positive plain, non-Git classification makes the item not applicable, with no item and delivery unavailable. Every other team follows the existing first-match listing: non-current or unknown facts list one source-cause item; current facts with cohort exclusions list one five-count coverage item; current facts AND (complete evidence OR an empty cohort) list no item. An indeterminate or failed classification is never coerced to not-applicable: the item is listed with availability unknown and no delivery value. Applicability uses the existing team binding and bounded team-owned source reads only: no new durable registry, store, migration, host scan, process, or liveness inference. The exact binding and shared types are coordinated before code.

The item is data-quality evidence: it never names performance or spending and never drives work (D8).

Alternative considered: keep the original plan's degradation rule table and monitor as the first landing's attention path. Their token rules wait on `SourceCoverage`, and the rest needs convergence history; both are follow-up, so the first product raises only the evidence it can establish.
### D8 — Delivery is evidence, never a decision input or acceptance

Delivery facts, metrics, and the delivery-evidence item are outcome and guard evidence only:
- No dispatch, routing, staffing, execution, landing, or acceptance path reads them, directly or through another module.
- Landing never accepts a result.
- A landed commit is not a first durable acceptance fact for `process-observability`, whose acceptance cohorts and mechanisms stay as that change defines them.

The boundary is checked behaviorally (Table N) at the real composition seams. The import guard is a second, supplementary check.

### D9 — Validation uses deterministic fixtures; real data needs its own authorization

Thresholds and behavior are validated only on sanitized deterministic fixtures:
- a temporary git repository built with `cleanGitEnv`, with fixed committer times;
- `metricsSeed.ts` rows with fixed UTC instants;
- a declared schema version and fixed read ends (`2026-10-27T00:00:00Z` and the four weeks before it), passed as `now`, never taken from the clock;

No step copies or reads the live database, its WAL or journal, or a backup. Any check on real data needs a separate explicit authorization and would use the existing consistent, integrity-checked, private backup procedure (`docs/operations/database-backups.md`), with private rows, paths, and credentials kept out of journals and results. This design prescribes none. The original author's historical counts, latencies, and sizes stay Unknown until such a check runs.

UI verification names one capability that is not guaranteed to exist in an implementing session: the `dev-browser` skill (screenshots, per AGENTS.md). Its availability is a prerequisite of task 2.4. When it is missing, the implementer stops that verification and asks the Lead for a separately reviewed alternative; its evidence is never substituted. Backend tasks do not depend on it.

### Acceptance oracles

**Table H: head resolution.** Seam: `resolveHead(commonDir)`.

| id | common dir state | → outcome |
|----|------------------|-----------|
| H1 | no git common directory | unavailable `no-default-branch`, no process |
| H2 | `refs/remotes/origin/HEAD` missing | unavailable `no-default-branch`, naming `git remote set-head origin --auto` |
| H3 | symbolic → loose ref | H = the loose ref's id |
| H4 | symbolic → packed only (with a `^` peel line after it) | H = the packed id, peel line ignored |
| H5 | symbolic → loose and packed differ | H = the loose id |
| H6 | the file holds a hex id | H = that id |
| H7 | malformed text/config/format/version, unsafe ref/component, loop/sixth hop, unsupported interpretation or missing target | unavailable `default-branch-unreadable` |
| H8 | `shallow` file present | unavailable `history-incomplete:shallow`, no process |
| H9 | partialclone, true promisor, partialclonefilter or pack promisor marker | unavailable `history-incomplete:partial`, no process |
| H10 | `info/grafts` file present | unavailable `history-incomplete:grafts`, no process |
| H11 | unsupported ref storage | unavailable `default-branch-unreadable`, no process |

P witnesses R1-R7: unchanged token AND byte digest parse once while freshly reading each lookup; atomic replacement and same-inode rewrite preserving mtime return the new H without a ctime-diff precondition; fresh loose overrides cached packed; missing/stat/read/parse/hash failure invalidates; untrusted token reparses; host symlink ancestors work and inner symlinks refuse. G5 models identical dev/ino/size/mtimeNs/ctimeNs across actual same-size A-to-B bytes: new H=B/parseCount2, following unchanged B skips parsing but READS again. Removing digest comparison must fail changed-H, not a hash-call counter. S1-S6 retain common-only/unknown/floor/future semantics. No native capability/runtime/liveness proof follows source definitions.

SC/T correction witnesses: missing/invalid bigint comparison fields refuse before callback consumption or after reading; null cache-token injection on complete native snapshots reparses two unchanged lookups; a one-shot lookup error then SAME file/token reparses; a valid readSync append is refused by after-stat comparison; kernel observations of fixture-owned descriptors cover success/refusal/data error; physical common/main replacement after pinning refuses, and a fresh resolution sees the replacement. Timestamp boundary uses fixed nanoseconds just below the next millisecond, negative and missing precision cases. These tests are defined, not executed at the source checkpoint. The previous five proposed control sites are cache-null, error-invalidation, after-stat, file-close and root-current; G5 adds its own digest-comparison oracle. A later direction must publish the exact execution/control budget; none has run.

**Table F: read completeness.** Seam: `DeliveryFactsReader.read(H)` with a stub runner that checks its arguments: the literal H, `--no-replace-objects`, `--no-renames`, no ref name, and no `fetch`, `push`, `update-ref`, or `remote`.

| id | runner outcome | → read |
|----|----------------|--------|
| F1 | exit 0, rows close under parents, first row H, archives on the chain | accepted |
| F2 | exit non-zero | failed `git-failed:<code>` |
| F3 | exit null (timeout or kill) | failed `git-timeout` |
| F4 | spawn failure | failed `git-unavailable` |
| F5 | stdout length = `DELIVERY_READ_BOUND` (clipped) | failed `history-exceeds-bound` |
| F6 | a row does not parse | failed `history-malformed` |
| F7 | first row is not H | failed `history-malformed` |
| F8 | a named parent has no row (a dropped tail) | failed `history-incomplete` |
| F9 | an archive `@<sha>` not on the chain, or a stray path | failed `archive-malformed` |

**Tables Q and Z: the recovery controller.** Seam: `DeliveryFactsCache` with a fake reader, ref, `FETCH_HEAD` mtime, clock, and flight ids. G's identity is (repository, object format, H, reader version); the fetch time is never part of it. These rows are the canonical model of D2 (Lead note-44b3a9d2), kept verbatim. Currentness is not decided here; it is the projection's (Table V).

*Table Q, RECONCILE* (rows disjoint, first match; every check, retry wake, and completion follow-up):

| id | condition | → result |
|----|-----------|----------|
| Q0 | stopped | no dispatch/publication |
| Q1 | a flight exists | keep that one flight, dispatch nothing; ref state can still change the projection. No second flight or stale pending-id dispatch |
| Q2 | idle and hNow unreadable/shallow/invalid | no flight; projection unavailable, preserve G |
| Q3 | idle, valid hNow, accepted G identity matches repository/objectformat/H/readerVersion | reuse EXACT G, no git/no new generation, irrespective of retry record for some OTHER head |
| Q4 | idle, valid hNow, G absent or different, retry.head == hNow and now < dueAt | preserve G, wait/own one due wake |
| Q5 | all remaining idle valid cases | start exactly one flight for fresh hNow |

*Table Z, COMPLETION* (Z0 first; for an owned flight, clear it once and freshly resolve hNow before classifying BOTH success and failure):

| id | condition | → result |
|----|-----------|----------|
| Z0 | stopped, or callback id does not match the owned flight | ignore completely |
| Z1 | invalid/unreadable hNow | discard completion as unusable/obsolete, preserve G, no pending-id fallback and no manufactured successful currentness. A later actual check can recover |
| Z2 | valid hNow != flight.target | discard completion as obsolete, for BOTH outcomes; do not overwrite lastAttempt/retry with an irrelevant failure. Call reconcile on fresh state. If hNow matches accepted G, Q3 REUSES it; otherwise Q4/Q5 handle only the actual desired target |
| Z3 | valid hNow == target and complete valid read SUCCESS | accept G for target, lastAttempt(target) = success, clear target retry, publish once; reconcile is now Q3 |
| Z4 | valid hNow == target and read/timeout/validation FAILURE | preserve G, lastAttempt(target) = failed, set/update due backoff and own wake; next reconcile is Q4 then Q5 after due. No failure is turned into a successful result or silent error clear |

Every read outcome of Table F that is not F1 is a FAILURE for Z4; a clipped successful stdout is never a Z3 success.

**Unreachable claims:** a FAILED nonobsolete `lastAttempt` for the same identity as the accepted matching G (D2, Reachability); two flights at once (Q1); a flight started for an identity equal to the accepted G (Q3); a Z3–Z4 completion whose callback id is not the owned flight's (Z0). **Completeness claim:** the Q rows partition every controller state over the axes stopped (yes | no), flight (none | owned), hNow (invalid | valid = G's H | valid ≠ G's H, or no G), and retry (none | for hNow, before due | for hNow, at or after due | for another head); the Z rows partition every completion over stopped, callback ownership, fresh hNow (invalid | ≠ target | = target), and outcome (success | failure). The completeness test expands these axes over the tables and the unreachable claims.

*Table CT, finite controller witnesses* (planned, unexecuted; rows keep the canonical ids T1–T7 and are cited as CT T1–CT T7):

| id | sequence | → required |
|----|----------|------------|
| T1 | accepted A, ref A; check or same-H fetch | same G, no read (Q3); a same-H fetch moves only `fetchAt` and re-arms the freshness wake |
| T2 | accepted A, ref B starts B (Q5); ref A while B runs (Q1); B succeeds, OR B fails | Z2 discards B for either outcome; reconcile Q3 reuses A; no flight for A; no failed `lastAttempt` for A |
| T3 | cold, ref B; B fails | Z4: `unavailable` with the failed reason; no retry before due (Q4); the due wake re-checks ref B and retries B (Q5); success → G = B (Z3), retry cleared, a fresh eligible M |
| T4 | accepted A, ref B; B fails | Z4: `behind` with the failed reason; the due wake retries the same B; success → G = B, current with a fresh M. No new external event or restart is required to clear the failure |
| T5 | during B's backoff, ref A | Q3 reuses A without a read; if the ref returns to B before due, wait the remaining B backoff (Q4); after due, Q5 starts B. The retained B failure never poisons A |
| T6 | obsolete B completes with actual ref C (≠ G) | Z2 → reconcile flies C only (Q4/Q5); with an unreadable ref, Z1: no cached pending-target spawn; with the ref restored to the matching A, Q3 reuses A. At most one active flight always |
| T7 | stop while a flight runs | Q0/Z0: no late publication and no retry wake; an old callback id cannot clear or publish a different owned flight |

Reusing A never makes an expired A materialization current: M's expiry and recomputation still apply (Table V). Accepting B never makes an old A materialization current: it reads `behind` until recomputed.

The model-based test runs Tables Q and Z as the reference model under seeded sequences of {move ref, make ref unreadable, touch `FETCH_HEAD`, check, complete ok, complete fail, complete with a stale callback id, advance clock, fire the retry wake, stop}, seed 0x6E4E, 300 sequences of 40 commands. After each command: every accepted generation's facts equal the facts computed offline for its own H (no mixed heads); at most one flight exists; no `FETCH_HEAD` touch alone changes G's identity; and no failed `lastAttempt` matches the accepted G's identity.

**Table V: return-time projection.** Seam: `view(M, G, S, now)` and every live surface over one materialization M (metrics read, `team_metrics`, workspace snapshot), each served from its cache. A row holds on a cache hit with no recomputation.

| id | after M was materialized under G at H_a | → state on the next return |
|----|------------------------------------------|----------------------------|
| V1 | nothing changed, within `maxAge` | `current`; no delivery-evidence item for currentness |
| V2 | the ref moved A → B, no flight completed yet | `behind` (cache hit, no recomputation); the delivery-evidence item lists `behind` |
| V3a | `now` = `fetchAt` + 24 h − 1 ms, M otherwise fresh | `current` |
| V3b | `now` = `fetchAt` + 24 h exactly, no other event | `stale` at the owned wake; the delivery-evidence item is published |
| V3c | `now` = `fetchAt` + 24 h + 1 ms, no other event | still `stale` |
| V4 | a same-head fetch moves `fetchAt` forward before the crossing | `current`; the owned wake is cancelled and re-armed; same G identity; an already queued old callback re-reads the actual `fetchAt` and its owner token and leaves the view current |
| V5 | synthetic input only: `lastAttempt` failed for H_a while G is at H_a (unreachable from the controller, Tables Q and Z) | `refresh-failed`, fail-closed; the defensive branch, labeled as unreachable in production |
| V6 | the ref moved to B and B's read failed (CT T4) | `behind`, with the refresh-failed reason also in `reasons`; `current` again only after B's retry succeeds and M is recomputed |
| V6b | no G, ref B, and B's read failed (CT T3) | `unavailable`, with the refresh-failed reason |
| V7 | the ref became unreadable or the repository shallow | `unavailable` |
| V8 | M older than its `maxAge` (30 s) | `expired`; the caller recomputes rather than serve it as current |
| V9 | `fetchAt` unknown (no `FETCH_HEAD`) | `stale` |
| V10 | a report frozen while V1 held, read after V2 | byte-equal to its stored snapshot: never re-projected |

**Table O: runtime timer ownership.** Seam: `DeliveryRuntime` with fake timers, a fake reader, and subscriber counts from `WorkspaceConnections`. Backoff as in D2 (30 s first).

| id | sequence | → required |
|----|----------|------------|
| O1 | one subscriber, then its last close or disconnect | only the 60 s poll is cleared; an armed retry wake and the freshness wake stay armed |
| O2 | no subscriber; a `team_metrics` read finds the ref at B (cold or behind), and B's read fails at t₀ | Z4 arms one retry wake at t₀ + 30 s; no read at t₀ + 30 s − 1 ms; exactly one read at t₀ + 30 s; on success G = B, the retry is cleared, and the next read is current (CT T3, T4) |
| O3 | no subscriber; `now` reaches `fetchAt` + 24 h | the freshness wake fires at exactly the boundary and the workspace is published (V3a–V3c); a later same-head fetch re-arms it (V4) |
| O4 | a subscriber returns while a retry is pending | the poll is re-armed; still exactly one retry wake |
| O5 | `stop()` with the poll, a retry, and the freshness wake armed and a flight running | every owned timer is cleared; the later completion and any old callback publish nothing (Q0, Z0) |

**Table I: window membership.** Seam: `landingPositions` plus the containment and membership predicates (D3), span d, end T, current [T − d, T), baseline [T − 2d, T − d).

| id | chain (committer times) | event | → current | → baseline | → contained by T |
|----|-------------------------|-------|-----------|------------|------------------|
| I1 | monotonic | at = bound = T − d | in | out | yes |
| I2 | monotonic | at = bound = T | out | out | yes; in the window ending T + d |
| I3 | monotonic | at = bound = T − 2d | out | in | yes |
| I4 | monotonic | at = bound = T − 2d − 1 ms | out | out | yes |
| I5 | F₁ at T − d + 1 h, then F₂ at T − 3d | F₂: U = [T − 3d, T − d + 1 h] | unknown | unknown | yes |
| I6 | F₁ at T + 1 h, then F₂ at T − 1 h | F₂: U = [T − 1 h, T + 1 h] | unknown | out | unknown |
| I7 | any | at > T | out | out | no |

Property: for every generated chain and every pair of adjacent intervals, no event is `in` both (P1 extends to it).

**Table L: result landing.** Seam: `landingPositions` plus the commit-ref resolution. Ft is a first-parent commit with committer time t.

| id | graph | T | → landing |
|----|-------|---|-----------|
| L1 | C is the first-parent commit F₂ | * | position 2, `at` = ct(F₂) |
| L2 | C reached only through F₂'s second parent | * | position 2 |
| L3 | C reachable from F₁ (t 100) and from F₂ (t 90) | * | position 1, `at` 100, never 90 |
| L4 | a result names full literal D not in H's graph, with the strict same-result passing check of D1 (as L8b) | * | known, not landed |
| L4b | the same D with only a pending check, or none | * | unresolvable: excluded from `landed_result_share`, never known-not-landed |
| L5a | F₁ t 100, F₂ t 50 brings X through its second parent, F₃ t 200; X has U = [50, 100] | 40 | X not contained by T |
| L5b | same | 75 | X's containment unknown at T: excluded from the share, counted in its coverage counts |
| L5c | same | 150 | X contained by T; its membership in [100, 150) is unknown (at 50 < 100), in [40, 150) it is in |
| L6 | F₁ t 1000, F₂ t 10 (old-dated), F₃ t 1100 brings X (ct 1050) through its second parent | 1200 | X landed at position 3, U = [1100, 1100] (no `--since` cut) |
| L7 | `commit_ref` is a 7- or 12-digit abbreviation of a graph commit, including one a later check resolved to a full id; symbolic text (`HEAD`, a branch name); a 39- or 41-digit hex; a 64-digit literal in a sha1 repository | * | unresolvable: excluded from `landed_result_share`, counted in its coverage counts, never landed or known-not-landed |
| L8a | a full literal C in H's graph | * | known; C's landing by position |
| L8b | a full literal D off H's graph with one same team/task/result check: `done`, version 1, `commit.status` `pass`, `commit.given` = D, `commit.sha` = D | * | known, not landed; evidence names the check's id, `seq`, `finished_at` |
| L8c | D off-graph with no check, or a check that is pending, unavailable, failed, of another result, missing `commit.sha`, or with `given` ≠ the literal | * | unresolvable |
| L8d | D off-graph with two checks naming different `sha` | * | unresolvable |
| L8e | C landed and an unmerged D share their first 7 digits; the result names the 7-digit prefix | * | unresolvable (no prefix search, whichever commit is unique in H's graph) |
| L8f | `extensions.objectformat = sha256` in the config text; a 64-digit literal in the graph | * | known and landed; a 40-digit literal is unresolvable |

**Table C: change landing.** Seam: `changeLandings` over read 2 with a real temporary repository.

| id | archive history | → landing |
|----|-----------------|-----------|
| C1 | added by a merge commit | at the merge's position |
| C2 | added by a direct first-parent commit | at that commit's position |
| C3 | added twice (re-archived under a new date) | at the first arrival |
| C4 | added on an unmerged branch only | not landed |
| C5 | added, later deleted from master | landed at the arrival (history is not rewritten) |
| C6 | archived by `git mv` from `changes/<name>/`, with `diff.renames=true` | landed at that position |

**Table K: inputs at an end.** Seam: `loadMetricsInputs` plus `computeMetrics(…, end)` over `metricsSeed.ts` rows and fixture facts, `now` fixed. "Legacy flags" means the flags the base code computes, unchanged.

| id | records | → result |
|----|---------|----------|
| K5 | point before the team's first record | value null, `n` 0 (no data) |
| K8 | read at `end = now` | every pre-existing metric's value, `n`, baseline, and legacy flags byte-identical to the base read; only the additive `evidence`, `coverage`, and `delivery` fields and the new metrics are new |
| K12 | an archive of unknown membership in the baseline (I5) | `changes_landed` baseline excludes it; baseline evidence incomplete with `unknown: 1` |
| K13 | 30 tasks first done in the window: 20 without a result, 1 naming an abbreviation, 9 full literals of which 6 are contained by T | `landed_result_share` 6/9 with `n` 9; coverage `{ cohort 30, eligible 9, noResult 20, unresolvable 1, unknown 0 }`; evidence incomplete |
| K14 | one cohort task's commit has unknown containment at T (L5b) | excluded from `n`, counted `unknown: 1`; `cohort = eligible + noResult + unresolvable + unknown` |
| K15 | no accepted G (cold, or an unknown object format); current cohort 30 with 20 no result, baseline cohort 12 with 3 no result | `landed_result_share` value null, `n` 0, `unavailable` with the reason, never 0; current coverage exactly `{ cohort 30, eligible 0, noResult 20, unresolvable 0, unknown 10 }`, baseline exactly `{ cohort 12, eligible 0, noResult 3, unresolvable 0, unknown 9 }`; `cohort = eligible + noResult + unresolvable + unknown` and `n = eligible` on both sides; the tab and `team_metrics` return equal objects |
| K16 | no result ever accepted, all eligible commits landed | `landed_result_share` 1.0; `accepted_result_share` 0 and in the coverage family; `lead_time_*`'s guard is `landed_result_share` |
**Table W: attention.** Seam: the production `WorkspaceRead.snapshot` with the runtime's projected read, fake clock.

| id | state | → queue |
|----|-------|---------|
| W1 | current; 7d cohort 30 done, 9 eligible, 20 no result, 1 unresolvable, 0 unknown | one human item `delivery-evidence` stating those five counts, linked to `{ kind: 'metrics', id: '7d' }` |
| W2 | next snapshot: every cohort task has a known landing state | item gone, counts drop by one, one publish |
| W3 | still incomplete with new counts | one publish; same identity; the cause shows the new counts |
| W4 | evidence complete, then `now` reaches `fetchAt` + 24 h exactly with no other event | at 24 h − 1 ms no item; at the owned wake the item is listed (stale, with the fetch age) and published; at + 1 ms still listed |
| W5 | the ref moves to B and the snapshot is served from cache with no recomputation | the item is listed, cause `behind`, no delivery value |
| W6 | the ref moves to B and B's read fails | listed, `behind` with the failed reason; after B's backoff the owned retry wake retries B, and with complete evidence over the accepted B the item clears |
| W7 | positively classified plain directory team | no item; the Metrics tab shows delivery unavailable |
| W8 | current, no task first done in the window | no item |
| W9 | Git-backed, `refs/remotes/origin/HEAD` missing or the repository shallow | listed, `unavailable` with the reason |
| W10 | current; 7d cohort 10, eligible 9, noResult 0, unresolvable 0, unknown 1 (a full literal whose containment at T is unknown, D3) | exactly one item, cause naming those five counts with `unknown` 1 |
| W11 | after W10, the chain makes that containment known: eligible 10, unknown 0 | no item; one publish |
| W12 | expected Git team whose common directory goes missing | the same `delivery-evidence` identity, `unavailable` with the reason, no delivery value |
| W13 | expected Git team whose common directory or its metadata is unreadable | the same identity, `unavailable` with the unreadable reason |
| W14 | after W12 or W13, the root is restored and the facts are current with complete evidence | the item clears under the same identity; with incomplete evidence it shows the counts under the same identity |
| W15 | Git classification indeterminate (a classification error, not a positive plain result) | listed, availability unknown, no delivery value; never suppressed as not-applicable |

**Table N: noninterference.** Seam: the production manager composition with a fixture team. The same dispatch, routing, staffing, execution-tick, and acceptance inputs are run under four delivery states: unavailable, current with the delivery-evidence item listed, stale, and current with different landings.

| id | check | → result |
|----|-------|----------|
| N1 | dispatcher pass, routing decision log, staffing preview, the execution fixture's tick effects, and Accept result outcomes under each state | identical across the four |
| N2 | mutant: the dispatcher receives `MetricsReader` through an injected dependency and skips a dispatch when `delivery.state` is stale | N1 fails |
| N3 | supplementary import guard: the outbound-isolation modules import nothing from `metrics/delivery/` or `MetricsReader` | no offenders, file list non-empty |

**Properties.** All use a seeded `mulberry32`, defined in the test file the way the existing property tests define it (for example `checkRecords.test.ts`), and no new dependency.

- **P1, landing position equals brute force.**
  - Generator: random DAGs of 30–200 commits with 1–3 parents, a random first-parent chain, and committer times shuffled independently of position.
  - Seam: `landingPositions`.
  - Property: each commit's position is the smallest k whose ancestor closure of Fₖ contains it, its `at` is ct(Fₖ), and its `bound` is the maximum ct over F₁…Fₖ.
  - Seed 0xDE11, 500 cases.
- **P5, generations never mix heads.** This is the model-based test of Tables Q and Z (seed 0x6E4E).
- **P6, no double count.** Over P1's generator, for random ends T and spans d, no landing is `in` both [T − 2d, T − d) and [T − d, T), and every landing `in` either is contained by T. Seed 0x1A1F, 500 cases.
- **P7, the projection is the only currentness.** Over random sequences of P5's commands, every live return's state equals `view(M, G, S, now)` recomputed from scratch at the same instant, including cache hits. Seed 0x51E3, 300 sequences.

**Production composition (M1).** One test builds `ChatSessionManager` as production does, with no browser connection, over a temporary git repository (`cleanGitEnv`) whose origin carries archives and the merged result commits of K13's cohort, and `metricsSeed.ts` rows for that cohort. It runs two branches through the real manager and `WorkspaceRead.snapshot`. The **unknown-only branch** comes first: a current, otherwise complete 7d cohort of 10 tasks whose results are full literals, 9 contained by T and 1 whose first containing position straddles T (unknown containment, D3). Its first assertion is that the snapshot lists exactly one `delivery-evidence` item whose cause states `{ cohort 10, eligible 9, noResult 0, unresolvable 0, unknown 1 }`. A separate recovery step then advances the fixture so that containment is known (eligible 10, unknown 0), and the next snapshot lists no item. The **missing-result branch** then uses K13's cohort. It asserts that the manager starts the runtime, that a workspace snapshot lists `delivery-evidence` with K13's five counts and the `metrics` 7d link, and that the Metrics tab read and `team_metrics` return the same G identity, projected state, `landed_result_share`, `n`, and coverage. A failure path removes `refs/remotes/origin/HEAD`: the next snapshot lists the item `unavailable` with the reason, and both reads show the share unavailable. There are three mutants: the source removed from `ATTENTION_SOURCES`; the manager not starting the runtime; and the predicate reading an unknown count as 0, which fails the unknown-only branch's first assertion, because no item is listed. Each fails the test.

#### S1 acceptance oracles: dormant result-frame syntax

**Boundary.** Internal `decodeGitResultFrame(bytes: Uint8Array): GitResultFrame | null` consumes ONE supplied complete view (offset/length respected). It is total, pure and stateless: invalid supplied-byte syntax returns plain null, never throws or coerces. Raw byteLength <=512 includes all whitespace, before fatal UTF-8 decoding; reject a leading EF BB BF without stripping it. Only JSON SP/TAB/LF/CR whitespace is allowed. No stream splitting or whole-stream/RAM bound is claimed.
**Shape.** Accept one JSON object with exactly the decoded, unique top-level keys `type`, `code`, `signal`; type is `GIT_RESULT`. A numeric safe integer 0..255 with explicit null signal OR null code with a full ASCII signal-string match `SIG[A-Z0-9]+` is valid. No trailing line terminator is part of that signal language. Return plain data with that tuple. A bounded key-aware scan plus standard JSON grammar parse must respect strings, quotes, backslashes, Unicode escapes, nesting and key/value position; reviver-only duplicate detection is insufficient.
**Scope.** No local codec imports; tests import only the actual decoder and `bun:test`. Syntax never proves HELLO/STARTED/once/order/CLOSING, provenance, ordinary return, cleanup or delivery facts. Future owner/Reader/native/app/public composition remain owed; these helper tests make no public-scenario `@covers` claim.

| Oracle id | Supplied input / variants | Observable decoder result |
| --- | --- | --- |
| S1O01 | GIT_RESULT, code 0/1/128/255, explicit signal null | Equal numeric tuple; 128 is syntax-valid, owner classification deferred |
| S1O02 | GIT_RESULT, code null, signal SIGTERM/SIGKILL/SIGUSR2 | Equal signal tuple |
| S1O03 | Alternate key order, escaped valid keys/values, normal JSON whitespace; JSON-encoded NaN code + SIGTERM becomes null code | Equal valid tuple AFTER encoding |
| S1O04 | BOTHSET code 0 + SIGTERM; BOTHNULL; each missing/extra/wrong key, wrong type/value; nonobject/nested wrong shape | null |
| S1O05 | Code -1/256/fraction/string/unsafe; raw NaN/Infinity; overflowing JSON number | null |
| S1O06 | Empty/lowercase/no-SIG signal, or signal with final LF/CR/U+2028/U+2029 | null |
| S1O07 | Literal duplicate key or escaped-equal key (code vs \u0063ode), either order, equal or unequal values | null |
| S1O08 | Malformed/truncated/overlong UTF-8, leading BOM, non-JSON whitespace | null |
| S1O09 | Empty/whitespace-only/malformed JSON/trailing garbage/concatenated frames; property-like strings/escaped quotes/backslashes in wrong-shape values | null, no throw |
| S1O10 | Valid frame padded with JSON whitespace to exactly512 raw bytes; same content padded to513 | Equal tuple at512; null at513 |
| S1O11 | Valid frame in a Uint8Array subview with unrelated invalid prefix/suffix bytes in backing buffer | Equal tuple from view only |
| S1O12 | Delete numeric-branch signal===null; input BOTHSET code0 + SIGTERM | S1O04 BOTHSET rejection is FIRST expected failing assertion; missing-signal is masked by the key guard |

**S1P1 (S1-only generator; existing P1/P5/P6/P7 generator rules unchanged).** EXACT500 cases; seed0x6009; unsigned32 LCG `s=(Math.imul(s,1664525)+1013904223)>>>0`, advance once per case. Category is i%10, variant is floor(i/10), each category exactly50: 0 valid numeric (code=s&255), 1 valid signal (cycle TERM/KILL/USR2), 2 invalid code, 3 invalid BOTHNULL/BOTHSET tuple, 4 literal duplicate, 5 escaped-equal duplicate, 6 invalid UTF-8, 7 malformed JSON including raw NaN/Infinity, 8 missing/extra/wrong shape/type, 9 exactly513 raw bytes. Generate both valid branches and independently known POST-ENCODING expected data/null by construction, never by the decoder or a copy of its predicate. Vary invalid-code and shape categories across S1O04/O05, duplicate order/equality across O07, byte/grammar variants across O08/O09. Assert every category count=50 and both valid branches occur; valid cases round-trip, invalid bytes return null, repeat calls agree and none throws. JSON.stringify NaN/Infinity can create valid signal tuples: never assume an invalid pre-encoding object remains invalid bytes.
**Causal and coverage checkpoint.** Every table row/variant and S1P1 calls the actual exported decoder. Preserve row IDs in executable table data/test names. S1O12 names a later separately authorized guard-removal run, not an executed mutant. This dormant module checkpoint does not satisfy the later S4 actual public runner composition or task1.2.

## Risks / Trade-offs

- **[Committer time is not arrival time]** → landings are ordered by first-parent position, each carries its uncertainty interval [at, bound], membership is half-open and never inferred inside it, and the proxy's limits are stated. A backdated position reads unknown in the windows it straddles and is counted as incomplete evidence.
- **[Abbreviated result commits are excluded]** → only full literal ids of the repository's object format count (D1); an abbreviation stays unresolvable even when unique, and the share's coverage counts it.
- **[Most done tasks may have no result]** → `landed_result_share` shows the done cohort and the no-result count beside `n`, and the delivery-evidence item names them, so a high share over few eligible tasks stays visible.
- **[A team that never fetches is never current]** → the tab shows the stale marker with the fetch age, and the delivery-evidence item lists it. Kawai does not fetch: that is a write to the repository's refs, and agents fetch routinely.
- **[Whole-history reads grow with the repository]** → the byte bound and closure check make an oversized or truncated history unavailable, never partial. The cost on a real repository is Unknown until measured under D9.
- **[The first landing omits convergence, cost, rules, trends, and export]** → they are the non-blocking follow-up list; nothing here precludes them, and the facts generation and projection are the seams they will read.
- **[Old report snapshots lack the delivery family and show lead time's new guard as absent]** → readers render absent, and the guard is read from definitions as today.

## Migration Plan

There is no schema migration and no stored state. Deploying adds the delivery family, `landed_result_share` with its coverage, the guard change, and the `delivery-evidence` attention kind. Rolling back is a revert: no data was written that older code would misread. Reports frozen after the change carry the delivery family in their snapshot JSON, and older readers ignore unknown metric ids.
