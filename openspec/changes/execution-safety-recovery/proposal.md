# Proposal

## Why

Strategy revision 2 makes promises about safety and durability that Kawai does not keep yet:
- **P4 and the boundaries:** "Kawai puts its security rules in every agent's system prompt." Work stays inside the development environment. Nothing is sent or published except to model providers, the repository's GitHub remote, and internal cluster services. Actions are never blocked: "Kawai logs the outbound publish and send actions it can observe … for the owner to audit afterwards." Kawai makes no host OS changes.
- **P9:** durable records over chat memory.
- **P10:** trustworthy results before throughput.

The spike (`docs/spikes/execution-safety-recovery.md`, branch `docs/esr-spike`) measured where Kawai stands at master `bfe5004`:
- **No prompt carries the rules.** `buildTeamPrompt` (`src/server/team/teamPrompt.ts`) appends the role, mailbox, task, and strategy notes to every chat session, and nothing about outbound actions.
- **Nothing records agent sends.** The wire log holds 10,310 tool uses across 129 sessions: 106 `git push`, 51 `gh pr create`, and 56 `curl` calls. Kawai's own git and `gh` calls are plan-execution effect rows (X3), but an agent's are only raw protocol lines. The UX doc's durability row "External API outcome unknown" is therefore covered for Kawai and absent for agents.
- **A naive classifier is wrong.** A throwaway rule set found no true violation. An origin-naive `gh` rule raised 57 false positives, all `gh pr create` or `gh pr comment` on kawai's own repository, so the classifier must resolve gh's implicit repository and must never read a comment body as a target.
- **The database has no version and no backup.** `src/server/db.ts` migrates by column presence, which cannot express drops, renames, or backfills. No code path writes a copy. A file copy of the live rollback-journal database can tear, and an outside reader can stall the server's commits.
- **Startup recovery is already broad.** The mailbox, staffing, member releases, task notices, plan-execution effects (D14), and promotions (I2) all reconcile from stored state. R17 and R18 are covered. R19 is covered for Kawai's effects only. No leases, epochs, or fencing are needed at rev 2's scale.

This change closes those gaps with rules, records, and backups. It adds no enforcement and no new reconciliation machinery.

## What Changes

- **Security note in every agent prompt.** `buildTeamPrompt` gains `securityNote()`, read at spawn like the role body. It names the allowed destination classes generically and renders the owner's configured internal destinations at spawn. `codex-chat-sessions` carries the same text in `developerInstructions`.
- **User-level outbound destinations.** `~/.kawai/outbound.json` lists internal domains, hosts, and address ranges, extra model-provider hosts, and allowed external MCP servers. It follows the `teams.json` pattern: re-read on change, a malformed value logged with defaults applied, never settable from a project file. The defaults are:
  - loopback and private address ranges count as internal;
  - model-provider hosts come from the profiles' base URLs;
  - the GitHub remote is each repository's `origin`.
  Kawai ships no concrete internal hostname or address.
- **Observational audit capture.** `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, and `PermissionDenied` hooks cover Bash, Monitor, and external MCP tools, subagent calls included. The hooks never decide: each returns `{ continue: true }` before any I/O and swallows its errors. A pure classifier applies the spike's rule set:
  - it resolves gh's implicit repository and git push targets from the repository's own configuration;
  - comment bodies are never targets;
  - each observed send gets one verdict: violation, allowed, or unknown destination.
- **Append-only audit records.** One row per observed publish or send, allowed ones included, with secrets redacted. A second append-only table holds outcomes: completed, failed, denied, or started in background. A call with no outcome whose agent process has ended reads "outcome unknown". `kawai-team` tools and Kawai's own git and `gh` effects are excluded. Rows are never pruned.
- **Owner audit view.** A read-only **Audit** tab on the Team page lists sends newest first, with filters by verdict, rule, session, and time, and counts of allowed sends. Each violation raises an informational attention item owned by the human. It clears through a human-only **Acknowledge** command with a command id, and the row stays. No agent tool reads or writes audit rows. Verdicts never become stop reasons or supervision causes.
- **Versioned migrations.** A `schema_migrations` table records numbered migrations. Today's ad-hoc schema becomes the baseline, version 1. Each later migration runs in a transaction after a pre-migration backup. A database newer than the build refuses to start.
- **Online backups.** Same-connection `serialize()` snapshots run at startup, hourly while the database changes, and before each migration. Each is integrity-checked and kept in a rotating set beside the database. A restore procedure is documented. Backups stay on the host.
- **Recovery matrix.** A maintained `docs/recovery-matrix.md` maps each fault to its mechanism and test. It adds an R19-style test for an audit call whose outcome is unknown across a restart. It restates X6: every future exclusive-slot holder ships a liveness check, and results keep their revision pins.

## Non-goals

- Network blocking, sandboxing, or any enforcement. Nothing this change adds can stop, delay, or deny a tool call.
- Budgets of any kind (P8). S3 is cited only.
- Leases, epochs, and fencing tokens (spike Q5).
- Observing subprocesses, git hooks, or network traffic.
- Codex-session auditing, which rides `codex-chat-sessions`.
- New crash-reconciliation machinery beyond backups.
- Host OS hardening.
- `chat-wire/` retention (1.2 GB today), which is a separate follow-up.
- Off-host backups.
- Voluntary checkpoints. `task_checkpoint` stays pause-only, as `revision-control` R2 defines it (D12).

## Capabilities

### New Capabilities

- `outbound-rules`: the security note in every agent prompt and the user-level outbound destinations configuration it renders.
- `outbound-audit`: observational capture, the classifier and redaction, append-only call and outcome records, the owner audit view, and the violation attention item with its acknowledgement.
- `database-safety`: the schema version, numbered migrations, online backups with integrity checks and rotation, and the restore procedure.
- `execution-recovery`: the recovery matrix and its tests, outcome-unknown across restart, and the late-writer invariants (slot liveness and revision pins).

### Modified Capabilities

None. The prompt, the hooks, and the attention registry gain entries through extension points that `agent-teams`, `chat-sessions`, and `team-workspace` already define.

## Impact

- **Server:**
  - `src/server/team/teamPrompt.ts` gains `securityNote`;
  - new `src/server/outbound/` holds the destinations loader, the pure parser and classifier, redaction, the facts resolver, the store, the observer, and the connections;
  - `ChatSessionDriver.ts` registers four observational hooks beside `CwdChanged`;
  - new `src/server/dbSafety/` holds the migration runner, the backups, and the integrity checks;
  - `db.ts` calls the runner at startup;
  - `workspaceRead.ts` gains one attention source and one summary bucket.
- **Shared:** `src/shared/outbound.ts` holds verdicts, rule ids, rows, and the wire messages.
- **Client:** the Team page's **Audit** tab gets `TeamAuditView` and `teamAuditStore`.
- **Records:**
  - `schema_migrations`;
  - `outbound_calls`, `outbound_outcomes`, and `outbound_acknowledgements`, all append-only and added by migration 2;
  - `~/.agentboard/backups/`.
- **Docs:** `docs/recovery-matrix.md`, `docs/operations/database-backups.md`, and AGENTS.md bullets.
- **Depends on:**
  - `team-workspace-pages`, for the tab model;
  - `durable-plans`, for the Plans-tab extension point;
  - `plan-execution`, `integration-candidates`, `plan-supervision`, and `revision-control`, for the contracts the matrix and the exclusions name.
  The prompt, the configuration, the audit, and the database safety work do not wait for the plan changes.
