## MODIFIED Requirements

### Requirement: Conversation events stream to the chat view
The system SHALL stream conversation events for a chat session to connected
clients in order: the user's submitted turn, assistant text, tool activity,
and turn completion. The chat view SHALL render assistant text as markdown
and tool activity as compact activity entries. A client that attaches to an
existing chat session SHALL receive the recent window of the session's prior
conversation, with older history available on request.

#### Scenario: Message exchange streams end to end
- **WHEN** the user submits a message in the chat view
- **THEN** the user turn appears in the transcript, assistant text and tool activity stream in as they are produced, and the turn ends with a completion event

#### Scenario: Reconnect during a turn or pending request
- **WHEN** a client reconnects while output streams or an approval/question is pending
- **THEN** it receives a snapshot containing the history window, unfinished output, current status, and pending requests before subsequent live events, without lost or duplicated content

#### Scenario: Multiple clients answer the same request
- **WHEN** two clients answer the same pending request
- **THEN** only the first valid answer takes effect and all attached clients remove the resolved request

#### Scenario: Reconnect replays prior conversation
- **WHEN** a client attaches to a chat session that already has history (including after a page reload)
- **THEN** the recent window of the prior conversation is displayed before any new live events arrive

## ADDED Requirements

### Requirement: Attaching delivers the recent history window
On attach, the system SHALL deliver only the turns that started within the 24 hours ending at the session's newest dated event, and at least the newest turn. Turns SHALL NOT be split. Pending requests, unfinished output, activity, and rosters SHALL be delivered whatever their age. The snapshot SHALL state whether older history exists. This SHALL apply to live and archived chats.

#### Scenario: Long-running session opens on its last day
- **WHEN** a client attaches to a chat whose conversation spans five days and whose newest event is from now
- **THEN** the transcript shows only the turns that started in the last 24 hours, and the top of the transcript offers to load earlier messages

#### Scenario: Idle session still opens on its last work
- **WHEN** a client attaches to a chat whose newest event is three days old
- **THEN** the transcript shows the turns that started in the 24 hours before that event, not an empty transcript

#### Scenario: A turn that began before the window is kept whole
- **WHEN** a turn started 25 hours before the newest event and its tool results arrived within the last 24 hours
- **THEN** the turn is either delivered whole or left wholly to older history, and no tool entry is shown without its call or result

#### Scenario: Short conversation has no older history
- **WHEN** a client attaches to a chat whose whole conversation lies within the window
- **THEN** the whole conversation is shown and no control to load earlier messages is offered

#### Scenario: Old pending request is still shown
- **WHEN** an approval requested 30 hours ago is still pending at attach
- **THEN** its approval card is shown even though its turn lies before the window

### Requirement: Users load earlier history on request
While older history exists, the top of the transcript SHALL offer a control to load earlier messages. Each use SHALL prepend the 24 hours before the oldest loaded turn, and at least one turn, without moving the entries the user is reading. The control SHALL show progress while loading, SHALL be disabled while disconnected, and SHALL be replaced by a start-of-conversation marker once nothing older remains.

#### Scenario: Load one more day
- **WHEN** the user activates the load-earlier control in a chat with a week of history
- **THEN** the turns of the preceding 24 hours appear above the previously oldest entry, and the entry the user was looking at stays where it was on screen

#### Scenario: Reaching the beginning
- **WHEN** the user loads earlier messages until the first turn of the conversation is shown
- **THEN** the control is replaced by a marker stating that this is the beginning of the conversation

#### Scenario: Gap in activity
- **WHEN** the 24 hours before the oldest loaded turn contain no turns but older turns exist
- **THEN** one use of the control still loads at least the next older turn

#### Scenario: Disconnected
- **WHEN** the connection to the server is lost
- **THEN** the load-earlier control is disabled until the connection returns

### Requirement: The history window moves only when a chat is opened
Entries SHALL NOT be removed from a transcript while it is shown. A reconnect while a chat is shown SHALL keep every entry it showed. Opening a chat (selecting it again or reloading the page) SHALL recompute the recent window at that moment, except that within the same page load a chat where the user loaded earlier history SHALL reopen from the oldest turn the user had loaded. Live events SHALL follow every snapshot without loss or duplication.

#### Scenario: Open chat stays put for days
- **WHEN** a chat stays shown for three days while its agent keeps working
- **THEN** new entries append at the bottom and no entry disappears from the top

#### Scenario: Reconnect while shown
- **WHEN** the connection drops and returns while a chat is shown
- **THEN** the transcript shows every entry it showed before, plus anything that arrived meanwhile, with no duplicated entries

#### Scenario: Reopening slides the window
- **WHEN** the user switches away from a chat that was shown for three days without loading earlier messages and later selects it again
- **THEN** it opens on the turns of the last 24 hours, with the load-earlier control offered

#### Scenario: Reopening keeps history the user loaded
- **WHEN** the user loaded two earlier days of a chat, switched to another chat, and selects it again without reloading the page
- **THEN** it opens from the oldest turn the user had loaded

#### Scenario: Reload starts from the recent window
- **WHEN** the user reloads the page after loading earlier messages
- **THEN** the chat opens on the recent window with the load-earlier control offered
