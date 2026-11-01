# Spec Delta

## Purpose

Measures what a team delivers to its default branch — integrations, landed OpenSpec changes, and landed result commits — from one fetched head and its whole history, and states how current that evidence is.

## ADDED Requirements

### Requirement: Delivery facts are read from the default branch as last fetched
Kawai SHALL read delivery facts for a team from the commit its `refs/remotes/origin/HEAD` names, as last fetched, using read-only git at the main checkout. Kawai SHALL NOT fetch, write a ref, or touch a worktree to obtain them. A team whose directory is not a git repository, or whose default-branch ref is unset or unreadable, SHALL have no delivery facts, and its delivery metrics SHALL read as unavailable with that reason.

#### Scenario: Plain directory team
- **WHEN** a team's directory is not a git repository
- **THEN** every delivery metric reads unavailable with the reason "no default branch", never 0

#### Scenario: No fetch
- **WHEN** delivery facts are read
- **THEN** no git command run for them contacts a remote or changes a ref

### Requirement: Delivery source resolution is process-free and fail-closed
The resolver SHALL use physical common/main roots, full ids and bounded nonlink metadata without a process. It SHALL validate bigint snapshots before/after reads and reject replaced roots. Loose refs win. Every packed lookup rereads raw bytes; reuse requires matching root/format/token and SHA256. Hash and parser use the same snapshot. Null tokens or changed bytes force parsing; errors invalidate. Unsupported config refuses. FETCH_HEAD has its own contract. P remains dormant.

#### Scenario: Partial metadata refuses source resolution
- **WHEN** local partialclone, true remote promisor, partialclonefilter or a pack promisor marker is present
- **THEN** the source resolver returns `history-incomplete:partial` with no target

#### Scenario: Graft metadata refuses source resolution
- **WHEN** the common directory contains `info/grafts`
- **THEN** the source resolver returns `history-incomplete:grafts` with no target

#### Scenario: Unsupported ref storage refuses source resolution
- **WHEN** local config names unsupported ref storage
- **THEN** the source resolver returns `default-branch-unreadable` with no target

#### Scenario: Internal metadata symlink refuses source resolution
- **WHEN** a config, ref, packed-refs, shallow, info/grafts or objects/pack component inside the common directory is a symlink
- **THEN** source resolution returns `default-branch-unreadable` with no target; symlinked host ancestors alone do not require refusal

#### Scenario: Packed metadata collision still returns changed content
- **WHEN** a same-size in-place packed-refs rewrite changes an id while all metadata token fields collide
- **THEN** source resolution returns the newly read id, not the previous cached id; unchanged bytes may reuse parsing but are still read again

### Requirement: Delivery facts come from one head and complete history
Every delivery fact SHALL be derived from one resolved commit of the default branch and its whole history, read in full. Facts SHALL be published only as a whole, for the commit the ref names when the read completes. A read that fails, times out, is cut short, or meets shallow or missing history SHALL publish nothing; the previous facts stay, marked as failing to refresh, or delivery reads unavailable with the reason.

#### Scenario: Ref moves during a read
- **WHEN** a fetch moves the default branch from H1 to H2 while the facts for H1 are being read
- **THEN** no facts mixing H1 and H2 are published, and the facts published next are wholly H2's

#### Scenario: Output cut short
- **WHEN** a history read stops at the output bound
- **THEN** no partial facts are published, and delivery states that the history exceeds the read bound

#### Scenario: Shallow clone
- **WHEN** the repository is shallow
- **THEN** delivery reads unavailable stating that history is incomplete

### Requirement: An integration is a first-parent commit of the default branch
Each commit on the first-parent chain of the default branch SHALL count as one integration, ordered by its position on that chain, with its position's landing interval as its time, whatever the merge method that produced it.

#### Scenario: Merge and squash alike
- **WHEN** one pull request lands as a merge commit and another as a squash commit
- **THEN** each counts as one integration

### Requirement: A change lands when its archive directory reaches the default branch
An OpenSpec change SHALL count as landed at the first first-parent commit of the default branch that added `openspec/changes/archive/<date>-<name>/proposal.md`, identified by `<name>`, whether the directory was added or moved there. A change archived more than once SHALL land at its first archive.

#### Scenario: Archive merged
- **WHEN** a pull request archiving `parallel-suite` merges to master in a merge commit with committer time 14:00
- **THEN** `parallel-suite` counts as landed at 14:00

#### Scenario: Archive on a branch only
- **WHEN** a change is archived on a feature branch that has not merged
- **THEN** it has not landed

### Requirement: A result commit lands at its first containing position
A commit SHALL land at the first first-parent commit Fk of the default branch whose history contains it, else not land. Its time SHALL be the interval [at, bound]: Fk's committer time, and the latest of F1…Fk's, a proxy only. It SHALL be contained by T when bound ≤ T, not when at > T, else unknown. It SHALL be in an interval [a, b) when a ≤ at and bound < b, out when bound < a or at ≥ b, else unknown. Every window count SHALL use membership.

#### Scenario: Result merged through a pull request
- **WHEN** a result names commit C and the merge commit M that brought C to master has committer time 10:00
- **THEN** C counts as landed at 10:00

#### Scenario: First position, not earliest time
- **WHEN** C is first contained by F1 at time 100 and is also contained by the later F2, whose time is 90
- **THEN** C lands at F1 with time 100

#### Scenario: Backdated bridge
- **WHEN** F1 has time 100, F2 has time 50 and first contains X, and F3 has time 200
- **THEN** X is not contained by 40, unknown at 75, and contained by 150

#### Scenario: Boundary at the window end
- **WHEN** on a chain with increasing committer times an integration's time equals the end T of a 7d window
- **THEN** it counts in the window ending T + 7 d, not in the window ending T, and is contained by T

#### Scenario: Backdated straddle
- **WHEN** F1 has time T − 7 d + 1 h and the next first-parent commit F2 is backdated to T − 21 d
- **THEN** F2's membership is unknown in both the current window and its baseline, it is excluded from both counts and recorded as incomplete evidence, and it is contained by T

#### Scenario: Unmerged result
- **WHEN** a result names a full id that exists only on its task branch, and a passing check of the same result names that id
- **THEN** it counts as not landed

#### Scenario: Unmerged result without a passing check
- **WHEN** a result names a full id that exists only on its task branch, and its check is pending or absent
- **THEN** the commit is unresolvable and excluded, never landed and never known not landed

### Requirement: Result commits are identified by full literal ids only
Only a full literal object id of the repository's object format SHALL identify a result commit. A literal off the default branch's history SHALL be known, and not landed, only with a passing check of the same result naming that literal and id. Abbreviations, symbolic names, other lengths, and contradicted or unchecked off-history literals SHALL be unresolvable: never landed, never known not landed, and excluded with a count. No prefix search SHALL run.

#### Scenario: Abbreviation stays unresolvable
- **WHEN** a result names a 7-digit prefix that only one commit on the default branch matches, and a later check resolved it
- **THEN** the result's commit is unresolvable and excluded, never landed

#### Scenario: Off-history literal with a check
- **WHEN** a result names a full id not on the default branch and its passing check names the same id
- **THEN** the commit is known and not landed

### Requirement: Delivery source timestamp provenance
Source fetch evidence SHALL use only common-directory/main-worktree FETCH_HEAD mtime. Convert captured bigint mtimeNs by integer /1000000n before Number. Negative, missing-precision, unsafe or unavailable evidence SHALL be unknown. Floor finite nonnegative supplied now; future values SHALL be unknown without tolerance or clock fallback. A valid head survives unknown evidence. Linked-only/no-write-fetch-head fetches may leave the stamp stale. P does not activate freshness projection/runtime.

#### Scenario: Unsafe FETCH_HEAD keeps the head
- **WHEN** FETCH_HEAD is a symlink or not a regular file and the head otherwise resolves
- **THEN** the source target is retained and its fetch timestamp is unknown with reason `unsafe`

### Requirement: Delivery facts state their freshness
Facts SHALL be identified by repository, object format, head, and reader version, never fetch time. At every live return, cached or not, state SHALL be projected from the live ref, first match: unavailable; behind (another head named); stale (`FETCH_HEAD` aged 24 hours or more, or unknown); refresh-failed (defensive only); expired; else current. A needed head's failed read SHALL be a stated reason, retried after backoff. Every surface SHALL show it. A stored report SHALL keep its frozen state.

#### Scenario: Old fetch
- **WHEN** the repository was last fetched 30 hours ago
- **THEN** the delivery metrics show the stale marker with the fetch age

#### Scenario: Exactly 24 hours
- **WHEN** the last fetch reaches exactly 24 hours old with no other change
- **THEN** the state becomes stale at that time without waiting for another event, and 1 ms earlier it read current

#### Scenario: Fetch without new commits
- **WHEN** a fetch updates `FETCH_HEAD` but the default branch did not move
- **THEN** the facts are current again without re-reading history, under the same identity

#### Scenario: Cache hit after a ref move
- **WHEN** the ref moves from A to B and a metrics read is served from its cache before any facts for B exist
- **THEN** it reports behind, and the delivery-evidence item states that the facts are not current

#### Scenario: Failed refresh of the named head
- **WHEN** the head the ref names has no facts and its read fails
- **THEN** delivery reports behind, or unavailable with no earlier facts, with the failed reason, and the read is retried after its backoff without another event

#### Scenario: Retry with no subscriber
- **WHEN** no workspace or Metrics subscriber is open, a `team_metrics` call finds the named head without facts, and that head's read fails
- **THEN** the read is not retried before its backoff ends, is retried exactly once when it ends, and a successful retry makes the next call current

### Requirement: The delivery family reports landed outcomes per window
The metric set SHALL include a `delivery` family over each window and its baseline: changes landed and integrations. Each value SHALL follow the existing sample, baseline, and sufficiency rules. A landing of unknown membership in an interval SHALL be excluded from that interval's count, counted as unknown, and SHALL make that side's evidence incomplete. Unavailable facts SHALL read unavailable with the reason, never 0.

#### Scenario: A week that lands little
- **WHEN** the 7d window lands 6 changes over 59 integrations, against 40 changes over 146 integrations in the baseline, all of known membership
- **THEN** changes landed reads 6 against 40 and integrations 59 against 146, with complete evidence on both sides

### Requirement: Delivery evidence never drives work
No delivery fact, delivery metric, or delivery-evidence item SHALL be an input to dispatch, routing, staffing, execution, landing, or acceptance, directly or through another component. Landing SHALL NOT accept a result, and a landed commit SHALL NOT count as an acceptance.

#### Scenario: Landed result stays unaccepted
- **WHEN** a result's commit lands on the default branch
- **THEN** the result's acceptance is unchanged

#### Scenario: Delivery state changes nothing downstream
- **WHEN** the same team state is dispatched, routed, staffed, executed, and accepted once with delivery unavailable, once with the delivery-evidence item listed, and once with stale facts
- **THEN** every decision and effect is the same in all three
