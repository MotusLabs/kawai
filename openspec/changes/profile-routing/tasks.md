# Tasks

## 1. Group frontmatter: profiles, strategy, onLimit

- [x] 1.1 Extend the `groupFile.ts` frontmatter subset with strict single-line flow values for `profiles` (`[a, b]` or `{ a: 2, b: 1 }`) and `onLimit` (`{ parkIfResetWithin: 3h, otherwise: forward, forwardTo: architects }`), still rejecting nested structure; verify with `teamGroupFile.test.ts` cases for both forms, a bare scalar, nesting, and unbalanced brackets
- [x] 1.2 Add `profiles: Array<{ profileId, cap? }>` (a single `profile` becomes a one-item list; `profile` and `profiles` together is an error), `strategy` (`first-available` | `profile-order`, default `first-available`), and the `max` default (sum of caps when every entry has a cap, else 1, explicit `max` still wins) to `GroupDefinition`; verify with parse tests for each form and the default/explicit `max` scenarios
- [x] 1.3 Parse `onLimit` into `{ parkIfResetWithin (ms, default 3h), otherwise (default forward), forwardTo? }` with `<n>m`/`<n>h` durations; invalid values add a per-group warning and fall back to defaults instead of rejecting the file; verify the `soon` → 3h scenario reports a warning
- [x] 1.4 Add `warnings` to `GroupDefinition`, and in the group catalog drop `profiles` ids that no profile catalog defines, recording a warning (catalog errors list includes them); verify with `teamGroupCatalog.test.ts` for the unknown-profile scenario and that existing callers (`groupId` validation, prompts) are unchanged

## 2. Limit events and cooldown

- [x] 2.1 Add `profile_limit_events(id, profile_id, session_id, group_id, at, kind, final, status, message, resets_at)` with a store (`src/server/team/routing/limitEvents.ts`) that records events, prunes rows older than 24h on write and at startup, and lists events per profile; verify with a store test covering insert, prune, and survival across reopening the DB
- [x] 2.2 Capture limit events in `ChatSessionDriver.ts` through a new `onLimitEvent` option: `system/api_retry` with error `rate_limit`/`billing_error`/`overloaded` as `final: false` (status from `error_status`), and failed assistant messages / error results with those classes or status 429 as `final: true` (message text, reset time from the latest `rate_limit_event` when known); verify with driver tests feeding each frame type, including a misclassified 429 and an unrelated `invalid_request` that records nothing
- [x] 2.3 Wire `onLimitEvent` in the chat session manager to the store with the session's profile and group; verify a manager-level test records an event with the right profile/group ids
- [x] 2.4 Implement computed cooldown (`cooldownUntil(profileId, now)`: latest final event's `resets_at`, else `at + 1h`; retries never cool), shared across all groups and teams; verify with tests for reset-known, reset-unknown, retry-only, and expiry

## 3. Route contract and built-in strategy

- [x] 3.1 Define the rule contract in `src/shared/routing.ts` (`RouteContext` with group caps and live counts, message metadata without body, candidates `{ id, kind, profileId, sessionId?, cwd, idleForMs? }`, per-profile usage and limit events; `RouteDecision` pick/hold/default; `LimitEvent` for `onLimit` and its park/release/forward result; `RoutingRule` with `route`, `onLimit?`, `env?`, `timeoutMs?`) and publish it as a `.d.ts` rule authors can import; verify `bun run typecheck` and a type-level test rule compiles
- [x] 3.2 Build the candidate list (`routing/candidates.ts`): idle, available, non-parked group members in the target worktree whose profile is not cooling, plus one spawn slot per allowed non-cooling profile when staffing would spawn and the per-profile cap, group `max`, team cap, and worktree rule all allow it; forwarded work excludes the limited profile; verify with unit tests for each cap scenario in the spec (profile cap reached, parked members hold slots, overall max, default max, other groups not counted)
- [x] 3.3 Implement the built-in strategies (`routing/builtin.ts`): `first-available` (longest-idle member, else the first allowed profile's spawn slot) and `profile-order` (earlier profile first, longest idle within it); verify with tests for the profile-order and cooling-profile-skipped scenarios

## 4. Rule runtime

- [x] 4.1 Implement the loader (`routing/ruleLoader.ts`) reading only `~/.kawai/routing/<group>.ts` (never project `.kawai/`): a bootstrap Worker with `env: {}` imports the module and reports `default.env`, then a serving Worker starts with exactly those variables; per-rule load results (ok / error text / file mtime) are kept; verify with tests using temp rule files for a valid rule, a syntax error, a missing `route`, and a project-level file that is never loaded
- [x] 4.2 Implement the Worker host call path: structured-clone `RouteContext` in, decision out, timeout from `timeoutMs` (default 3s, clamped to 10s), Worker terminated and restarted after repeated timeouts, module state kept between calls; verify with tests for a throwing rule, a hanging rule, an async rule, and that an undeclared env variable is absent while a declared one is present
- [x] 4.3 Load rules at server start and expose `reload()` that rebuilds all Workers and returns per-rule results including which files changed since the previous load; no file watching; verify a test that an edited file has no effect until `reload()`

## 5. Dispatcher integration

- [x] 5.1 Route group mail per message instead of letting each idle member pull: for each eligible group message build candidates, consult the group's rule (or built-in strategy), serialize to one in-flight decision per group, and claim for the picked member; urgent direct mail and session mail keep their current paths and never consult a rule; verify with `teamDispatcher.test.ts` that existing ordering tests still pass and that a rule's pick decides the recipient
- [x] 5.2 Re-validate picks inside the claim (`claimWhen` eligibility plus candidate still listed); on failure re-run the rule once, then the built-in strategy; picks outside the list, throws, and timeouts fall back and are logged; verify with tests for stale pick, unknown candidate, and timeout scenarios
- [x] 5.3 Support hold: the message stays queued and is re-attempted after `retryAfterMs` (armed in the dispatcher timer) or when candidates change; verify with a test using a 10-minute hold and a fake clock
- [x] 5.4 Route spawns through the decision: a picked spawn slot spawns with that profile via `WorktreeStaffing`, whose reservation transaction re-counts the per-profile cap (live non-archived group members on the profile plus pending reservations, now recorded with `profile_id` in `team_spawns`) and group `max`; verify with `teamStaffing.test.ts` for concurrent spawns not overshooting a profile cap and the pick-a-spawn-slot scenario
- [x] 5.5 Keep a bounded in-memory decision log per group (time, message id, source rule/built-in/fallback, decision, reason) for the mailbox view; verify with a dispatcher test that fallbacks are recorded with their reason

## 6. Limit outcomes: park, release, forward

- [ ] 6.1 Record at claim the member's `git rev-parse HEAD` (null outside git) and track per claimed message the completed tool calls and touched file paths from the chat event log since `claimed_at`; add `claim_commit`, `parked_until`, `park_count`, `resume_message_id` columns to `team_messages` with migration; verify with store migration tests and a progress-digest test
- [ ] 6.2 Resolve a final limit event during a turn handling a delivered message: rule `onLimit` if present, else group `onLimit` frontmatter, else the default (park if progress and reset within `parkIfResetWithin`, `otherwise` if progress and later, release if no progress; release after 3 parks); verify with tests for close-reset parks, far-reset forwards, no-progress releases, release-instead-of-forward, and the park cap
- [ ] 6.3 Implement park: message state `parked` with `parked_until` and `park_count`, a scheduled resume message to the same agent at reset; parked members are excluded from group pickup and candidates; a successful human-driven turn cancels the resume and clears the park; verify with tests for resume-after-reset, parked-agent-skipped, and human-message-to-parked-agent
- [ ] 6.4 Implement forward with a handoff package (task header, journal, thread, progress digest, last error, claim commit, and the instruction to run `git status`, `git diff <claim-commit>`, `git log <claim-commit>..` first) as a fixed section of the envelope; `forwardTo` resolved at forward time, unknown targets fall back to the same group with a log; the limited profile is excluded from routing for that message; verify with `teamEnvelope.test.ts` and a forward test where a non-`glm` member receives it
- [ ] 6.5 Implement release (back to the group queue, no package) and the recovery note: after a forward, when the original agent's profile leaves cooldown it receives one note naming the task and the new agent; verify with a fake-clock test of the notified-on-recovery scenario
- [ ] 6.6 Refuse urgent direct mail to an agent whose profile is cooling in `send_message`/`reply`/`schedule_message` with an error naming the profile and the cooldown end time, queueing nothing; verify with `teamMailboxTools.test.ts`

## 7. Server API and WebSocket

- [ ] 7.1 Add the authenticated **Reload routing rules** action over the chat WebSocket (request + result with per-rule status, errors, and changed files) and include current rule load status in the mailbox snapshot; verify with a connection test
- [ ] 7.2 Expose parked state (reason, profile, resume time) on sessions and messages, the decision log in mailbox pushes, group warnings in the groups route, and a cap-exceeded flag in group/profile listings used by session creation; verify with route/connection tests
- [ ] 7.3 Add the **Hand off** action for a parked message to a chosen group or session, forwarding with a handoff package and cancelling the resume; verify with the manual-handoff scenario test

## 8. Client UI

- [ ] 8.1 Mailbox panel: Reload routing rules button with per-rule load results and errors, the rule decision log, and a Hand off control on parked messages (group/agent picker), all disabled while disconnected; verify with component tests
- [ ] 8.2 Show parked members as paused (reason and resume time) in the chat header and navigator; verify with component tests
- [ ] 8.3 New-session dialog warns, without blocking, when the chosen group and profile are at the profile cap; verify with a `NewSessionModal` test for the user-exceeds-cap scenario
- [ ] 8.4 Walk through reload, parked indicator, and hand off in the running app with the `dev-browser` skill (headless WS checks where chat turns are needed) and capture screenshots

## 9. Documentation and integration

- [ ] 9.1 Document `profiles`, `strategy`, `onLimit`, routing rules (`~/.kawai/routing/`, `env`, timeouts, manual reload), limit events, cooldown, and park/release/forward in `CLAUDE.md`, plus an example rule using the published `.d.ts`; verify the example rule loads via the loader test fixture
- [ ] 9.2 Run `bun run lint && bun run typecheck && bun run test` and an integration test (`teamRouting.integration.test.ts`) covering a mixed `glm`/`claude` group where `glm` hits a final limit, its member forwards with progress, and group mail goes to the `claude` member

## Workflow follow-up

- Open a PR for `profile-routing` and archive the change after review.
