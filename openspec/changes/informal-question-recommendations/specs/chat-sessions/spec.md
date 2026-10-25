## ADDED Requirements

### Requirement: Explicit recommendation wording identifies an option
The system SHALL recognize `recommended`, `I recommend this`,
`I recomend this`, and `my recommendation` in option labels or descriptions
using the marker positions below. Matching SHALL ignore case, collapse
whitespace, and allow surrounding brackets, parentheses, Markdown emphasis,
and punctuation. Negated or incidental mentions SHALL NOT qualify; explicit
negation in either field SHALL exclude the option.

#### Scenario: Supported marker positions
- **WHEN** a supported phrase occupies an entire label or description, starts it followed by punctuation and explanation, or forms a trailing annotation separated from preceding text by brackets or a dash/colon
- **THEN** it qualifies as a recommendation, including the existing trailing `(Recommended)` convention

#### Scenario: Recommendation in an option description
- **WHEN** option `A` has description `I recommend this. It is easier to maintain.`, every question has a recommended option, and the wait is positive
- **THEN** the request gets a deadline and its automatic answer selects the original label `A`

#### Scenario: Informal markers and the observed typo qualify
- **WHEN** an option label or description is `I recomend this`, `[MY RECOMMENDATION]`, or `  I   recommend this!  `, or the label is `A — My recommendation`
- **THEN** the option qualifies as recommended and can supply its question's automatic answer

#### Scenario: Negated or conflicting recommendations do not qualify
- **WHEN** an option's only signal is `Not recommended`, `I do not recommend this`, `I don't recommend this`, `I never recommend this`, or `This is not my recommendation`, or its label is `A (Recommended)` but its description is `Not recommended`
- **THEN** that option does not qualify and a question with no other qualifying option prevents a deadline for the entire request

#### Scenario: Incidental mentions and unrelated fields do not qualify
- **WHEN** an option only says `Review my recommendation`, `Uses the recommended settings`, or `A (Recommended) only in a different situation`, or a marker appears only in question text or preview
- **THEN** that option does not qualify and a question with no other qualifying option keeps the entire request waiting for the user

#### Scenario: Mixed markers preserve selection order and labels
- **WHEN** multiple options qualify through different label or description markers, including an option with a marker in both fields
- **THEN** single-select chooses the first matching option in input order, multi-select chooses all matching options once each, and the selected labels are returned verbatim

#### Scenario: Only option labels and descriptions supply a signal
- **WHEN** an option has no matching label and its description is missing or non-string, or a recommendation appears only in option order, question text, preview, or surrounding conversation
- **THEN** no recommendation is inferred for that option

## MODIFIED Requirements

### Requirement: Recommended answers are taken after a configurable wait
When every question in a pending Claude chat request has a recommended
option and the wait is positive, the system SHALL set a deadline at request
time plus the wait. Unless an answer, hold, cancellation, or interruption
settles it first, the server SHALL answer with all recommended options for
multi-select or the first in input order for single-select, using verbatim
labels and selecting each option once.

#### Scenario: Unanswered question takes the recommendation
- **WHEN** the agent asks one single-select question with options `A (Recommended)` and `B`, the wait is 5 minutes, and nobody answers for 5 minutes
- **THEN** the request is answered with `A (Recommended)`, the agent continues, and the session leaves the permission status

#### Scenario: User answers before the deadline
- **WHEN** the user submits `B` before the deadline
- **THEN** the agent receives `B` and no automatic answer is ever sent for that request

#### Scenario: Question without a recommendation keeps waiting
- **WHEN** a request has two questions and only one of them has a recommended option
- **THEN** no deadline is set and the request waits for the user as before

#### Scenario: A Codex chat question waits for the user
- **WHEN** a Codex chat session asks a question whose options include a recommended one
- **THEN** no deadline is set and the question waits for the user as before

#### Scenario: Multi-select takes every recommendation
- **WHEN** a multi-select question marks two options as recommended and its deadline passes
- **THEN** the answer selects both recommended options

#### Scenario: Applies under either approval policy
- **WHEN** a session with the manual policy and one with the auto policy each ask a question with a recommended option
- **THEN** both questions get a deadline

#### Scenario: Cancelled request is never auto-answered
- **WHEN** a request with a deadline is cancelled by an interrupt, the turn ending, archive, kill, or server shutdown before the deadline
- **THEN** no automatic answer is sent and its deadline is discarded
