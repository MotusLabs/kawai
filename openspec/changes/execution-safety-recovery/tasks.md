# Tasks

Order:
- group 6 (the migration runner and backups) lands first;
- group 3 follows group 6, because migration 3 needs the runner;
- groups 1, 2, and 5 are independent of the others;
- group 4 waits until `team-workspace-pages` and `durable-plans` are on master: it needs the tab model and durable-plans' host-agnostic mount pattern (D12), not the Plans tab itself;
- group 7 comes last, after `plan-execution`, `integration-candidates`, `plan-supervision`, and `revision-control` merge.

Group 7's matrix rows for plan execution, integration, supervision, and revision control cite the tests those changes land, so write it after they merge, rebasing this branch onto master. Every file stays under 500 LOC. Tests that spawn git use `cleanGitEnv`. No test, fixture, or doc uses a concrete internal hostname or address, only reserved example names (`example.internal`, `192.0.2.0/24`, `2001:db8::/32`).

## 1. Security note

- [x] 1.1 Add `SECURITY_NOTE_BODY` and `securityNote(input)` to `src/server/team/teamPrompt.ts`, append it after `strategyNote`, and extend `TeamPromptInput` with `outbound: OutboundPromptFacts` (D1). Update the header comment. Verify with unit tests:
  - the section follows the strategy note, with a group and without;
  - configured entries render as written;
  - an empty configuration renders the "none beyond loopback and private network addresses" line.
- [x] 1.2 Pass the facts from `sessionTeams.promptFor` at spawn, read from the loader (group 2). Verify with a driver test: the append is rebuilt per spawn, so an edit reaches only the next start.
- [x] 1.3 Add the AGENTS.md bullet for the note and the E1 contract line for `codex-chat-sessions`; that is the docs for group 1. Verify by reading the bullet against D1.

## 2. Outbound destinations

- [x] 2.1 Implement `src/server/outbound/destinations.ts`: `OutboundDestinations` with the D2 shape, its defaults, the stamp re-read, and per-entry error reporting, copying `TeamCaps`. Verify with unit tests:
  - a missing file gives the defaults;
  - an unparsable file is reported and the defaults apply;
  - a malformed entry is dropped while its siblings apply;
  - an unknown key is reported;
  - an mtime change re-reads;
  - a project `.kawai/outbound.json` is never read;
  - profile base-URL hosts are model providers;
  - private and loopback addresses match as internal for IPv4 and IPv6.
- [x] 2.2 Document the file in AGENTS.md beside `teams.json`, with example names only; that is the docs for group 2. Verify by reading it against D2.

## 3. Capture, classification, and records

- [x] 3.1 Implement the pure `src/server/outbound/parse.ts` (tokenizer, segments, one-level `-c` unwrap, `cd`/`-C` tracking) and `classify.ts` (`parseSends`, `judge`, the D4 rules, verdicts, and `CLASSIFIER_VERSION`). Verify with unit tests over a corpus from the spike's command shapes, rewritten with example names:
  - each rule's send and non-send forms;
  - origin-implicit and `-R` gh;
  - `--body`, `--body-file`, `-F body=@file`, and heredoc values never being targets;
  - `GH_REPO`/`GH_HOST` as a prefix, by `env`, and by an earlier `export` or assignment segment, each reading `unknown-destination`, never `allowed`;
  - `git push --repo=<url>` and `-R https://github.com/o/r`;
  - a named remote, a URL, and scp push targets;
  - public and internal registries;
  - curl, wget, and httpie bodies against GETs;
  - mail;
  - variables and `$(…)` reading unknown;
  - the strongest verdict and the match list of compound commands.
- [x] 3.2 Implement `redact.ts` (D8). Verify with a fixture corpus: every listed secret shape, including query-string credentials and JSON and form body fields, is redacted in the command, each match segment, the destination, and outcome details; a non-secret command is unchanged; and truncation at 4096 characters is marked.
- [x] 3.3 Add migration 3 `outbound-audit` (D6) to `MIGRATIONS` (after migration 2 `strategy-impact`), and `OutboundStore` as the only writer, with header comments saying so. Verify with tests:
  - migration on a fresh database and on a baseline copy, run twice;
  - the duplicate `(session_id, tool_use_id)` call and duplicate outcome are no-ops;
  - the store exposes no update or delete;
  - keyset paging and the filters.
- [x] 3.4 Register the four hooks in `ChatSessionDriver` (D3), and add `OutboundObserver` with the repository facts resolver and the `spawn_id` live set (D7). Verify with tests:
  - **The no-decision test:** across every audited event, tool, and an observer that throws, the hook's output deep-equals `{ continue: true }`.
  - the hook returns before the store write;
  - `kawai-team` calls and non-sends write nothing;
  - subagent calls record `agent_id`;
  - `canUseTool` deny and `PermissionDenied` record one `denied`;
  - background calls record `started-background`;
  - **Round-trip measurement (after the round-3 `setImmediate` deferral):** the synchronous part of the Pre hook — tokenizing, parsing, and filling `pendingSends`, with every later step (facts walk, judging, redaction, SQLite) deferred — measured **~10.3 µs per call** averaged over 20,000 calls across five representative commands (git push, a cd-chain, curl, npm publish, gh pr comment) on the dev host; a non-send call parses in the same range. This is the observer's synchronous work only — it does not include the fixture adapter's control-protocol round trip, which task 7.1 measures against the live driver. For group 7's recovery matrix.
  - a facts read error records `unknown-destination` and never throws;
  - an outcome that lands before its queued call row is recorded and joins the row once written.

  Measure the added per-call hook round trip with the fixture adapter and record it in the recovery matrix.
- [x] 3.5 Implement `outcomeState` (D7). Verify with unit tests: the precedence of every outcome, pending while the spawn lives, and outcome unknown once it ends. Add the AGENTS.md audit bullet; that is the docs for group 3.

## 4. Audit view and attention

- [ ] 4.1 Add `src/shared/outbound.ts` with the row, filter, count, and D9 message types, add them to `CHAT_CONNECTION_TYPES`, and add `outboundConnections.ts` over the team-scope resolver. Verify with router and connection tests:
  - every type is whitelisted;
  - `unknown-team` and another team's call id are refused;
  - `team-audit-changed` follows every committed row of the team and no other team's.
- [ ] 4.2 Implement `OutboundService.acknowledge` (D10). Verify with unit tests:
  - human only, with an agent refused and nothing written;
  - replay and different-payload refusal naming the field;
  - the acknowledgement covers its group through the named call and no later call;
  - a non-violation or another team's call refused;
  - one row written, with the call unchanged.
- [ ] 4.3 Add `outboundItems` to `ATTENTION_SOURCES`, the `audit` link kind, and the `outbound` summary bucket. Verify with workspace read tests:
  - one item per `(rule, destination)` group with unacknowledged violations, with its id, owner, cause and count, next action, and link;
  - repeated calls to one unlisted MCP server raise one item;
  - a violation after the group's acknowledgement raises it again;
  - none for unknown or allowed rows;
  - clearing after acknowledgement;
  - the bucket's counts over the window.

  Also verify by grep and test that no execution, supervision, or dispatch module imports the outbound store.
- [ ] 4.4 Add `TeamAuditView`, `teamAuditStore`, and the `#/team/<key>/audit` route (D9), including the backup status footer. Verify with component tests:
  - newest-first rows, filters, and Load more;
  - the counts;
  - each outcome state's label;
  - gone sessions named and not clickable;
  - Acknowledge arming one command id and reusing it while the payload is unchanged;
  - every control disabled while disconnected;
  - every store apply method has a dispatch caller.
- [ ] 4.5 Write one browser walkthrough with the fixture adapter, `tests/e2e/chat-outbound-audit.spec.ts`, named in `.github/workflows/ci.yml`: a fixture agent runs an allowed push and a foreign-repository `gh` call, the item appears, and the owner filters and acknowledges it. Run it alone on a spare `E2E_PORT` after `bun run build`. Add the AGENTS.md view bullet; that is the docs for group 4.

## 5. Database safety documentation

- [x] 5.1 Write `docs/operations/database-backups.md` (D16): layout, schedule, rotation, the restore steps, what a restore does not bring back, the newer-database refusal, and the same-disk limitation. Verify by following the steps on a copy in a test home: restore a `pre-migration-2` backup and start an older build fixture.

## 6. Schema version and backups

- [x] 6.1 Inventory every schema function (`db.ts` ensures, `migrateDatabase`, and each team, strategy, and plan store's schema), collect them into the baseline step, and add `schema_migrations` and the runner in `src/server/dbSafety/migrations.ts` (D13). Verify with tests:
  - the first start on a copy of a pre-change database leaves every table's rows and columns unchanged, and records version 1;
  - a fresh start records all versions;
  - `user_version` mirrors the highest version;
  - a migration that throws rolls back, records nothing, and refuses start naming it;
  - the baseline runs only on a database with no recorded version: a migration that drops a baseline column stays applied across a restart;
  - a database with extra tables records version 1;
  - a failed or corrupt pre-migration backup refuses start before `up(db)` runs.
- [x] 6.2 Implement the newer-database refusal (D14), checked before any write. Verify with a test: version 3 against a build knowing 2 exits with the message, and the file's bytes and mtime are unchanged.
- [x] 6.3 Implement `DatabaseBackups` (D15): snapshot, atomic rename, integrity check on a separate connection, corrupt marking, the schedule with the `total_changes()` skip, and rotation. Verify with tests:
  - a snapshot taken while another connection writes under its busy timeout loses no commit;
  - the copy passes `integrity_check`;
  - a truncated copy is marked corrupt and stays out of rotation;
  - an idle hour takes nothing, including the first hour after a restart;
  - each snapshot stores its `total_changes()` value, and the skip compares against the last snapshot's value;
  - at startup and after each snapshot, only the newest 3 `.partial` and the newest 3 `.corrupt` files are kept, and the `.partial` being written is never deleted;
  - rotation keeps 24/7/3 by reason;
  - a pre-migration backup precedes each migration, and its failure refuses start.

  Record the measured `serialize()` pause on a 5 MB fixture in the matrix.
- [x] 6.4 Add the AGENTS.md database bullet; together with 5.1 that is the docs for group 6. Verify by reading it against D13–D15.

## 7. Recovery matrix and late writers

- [ ] 7.1 Write `docs/recovery-matrix.md` (D17) from the spike's Q4 tables, one row per fault, each naming its test or `gap`, including the measurements from 3.4 and 6.3. Verify by a script check that every named test file and test title exists.
- [ ] 7.2 Write the R19-style integration test `outboundRecovery.test.ts`: a recorded send, a server stop before its outcome, and a restart. The call reads outcome unknown, nothing re-runs, and a resumed session's next push is a new row.
- [ ] 7.3 Write the late-writer tests (D11). Verify:
  - a superseded agent's result is readable and never changes the current assignment;
  - a stale pin reads needing re-evaluation;
  - an orphan landing-slot holder is cleared at startup (citing plan-execution's test where it exists, else adding it).

  Add the AGENTS.md rule that a new recovery mechanism or exclusive slot adds its matrix row; that is the docs for group 7.

## 8. Checks

- [ ] 8.1 Run `bun run lint && bun run typecheck && bun run test` and `openspec validate execution-safety-recovery --strict`, and grep the change, docs, and tests for any non-example hostname or address. Verify that all pass and the grep finds nothing.
