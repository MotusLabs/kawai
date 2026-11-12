# team-routing-rules Specification

## Purpose
Lets the user decide which agent or provider profile handles a group's messages, with a built-in strategy and optional user-level TypeScript rules running in isolation.

## Requirements

### Requirement: Groups list allowed profiles
A group's frontmatter SHALL accept `profiles` as a list of profile ids or as a map from profile id to a positive member cap. Either form SHALL define which profiles spawned members may use, and its order SHALL be the profile preference order. A single `profile` value SHALL be treated as a one-item list. Unknown profile ids SHALL be reported and ignored. Existing members SHALL keep their own profiles.

#### Scenario: Mixed group
- **WHEN** the `devs` group sets `profiles: [claude, glm]`
- **THEN** a spawned `devs` member may use either profile

#### Scenario: Map form
- **WHEN** the `devs` group sets `profiles: { glm: 2, mimo: 1, claude: 1 }`
- **THEN** spawned members may use `glm`, `mimo`, or `claude`, preferred in that order

#### Scenario: Unknown profile
- **WHEN** a group lists a profile id that no profile catalog defines
- **THEN** the id is ignored and the problem is reported

### Requirement: Per-profile member caps
When `profiles` is a map, the system SHALL NOT spawn a group member on a profile whose number of live members of that group has reached its cap. Live members SHALL include every non-archived session of the group on that profile, whether created by the user or spawned, including busy and parked members. Caps SHALL count only the group's own members. The group's `max` SHALL default to the sum of the caps and, when set, SHALL further limit the total.

#### Scenario: Profile cap reached
- **WHEN** `devs` has `profiles: { glm: 2, mimo: 1, claude: 1 }` and two live `glm` members
- **THEN** no `glm` member is spawned and spawn candidates offer only `mimo` and `claude` while they have room

#### Scenario: Parked members hold their slots
- **WHEN** both live `glm` members of `devs` are parked on a `glm` limit
- **THEN** forwarded `devs` work is not given a new `glm` member

#### Scenario: Overall max
- **WHEN** `devs` sets `max: 3` with caps summing to 4 and has three live members
- **THEN** no further member is spawned on any profile

#### Scenario: Default max
- **WHEN** `devs` sets per-profile caps summing to 4 and no `max`
- **THEN** up to four members may be live at once

#### Scenario: Other groups do not count
- **WHEN** `qa` has three live `glm` members and `devs` caps `glm` at 2 with none live
- **THEN** `devs` may still spawn `glm` members

### Requirement: Manual sessions over a cap are warned, not refused
When the user creates a chat session for a group on a profile whose cap is already reached, the new-session dialog SHALL warn that the cap is exceeded and SHALL still allow creation. The session SHALL count toward the cap.

#### Scenario: User exceeds cap
- **WHEN** `devs` caps `claude` at 1, one `claude` member is live, and the user creates another `devs` session on `claude`
- **THEN** the dialog shows a cap warning, the session is created, and kawai spawns no `claude` member for `devs` until the count drops below the cap

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
`route` SHALL receive the group with its per-profile caps and live member counts, the message's priority, sender group, tags, worktree, task id, the eligible candidates (idle members and spawn slots per allowed profile, already filtered by delivery and staffing rules), and per-profile usage and limit events with their sources and times. It SHALL return a pick of one candidate, a hold with a reason and optional retry delay, or default. It MAY be asynchronous.

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

### Requirement: Plan roles narrow the profiles execution mail may use
Mail Kawai dispatches for an execution SHALL record its role's profiles in the role's order. It SHALL reach only members and spawn slots whose profile is on that list and allowed by the group, preferring them in the role's order. A message with no such candidate SHALL wait, its reason naming the role's profiles. A forwarded message SHALL keep the list.

#### Scenario: A role narrows a mixed group
- **WHEN** a group allows `glm`, `sonnet`, and `mimo`, and the plan's role for it lists `sonnet` then `glm`
- **THEN** the instruction reaches only a `sonnet` or `glm` member or spawn slot, preferring `sonnet`

#### Scenario: No candidate in the role
- **WHEN** every profile the role lists is cooling
- **THEN** the instruction waits, and its waiting reason names the role's profiles

#### Scenario: A forward keeps the role
- **WHEN** the holder's profile hits a limit and its execution mail is forwarded
- **THEN** the forwarded message keeps the role's list, without the limited profile

### Requirement: Review mail names its authors' profiles
Review handoffs Kawai dispatches SHALL carry one tag `author-profile:<id>` for each profile that authored a result of the change in the execution, so a routing rule can send the review to another model family. The route contract SHALL be unchanged.

#### Scenario: A rule routes the review away from the author
- **WHEN** a reviewers rule reads the tag `author-profile:opus` and picks a `mimo` candidate
- **THEN** the review goes to the `mimo` member

#### Scenario: Without a rule the tags are metadata
- **WHEN** the review group has no routing rule
- **THEN** the built-in strategy routes the review as usual, and the tags show on its mailbox row

### Requirement: Flagged sessions are not route candidates
A context-exhausted session SHALL NOT be a candidate for group mail, however long it has been idle. It SHALL still count as a live member toward its group's and worker's caps until it is archived or killed. While a flagged member is excluded, the waiting reason of mail held by caps SHALL name it.

#### Scenario: Longest-idle but flagged
- **WHEN** the longest-idle member of `middle-devs` is flagged and another member is idle
- **THEN** group mail goes to the other member

#### Scenario: Flagged member holds the cap
- **WHEN** a group with `max: 1` has only a flagged human-created member
- **THEN** group mail waits, and its reason names the flagged member

### Requirement: Groups may list their workers
A group's frontmatter SHALL accept `workers` as the name of `profiles`, in the same list and capped-map forms with the same meaning. When `workers` is set, `profiles` and `profile` SHALL be ignored and a group warning SHALL name each ignored key. A worker written `<provider>/<model>` SHALL be read as that model's profile id when the provider holds that model; otherwise it SHALL be reported and ignored like an unknown profile id.

#### Scenario: Workers map
- **WHEN** the `juniors` group sets `workers: { glm-flash: 3, haiku: 2 }`
- **THEN** spawned members may use `glm-flash` or `haiku`, preferred in that order, with at most 3 and 2 live members on them

#### Scenario: Old and new keys together
- **WHEN** a group sets `workers: [haiku]` and `profiles: [glm-flash]`
- **THEN** spawned members use `haiku`, and a group warning names the ignored `profiles`

#### Scenario: Qualified names
- **WHEN** a group sets `workers: [zai/glm, claude/haiku]` and those providers hold those models
- **THEN** spawned members may use `glm` or `haiku`

#### Scenario: Qualifier names the wrong provider
- **WHEN** a group sets `workers: [zai/haiku, glm]` and provider `zai` holds no `haiku`
- **THEN** `zai/haiku` is reported and ignored, and spawned members use `glm`

### Requirement: Rules see each candidate's provider
The route context SHALL name the provider of each candidate and each listed profile, and SHALL carry, for each provider of those profiles, its usage, its limit events, and its cooldown end. Each profile's cooldown end SHALL be its effective cooldown, including its provider's. These fields SHALL be additive, so a rule written for the earlier context keeps working.

#### Scenario: A rule sees the cooling provider
- **WHEN** `glm` and `glm-flash` are profiles of provider `zai`, `glm` has a final limit event, and a rule routes group mail allowing both
- **THEN** the rule sees `zai` cooling, and the `glm-flash` profile reports the same cooldown end as `zai`

#### Scenario: Earlier rules keep working
- **WHEN** a rule written for the earlier context reads only candidates and per-profile entries
- **THEN** it loads and routes as before, and profiles of a cooling provider read as cooling

### Requirement: A worker choice filters route candidates
For group mail with a worker choice, route candidates SHALL include only the members and spawn slots on a chosen worker. Every other filter and cap still applies. When the message also carries a role's allowed profiles, candidates SHALL be limited to the intersection, in the role's order. The filter SHALL apply before any routing rule runs, so neither a rule nor the built-in fallback can pick a candidate outside the choice.

#### Scenario: Members on other workers are skipped
- **WHEN** an idle `glm-flash` member and an idle `sonnet` member are eligible, and the message chose provider `claude`
- **THEN** only the `sonnet` member is a candidate

#### Scenario: Choice within a role's profiles
- **WHEN** a message's role allows `opus` and `glm`, and the message chose provider `zai`, which owns `glm` and `glm-flash`
- **THEN** only `glm` members and `glm` spawn slots are candidates, and a member on `opus` reports the worker choice as its exclusion

#### Scenario: Rule pick outside the choice
- **WHEN** a rule names a candidate that the worker choice filtered out
- **THEN** the pick is treated as unknown, and the built-in strategy picks among the filtered candidates

### Requirement: Eligibility is one reusable pure check
Kawai SHALL decide which members and spawn slots may take group mail with one pure check over a stated state: workers, caps, choice, role list, members, task owner, cooldowns, staffing counts, and evaluation time. It SHALL return eligible candidates in preference order (an eligible owner first) and each excluded alternative's reasons as waiting-constraint kinds. Routing, waiting reasons, dispatch preview, the capacity tool, and past-cutoff observers SHALL all use it; it SHALL perform no I/O.

#### Scenario: Exclusion reasons per alternative
- **WHEN** a message chose `zai`, an idle `sonnet` member exists, and the `glm` worker is at its cap
- **THEN** the check returns no eligible candidate, the `sonnet` member excluded by `worker-choice`, and the `glm` slot excluded by `profile-cap` with its counts

#### Scenario: Evaluation at an incident cutoff
- **WHEN** an observer supplies the routing state as of an earlier cutoff, including the cooldowns then in force
- **THEN** the check returns the eligibility routing would have computed at that time, and reads no current state

#### Scenario: Same answer as a live pass
- **WHEN** the dispatcher routes a message, and the check is called with the same state
- **THEN** both name the same eligible candidates and the same exclusion reasons

#### Scenario: Task owner ranked first
- **WHEN** the state names task owner `A`, and `A` and `B` are both eligible with `B` idle longer
- **THEN** the check returns `A` before `B`

### Requirement: Rules see the worker choice
The route context and limit-outcome context given to routing rules SHALL include the message's worker choice as an additive metadata field, absent when the message has none.

#### Scenario: Rule reads the choice
- **WHEN** a message with `worker: "claude"` is routed through a group rule
- **THEN** the rule's context shows the choice beside the message's other metadata

### Requirement: A cooling chosen worker holds the message
When every candidate the worker choice allows is on a cooling provider, the message SHALL wait, neither refused nor routed elsewhere. It SHALL be routed again once the cooldown ends or the candidates change.

#### Scenario: Chosen provider is cooling
- **WHEN** a message chose provider `zai`, which cools until 18:00Z
- **THEN** the message stays queued and is routed again at 18:00Z

### Requirement: Groups may route by task owner
A group's frontmatter SHALL accept `affinity: task-owner` and `affinityWait` in whole minutes, defaulting to 30. An invalid `affinity` SHALL be reported and leave the group without affinity; an invalid `affinityWait` SHALL be reported and the default SHALL apply. A message's task owner SHALL be its affinity task's current owner at each routing decision, when that owner is a session of the target group. An eligible task owner SHALL be picked before the group's `strategy` applies.

#### Scenario: Owner preferred over the longest-idle member
- **WHEN** lead `B` has been idle for 10 minutes, lead `A` has just become idle, and a group message's affinity task is owned by `A`
- **THEN** `A` receives the message

#### Scenario: Owner preferred under profile order
- **WHEN** a group uses `profile-order`, an idle member on its first profile exists, and the idle task owner is on its second profile
- **THEN** the task owner receives the message

#### Scenario: Invalid affinity value
- **WHEN** a group file sets `affinity: newest`
- **THEN** the group reports the invalid value and routes without affinity

#### Scenario: Invalid wait value
- **WHEN** a group file sets `affinity: task-owner` and `affinityWait: -1`
- **THEN** the group reports the invalid value and routes with affinity and a 30-minute wait

#### Scenario: Owner outside the group
- **WHEN** a message's affinity task was created by the human, or is owned by a developer
- **THEN** the message has no task owner and the group's `strategy` routes it

#### Scenario: No task owner
- **WHEN** a message to an affinity group has no affinity task, or its task has no owner or one outside the group
- **THEN** the group's `strategy` routes it as before

### Requirement: A busy task owner holds its mail for a bounded wait
When a message's task owner is a live member excluded only because it is working or awaiting a card, routing SHALL hold the message until `affinityWait` minutes after it became due, then route it by the group's `strategy`. The owner going idle first SHALL end the hold. Routing SHALL apply the group's current settings on each pass. When the owner is gone, archived, context-exhausted, unavailable, parked, cooling, or excluded by the message's filters, routing SHALL NOT wait for it.

#### Scenario: Owner busy within the wait
- **WHEN** a message to `lead` was created 10 minutes ago with `affinityWait: 30`, its owner `A` is working, and lead `B` is idle
- **THEN** the message stays queued, and a pass routes it again by 30 minutes after creation at the latest, or as soon as `A` goes idle

#### Scenario: Owner frees up within the wait
- **WHEN** that owner `A` becomes idle 12 minutes after the message was created
- **THEN** `A` receives the message

#### Scenario: Wait runs out
- **WHEN** the owner is still working 30 minutes after creation and `B` is idle
- **THEN** `B` receives the message

#### Scenario: Affinity removed while mail waits
- **WHEN** a message held for its busy owner `A` is still queued, `affinity` is removed from the group file, and `B` is idle
- **THEN** the next dispatch pass gives the message to `B`, with no restart needed, and the message still records its affinity task

#### Scenario: Cooling owner does not hold
- **WHEN** the owner's profile is cooling and another member is idle
- **THEN** the other member receives the message without waiting

#### Scenario: Context-exhausted owner does not hold
- **WHEN** the owner is flagged context-exhausted and another member is idle
- **THEN** the other member receives the message without waiting

#### Scenario: No other candidate
- **WHEN** the wait has run out, the owner is still working, and no other member or spawn slot is eligible
- **THEN** the message waits as group mail with no eligible candidate does, and the owner receives it once idle

### Requirement: Rules see the task owner
The route context given to routing rules SHALL include the message's task owner, as resolved for that decision, as an additive metadata field, absent when the message has none. A rule's pick or hold SHALL take precedence over the owner preference and the owner hold. When the rule returns default, the built-in strategy SHALL apply both. With no eligible candidate, no rule SHALL run and the message SHALL wait as today.

#### Scenario: Rule reads the owner
- **WHEN** a message whose task owner is `A` is routed through a group rule
- **THEN** the rule's context shows `A` beside the message's other metadata

#### Scenario: Rule overrides the owner
- **WHEN** the rule picks member `B` while owner `A` is also idle
- **THEN** `B` receives the message
