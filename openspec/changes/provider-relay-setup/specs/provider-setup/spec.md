## ADDED Requirements

### Requirement: Relay setup configures a provider in one flow
The setup surface SHALL configure, per provider, the base URL, the access
token variable, header bindings, and the model IDs together, writing one
user-level catalog entry and importing credential values into the store. A
relay setup SHALL NOT require hand-editing catalog files. The flow SHALL
offer the shipped provider templates for adoption under their original ids.

#### Scenario: One-flow setup
- **WHEN** an operator configures a relay with its base URL, token variable, a virtual-key header binding, and model IDs
- **THEN** one user-level provider entry and the imported credential values exist afterwards, and a session on the provider reaches the relay with those headers

#### Scenario: Template adoption restores ids
- **WHEN** the operator adopts a shipped template
- **THEN** its provider or profile id resolves again exactly as the removed shipped entry did

### Requirement: Configuration sources are listed with their status
The system SHALL list every configuration source profile resolution reads:
each catalog file with loaded, missing, or rejected status and the rejection
reason, and each credential variable of the composed environment with its
presence and source. Entries adopted at upgrade are marked. The listing
SHALL be reachable from New Session and from Settings.

#### Scenario: Rejected file is named
- **WHEN** a project catalog file fails validation
- **THEN** the listing names the file and the full reason beside the picker, and the other files' profiles remain offered

#### Scenario: Credential presence is shown
- **WHEN** the composed environment holds a credential variable only the store provides
- **THEN** the listing shows that variable as set with source store

#### Scenario: Adopted entry is marked
- **WHEN** an entry was adopted at upgrade
- **THEN** the listing marks it adopted at upgrade

### Requirement: Validation failures name the supported setting
Each catalog rejection SHALL render prominently beside the profile picker
and in Settings, and its message SHALL name the supported way to achieve the
intent — for a refused credential variable, the credential store; for a
refused custom-headers entry, a trusted provider's header bindings with
values imported in the store.

#### Scenario: Custom-headers rejection directs the operator
- **WHEN** a catalog file sets `ANTHROPIC_CUSTOM_HEADERS` and is rejected
- **THEN** the visible message names the trusted provider `headers` field and the credential store instead

#### Scenario: Failures are never silent
- **WHEN** any catalog file is rejected
- **THEN** the picker shows the failure rather than only the surviving profiles

### Requirement: The effective configuration is previewed before creation
For the selected profile, the New Session dialog SHALL preview the
configuration creation would apply: each edited field's layer of origin, the
exact model ID per tier, credential variable names with presence and source,
header names with their variables' presence, and conflict warnings. Credential
and header values SHALL NOT appear. The preview SHALL be computed from the
same resolution creation uses, and every non-credential preview field SHALL
equal the launch configuration's field.

#### Scenario: Preview equals the launch
- **WHEN** any profile is previewed for a project path
- **THEN** each non-credential preview field equals the resolved launch configuration for that path and profile

#### Scenario: Conflicting overrides warn
- **WHEN** a nearer catalog layer overrides a field the operator set at another layer
- **THEN** the preview shows the winning layer and warns which value is overridden

#### Scenario: Values stay redacted
- **WHEN** the preview is shown
- **THEN** no credential value or header value appears in its payload

### Requirement: The connection test runs through the real launch path
A per-profile test SHALL resolve the profile as session creation does and
compose the same launch settings — cwd, settings sources, transport pins,
the resolved baseline-checked executable — then make one minimal model
request with transcript persistence disabled, bounded in time, the process
group killed and reaped on every exit path. A second concurrent test reports
busy. The test SHALL create no session and persist nothing; creation SHALL
NOT require the test.

#### Scenario: Test exercises the resolved launch
- **WHEN** the test runs for a profile
- **THEN** its request uses the same launch composition, executable, and startup model ID that creation would use

#### Scenario: Timeout is bounded and reaped
- **WHEN** the relay does not answer within the bound
- **THEN** the process group is killed, reaped, and the result class is timeout

#### Scenario: Test is transient
- **WHEN** a test completes
- **THEN** no session, transcript, wire log, or database row exists for it

#### Scenario: Concurrent test reports busy
- **WHEN** a second test for the same provider starts while one runs
- **THEN** it reports busy without queueing

### Requirement: The connection test covers Claude-runtime profiles
In v1 the test SHALL cover Claude-runtime profiles only. A Codex profile
SHALL show the test as not supported and keep its existing login check as
its verification.

#### Scenario: Codex test is not supported
- **WHEN** the test is requested for a Codex-runtime profile
- **THEN** the surface reports the test as not supported and the existing login check still runs

### Requirement: Diagnostic output is redacted before any sink
Diagnostic surfaces SHALL pass output through a redactor holding the exact
credential snapshot — every store value, the composed token, every composed
header value — applying exact-value plus pattern redaction before any log
line, wire frame, client payload, stderr echo, or error text. Pattern
redaction alone SHALL NOT be trusted to remove a known secret.

#### Scenario: Echoed secret is redacted
- **WHEN** a relay's error prose echoes a credential value back
- **THEN** the test card, the live error row, and any log line show the value redacted

#### Scenario: Spawn exception is redacted
- **WHEN** the test's process fails to spawn and the exception message embeds part of the environment
- **THEN** the reported message carries no credential value

### Requirement: Failure classes are distinguished with their evidence
Failed relay requests SHALL be classified by one ordered rule list: the
existing limit predicate first — 429, 402, and the limit error classes keep
recording limits on any status — then, only for non-limit failures, one
disjoint class: missing credential, gateway authentication failure,
virtual-key restriction, model-catalog failure, network failure, timeout,
relay error, or evidence-qualified unknown. A model-list result never proves
authentication; ambiguous evidence reads as the unknown.

#### Scenario: Restriction is not misread as an authentication failure
- **WHEN** the model list succeeds with the provider's credentials and the model request returns 403 without a limit class
- **THEN** the class is virtual-key restriction, shown with that evidence

#### Scenario: Ambiguous evidence reads as unknown
- **WHEN** the model list cannot be retrieved and the model request returns 403
- **THEN** the class is the evidence-qualified unknown, not a guessed one

#### Scenario: A limit-shaped 403 still cools
- **WHEN** a failed request returns 403 carrying a rate_limit error class
- **THEN** the existing limit handling records it and no diagnostic class applies

#### Scenario: Limits are untouched
- **WHEN** a turn fails with HTTP 429 or 402
- **THEN** limit handling records it exactly as before, not as a connection diagnostic

### Requirement: Live failures classify like tested ones
A live session's failed model turns SHALL show the same classification as
the connection test, on the transcript error row, additively, at any point
in the session's life. The display SHALL NOT change turn, mail, or limit
outcomes.

#### Scenario: A live failure shows its class
- **WHEN** a live session's model request returns a relay's "Failed to authenticate" 403 while the provider's model list succeeds
- **THEN** the transcript error row shows virtual-key restriction and no limit event is recorded

### Requirement: Model availability is checked against the provider's catalog
The server SHALL query `{base URL}/v1/models` — the configured path
preserved — with the provider's composed credentials, bounded in pages and
time, never following redirects, and compare the exact wire model ID the
launch sends (after CLI alias resolution) against a complete, schema-valid
list. Anything else SHALL read as unknown: no mark, a preview note, creation
never blocked. Credential, header, or catalog changes SHALL invalidate the
cache.

#### Scenario: Absent model is marked
- **WHEN** the provider's model list succeeds and lacks a profile's wire model ID
- **THEN** the picker marks that profile as not in the provider's catalog

#### Scenario: No list endpoint blocks nothing
- **WHEN** the model list cannot be retrieved
- **THEN** no profile is marked, the preview notes the catalog was unavailable, and creation proceeds

#### Scenario: Partial list reads unknown
- **WHEN** the list response is truncated or malformed
- **THEN** the result is unknown and no profile is marked absent

#### Scenario: Alias resolution precedes the comparison
- **WHEN** a profile's startup option is a tier alias the CLI resolves through `ANTHROPIC_DEFAULT_SONNET_MODEL`
- **THEN** the checked ID is the resolved wire ID, not the raw startup label
