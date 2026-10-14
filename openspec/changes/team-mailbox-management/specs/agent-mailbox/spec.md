# Spec Delta

## ADDED Requirements

### Requirement: The human can cancel parked mail
The Mailbox view SHALL offer Cancel on a parked message beside Hand off. Cancelling SHALL cancel the parked message together with its undelivered resume message, SHALL record the cancellation as the human's action, and SHALL neither restore nor resume the holder.

#### Scenario: Cancel work parked on an archived agent
- **WHEN** the user cancels a parked message whose holder is archived
- **THEN** the message and its resume message are cancelled, the row leaves the Parked section, and the holder stays archived

#### Scenario: Parked state changed meanwhile
- **WHEN** the user cancels a parked message that was unparked or handed off a moment earlier
- **THEN** the view reports that the action is no longer available and the message keeps its new state

### Requirement: Mailbox rows show their message id
Each row of the Mailbox view SHALL show a short form of its message id that matches the id's prefix, and SHALL make the full id available to read and copy, so an id quoted by an agent can be matched to its row.

#### Scenario: Match an id quoted by the lead
- **WHEN** the lead names message `0e849a2e-5025-…` in a chat
- **THEN** the user finds the Mailbox row showing `0e849a2e` and can copy its full id
