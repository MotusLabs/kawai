## ADDED Requirements

### Requirement: Agent starts load history without blocking the server
When a chat agent starts, whether from a user message, an explicit start, or a mail delivery, the system SHALL load the chat's history without blocking other requests, whatever the history's size. The history shown afterwards SHALL be the same as before this requirement: the conversation up to the start, followed by the live events, with no turn shown twice.

#### Scenario: Mail delivery to a chat with a very large history
- **WHEN** mail is delivered to an idle chat whose history file holds more than a gigabyte
- **THEN** the server keeps answering other requests while the history loads, and the message reaches the agent once the load completes

#### Scenario: A message sent while the history is loading
- **WHEN** the user sends a message to a chat whose history is still loading for another start
- **THEN** the message waits for that same load, the agent starts once, and the transcript shows the earlier conversation once, followed by the new turn

#### Scenario: History is unchanged
- **WHEN** a chat's history is loaded for an agent start
- **THEN** the transcript shows the same rows, in the same order and with the same ids, as a full read of the history file would give
