# Spec Delta

## ADDED Requirements

### Requirement: Replies to an open decision question are refused with guidance
A reply to a message tagged `decision-question` whose decision card is still open SHALL be refused with nothing queued, for agents and for the human. The refusal SHALL point agents to `decision_record` and the human to the card's **Answer**. Once the card is decided, replies to that message SHALL follow the normal rules. The decided answer Kawai delivers in the question's thread is not such a reply.

#### Scenario: The Lead replies instead of recording
- **WHEN** a member of the Lead role calls `reply` on an open card's question mail
- **THEN** the tool returns guidance to call `decision_record` for that card, and nothing is queued

#### Scenario: The human replies to the question
- **WHEN** the human replies to an open card's question mail in the Messages view
- **THEN** the reply is refused inline, pointing to the card's **Answer**, and nothing is queued

#### Scenario: After the decision
- **WHEN** the card has been decided and the asker replies to the answer to ask a follow-up
- **THEN** the reply is queued as usual
