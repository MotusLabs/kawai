# Spec Delta

## Purpose

Let each host choose an agent session's process environment, permissions and integrations explicitly, without inheriting Kawai services or another session's credentials.

## ADDED Requirements

### Requirement: Child environments are complete caller input
Every runtime-owned process launch, restart and executable check SHALL use only the explicit environment supplied for that operation. The runtime SHALL NOT merge ambient environment variables or discover credentials from an unspecified home. It SHALL neither mutate the caller's map nor the host environment.

#### Scenario: Poisoned host environment
- **WHEN** the host environment holds unrelated provider tokens and the caller supplies an environment without them
- **THEN** neither runtime's child or executable check receives those tokens, including after respawn

#### Scenario: Empty or missing environment
- **WHEN** a caller omits the required environment or required home configuration
- **THEN** creation fails before spawning with a configuration error rather than using the operator's environment or home

### Requirement: Provider helpers isolate credentials
The package SHALL provide pure helpers for constructing explicit Anthropic, proxy-compatible Claude and Codex environments. Helpers SHALL neutralize conflicting provider credentials using supplied inputs only. Routing, custom headers and selected authentication SHALL survive unchanged, and credential values SHALL NOT appear in settings arguments or diagnostics.

#### Scenario: Z.AI-style proxy profile
- **WHEN** the caller selects a proxy base URL, custom authentication header and placeholder auth token while unrelated credentials exist in the input
- **THEN** the spawned Claude environment exactly matches the helper's returned environment, with the selected proxy values and other provider credentials removed or blanked

#### Scenario: Anthropic OAuth and Codex home
- **WHEN** separate sessions select Anthropic OAuth and a Codex login home
- **THEN** each process receives only its explicitly selected credentials and homes, without cross-session mutation or fallback

### Requirement: Permission configuration is session-specific
Each driver SHALL accept permission configuration independently of credentials and provider selection. Configuration SHALL be reapplied on resume and respawn. A restrictive configuration SHALL refuse to start if the installed runtime cannot enforce it; it SHALL NOT fall back to a more permissive mode.

#### Scenario: Different permissions on one provider
- **WHEN** two sessions on the same provider use different permission configurations
- **THEN** each enforces its own configuration without altering the other session or the provider profile

### Requirement: Restricted Claude sessions deny unlisted tools
Claude sessions SHALL support bypass mode with explicit disallowed tools and a fail-closed tool set. The restricted profile SHALL deny AskUserQuestion, Edit, Write, MultiEdit and NotebookEdit, deny Bash entirely, and deny any unlisted tool without prompting. An auto-approval list or permission callback alone SHALL NOT count as enforcement.

#### Scenario: Attempted write or shell execution
- **WHEN** a restricted Claude session attempts a write tool, Bash or an unlisted custom tool
- **THEN** the operation is denied without executing or waiting for a user, even in bypass mode

#### Scenario: Allowed read
- **WHEN** a restricted Claude session uses a configured allowed read tool
- **THEN** the read runs under the selected policy without granting permission to other tools

### Requirement: Codex supports headless approval and sandbox policy
Codex sessions SHALL support approval policy never and explicit workspace-write, read-only or no-sandbox selection. The selection SHALL apply to thread start, resume and turns. Disabled user-input and elicitation requests SHALL be answered or denied immediately through the configured headless handler, without a UI wait.

#### Scenario: Read-only resumed thread
- **WHEN** a thread formerly using broader permissions resumes with the caller's read-only and never-approval policy
- **THEN** the supplied policy controls the resumed thread and no stored broader policy is inherited

#### Scenario: No sandbox is explicit
- **WHEN** a caller explicitly chooses no sandbox
- **THEN** Codex uses its supported unrestricted mode rather than silently substituting workspace-write

### Requirement: Tools are injected and can be absent
Custom tools SHALL be supplied by the host with names, schemas and handlers. An empty set SHALL register no Kawai tools. Unknown tools, invalid arguments and calls for a different session or thread SHALL be refused without invoking a handler.

#### Scenario: No tools
- **WHEN** agent-host supplies an empty tool set
- **THEN** both drivers start successfully and expose no team, mailbox, plan or strategy tools

#### Scenario: Wrong identity or schema
- **WHEN** a runtime requests a custom tool for another thread or with invalid arguments
- **THEN** the handler does not run and the runtime receives a structured refusal

### Requirement: Host integrations are optional injected seams
Logger, prompt append, workspace context, audit observation and wire recording SHALL enter only through host-provided options. Omitted optional integrations SHALL require no Kawai modules or stores. Context refusal SHALL occur before a user message is enqueued or a visible turn is opened.

#### Scenario: No workspace context
- **WHEN** a headless caller supplies only a prompt append and logger
- **THEN** a normal turn runs without accessing a plan store or mailbox

#### Scenario: Context persistence refuses
- **WHEN** the configured pre-submit context callback refuses a contextual message
- **THEN** no runtime message is sent and no turn-start or user-message event is emitted for that submission

### Requirement: Observation does not grant permissions or leak inputs by default
The default tool observer SHALL expose tool name, identity and lifecycle facts without arguments. Observer failure SHALL NOT authorize, block or duplicate a tool operation. Raw audit and wire payload access SHALL require explicit host opt-in. Logs and process receipts SHALL NOT contain launch credentials or the complete environment.

#### Scenario: Names-only observer
- **WHEN** a tool input contains a secret marker and the observer counts calls
- **THEN** it receives the tool's name and identity but not the marker or arguments

#### Scenario: Observer throws
- **WHEN** an observational hook throws
- **THEN** the underlying operation follows the same permission decision and runs at most once, with a safe diagnostic

### Requirement: Runtime I/O stays within supplied resources
The package SHALL run as a non-root user without listeners or tmux. Runtime-owned files SHALL be confined to the supplied working and home directories, including explicitly supplied cache and temporary directories. The package SHALL NOT alter host configuration or use a default operator data directory.

#### Scenario: Minimal container
- **WHEN** the headless example runs as a non-root user with isolated supplied directories and no Kawai installation
- **THEN** both runtimes operate without listeners or writes to unrelated host paths

