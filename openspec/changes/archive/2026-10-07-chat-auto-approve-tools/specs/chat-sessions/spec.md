## ADDED Requirements

### Requirement: Chat sessions have a per-session approval policy
Each chat session SHALL have an approval policy of either manual or auto.
Every new chat session SHALL start with the manual policy, and there SHALL be
no global or per-profile default. The policy SHALL be stored with the session
and SHALL be kept across server restarts, conversation resume, archive, and
restore. Sessions created before this feature SHALL behave as manual.

#### Scenario: New chat starts manual
- **WHEN** a user creates a chat session with any profile
- **THEN** the session's approval policy is manual and tool approvals show approval cards

#### Scenario: Policy survives restart
- **WHEN** a chat session's policy is auto and the server restarts
- **THEN** the session is listed with the auto policy and its next tool approval is granted without a card

#### Scenario: Policy survives archive and restore
- **WHEN** a chat session with the auto policy is archived and later restored
- **THEN** the restored session still has the auto policy

#### Scenario: Legacy session defaults to manual
- **WHEN** the server loads a chat session stored before approval policies existed
- **THEN** the session's approval policy is manual

### Requirement: Auto policy grants tool approvals without a card
While a chat session's policy is auto, the system SHALL grant each tool
approval request immediately without showing an approval card, and the
session SHALL NOT enter the permission status for it. Agent questions SHALL
NOT be answered by the policy: they SHALL always be shown as question forms.
Tool uses denied by the user's Claude Code permission settings SHALL remain
denied.

#### Scenario: Tool runs without a card
- **WHEN** the agent requests a tool use that requires approval in a session with the auto policy
- **THEN** no approval card is shown, the tool runs, and the session stays working rather than permission

#### Scenario: Questions still reach the user
- **WHEN** the agent asks a question in a session with the auto policy
- **THEN** the question form is shown, the session reports permission, and the agent waits for the user's answer

#### Scenario: Settings deny rules still apply
- **WHEN** the user's Claude Code settings deny a tool and the agent attempts it in a session with the auto policy
- **THEN** the tool use is denied as it would be under the manual policy

### Requirement: Users switch the approval policy from the chat view
The chat view SHALL let the user switch a live chat session between manual
and auto. The switch SHALL take effect for the next request without
restarting the agent, and every attached client SHALL see the new policy.
Switching to auto SHALL grant that session's pending approval cards; pending
questions SHALL stay open. Switching to manual SHALL affect only later
requests.

#### Scenario: Enabling auto clears pending approvals
- **WHEN** a session has a pending approval card and a pending question and the user switches it to auto
- **THEN** the approval is granted and its tool runs, the question remains open, and the agent process is not restarted

#### Scenario: Disabling auto returns to cards
- **WHEN** the user switches a session from auto to manual during a turn
- **THEN** tool uses already granted keep running and the next tool approval request shows an approval card

#### Scenario: Other clients see the switch
- **WHEN** two browsers are attached to the same chat session and one switches its policy
- **THEN** both show the new policy without a reload

### Requirement: Approval policy changes are validated
The system SHALL refuse a policy change for an unknown session, for an
archived session, or with a value other than manual or auto, and SHALL report
an error to the requesting client without changing the stored policy.
Archived chats SHALL NOT show the policy control.

#### Scenario: Archived session refuses a change
- **WHEN** a client requests a policy change for an archived chat session
- **THEN** the request is refused with an error and the stored policy is unchanged

#### Scenario: Unsupported value is refused
- **WHEN** a client requests a policy value that is not manual or auto
- **THEN** the request is refused with an error and the stored policy is unchanged

#### Scenario: Archived chat hides the control
- **WHEN** the user opens an archived chat session
- **THEN** the read-only view shows no approval-policy control

### Requirement: Auto-approved activity is visible
While a chat session's policy is auto, its chat view header SHALL show a
clearly distinguishable auto-approve indicator. Each tool use granted by the
policy SHALL be marked in the transcript as auto-approved, distinct from a
user's Allow, and each policy change SHALL add a transcript notice. Reconnecting
clients SHALL receive these entries in the history snapshot.

#### Scenario: Header indicates auto
- **WHEN** a chat session's policy is auto
- **THEN** its chat view header shows the auto-approve indicator, and the indicator disappears when the policy returns to manual

#### Scenario: Transcript distinguishes who approved
- **WHEN** one tool use is allowed by the user and another is granted by the auto policy
- **THEN** the transcript marks the second as auto-approved and the first as allowed by the user

#### Scenario: Policy change is recorded
- **WHEN** the user switches a session's policy
- **THEN** a notice stating the new policy appears in the transcript of every attached client and in the snapshot sent to clients that attach later

## MODIFIED Requirements

### Requirement: Tool approval requests surface as approval cards
When the agent requests a tool use that requires approval and the session's
approval policy is manual, the system SHALL present an approval card in the
chat view showing the tool and its arguments, and SHALL hold the agent until
the user answers. Allowing SHALL
let the tool run; denying SHALL return the denial to the agent so the turn
continues. A pending approval SHALL survive browser disconnects until answered, cancelled
by the SDK, interrupted, granted by switching the session to the auto policy,
or killed. Server restart SHALL cancel outstanding
requests rather than restore callbacks that no longer exist. Resolution and
cancellation SHALL update every attached client; only the first valid answer
SHALL take effect.

#### Scenario: Approval card with allow and deny
- **WHEN** the agent requests a tool use that requires approval in a session with the manual policy
- **THEN** an approval card with the tool name and arguments is shown, and no tool execution occurs before the user answers

#### Scenario: Allow executes the tool
- **WHEN** the user chooses Allow on a pending approval card
- **THEN** the tool use proceeds and its result streams into the conversation

#### Scenario: Deny returns the denial to the agent
- **WHEN** the user chooses Deny on a pending approval card
- **THEN** the tool use is not executed, the denial is reported to the agent, and the turn continues
