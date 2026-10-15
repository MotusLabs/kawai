# Spec Delta

## ADDED Requirements

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
