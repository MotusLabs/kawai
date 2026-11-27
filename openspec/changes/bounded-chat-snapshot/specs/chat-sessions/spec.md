## MODIFIED Requirements

### Requirement: Attaching delivers the recent history window
On attach, the system SHALL deliver only the turns that started within the 24 hours ending at the session's newest dated event, within the history size budget, and at least the newest part of the newest turn. A turn SHALL be split only where the size budget requires it. Pending requests, unfinished output, activity, and rosters SHALL be delivered whatever their age. The snapshot SHALL state whether older history exists. This SHALL apply to live and archived chats.

#### Scenario: Long-running session opens on its last day
- **WHEN** a client attaches to a chat whose conversation spans five days, whose newest event is from now, and whose last day fits the size budget
- **THEN** the transcript shows only the turns that started in the last 24 hours, and the top of the transcript offers to load earlier messages

#### Scenario: Idle session still opens on its last work
- **WHEN** a client attaches to a chat whose newest event is three days old
- **THEN** the transcript shows the turns that started in the 24 hours before that event, not an empty transcript

#### Scenario: A turn that began before the window is kept whole
- **WHEN** a turn started 25 hours before the newest event, its tool results arrived within the last 24 hours, and it fits the size budget
- **THEN** the turn is either delivered whole or left wholly to older history, and no tool entry of that turn is shown without its call or result

#### Scenario: Short conversation has no older history
- **WHEN** a client attaches to a chat whose whole conversation lies within the window and holds at most 500 events and 512 KiB of serialized events
- **THEN** the whole conversation is shown and no control to load earlier messages is offered

#### Scenario: A short day over the event cap is still budgeted
- **WHEN** a client attaches to a chat whose whole conversation lies within 24 hours, in two units holding 501 events together, and the newest unit alone fits both the 500-event and the 512 KiB limits
- **THEN** only that newest whole unit is shown, the older unit stays in older history, and the control to load earlier messages is offered

#### Scenario: Old pending request is still shown
- **WHEN** an approval requested 30 hours ago is still pending at attach
- **THEN** its approval card is shown even though its turn lies before the window

### Requirement: Users load earlier history on request
While older history exists, the top of the transcript SHALL offer a control to load earlier messages. Each use SHALL prepend the 24 hours before the oldest loaded entry, within the history size budget and at least one part of a turn, without moving the entries the user is reading. The control SHALL show progress while loading, SHALL be disabled while disconnected, and SHALL be replaced by a start-of-conversation marker once nothing older remains.

#### Scenario: Load one more day
- **WHEN** the user activates the load-earlier control in a chat with a week of quiet history
- **THEN** the turns of the preceding 24 hours appear above the previously oldest entry, and the entry the user was looking at stays where it was on screen

#### Scenario: A busy day loads in steps
- **WHEN** the 24 hours before the oldest loaded entry hold 1,500 events in parts that each fit, and the user activates the control
- **THEN** at most 500 of them appear, the control is still offered, and the next use continues from the new oldest entry

#### Scenario: A page may carry one oversized part
- **WHEN** the 24 hours before the oldest loaded entry hold one part of 501 events and nothing smaller can be delivered
- **THEN** that part appears whole, and the control is offered only if older events actually remain

#### Scenario: Reaching the beginning
- **WHEN** the user loads earlier messages until the first turn of the conversation is shown
- **THEN** the control is replaced by a marker stating that this is the beginning of the conversation

#### Scenario: Gap in activity
- **WHEN** the 24 hours before the oldest loaded turn contain no turns but older turns exist
- **THEN** one use of the control still loads from the nearest older turn, within the size budget: the whole turn when it fits both limits, otherwise its newest parts that fit, or its single oversized newest part alone, and the control stays offered while older events remain

#### Scenario: Disconnected
- **WHEN** the connection to the server is lost
- **THEN** the load-earlier control is disabled until the connection returns

## ADDED Requirements

### Requirement: The history window has a size budget
Empty eligible history SHALL yield no events; otherwise at least one part SHALL be returned. Whole units SHALL fill newest-first within 500 events/512 KiB of serialized delivered events-array UTF-8 (envelope excluded), stopping before older-unit overflow. Only an oversized newest unit SHALL fill by quiet parts newest-first under both caps; its oversized newest part SHALL stand alone. Cuts SHALL be at part boundaries; older units SHALL NOT partly fill leftover space. Widened anchors ignore caps.

#### Scenario: A busy day opens on its newest turns
- **WHEN** a client attaches to a chat whose last 24 hours hold 2,300 events across nine turns
- **THEN** the transcript shows the newest whole turns that fit 500 events and 512 KiB of encoded events, and the load-earlier control is offered

#### Scenario: A newest unit larger than the budget is cut at a part boundary
- **WHEN** the newest unit alone holds 2,700 events with quiet points inside it, so no whole unit can be selected
- **THEN** the transcript shows that unit's newest quiet parts totalling at most the budget, each starting at a part boundary where no tool call awaits its result, and the load-earlier control is offered

#### Scenario: An older unit that would overflow is left whole
- **WHEN** newer units are selected and the next older unit would exceed the remaining budget, however finely its own parts divide
- **THEN** that unit is left to older history whole, its parts never fill the leftover space, and no cut moves across several parts to reach a nominal boundary

#### Scenario: An older part holding a call and its result is never split
- **WHEN** the newest unit's quiet-part walk has already selected a newer part and the next older part holds a tool call and its result, or a continuing assistant message, and would exceed a cap
- **THEN** that older part is left to older history and the walk stops, the cut lands on a part boundary, and the call and its result are shown together or not at all

#### Scenario: One oversized part is delivered whole
- **WHEN** the newest unit alone exceeds the budget and its newest part holds 501 events with no quiet point inside it
- **THEN** that part is delivered whole rather than an empty transcript

#### Scenario: A large tool result is priced at its elided size
- **WHEN** the newest unit alone exceeds the budget and its newest part holds a tool call whose tool result output is 600 KiB
- **THEN** the result is delivered elided so its serialized output is at most 65,536 bytes, the part is priced at that elided size, and the window stays within 512 KiB

#### Scenario: Non-ASCII text crosses the byte budget without crossing the event count
- **WHEN** the window's events are small CJK text events forming independent quiet parts, each part within the byte budget, whose combined UTF-8 encoded size crosses 512 KiB while their code-unit count stays far below it
- **THEN** the walk stops before the unit or part whose addition would push the encoded size past 512 KiB, with no single-part exception

#### Scenario: Workspace context counts toward the delivered budget
- **WHEN** a budgeted attach or beforeId page has three eligible units whose raw events total about 510 KiB and whose valid persisted workspace-context decoration makes the array exceed 512 KiB, each decorated unit individually fits the byte cap, and exactly the newest two fit together under both limits
- **THEN** the newest two units are delivered intact with their full metadata, the third remains in older history, and the delivered events-array UTF-8 size is at most 512 KiB

### Requirement: A late tool result never widens the window
A tool result whose call lies in an earlier turn SHALL be delivered only when the ordinary 24-hour and size selection includes it, and its call SHALL NOT widen that selection or the single-part exception. A result shown without its call SHALL be marked "call not loaded"; when loading earlier messages brings the call, the pair SHALL be shown once.

#### Scenario: A late result is shown with a marker
- **WHEN** a call from 26 hours before the newest event has its result in the newest turn, and a client attaches
- **THEN** the result is shown as a standalone result marked "call not loaded", the call stays in older history, and the control to load earlier messages is offered

#### Scenario: Loading the call pairs it once
- **WHEN** the user loads earlier messages until the call is shown
- **THEN** the call and its result appear as one entry, with no duplicate row and no marker

#### Scenario: The window never expands to the whole span
- **WHEN** a call and its late result are separated by more than 2,700 events in turns that each fit the budget
- **THEN** the ordinary cut applies and the delivered window is not widened to hold both

### Requirement: Large tool outputs are elided from delivered events
Every tool result delivered to a client in a snapshot, a history page, or live chat events whose output, serialized as a JSON string with its quotes, exceeds 65,536 UTF-8 bytes SHALL carry the longest prefix within that size that ends on a character boundary, with `outputElided` giving the full output's UTF-8 size. The client SHALL fetch the full output over HTTP on request, never over the WebSocket. Stored history, search, and the agent SHALL keep the full output.

#### Scenario: A large result opens as a preview
- **WHEN** a client attaches to a chat whose window holds a tool result with 2 MB of output
- **THEN** the snapshot carries a preview of that output whose serialized value is at most 65,536 bytes and `outputElided` with its full size, and the result view says the output is shortened

#### Scenario: An output at the limit is delivered whole
- **WHEN** a tool result's output serializes to exactly 65,536 bytes, quotes included
- **THEN** it is delivered whole with no `outputElided`

#### Scenario: Escaped characters count as sent
- **WHEN** a tool result's output is 2,000,000 control characters that JSON writes as six-byte escapes
- **THEN** the preview is cut so that its serialized value, escapes included, is at most 65,536 bytes, and `outputElided` gives 2,000,000

#### Scenario: Non-ASCII output is cut on a character boundary
- **WHEN** a tool result's output exceeds the limit and a multi-byte character straddles the limit
- **THEN** the preview ends before that character, so it decodes without a replacement character

#### Scenario: A live result is elided like history
- **WHEN** an agent's tool call returns 2 MB of output while a client watches the chat
- **THEN** the live chat event carries the same elided preview and `outputElided` that a later snapshot would

#### Scenario: Search still finds elided text
- **WHEN** a user searches a chat for text that appears only beyond the preview of an elided result
- **THEN** the search finds it, and revealing it shows the elided result

### Requirement: The full tool output is served byte for byte
The server SHALL serve a tool result's full output at `GET /api/chat/sessions/{sessionId}/tool-output/{eventId}` as `text/plain; charset=utf-8` with `no-store` and its exact UTF-8 length, reading without changing the chat, and 404 when that chat holds no such tool result. The client SHALL keep the preview until the whole body arrives with the expected length, and SHALL discard a response for an expansion that was collapsed, replaced, or left.

#### Scenario: The full output on request
- **WHEN** the user expands an elided tool result
- **THEN** the client downloads that output over HTTP and shows the full text the agent received, byte for byte, once the whole body has arrived

#### Scenario: Text is preserved exactly
- **WHEN** the stored output begins with a byte order mark and holds multi-byte and control characters
- **THEN** the served body and the shown text keep every one of them, including the leading byte order mark

#### Scenario: The full output is unavailable
- **WHEN** a client requests the full output for an event id that is not a tool result in the chat's history, after the server has loaded that history
- **THEN** the reply is 404, the view says the output is unavailable, and the preview stays as shown

#### Scenario: Another chat's result is not served
- **WHEN** a client requests the full output of a tool result that belongs to a different chat than the one in the path
- **THEN** the reply is 404 and no output is served

#### Scenario: Reading an archived chat changes nothing
- **WHEN** the full output of a result in a cold archived chat is requested after a server restart, and the transcript's last working directory differs from the chat's project path
- **THEN** the output is served, and the chat's project path, workspace refresh, loaded history and agent are all unchanged

#### Scenario: A collapsed expansion is not adopted
- **WHEN** the user collapses a result, switches chats, or leaves while its download is pending, and the download later completes
- **THEN** the download is aborted or its body discarded, and the view keeps what it showed after the collapse or switch

#### Scenario: A WebSocket reconnect does not restart the download
- **WHEN** the WebSocket drops and reconnects while a download for the same chat and result is pending
- **THEN** the download continues, no second request is made, and the full text is shown when it completes

#### Scenario: Expanding keeps the WebSocket free
- **WHEN** the user expands a 2 MB elided tool result
- **THEN** no snapshot, history page or live chat events message carries the full output, while the Debug view's raw frames keep their own contract

### Requirement: Live chat event batches are bounded in size
Each live chat events message SHALL be at most 262,144 UTF-8 bytes as sent, envelope included, except a single event that alone exceeds that size, which SHALL be sent alone. Splitting a batch SHALL deliver every event exactly once and in order, and SHALL keep the existing turn and 128-event boundaries.

#### Scenario: A burst of large results is split
- **WHEN** eight elided tool results arrive in one turn before a flush
- **THEN** they are sent in messages each at most 262,144 bytes as sent, every event once and in order

#### Scenario: The envelope counts toward the size
- **WHEN** a batch's events array is 262,062 bytes and its complete message, envelope included, is 262,145 bytes
- **THEN** it is sent as two messages each within 262,144 bytes, and a batch whose complete message is exactly 262,144 bytes is sent whole

#### Scenario: A single oversized event is sent alone
- **WHEN** a tool call event with a 2 MB input arrives between two small events
- **THEN** it is sent as a message of its own, and the small events are delivered in order around it
