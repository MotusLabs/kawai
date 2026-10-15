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
Kawai SHALL record each tool call that a classifier rule matches as a publish or send, allowed ones included, and SHALL record nothing for other tool use. Calls to `kawai-team` tools SHALL NOT be recorded. Kawai's own git and `gh` calls SHALL stay plan-execution effect rows and SHALL NOT be audit rows. Every external MCP tool call SHALL be recorded.

#### Scenario: A read is not recorded
- **WHEN** an agent runs `curl` with a plain GET, or `git status`
- **THEN** no audit row exists for the call

#### Scenario: Team mail is not recorded
- **WHEN** an agent calls `mcp__kawai-team__send_message`
- **THEN** no audit row exists, and the mailbox records the message as before

#### Scenario: An external MCP call
- **WHEN** an agent calls a tool of an external MCP server
- **THEN** the call is recorded with rule `mcp-call` and the server's name

### Requirement: Sends are classified by rule and resolved target
A pure classifier SHALL match the `git-push`, `gh-write`, `gh-api-write`, `registry-publish`, `http-send`, `mail-send`, and `mcp-call` rules by argument position and flag, never by text search. gh's implicit repository and git's push remote SHALL resolve from the repository's configuration. A message, title, body, or heredoc value SHALL never be a target.

#### Scenario: Origin-targeted gh is allowed
- **WHEN** an agent runs `gh pr comment 62 --body "see https://github.com/other/repo"` in a repository whose origin is the kawai repository
- **THEN** the target is origin and the verdict is allowed

#### Scenario: A foreign repository
- **WHEN** an agent runs `gh issue create -R other/repo --title x`
- **THEN** the verdict is violation with destination `other/repo`

#### Scenario: A push through a named remote
- **WHEN** an agent runs `git push fork main` where remote `fork` points to another GitHub repository
- **THEN** the verdict is violation naming that repository

### Requirement: Each send gets one verdict
A send SHALL be `allowed` when its target resolves to origin, an internal destination, a model provider, or a configured MCP server; `violation` when it resolves to anything else, any mail target included; and `unknown-destination` when it does not resolve. A call SHALL keep its strongest verdict, list every match, and record the classifier version.

#### Scenario: An unresolved target
- **WHEN** an agent runs `curl -d @data.json "$TARGET"`
- **THEN** the verdict is unknown-destination with the reason that the target is a variable

#### Scenario: A compound command
- **WHEN** one Bash call runs `git push && npm publish`
- **THEN** its row's verdict is violation for `registry-publish`, and its matches list both segments

#### Scenario: A configured internal registry
- **WHEN** an agent pushes an image to a registry under a configured internal domain
- **THEN** the verdict is allowed

### Requirement: Secrets are redacted before anything is written
Kawai SHALL redact tokens of known shapes, authorization and cookie header values, `-u` credentials, credentials in URLs, token and password flag values, and secret-named inline variables from the command and outcome detail before storing, logging, or showing them. Commands SHALL be stored up to 4096 characters, with truncation marked.

#### Scenario: A token in a header
- **WHEN** an agent runs `curl -H "Authorization: Bearer abc123" -d x https://host.example.internal`
- **THEN** the stored command shows the header value as redacted

#### Scenario: Credentials in a push URL
- **WHEN** an agent runs `git push https://user:secret@github.com/o/r.git`
- **THEN** the stored command and destination contain no `secret`

### Requirement: Audit records are append-only
Each recorded call SHALL store team, session, agent process, group, profile, task, subagent id, tool, MCP server, tool use id, redacted command, rule, verdict, destination, matches, classifier version, cwd, and time. Outcomes SHALL be separate append-only rows. No path SHALL update or delete either, and rows SHALL NOT be pruned.

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
Each violation not yet acknowledged SHALL raise a team attention item of kind `outbound-violation`, owned by the human, naming the session, rule, and destination and linking to the row. Unknown destinations and allowed sends SHALL raise none. A verdict SHALL NOT become a stop reason, supervision cause, or dispatch, routing, or staffing input.

#### Scenario: A violation is raised
- **WHEN** a send is judged a violation
- **THEN** the attention queue shows an `outbound-violation` item for the human that opens the row in the Audit tab

#### Scenario: Execution continues
- **WHEN** a plan change's developer's send is judged a violation
- **THEN** the change's execution, supervision cause, and dispatch are unchanged

### Requirement: Only the human acknowledges a violation
The human SHALL acknowledge a violation, with an optional note, under a command id: the item clears and the row and verdict stay. A replay SHALL return the prior result; a different payload SHALL be refused naming the field. Non-violations and other teams' calls SHALL be refused. No agent tool SHALL read or write audit records.

#### Scenario: Acknowledge clears the item
- **WHEN** the owner acknowledges a violation and the result is lost, so the dialog resends it
- **THEN** one acknowledgement exists, the item is gone, and the row still reads violation

#### Scenario: Agents have no audit tool
- **WHEN** an agent looks for a tool to read, acknowledge, or delete audit records, or calls the service directly
- **THEN** no such tool exists and the direct call is refused with nothing written
