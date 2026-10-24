## MODIFIED Requirements

### Requirement: Auto policy grants tool approvals without a card
While a chat session's policy is auto, the system SHALL grant each tool
approval request immediately without showing an approval card, and the
session SHALL NOT enter the permission status for it. Agent questions SHALL
NOT be answered by the policy: they SHALL always be shown as question forms,
answered only by the user or by the recommended-option timeout. Tool uses
denied by the user's Claude Code permission settings SHALL remain denied.

#### Scenario: Tool runs without a card
- **WHEN** the agent requests a tool use that requires approval in a session with the auto policy
- **THEN** no approval card is shown, the tool runs, and the session stays working rather than permission

#### Scenario: Questions still reach the user
- **WHEN** the agent asks a question in a session with the auto policy
- **THEN** the question form is shown, the session reports permission, and the agent waits for the user's answer or the question's auto-answer deadline

#### Scenario: Settings deny rules still apply
- **WHEN** the user's Claude Code settings deny a tool and the agent attempts it in a session with the auto policy
- **THEN** the tool use is denied as it would be under the manual policy

### Requirement: Agent questions collect structured user answers
The system SHALL handle SDK `AskUserQuestion` requests with question forms
supporting offered options, multiple selections where requested, and the
user's own free-text answer. A single-select answer SHALL be one choice — an
offered option or the user's own text — and an answer carrying both SHALL be
refused; a multi-select answer SHALL add the user's text as one more
selection. Validated answers SHALL be returned as updated tool input.
Questions SHALL follow the same reconnect, cancellation, and first-answer
rules as approvals.

#### Scenario: User answers an agent question
- **WHEN** the agent requests user input through `AskUserQuestion`
- **THEN** the chat view displays the questions and the user's submitted answers are returned to the agent so it can continue

#### Scenario: Own text replaces a single-select option
- **WHEN** the user selects an option of a single-select question and then types their own answer
- **THEN** the option is deselected and the typed text is the answer sent to the agent

#### Scenario: Selecting an option replaces own text
- **WHEN** the user types their own answer to a single-select question and then selects an option
- **THEN** the text is cleared and the option is the answer sent to the agent

#### Scenario: Both for single-select is refused
- **WHEN** a client submits an option and non-empty text for one single-select question
- **THEN** the answer is refused with an error naming the question and the request stays pending

#### Scenario: Own text joins multi-select options
- **WHEN** the user checks two options of a multi-select question and types their own answer
- **THEN** the agent receives both options and the typed text as the answer

## ADDED Requirements

### Requirement: Recommended answers are taken after a configurable wait
When every question of a pending agent question request has at least one
option whose label ends with `(Recommended)` (case-insensitive, after
trimming) and the auto-answer wait is not zero, the system SHALL set a
deadline of the request's time plus the wait. If no answer, hold,
cancellation, or interruption settles the request first, the server SHALL
answer it with each question's recommended option — every recommended option
for a multi-select question, the first one otherwise.

#### Scenario: Unanswered question takes the recommendation
- **WHEN** the agent asks one single-select question with options `A (Recommended)` and `B`, the wait is 5 minutes, and nobody answers for 5 minutes
- **THEN** the request is answered with `A (Recommended)`, the agent continues, and the session leaves the permission status

#### Scenario: User answers before the deadline
- **WHEN** the user submits `B` before the deadline
- **THEN** the agent receives `B` and no automatic answer is ever sent for that request

#### Scenario: Question without a recommendation keeps waiting
- **WHEN** a request has two questions and only one of them has a recommended option
- **THEN** no deadline is set and the request waits for the user as before

#### Scenario: Multi-select takes every recommendation
- **WHEN** a multi-select question marks two options as recommended and its deadline passes
- **THEN** the answer selects both recommended options

#### Scenario: Applies under either approval policy
- **WHEN** a session with the manual policy and one with the auto policy each ask a question with a recommended option
- **THEN** both questions get a deadline

#### Scenario: Cancelled request is never auto-answered
- **WHEN** a request with a deadline is cancelled by an interrupt, the turn ending, archive, kill, or server shutdown before the deadline
- **THEN** no automatic answer is sent and its deadline is discarded

### Requirement: The agent learns an answer was automatic
An automatic answer SHALL be returned to the agent as the chosen option
labels, together with a note stating that the user did not answer within the
wait and the recommended option was selected automatically, so the agent can
treat the choice as unconfirmed.

#### Scenario: Agent sees the automatic note
- **WHEN** a question is answered by its deadline
- **THEN** the tool result the agent receives names the selected option and states that it was chosen automatically after no user answer

### Requirement: Question forms show the auto-answer deadline
A question form with a deadline SHALL show the option(s) that will be chosen
and a countdown to the deadline, and SHALL offer **Wait for me**, which
removes the deadline for that request only; the request then waits for the
user. Selecting an option or typing in the form SHALL hold the deadline the
same way. A hold SHALL reach every attached client, and the deadline or its
removal SHALL be included for clients that attach later.

#### Scenario: Countdown is visible
- **WHEN** a question with a deadline is pending
- **THEN** its form shows the recommended option that will be chosen and the remaining time

#### Scenario: Wait for me removes the deadline
- **WHEN** the user chooses Wait for me on a pending question
- **THEN** every attached client stops showing the countdown and the question is never answered automatically

#### Scenario: Starting an answer holds the deadline
- **WHEN** the user selects an option or types in a question form with a deadline, without submitting
- **THEN** the deadline is removed for every attached client and the user's unsubmitted answer is never replaced by an automatic one

#### Scenario: Late attach sees the deadline
- **WHEN** a client attaches while a question with a deadline is pending
- **THEN** the form shows the same deadline the other clients show

#### Scenario: Hold on a settled request is refused
- **WHEN** a client sends Wait for me for a request that is no longer pending
- **THEN** the client receives an error and nothing changes

### Requirement: Automatic answers are marked in the transcript
The transcript SHALL mark a question answered by its deadline as answered
automatically with the selected option(s), distinct from a user's answer and
from a policy grant, and SHALL record a hold. Reconnecting clients SHALL
receive these entries in the history snapshot.

#### Scenario: Transcript distinguishes automatic answers
- **WHEN** one question is answered by the user and another by its deadline
- **THEN** the transcript marks the second as answered automatically with its recommended option and the first as answered by the user

### Requirement: Users configure the auto-answer wait from Settings
Settings SHALL let the user set the auto-answer wait in whole minutes from 0
to 1440, default 5, where 0 disables automatic answers. The value SHALL be
stored on the server, kept across restarts, and applied to questions asked
after the change; a pending question keeps its deadline. An out-of-range or
non-integer value SHALL be refused with an error and nothing saved.

#### Scenario: Default wait is five minutes
- **WHEN** the wait was never saved and the agent asks a question with a recommended option
- **THEN** its deadline is five minutes after the question

#### Scenario: Zero disables automatic answers
- **WHEN** the user saves a wait of 0 and the agent then asks a question with a recommended option
- **THEN** no deadline is set and the question waits for the user

#### Scenario: Change does not move pending deadlines
- **WHEN** the user changes the wait while a question with a deadline is pending
- **THEN** that question keeps its deadline and the next question uses the new wait

#### Scenario: Invalid wait is refused
- **WHEN** the user saves a wait of 1441 or -1
- **THEN** nothing is saved and Settings shows why
