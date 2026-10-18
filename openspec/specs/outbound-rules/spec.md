# outbound-rules Specification

## Purpose
Puts the strategy's security rules into every agent's system prompt. The rules say what an agent may send or publish and where. The internal destinations they name come from the owner's user-level configuration and are rendered when the agent starts, so the product carries no concrete hostname or address.

## Requirements

### Requirement: Every chat agent's prompt carries the security note
The system prompt addition of every chat session SHALL include an `Outbound actions` section after the strategy note: work stays inside the development environment; sends and publishes go only to model providers, the repository's GitHub remote, and internal services; no public registry, forum, social, or email sends; no host OS changes; and observable actions are recorded for the owner. It SHALL be read at each agent start.

#### Scenario: A spawned member gets the note
- **WHEN** Kawai spawns a member of a group for a task
- **THEN** its system prompt append contains the `Outbound actions` section after the strategy note

#### Scenario: A session without a group gets the note
- **WHEN** the human creates a chat session that belongs to no group
- **THEN** its system prompt append still contains the `Outbound actions` section

#### Scenario: A running agent keeps its prompt
- **WHEN** the owner edits the outbound configuration while an agent runs
- **THEN** that agent's prompt is unchanged, and its next start renders the edited destinations

### Requirement: The note renders the owner's configured destinations
The note SHALL list the internal entries and extra model-provider hosts read from the owner's outbound configuration at agent start, as written, or state that none is configured beyond loopback and private network addresses. Kawai's source, project files, and shipped docs SHALL contain no concrete internal hostname or address; examples use reserved example names.

#### Scenario: Configured destinations appear
- **WHEN** the owner's configuration lists the internal domain `example.internal` and the agent starts
- **THEN** the note names `example.internal` among the internal destinations

#### Scenario: Nothing configured
- **WHEN** no outbound configuration file exists and an agent starts
- **THEN** the note says no internal destinations are configured beyond loopback and private network addresses

### Requirement: Outbound destinations are user-level configuration only
Kawai SHALL read outbound destinations only from `~/.kawai/outbound.json`: optional `internal` entries (domains, hosts, CIDRs), `modelProviders` hosts, and `mcpServers` names. It SHALL re-read the file when it changes, report a malformed file or entry and apply the defaults in its place, and never read destinations from a project file.

#### Scenario: A malformed entry is dropped
- **WHEN** `internal` lists one valid domain and one malformed CIDR
- **THEN** the error is logged naming the entry, and the valid domain still applies

#### Scenario: A project file cannot add destinations
- **WHEN** a repository contains `.kawai/outbound.json` listing a host
- **THEN** that host is not an allowed destination and is not rendered in any prompt

#### Scenario: Edits apply without restart
- **WHEN** the owner adds a domain to the file while the server runs
- **THEN** the next classification and the next agent start use it

### Requirement: Defaults always apply
Whatever the file says, loopback and private address ranges SHALL count as internal, the hosts of the configured profiles' base URLs and the default model provider SHALL count as model providers, and the GitHub remote SHALL be the `origin` of the repository containing the call's working directory.

#### Scenario: A private address is internal
- **WHEN** an agent posts to a private-range address with no configuration file present
- **THEN** the destination is judged internal

#### Scenario: A profile's gateway is a model provider
- **WHEN** a profile's base URL names a gateway host and an agent posts to that host
- **THEN** the destination is judged a model provider

### Requirement: Codex sessions carry the same note
When `codex-chat-sessions` starts Codex sessions, it SHALL pass the same security note text, rendered from the same configuration, in `developerInstructions`. Kawai SHALL keep the note's text in one exported constant that both session kinds read.

#### Scenario: One text for both
- **WHEN** the note's text changes
- **THEN** Claude prompts and Codex `developerInstructions` both carry the new text at their next start

#### Scenario: Before Codex sessions exist
- **WHEN** Codex chat sessions have not shipped
- **THEN** the constant is still exported, and no Codex path reads it yet
