# Spec Delta

## Purpose

Lets the user decide which agent or provider profile handles a group's messages, with a built-in strategy and optional user-level TypeScript rules running in isolation.

## ADDED Requirements

### Requirement: Groups list allowed profiles
A group's frontmatter SHALL accept `profiles`, a list of profile ids that its spawned members may use. A single `profile` value SHALL be treated as a one-item list. Unknown profile ids SHALL be reported and ignored. Existing members SHALL keep their own profiles.

#### Scenario: Mixed group
- **WHEN** the `devs` group sets `profiles: [claude, glm]`
- **THEN** a spawned `devs` member may use either profile

#### Scenario: Unknown profile
- **WHEN** a group lists a profile id that no profile catalog defines
- **THEN** the id is ignored and the problem is reported

### Requirement: Built-in routing strategy
Without a routing rule, the system SHALL route by the group's `strategy`: `first-available` (default) picks the longest-idle member, else a spawn slot of the first allowed profile; `profile-order` prefers candidates whose profile appears earlier in `profiles`. Both SHALL skip candidates whose profile is in cooldown.

#### Scenario: Profile order
- **WHEN** `devs` uses `profile-order` with `profiles: [claude, glm]` and an idle member exists for each
- **THEN** the `claude` member receives the message

#### Scenario: Cooling profile skipped
- **WHEN** the only idle member uses a profile in cooldown
- **THEN** that member does not receive group mail

### Requirement: Routing rules are user-level TypeScript files
The system SHALL load a routing rule for group `<id>` from `~/.kawai/routing/<id>.ts`. It SHALL NOT load routing rules from any project directory. A rule SHALL default-export an object with a `route` function and optionally `onLimit`, `env`, and `timeoutMs`. A rule that fails to load SHALL be reported and the built-in strategy used.

#### Scenario: Rule loaded
- **WHEN** `~/.kawai/routing/devs.ts` exports a valid rule
- **THEN** `devs` messages are routed by that rule

#### Scenario: Project rule ignored
- **WHEN** a repository contains `.kawai/routing/devs.ts`
- **THEN** it is never executed

#### Scenario: Broken rule
- **WHEN** a rule file has a syntax error
- **THEN** the error is shown in the UI and the group uses the built-in strategy

### Requirement: Rules run isolated
Rules SHALL run outside the server's main context with an empty environment. A rule SHALL receive only the environment variables it lists in `env`. Rules SHALL NOT receive message bodies.

#### Scenario: Credentials hidden
- **WHEN** a rule reads a provider token it did not declare
- **THEN** the value is absent

#### Scenario: Declared variable available
- **WHEN** a rule declares `env: ['GLM_API_KEY']`
- **THEN** that variable is available to the rule and no other server variable is

### Requirement: Rules change only on explicit reload
The system SHALL load routing rules at server start and when the user triggers Reload routing rules in the web UI. Changing, adding, or removing a rule file SHALL NOT take effect before a reload. The reload SHALL report each rule's load result.

#### Scenario: Edited file without reload
- **WHEN** a rule file is edited and no reload is triggered
- **THEN** routing still uses the previously loaded rule

#### Scenario: Reload applies changes
- **WHEN** the user triggers Reload routing rules
- **THEN** the edited rule is used for later decisions and the UI lists its load status

### Requirement: Route contract
`route` SHALL receive the group, the message's priority, sender group, tags, worktree, task id, the eligible candidates (idle members and spawn slots per allowed profile, already filtered by delivery and staffing rules), and per-profile usage and limit events with their sources and times. It SHALL return a pick of one candidate, a hold with a reason and optional retry delay, or default. It MAY be asynchronous.

#### Scenario: Pick a spawn slot
- **WHEN** a rule returns a pick of the `glm` spawn slot
- **THEN** a `devs` member is spawned with the `glm` profile and receives the message

#### Scenario: Hold
- **WHEN** a rule returns a hold with a retry delay of 10 minutes
- **THEN** the message stays queued and routing is re-attempted after 10 minutes or when candidates change

#### Scenario: Default
- **WHEN** a rule returns default
- **THEN** the built-in strategy decides

### Requirement: Routing decisions are safe
The system SHALL re-validate a picked candidate when claiming; if it is no longer eligible, routing SHALL be re-run once and then fall back to the built-in strategy. A rule call that throws, exceeds its timeout (default 3 s, at most 10 s), or picks an unknown candidate SHALL fall back to the built-in strategy and be logged. At most one routing decision per group SHALL be in progress at a time.

#### Scenario: Stale pick
- **WHEN** a rule picks a member that started a turn while the rule ran
- **THEN** the message is not delivered to that member and routing is retried

#### Scenario: Timeout
- **WHEN** a rule does not return within its timeout
- **THEN** the built-in strategy routes the message and the timeout is logged

#### Scenario: Urgent direct mail bypasses rules
- **WHEN** an urgent message is sent directly to an agent
- **THEN** no routing rule is consulted
