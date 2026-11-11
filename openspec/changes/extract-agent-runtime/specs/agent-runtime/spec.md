# Spec Delta

## Purpose

Give headless applications and Kawai one reusable contract for driving Claude and Codex sessions, observing their work, stopping owned processes and resuming conversations.

## ADDED Requirements

### Requirement: Drivers operate without a Kawai server
The runtime SHALL expose Claude and Codex drivers usable with injected dependencies and callbacks alone. Importing or constructing them SHALL NOT start a Kawai service, open a listener, require tmux or read Kawai configuration.

#### Scenario: Headless construction
- **WHEN** a clean Bun application constructs either driver with no custom tools, workspace context or wire recorder
- **THEN** it can start and run a turn without importing Kawai server modules or creating a network listener

### Requirement: Session start and turn results are distinct
Starting a driver SHALL initialize a session without submitting a prompt and complete once it is ready. A submission while starting SHALL wait for readiness, then be admitted or refused. Each submitted turn SHALL have a correlated handle and exactly one terminal result with outcome, final text, model, available token usage, unique tool-call count and compaction count. Missing measurements SHALL be distinguishable from measured zero.

#### Scenario: Successful turn
- **WHEN** a runtime finishes the submitted turn successfully
- **THEN** its handle resolves once with the matching turn identity, final text and measured results

#### Scenario: Failed or interrupted turn
- **WHEN** a submitted turn fails, is interrupted or loses its process
- **THEN** its handle resolves once with the corresponding non-success outcome and available partial measurements

### Requirement: Cooperative interrupt is distinct from forced stop
A cooperative interrupt SHALL cancel pending requests, settle the active turn and queued submissions as interrupted at once, refuse every submission not yet acknowledged, and request that the turn stop while retaining its conversation. Its receipt SHALL NOT imply process exit. Callers SHALL have a separate forced-stop operation when they require proof that the agent process has ended.

#### Scenario: Interrupt then continue
- **WHEN** a caller cooperatively interrupts a turn and later submits another
- **THEN** the second turn continues the same conversation and the interrupt receipt makes no process-exit claim

#### Scenario: Interrupt while a submission awaits checkpoint persistence
- **WHEN** a submission waits for a checkpoint to persist, the turn before it has ended, and the caller interrupts
- **THEN** the submission is refused as interrupted at once, before the persistence settles, it never runs later, and the receipt reports that work was cancelled

### Requirement: Forced stop has an actual exit boundary
Forced stop SHALL prevent further submissions, request termination of every process generation still owned by the driver, and await actual process exits and owned asynchronous work. Success SHALL include an explicit exit receipt. A signal acknowledgement, closed iterator or elapsed drain bound SHALL NOT substitute for exit. Unsupported or failed stop evidence SHALL fail explicitly.

#### Scenario: Delayed process exit
- **WHEN** a process remains alive after receiving a termination request
- **THEN** forced stop remains incomplete until actual exit, and the caller receives no successful stopped receipt beforehand

#### Scenario: Repeated stop and retired generation
- **WHEN** callers stop the same driver concurrently while an earlier process generation still has work
- **THEN** they observe the same terminal stop outcome after all owned generations settle, without orphaned work or duplicate termination results

### Requirement: Shutdown preserves resumability
Shutdown SHALL stop and join the session's owned work without deleting its runtime conversation or transcripts. Callers SHALL be able to resume using the runtime identity and the same supplied home directories after constructing a new driver in another host process.

#### Scenario: Resume after forced process termination
- **WHEN** the caller saves a reported runtime identity, kills the process and constructs a driver with that identity and the retained homes
- **THEN** the driver resumes the same conversation and does not silently create a new one

#### Scenario: Missing or invalid resume identity
- **WHEN** the runtime refuses a supplied identity or its required transcript state is unavailable
- **THEN** start fails with a resumability error and no fresh conversation is substituted

### Requirement: Runtime identity is available for persistence
The runtime SHALL report its session or thread identity and available transcript location as soon as known. The caller SHALL own durable storage. A configured checkpoint callback SHALL complete successfully before the runtime acknowledges acceptance of subsequent user work that relies on that checkpoint.

#### Scenario: Checkpoint persistence fails
- **WHEN** the caller's checkpoint callback rejects
- **THEN** work depending on that unsaved identity is not acknowledged as accepted, and the failure is observable

### Requirement: Unexpected process end is reported
An exit not requested by the caller SHALL invoke the process-end callback once for that process generation, with available exit or failure facts. Requested shutdown or kill SHALL be represented by its stop receipt and SHALL NOT be reported as an unexpected exit.

#### Scenario: Crash during a turn
- **WHEN** the CLI process exits unexpectedly with a turn pending
- **THEN** the caller receives one process-end notification and one failed terminal turn result

### Requirement: Agent-started turns are reported
When the runtime opens a turn without a submitted message, such as after a background task ends, an idle driver SHALL report one turn with the runtime's turn identity: a turn-start event carrying its trigger (the ending tasks' summaries), no user message, the active state, and exactly one terminal result, with no message identity, through the turn-result callback. Input that arrives while a turn is active SHALL bind to that turn. Input before ready or after stop or exit SHALL open no turn.

#### Scenario: Background completion wakes an idle driver
- **WHEN** a background task ends while the driver is idle and the runtime starts a turn in response
- **THEN** the caller receives one turn start naming the task, the turn's events, and one terminal result, and the driver returns to idle

#### Scenario: No phantom or late agent-started turn
- **WHEN** a driver attaches idle without a prompt, or turn-opening input arrives after stop
- **THEN** no turn start, turn result or state change is reported

### Requirement: Requests can be answered immediately
A question or approval request SHALL be registered before the request callback fires with its identity. The caller SHALL be able to answer or deny inside that callback. Only the first valid response SHALL apply. Headless handling SHALL NOT depend on a browser, UI deadline or recommended answer.

#### Scenario: Inline response
- **WHEN** the request callback immediately answers a question or denies an approval by its request id
- **THEN** the runtime receives that response without an intervening UI operation or timer

#### Scenario: Response races stop
- **WHEN** a response and stop target the same pending request
- **THEN** exactly one settlement occurs and a late response reports that the request is no longer pending

#### Scenario: Explanatory response on a Claude question
- **WHEN** a caller answers a pending Claude question with valid answers and a non-blank response, or supplies a response that is blank, on a Codex question or on an approval
- **THEN** the valid Claude answer carries the chosen answers and that response unchanged, and every other case reports invalid and leaves the request pending

### Requirement: Events are ordered serializable values
Conversation events SHALL be JSON-serializable and carry stable event ids, stream ordering, timestamps when known and relevant turn, message and tool identities. An archived event SHALL retain its identity on replay. Runtime-native objects, errors, callbacks and secrets from the launch environment SHALL NOT be placed in the event envelope.

#### Scenario: JSONL and resumed stream
- **WHEN** a caller serializes events to JSONL, reads them back and appends events from a resumed driver
- **THEN** stored event identities and order remain intact, and new events do not collide with earlier events

### Requirement: Usage and quota reports remain observable
The runtime SHALL expose token, model and compaction facts, quota-window reports and rate-limit signals when supplied by the provider. Reports SHALL retain provider window identity, percent used and reset time when known. Reports SHALL be delivered while idle, working or awaiting a request; unavailable information SHALL remain explicitly unknown.

#### Scenario: Idle quota update
- **WHEN** Codex or Claude supplies an account usage update while no turn is active
- **THEN** the usage or rate-limit callback receives the normalized windows without creating a turn

#### Scenario: Caller-claimed Codex quota read
- **WHEN** a Codex host supplies a quota-read claim and each started generation becomes ready after its checkpoint persisted
- **THEN** the claim is asked once per generation, only a granted claim sends that generation's one account read, a denied or throwing claim sends none and reports nothing, pushed updates are still reported, and without a claim the driver reads once

#### Scenario: Caller-claimed Claude usage pull
- **WHEN** a Claude host chooses its login as quota source and supplies a usage-pull claim, and a generation's query is constructed
- **THEN** the claim is asked once for that generation, only a granted claim makes its one usage pull, a denied, stale or failed spawn's claim makes none and reports nothing, and a rejecting claim is reported by the stop

#### Scenario: Quota read yields no data
- **WHEN** a permitted Codex read or Claude usage pull is attempted and the provider answers with no windows, lacks the method or fails
- **THEN** the no-data callback names the source and account scope once, no quota report is fabricated, and a denied or unattempted read reports neither

### Requirement: Host-compatibility inputs and observations are optional
A host MAY supply a live Codex effort reader, a Claude prompt composer, a detailed Claude hook observer and callbacks for cwd changes, spawns, Codex thread openings, compaction progress, context-usage metadata and notification expiry. Each SHALL report provider facts as observed, keep unknown values null, never affect permission or transport, and leave behavior unchanged when omitted. A reader failure SHALL refuse only the work that read it.

#### Scenario: Live Codex turn effort
- **WHEN** a Codex host supplies an effort reader and changes its answer between two turns on the same process
- **THEN** each new turn/start carries the answer read when it was sent, a steer or refused submission reads nothing, and a throwing reader refuses that turn with its raw error and sends no request

#### Scenario: Detailed Claude audit facts
- **WHEN** a Claude host supplies a detailed hook observer and a tool call succeeds, fails or is denied
- **THEN** the observer receives each hook's JSON-safe input with its kind, and its result or throw changes no permission decision

#### Scenario: Process and compaction observations
- **WHEN** a host supplies the spawn, cwd, compaction, context and notification callbacks
- **THEN** each actual spawn reports its launch provenance once, main-session cwd changes are reported, compaction start and completion carry their source ids and measured facts, context readings carry their persistence and threshold source, and notifications carry their timeout

#### Scenario: Codex thread opening reports a moved transcript
- **WHEN** a Codex host supplies the thread-open observer and a resume reply names the saved thread with a new transcript path
- **THEN** the observer receives that generation, thread id, path and resumed flag once before readiness, and no checkpoint is persisted again

#### Scenario: Claude prompt composition
- **WHEN** a Claude host supplies a prompt composer that returns pasted content and a peer origin for an accepted send
- **THEN** that prompt carries them beside its unchanged literal text and minted UUID, and a throwing or malformed composer refuses the send before anything is enqueued or emitted

#### Scenario: Native Codex skill input
- **WHEN** a Codex user message names a skill in the runtime's own skill catalog
- **THEN** its turn/start carries the typed skill input after the text, without any host-supplied input items

#### Scenario: Codex skill suppression per submission
- **WHEN** a Codex host submits text naming a catalog skill with the skill mode `none`
- **THEN** its turn/start carries the text alone, a later submission without the mode carries the skill again, and an unknown mode or any mode on Claude is refused before anything is sent

#### Scenario: Codex skill directory moves on a live process
- **WHEN** a Codex host moves the skill directory of a ready generation to another absolute path
- **THEN** the catalog is loading at once and a send meanwhile carries its text only, the same process lists the new directory with forceReload, a reply for the old directory publishes nothing, and later turns use only the new catalog

### Requirement: Rate-limit waits have explicit boundaries
A provider-observed retry wait SHALL emit a wait-start signal and one matching wait-end signal on observed resumption, cancellation or process end. Window and reset facts SHALL be retained when known. A predicted reset time alone SHALL NOT establish that work resumed.

#### Scenario: Reset passes without resumption
- **WHEN** a reported reset time passes while the provider has not resumed work
- **THEN** the runtime does not emit a successful resumption signal merely because time elapsed

### Requirement: Codex authentication errors are distinguishable
The runtime SHALL export a structural Codex-login check that returns only presence and type validity, never credentials. A recognized authentication failure during a turn SHALL carry an authentication error category distinct from quota, transport and other failures.

#### Scenario: Login shape and refusal
- **WHEN** a Codex home contains malformed authentication data or a turn returns the protocol's unauthorized error
- **THEN** the check returns false for the malformed data and the unauthorized turn is classified as an authentication failure without exposing credential values

