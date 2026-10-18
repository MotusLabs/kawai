# Spec Delta

## ADDED Requirements

### Requirement: Group mail can name a worker
`send_message` and `schedule_message` SHALL accept an optional `worker` for group mail. It is either a provider, meaning any of that provider's models the group lists, or `provider/model`. The worker SHALL be stored on the message and applied when the message is routed, including scheduled mail at its due time.

#### Scenario: Provider choice
- **WHEN** the lead sends group mail to `middle-devs` with `worker: "claude"`
- **THEN** the message is queued with that choice, and only `middle-devs` workers from provider `claude` can take it

#### Scenario: Exact model
- **WHEN** the lead sends group mail with `worker: "zai/glm-flash"`
- **THEN** only the `glm-flash` worker can take it

#### Scenario: Scheduled mail keeps its choice
- **WHEN** scheduled group mail with a worker choice becomes due
- **THEN** it is routed with that choice

### Requirement: Invalid worker choices are refused
A send SHALL be refused, with nothing queued, when its `worker` names no provider or model in the catalog, names nothing among the target group's workers, could mean either a provider or a model of another provider, or is given on mail to a session or to the human. The refusal SHALL name the reason.

#### Scenario: Not among the group's workers
- **WHEN** the lead names a worker that `middle-devs` does not list
- **THEN** the send is refused naming the group's workers, and nothing is queued

#### Scenario: Direct mail
- **WHEN** an agent gives a `worker` on mail to a session
- **THEN** the send is refused stating that a worker choice applies only to group mail

#### Scenario: Ambiguous bare id
- **WHEN** a bare `worker` is both a provider id and a model key of a different provider
- **THEN** the send is refused asking for the `provider/model` form

### Requirement: A worker choice does not survive a limit forward
When a limit outcome forwards a message, the forwarded message SHALL carry no worker choice. The forward's exclusion of the limited worker SHALL govern instead.

#### Scenario: Chosen provider hits its limit
- **WHEN** a message routed with `worker: "zai"` is forwarded after a final limit on that provider
- **THEN** the forwarded message has no worker choice and does not go back to the limited worker
