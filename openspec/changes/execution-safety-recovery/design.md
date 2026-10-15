# Design

## Context

- **Strategy `kawai` revision 2.** P4 and its boundaries: the rules go in every agent prompt; nothing is sent or published except to model providers, the repository's GitHub remote, and internal cluster services; nothing is blocked; observable outbound actions are logged for the owner to audit afterwards; no host OS changes. P8 sets no budget. P9 prefers durable records. P10 puts trustworthy results before throughput.
- **The spike** (`docs/spikes/execution-safety-recovery.md` on `docs/esr-spike-report` at `de32e7a`, measured at master `bfe5004`) sets the scope:
  - Q1: the prompt carries no rules, and `buildTeamPrompt` is the insertion point;
  - Q2: what Kawai observes, and that the SDK hooks are available and unused for tools;
  - Q3: the rule set, with zero true violations in 7,276 commands and 57 false positives from an origin-naive `gh` rule;
  - Q4: the recovery inventory;
  - Q5: no leases needed;
  - Q6: no schema version and no backups;
  - Q7: budgets are out.
- **The prompt.** `buildTeamPrompt` (`src/server/team/teamPrompt.ts`) assembles the role, mailbox, task, and strategy notes. `ChatSessionDriver` reads it at every spawn through `getSystemPromptAppend` (`ChatSessionDriver.ts:661-671`), so a running process keeps its prompt and edits reach the next spawn.
- **The hook precedent.** The driver registers one observational hook, `CwdChanged` (`ChatSessionDriver.ts:684`, `1171-1184`). It swallows its errors and always returns `{ continue: true }`. The SDK also offers `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, and `PermissionDenied`, each carrying `tool_name`, `tool_input`, `tool_use_id`, and an optional `mcp_server` provenance. `BaseHookInput.agent_id` is set only for subagent calls. `PreToolUse` fires before `canUseTool` decides.
- **The user-level configuration pattern.** `TeamCaps` (`src/server/team/teamCaps.ts`) reads `~/.kawai/teams.json` at startup and again whenever its mtime or size stamp changes. A malformed file or value is reported and the default applies. A project file can never set it.
- **The database.** `src/server/db.ts` opens `~/.agentboard/agentboard.db` in rollback-journal mode with `busy_timeout = 5000`. It deliberately avoids WAL so that a copy is one file. The schema is ensured by `CREATE TABLE IF NOT EXISTS` and column-presence `ALTER`s in `db.ts` and in each team or plan store's schema function, plus a few one-off rewrites (`migrateDatabase`). `PRAGMA user_version` is 0. The live file is 5.1 MB with 29 tables.
- **The team workspace** (on master) registers attention sources in `ATTENTION_SOURCES` (`src/server/team/workspaceRead.ts`), each a pure function over existing state, and computes a `MorningSummary` of fixed buckets. `team-workspace-pages` gives the Team page its `#/team/<key>/<tab>` route. `durable-plans` adds the **Plans** tab as a host-agnostic view (`TeamPlansView`) that owns its own subscriptions over `teamPath`.

## Goals / Non-Goals

**Goals:**
- Every Claude chat agent starts with the security rules, including the owner's configured internal destinations.
- Every observable agent publish or send leaves a durable, redacted, classified record and its outcome, without delaying or deciding anything.
- The owner can audit those records afterwards and is told about each violation once.
- The database has a version, migrations that cannot half-apply, and online backups that can be restored.
- One maintained document maps each fault to its mechanism and test.

**Non-Goals:**
- Network blocking, sandboxing, or any enforcement.
- Budgets of any kind. S3's usage records are cited, and nothing is added to them.
- Leases, epochs, and fencing tokens.
- Observing subprocesses, git hooks, or network traffic. The audit records tool boundaries only.
- Codex-session auditing, which rides `codex-chat-sessions`.
- New crash-reconciliation machinery beyond backups.
- Host OS hardening.
- `chat-wire/` retention, which is a separate follow-up.
- Off-host backups.
- Voluntary checkpoints (D12).

## Decisions

### D1. The security note is one more prompt section, read at spawn

`buildTeamPrompt` appends `securityNote(input)` after `strategyNote`, so the note reaches every chat session: spawned or human-created, with a group or without. `TeamPromptInput` gains `outbound: OutboundPromptFacts`, which the caller reads at spawn from the destinations loader (D2), just as it reads the group catalog. It holds the configured internal entries and the extra model-provider hosts. The note's text extends the spike's Q1 block:

```
# Outbound actions

Work stays inside the development environment. You may fetch anything from
outside, and you may change anything inside the workspace, but you send or
publish nothing except to: model providers, this repository's GitHub remote
(origin), and the workspace's internal services. That means no publishing to
public registries (npm/pypi/crates/containers), no posts or comments on forums
or social sites, no email or chat messages outward, and no changes to host OS
settings. Kawai records the outbound actions it can observe for the owner to
audit. When an action's destination is unclear, ask or choose the allowed
path.

Internal destinations the owner configured: <rendered list, or "none beyond
loopback and private network addresses">.
```

The rendered list prints each configured entry (D2) as written, with the extra model-provider hosts on a second line. Kawai's source, tests, and docs use reserved example names only (`example.internal`, `192.0.2.0/24`). A concrete value can reach a prompt only from the owner's own `~/.kawai/outbound.json`. The text is a module constant (`SECURITY_NOTE_BODY`) exported for `codex-chat-sessions` (contract E1).

*Alternative:* put the rules in the group files. Rejected, because a session without a group would miss them, and an agent-writable project file could drop them.

### D2. `~/.kawai/outbound.json`: user-level destinations

```json
{
  "internal": ["example.internal", "build.example.internal", "192.0.2.0/24"],
  "modelProviders": ["llm.example.com"],
  "mcpServers": ["docs-search"]
}
```

- **`internal`** entries take one of three forms: a domain, which matches itself and every subdomain; a host with an optional `:port`; or an IPv4 or IPv6 CIDR or literal address.
- **`modelProviders`** lists hosts added to those Kawai derives.
- **`mcpServers`** names external MCP servers whose calls count as allowed (D5).

Every key is optional. An unknown key is reported and ignored. A malformed entry is reported and dropped, and its siblings still apply. A file that does not parse is reported and the defaults apply in its place.

The `OutboundDestinations` loader copies `TeamCaps`: it reads at startup, re-reads on an mtime/size stamp change, shares one read per stamp among callers, and reports errors to the server log. The loader never reads a project directory.

The defaults always apply, under every entry:
- **Internal:** loopback (`127.0.0.0/8`, `::1`, `localhost`) and the private ranges `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`, and `169.254.0.0/16`.
- **Model providers:** the host of every configured profile's `ANTHROPIC_BASE_URL`, plus `api.anthropic.com` and the claude.ai login hosts the CLI uses. These are public product endpoints, not internal ones.
- **GitHub remote:** the `origin` URL of the repository containing the call's effective cwd (D4).

Hostnames are matched by name. Kawai never resolves DNS, so an internal service reached by a name the owner did not configure is judged by that name.

### D3. Capture: four observational hooks, matched by tool name

The driver's `hooks` option gains one matcher per event, beside `CwdChanged`:

```ts
const AUDITED = '^(Bash|Monitor|mcp__.+)$'
hooks: {
  CwdChanged: [{ hooks: [this.cwdChangedHook] }],
  PreToolUse: [{ matcher: AUDITED, hooks: [this.auditHook] }],
  PostToolUse: [{ matcher: AUDITED, hooks: [this.auditHook] }],
  PostToolUseFailure: [{ matcher: AUDITED, hooks: [this.auditHook] }],
  PermissionDenied: [{ matcher: AUDITED, hooks: [this.auditHook] }],
}
```

`auditHook` behaves the same for every event:
1. It hands the input to `options.onToolAudit` (the `OutboundObserver`) inside `try`/`catch`.
2. It returns exactly `{ continue: true }`.

It never sets `decision`, `hookSpecificOutput`, `permissionDecision`, `updatedInput`, `retry`, `systemMessage`, or `suppressOutput`. The observer's synchronous part is pure parsing (D4). Anything that touches I/O is queued with `queueMicrotask` behind a catch-all, because an uncaught microtask throw would exit Bun. The hook therefore returns before any file read or database write.

The observer:
- **Ignores `mcp__kawai-team__*`.** The mailbox already records that traffic.
- **On `PreToolUse`,** parses the command. Bash and Monitor read `tool_input.command`. An external MCP call is a candidate by itself (D5). When the parse finds a send candidate, it adds `(session_id, tool_use_id)` to the in-memory `pendingSends` set synchronously, before the hook returns, then queues the facts read and the `outbound_calls` insert (D6). Non-send tool use writes nothing.
- **On `PostToolUse`, `PostToolUseFailure`, and `PermissionDenied`,** appends an `outbound_outcomes` row when `(session_id, tool_use_id)` is in `pendingSends`, whether or not the queued call row has been written yet. The set is filled before any outcome hook can fire, because `PreToolUse` precedes the permission decision and the run, so an outcome that lands before its call row is never dropped. An entry leaves the set when its terminal outcome is written or its spawn ends. The outcome is:
  - `started-background` for a `PostToolUse` whose input ran in the background (`run_in_background`, or any Monitor);
  - `completed` for any other `PostToolUse`;
  - `failed` for `PostToolUseFailure` (with `is_interrupt` in the detail);
  - `denied` for `PermissionDenied`.
  The driver's own `canUseTool` deny path (a manual card answered Deny) reports `denied` too, using the SDK's `toolUseID`. `UNIQUE (session_id, tool_use_id, outcome)` makes the second report a no-op.

Subagent calls fire the same hooks with `agent_id`, which the row records. That closes the transcript-stream gap D4 of chat-sessions leaves.

Kawai's own git and `gh` calls (plan-execution effects, promotions) never pass through an agent's tools, so the hooks never see them, and they stay X3 effect rows.

*Alternative:* derive the audit from `tool_call` chat events or the wire log. Rejected: the transcript stream drops subagent tools, and the wire log is unbounded raw data with no outcome join.

### D4. The classifier is pure: parse, then judge

`src/server/outbound/classify.ts` has no I/O. It works in two steps:

- **`parseSends(command, cwd) → SendCandidate[]`**:
  1. Tokenizes with shell quoting rules: single and double quotes, backslash escapes, and `$(…)` and backticks kept as opaque words.
  2. Splits on `;`, `&&`, `||`, `|`, `&`, and newlines.
  3. Unwraps one level of `bash -c` / `sh -c` / `env … cmd`.
  4. Tracks `cd <dir>` and `git -C <dir>` to give each segment an effective cwd.
  5. Matches each segment's argv against the rules below.

  A candidate names its rule, its segment, its effective cwd, and a target spec: `origin-implicit`, `remote:<name>`, `url:<url>`, `host:<host>`, `registry:<host or default>`, `repo:<owner/name>`, `mail`, or `unresolved:<why>`.
- **`judge(candidate, facts) → { verdict, destination }`**: `facts` holds the destination classes (D2) and the repository facts the resolver read for each effective cwd: the repository root, `origin`'s URL, every remote's URL, and the current branch's push remote.

Arguments are read by position and flag, never by searching text. A `--git-dir`, `--work-tree`, or `remote.*`/`url.*` `git -c` override pins a push's target unresolved exactly like a `GIT_DIR` environment assignment. A `--body`, `--body-file`, `--title`, `-m`, `--notes`, `-f body=…` or `-F body=@file` value, or a heredoc is a value and never a target. A `GH_REPO`, `GH_HOST`, or `GIT_DIR`/`GIT_WORK_TREE` assignment — as a prefix (`GH_REPO=… gh …`), through `env`, or by an earlier `export` or assignment segment — makes the affected `gh` or `git` target unresolved, so the call reads `unknown-destination` and never `allowed`; the classifier does not evaluate shell variables. That removes the spike's whole false-positive class.

The rules (ids are append-only, contract E3):

| Rule | Send when | Target |
| --- | --- | --- |
| `git-push` | `git push` | `--repo=<remote or URL>`, the named remote's URL, a URL or `user@host:path` argument, else the branch's push remote, else `origin` |
| `gh-write` | `gh <issue\|pr\|release\|repo\|gist\|label\|secret\|variable\|workflow\|run> <create\|edit\|close\|reopen\|comment\|merge\|delete\|review\|upload\|set\|run\|fork\|…>` | `-R`/`--repo` (`owner/repo`, `host/owner/repo`, or a URL such as `-R https://github.com/o/r`), a `github.com/<owner>/<repo>` positional argument, else the cwd's `origin`; any `GH_REPO`/`GH_HOST` assignment before it makes the target unresolved. `gh repo create`/`fork` and `gh gist create`/`edit` never fall back to origin (D1): a create or fork targets the new repository — the positional `owner/name`, a bare name reading as the caller's own account — and a gist targets `gist.github.com`; each is a violation unless it equals origin's `owner/repo` |
| `gh-api-write` | `gh api` with `-X`/`--method` other than GET, or with `-f`/`-F`/`--field`/`--raw-field`/`--input` | `repos/<owner>/<repo>/…` (with `{owner}`/`{repo}` meaning origin), else unresolved (for example `graphql`) |
| `registry-publish` | `npm`/`bun`/`pnpm`/`yarn publish`, `twine upload`, `cargo publish`, `docker`/`podman push`, `helm push`, `buildctl … type=image,push=true`, `docker buildx … --push` | `--registry`, `--repository-url`, `--index`, the image or OCI reference's registry host, else that tool's public default registry |
| `http-send` | `curl` with `-X`/`--request` other than GET or HEAD, `-d`/`--data*`, `-F`/`--form`, `-T`/`--upload-file`, or `--json`; `wget --post-data`/`--post-file`/`--method`; `http`/`https` (httpie) with a non-GET method or a body item | the URL's host |
| `mail-send` | `sendmail`, `msmtp`, `mailx`, `ssmtp`, `mail -s`, `python -m smtpd`, or a `smtp://` / `smtps://` URL argument | `mail` |
| `mcp-call` | any external MCP tool call (D5) | `mcp:<server>` |

The verdicts:
- **`allowed`:** the target resolved to an allowed class. That means a GitHub URL whose `owner/repo` equals `origin`'s (https and ssh forms normalized), or a host in the internal or model-provider classes.
- **`violation`:** the target resolved to anything else. Examples: another GitHub repository, a public registry, a host outside every class, any `mail` target, an MCP server not in `mcpServers`.
- **`unknown-destination`:** the target did not resolve. Examples: a shell variable or `$(…)` in the target position, an unknown remote name, `gh api graphql`, no repository at the cwd, or a facts read that failed.

A call's row carries its strongest candidate (`violation` > `unknown-destination` > `allowed`, then rule order) and lists every candidate in `matches`. `classifier_version` records the rule-set version that judged it, so a later rule change never rewrites history.

The facts resolver is the one I/O step. It finds the repository with the same nearest-`.git` walk as `resolveTeam`, then reads remotes and the push remote from the common dir's `config` file as text, with no `git` process. Reads are cached per repository root by that file's mtime and size. It runs only for send candidates, about 200 a month.

*Alternative:* spawn `git remote get-url` per call. Rejected as a process spawn on the observation path for data that is one small file.

### D5. External MCP calls are recorded as `mcp-call`

Kawai cannot tell an MCP read from a send. So every call to an MCP server other than `kawai-team` is recorded: `allowed` when its server is in `mcpServers`, else `violation`. The spike's history has none, so the volume is zero today. Each call keeps its own violation row, but attention groups by rule and destination (D10): a stream of calls to one unlisted server raises one item, which stands until the owner acknowledges it. Adding the server to `mcpServers` records later calls as `allowed`; it never clears the standing item.

The allowlist is never derived from the CLI's MCP settings. `mcpServers` is the owner's reviewed list in user-level configuration; deriving it from settings, which project files can also supply, would mark unreviewed servers allowed.

*Alternative:* record no MCP calls. Rejected: P4 asks for every observable send, and an external MCP server is the most direct outward channel an agent has.

### D6. Records: three append-only tables, added by migration 3

```sql
-- Migration 3 (`outbound-audit`, after migration 2 `strategy-impact`). Append-only: no UPDATE or DELETE
-- statement exists for these tables (E3).
CREATE TABLE outbound_calls (
  id TEXT PRIMARY KEY,                 -- 'obc-<uuid>'
  team_id TEXT NOT NULL,               -- resolved from the effective cwd at the call
  session_id TEXT NOT NULL,
  spawn_id TEXT NOT NULL,              -- the agent process that made the call (D7)
  group_id TEXT,                       -- the session's group, profile, and task when called
  profile_id TEXT,
  task_id TEXT,
  agent_id TEXT,                       -- subagent id; null on the main thread
  tool TEXT NOT NULL,                  -- Bash | Monitor | mcp__<server>__<tool>
  mcp_server TEXT,
  tool_use_id TEXT NOT NULL,
  command TEXT NOT NULL,               -- redacted (D8), at most 4096 characters
  truncated INTEGER NOT NULL DEFAULT 0,
  rule TEXT NOT NULL,                  -- E3 rule id of the strongest candidate
  verdict TEXT NOT NULL,               -- violation | allowed | unknown-destination
  destination TEXT NOT NULL,           -- e.g. 'github:origin', 'internal:<host>', 'unresolved:<why>'
  matches TEXT NOT NULL,               -- JSON: every candidate {rule, segment, verdict, destination}
  classifier_version INTEGER NOT NULL,
  cwd TEXT NOT NULL,                   -- the session's cwd at the call
  created_at TEXT NOT NULL,
  UNIQUE (session_id, tool_use_id)
);
CREATE INDEX outbound_calls_team_time ON outbound_calls (team_id, created_at DESC, id DESC);

CREATE TABLE outbound_outcomes (
  session_id TEXT NOT NULL,
  tool_use_id TEXT NOT NULL,
  outcome TEXT NOT NULL,               -- completed | failed | denied | started-background
  detail TEXT,                         -- redacted error or deny reason, at most 1024 characters
  duration_ms INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (session_id, tool_use_id, outcome)
);

CREATE TABLE outbound_acknowledgements (
  id TEXT PRIMARY KEY,                 -- 'oba-<uuid>'
  team_id TEXT NOT NULL,
  command_id TEXT NOT NULL,
  rule TEXT NOT NULL,                  -- the violation group (D10): rule and destination
  destination TEXT NOT NULL,
  through_created_at TEXT NOT NULL,    -- covers the group's violations up to this call
  through_call_id TEXT NOT NULL REFERENCES outbound_calls(id),
  note TEXT,                           -- optional, at most 300 characters
  acknowledged_at TEXT NOT NULL,
  UNIQUE (team_id, command_id)
);
```

`OutboundStore` is the only SQL writer of these tables. An outcome may be written before its call row, because the call insert is queued (D3). Outcomes therefore key on `(session_id, tool_use_id)`, not on the call id; the read joins them, and `UNIQUE (session_id, tool_use_id, outcome)` is the dedupe. An outcome row whose call row never arrives (a crash in between) is kept and joins nothing.

Rows are never pruned. At about 200 sends a month, a row of at most 5 KiB costs about 1 MB a month at worst. A later change may add retention, and the view and the summary read nothing that pruning would break.

### D7. Outcome state is derived at read time

`outcomeState(call, outcomes, liveSpawns)`:
1. `denied`, `failed`, or `completed` when such a row exists. The precedence is denied, failed, completed.
2. Else `started-background`, when that row exists. The view links it to the background task through chat-session-background-tasks' roster, which joins by tool-call id. Its later fate shows there and is never copied here.
3. Else `pending`, while the call's `spawn_id` is in the live set.
4. Else `outcome-unknown`.

The driver mints a `spawn_id` at each agent process start and drops it from `liveSpawns` when the process ends: an exit, a kill, an archive, or a server stop. The set lives in memory only, so after a restart every call without an outcome reads `outcome-unknown` and is never re-run or re-judged (the R19-style test, contract E7).

### D8. Redaction runs before any write

`redact(text)` runs on every field written from the command or the tool's output before it reaches the store, the log, or the view: the command, each `matches[].segment`, `destination`, and the outcome detail. `destination` is built from the redacted target, so a credential in a URL never reaches it. It replaces each of the following with `‹redacted›`:
- known token shapes: `ghp_`/`gho_`/`ghu_`/`ghs_`/`ghr_`/`github_pat_`, `sk-…`, `xox[abpr]-…`, AWS `AKIA…`, JWT-shaped triples, and `-----BEGIN … PRIVATE KEY-----` blocks;
- the values of `Authorization:`, `Proxy-Authorization:`, `Cookie:`, `X-Api-Key:`, and `PRIVATE-TOKEN:` headers;
- `-u`/`--user` credentials;
- URL userinfo (`https://user:pass@`, and `https://token@`);
- `--token`/`--password`/`--api-key` values, and the `-b`/`--body` value of a `gh secret set` (a secret itself; `gh variable set` is unchanged);
- query-string credentials: the values of `token`, `access_token`, `api_key`, `apikey`, `key`, `secret`, `password`, `sig`, and `signature` parameters;
- body credentials in `-d`/`--data*`/`--json`/`-F`/`-f` values: JSON members and form fields whose name matches the inline-assignment pattern below;
- inline assignments whose name matches `/(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|AUTH)/i`.

Redaction is pure and tested against a fixture corpus. It errs toward over-redaction. The classifier sees the unredacted command in memory only, and nothing unredacted is ever written.

### D9. The owner audit view is the Team page's **Audit** tab

`team-workspace-pages` D3 routes `#/team/<key>/<tab>[/<id>]`, and `durable-plans` mounts **Plans** as a host-agnostic view that owns its subscriptions. **Audit** follows that pattern as the last tab, after Members: `#/team/<key>/audit[/<callId>]` mounts `TeamAuditView` from `src/client/components/team/`. It is the last tab because it is read-only and owner-facing, not part of the daily flow.

*Alternative:* the chat side slot. Rejected, because `team-workspace-pages` D4 reduces the side slot to Debug.

The view shows:
- **Header counts** for the chosen time range: allowed sends per rule (for example `git-push 106`, `gh-write 51`), unknown destinations, violations, and unacknowledged violations.
- **Rows,** newest first: time, verdict, rule, destination, the session (named, `Name (gone)` through `team_session_directory` for a killed one, linking only live or archived sessions), group, profile, task, subagent, tool, the redacted command (one line, expandable), cwd, and the outcome state (D7) with its detail.
- **Filters:** verdict, rule, session, and a time range. These are server filters with keyset paging over `(created_at, id)` and **Load more**, as in the Messages view.
- **Acknowledge** on a violation row, with an optional note. It acknowledges the row's group (rule and destination) through that row (D10).

The protocol, addressed by `teamPath` through the shared team-scope resolver:
- `team-audit-open { teamPath, filters }` answers `team-audit-page { rows, counts, cursor }`, and `team-audit-more { teamPath, filters, cursor }` answers the next page.
- `team-audit-close` ends the subscription.
- Every committed call, outcome, or acknowledgement of the team sends `team-audit-changed`, and the client re-requests its first page. Volume is low, and replace semantics keep the client trivial.
- `team-audit-acknowledge { teamPath, callId, commandId, note? }` answers `team-audit-result`.

Every type joins `CHAT_CONNECTION_TYPES`. Every control disables while disconnected.

### D10. Violations raise a human-owned informational attention item

`ATTENTION_SOURCES` gains `outboundItems`, pure over the team's unacknowledged violation rows, grouped by `(rule, destination)`. A violation is unacknowledged when no acknowledgement of its group covers it (`through_created_at`, `through_call_id` at or after the call's `(created_at, id)`), so a later violation of an acknowledged group raises the item again. One item per group:
- kind `outbound-violation`, with id `outbound-violation:<rule>:<destination>`;
- owner `{ kind: 'human' }`, with `requiresHuman: true`;
- the impact is informational: nothing waits on the item;
- the cause is "<rule> to <destination>: <n> unacknowledged, latest by <session>";
- the next action is "Review and acknowledge";
- the link is the new `AttentionLink` kind `audit`, with the newest call id, which opens the Audit tab on that row filtered to the group.

Unknown-destination and allowed rows raise nothing. The `MorningSummary` gains the bucket `outbound`, counting the window's violations, unknown destinations, and allowed sends. It is durable, not `runtimeOnly`.

Acknowledgement:
- `OutboundService.acknowledge` refuses a non-human caller first.
- The command names one violation call (`callId`, the newest the dialog showed) and an optional note. It acknowledges that call's group through that call.
- It replays by `(team_id, command_id)`: the same call and note return the prior result, and a different payload is refused naming the field.
- It refuses a call that is not a violation or belongs to another team (read as not found).
- It inserts one row.

Acknowledged calls keep their rows and verdicts, and the item clears until the group's next violation.

No agent tool reads or writes audit rows, and no `kawai-team` tool is added. A verdict never stops anything: it is not an X8 stop reason, not an S2 cause, not an R5 attention kind, and not a dispatch, routing, or staffing input.

### D11. Late writers: pins and liveness, no leases (spike Q5)

The guards that already exist are the design:
- results pin the task revision they were submitted under, and acceptance derives "needs re-evaluation" from the pin;
- a superseded assignment derives `superseded` before any failure, and its undelivered stage mail is cancelled;
- member release archives only settled members;
- every exclusive-slot holder kind ships a liveness check.

This change restates the last two as a binding rule for every later change (E7). A change that adds a holder kind of `plan_landing_slots`, a promotion holder, or any new exclusive slot must also add:
- a liveness predicate;
- startup clearance of orphan holders, run again whenever the slot is found taken;
- a recovery-matrix row naming the test.

The residual hole: a still-live superseded agent can submit a result. That result stays readable history and never wins acceptance over the pin. It is accepted under rev 2.

*Alternative:* fencing tokens on results. Rejected: they add a protocol to every tool for a case the pins already make harmless.

### D12. Voluntary checkpoints stay out

`revision-control` left voluntary checkpoints to this change. They are out:
- R17–R19 need none;
- the pause path's `task_checkpoint` (R2) already covers the one case where the owner needs work on `origin`;
- an agent can always commit and push its branch.

`task_checkpoint` keeps refusing without a pause, as `no-pause-requested`.

### D13. Schema version: a `schema_migrations` table with a baseline

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL,
  app_version TEXT NOT NULL,           -- package.json version of the build that applied it
  backup_path TEXT                     -- the pre-migration backup (D15); null for the baseline
);
```

`src/server/dbSafety/migrations.ts` holds `MIGRATIONS: readonly Migration[]`, each `{ version, name, up(db) }`, versions dense from 2.

At startup, `initDatabase` does the following in order:
1. **Reads the version without writing.** It checks `sqlite_master` for `schema_migrations` and reads `max(version)`, with 0 for a missing table or no rows.
2. **Refuses a newer database** (D14) when that version is greater than the newest known one, before any statement that could write, so the file's bytes are unchanged.
3. Takes the `startup` snapshot (D15).
4. **Runs the baseline exactly once,** only when `schema_migrations` has no rows: today's schema functions unchanged — `db.ts`'s ensures, `migrateDatabase`, and every store schema function, which `initDatabase` collects into this step instead of stores calling them lazily (task 6.1 inventories them) — then creates `schema_migrations` and records version 1 `baseline`. The steps are idempotent today, so a crash before version 1 is recorded just runs them again. A database with extra tables, such as one a development branch created, still records version 1; the baseline never inspects or drops what it does not know.
5. **Applies each pending migration in order,** gated on its backup: it takes the `pre-migration-<n>` snapshot and waits until that file is renamed into place and its integrity check has passed. A failed snapshot or check refuses startup, naming the backup, and `up(db)` never starts. Otherwise it runs `up(db)` and inserts the version row, with `backup_path`, in one `BEGIN IMMEDIATE` transaction. A throw rolls the transaction back and refuses startup, naming the migration and the backup.

On every later start, step 4 is skipped, so a migration that drops or renames a baseline column is never undone by the frozen ensures.

`PRAGMA user_version` mirrors `max(version)` for outside tools and is never read for a decision.

*Alternative:* `user_version` alone. Rejected: it records no names, times, or backups, and a mirror costs nothing.

Rule for later changes (E5): a schema change after this one is a numbered migration. The baseline ensures stay frozen, apart from bug fixes, and run only on a database with no recorded version.

### D14. A database newer than the build refuses to start

A newer database means it was migrated by a newer build. An older build could write rows that violate invariants it does not know. Recommendation: refuse, and offer no override. The server exits with one message naming:
- the database's version and the build's newest version;
- the newest backup taken before that migration;
- the restore procedure (D16).

Going back to an older build is therefore a restore, which is explicit and keeps the newer file aside.

*Alternative:* start read-only. Rejected, because Kawai cannot run without writing.

### D15. Online backups: same-connection `serialize()`, verified and rotated

`DatabaseBackups.snapshot(reason)` takes one backup:
1. Runs on the server's own connection, from a timer or a startup step, never inside a transaction. bun:sqlite transactions are synchronous, so a callback cannot interleave with one.
2. Calls `db.serialize()`, which takes SQLite's shared lock for the copy, then writes the bytes asynchronously to `<name>.partial`, fsyncs, and renames to `agentboard-<UTC stamp>-<reason>.db` in `~/.agentboard/backups/`.
3. Opens the file read-only on a separate connection, runs `PRAGMA integrity_check`, and closes it.
4. A failed check renames the file to `.corrupt`, logs it, and keeps it out of rotation.

Leftover files have their own retention, outside the reason rotation: at startup and after each snapshot, the newest 3 `.corrupt` and the newest 3 `.partial` files (never the one being written) are kept for diagnosis and older ones deleted, so neither kind grows without bound.

**Measured** on a copy of the live 5.1 MB database (bun:sqlite, this host): `serialize()` took 2.4–5.0 ms, `VACUUM INTO` 15–52 ms, and the integrity check of the copy 4.8–5.6 ms. The event loop pauses for the `serialize()` only, under about 5 ms at today's size. The write and the check are off the hot path.

A snapshot can never fail a live commit:
- the server's own statements cannot run during it;
- the shared lock is held for milliseconds, within the 5 s `busy_timeout` of any outside writer;
- nothing is attached to the live connection;
- the live file is never copied with `cp`.

The schedule:
- `startup`: after the version check and before the baseline and pending migrations (D13);
- `interval`: hourly, skipped when the database has not changed since the last snapshot. Each snapshot stores the connection's `total_changes()` value at the moment it was taken, and the interval compares against the last snapshot's stored value. The counter is per connection and restarts at zero with each process, so only snapshots of the running process count: every start takes a `startup` snapshot, which stores the first value;
- `pre-migration-<n>`: before migration n.

The rotation, per reason, by name:
- the newest 24 `interval` snapshots;
- the newest 7 `startup` snapshots;
- every `pre-migration` snapshot of the newest 3 migrations.

At today's size the set is at most about 180 MB. The view shows backup status read-only (D9's footer): the newest snapshot per reason, its size, its check result, and failures, server-wide and labeled as such.

*Alternative:* `VACUUM INTO`. It is three to ten times slower measured, and it also blocks the connection. It remains the fallback if `serialize()` ever exceeds memory, which at 5 MB it does not.

### D16. The restore procedure lives in docs

`docs/operations/database-backups.md` gives the layout, the rotation, and these restore steps:
1. Stop the server.
2. Move `agentboard.db` and any `agentboard.db-journal` aside together. A hot journal belongs to its database.
3. Copy the chosen backup to `agentboard.db`.
4. Run `PRAGMA integrity_check` with the `sqlite3` CLI or `bun`.
5. Start the server.

It also states what a restore does not bring back:
- rows written after the snapshot;
- the sidecars beside the database (`chat-wire/`, `chat-tasks/`, `chat-workers/`);
- the SDK transcripts.

Rows created after the snapshot, mail included, are simply absent. On start after a restore, mailbox reconciliation re-derives delivery for mail the snapshot holds as claimed or pushed: it is confirmed from the recipient's transcript or held as uncertain for the human, so a restore never silently re-sends it.

The doc also states the limitation: **backups stay on the host, on the same disk as the database.** Losing the disk loses both. Copying `~/.agentboard/backups/` elsewhere is the owner's choice, and Kawai never sends it anywhere (P4).

### D17. The recovery matrix is a maintained doc

`docs/recovery-matrix.md` turns the spike's Q4 tables into one table: fault, mechanism, owning change, contract, and test, the test being a file and test name, or "gap" with the reason. It covers:
- each row of `docs/multi-agent-development-ux.md`'s durability table;
- R17–R19;
- this change's own faults: a crash between a hook and its row, an outcome missing across a restart, a torn backup, a failed migration, a newer database, and a restore;
- revision-control's hold, pause, checkpoint-push, and Apply crash cases (R1–R4).

AGENTS.md gains the rule that a change adding a recovery mechanism or exclusive slot adds its matrix row in the same change. Review reads the matrix like any spec.

## Contracts consumed

| Contract | From | Used for |
| --- | --- | --- |
| X3 Effects | `plan-execution` D14 | Kawai's own git and `gh` calls stay effect rows. The audit is a separate table and id space, and adds no effect kind. The view may link an effect, and never writes one. The matrix cites the `running` → `unknown` inspection. |
| X6 `LandingMechanism` | `plan-execution` D13, with D3's slot-liveness rule (orphan holders cleared at startup and whenever the slot is found taken; a new holder kind supplies its own check) | D11 restates the liveness rule for every later holder kind. |
| X8 Stop reasons | `plan-execution` D12 | Audit verdicts add no stop reason. The X8 table's "new reasons" entry for this change is empty. |
| I2 Promotions | `integration-candidates` D3 | Promotion writes are effects, never audit rows (D3). The matrix cites promotion recovery. |
| S2 Outcomes and causes | `plan-supervision` D10 | Audit adds no cause. The matrix names `changeSupervision` as the recovery-state reader. |
| S3 Usage records | `plan-supervision` D14 | Cited only. No budget or cost column. |
| R1 Holds | `revision-control` D2, D4–D5 | Matrix rows for hold durability. Audit never places, releases, or gates a hold. |
| R2 Pauses and checkpoints | `revision-control` D6–D9 | `task_checkpoint` stays pause-only (D12). Matrix rows for Paused across restart, R18, and the `push-checkpoint` inspector. |
| R3 Execution revisions and publications | `revision-control` D10–D11 | Matrix row for Apply's atomic commit, R17. |
| R4 Command events | `revision-control` D3 | Cited as the command-replay pattern that D10's Acknowledge follows. |
| R5 Causes and attention | `revision-control` D13 | `outbound-violation` is a separate attention kind and never a cause. |
| Attention sources and summary | `team-workspace` D5, D8 (`workspaceRead.ts`) | `outboundItems` source, `AttentionLink` kind `audit`, `outbound` summary bucket. |
| Tab model | `team-workspace-pages` D3 | The `#/team/<key>/audit` tab. |
| Host-agnostic team view | `durable-plans` D12 | `TeamAuditView` owns its subscription over `teamPath`, as `TeamPlansView` does. |
| C3 / C6 | `durable-plans` | Not consumed. durable-plans' contract table lists this change under them, but it writes no plan events and no plan records. |
| Team-scope resolver | `team-message-history`, shipped | `teamPath` addressing and the `unknown-team` refusal. |
| Background task roster | `chat-session-background-tasks` | The `started-background` link by tool-call id. |
| `developerInstructions` | `codex-chat-sessions` | Carries E1's text. |

## Contracts published

| Contract | Definition | Consumers |
| --- | --- | --- |
| E1 Security note | D1 `SECURITY_NOTE_BODY` and its rendering of configured destinations, read at spawn | `codex-chat-sessions` (the same text in `developerInstructions`), every later prompt change |
| E2 Outbound destinations | D2 file shape, defaults, and the `OutboundDestinations` loader | later classifiers, a future settings UI |
| E3 Audit records | D6 tables, append-only; D4 rule ids and verdicts, append-only, with `classifier_version`; D7 `outcomeState` | a later team usage or safety view; retention, if ever |
| E4 Audit attention | D10 kind `outbound-violation`, link kind `audit`, `outbound` bucket, the Acknowledge command | `team-workspace` consumers, Lead decision cards |
| E5 Schema migrations | D13 table, `MIGRATIONS` registry, backup before each migration, and D14's refusal | every later change that alters the schema |
| E6 Backups | D15 `DatabaseBackups.snapshot(reason)`, layout, and rotation; D16 restore | later risky operations needing a snapshot first |
| E7 Recovery matrix | D17 doc; D11 liveness and pin rule; D7's outcome-unknown | every later change adding a recovery mechanism or exclusive slot |

## Risks / Trade-offs

- **The classifier is heuristic.** Obfuscation, scripts that send, and variables defeat it. → Unresolvable targets read `unknown-destination` rather than allowed. The prompt rules carry the rest, as P4 accepts. Precision matters more than recall for the owner's trust, and the history shows zero true violations.
- **Unconfigured internal hosts read as violations.** → The attention item names the host, and adding it to `outbound.json` stops later items. Earlier rows keep their verdict, because history is never rewritten.
- **Queued writes can be lost on a crash.** → The window is milliseconds. A server crash also ends the CLI child, so the tool almost certainly did not run. The matrix lists it as a known gap.
- **Hooks add a round trip per audited tool.** → Each SDK hook is a control-protocol message the CLI awaits. The callback returns at once (D3), so the cost is the round trip, measured in task 3.4 and stated in the matrix. It applies only to Bash, Monitor, and external MCP calls.
- **Backups share the disk.** → Stated in D16. Off-host copies are the owner's choice.
- **A refused start after a downgrade surprises the owner.** → The message names the backup and the procedure. That is safer than an old build writing into a newer schema.

## Migration Plan

1. Land the baseline and backups first (task group 6). The first start records version 1 and takes a `startup` snapshot. Nothing else changes.
2. Migration 3 creates the audit tables (task group 3) and takes `pre-migration-3` first, after migration 2 `strategy-impact` (strategy-revision-impact).
3. The prompt note and loader (groups 1–2) need no migration. They reach each agent at its next spawn.
4. Rollback: an older build refuses the migrated database (D14). Restore `pre-migration-3` to go back.

## Open Questions

None blocking. Settled here with a recommendation:
- voluntary checkpoints are out (D12);
- no retention for audit rows (D6);
- hooks return before I/O and writes are queued (D3);
- a newer database refuses without an override (D14);
- external MCP calls are recorded (D5).
