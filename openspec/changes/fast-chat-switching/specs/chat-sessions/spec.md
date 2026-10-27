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
- **THEN** the turn is either delivered whole or left wholly to older history, and no tool entry is shown without its call or result

#### Scenario: Short conversation has no older history
- **WHEN** a client attaches to a chat whose whole conversation lies within the window
- **THEN** the whole conversation is shown and no control to load earlier messages is offered

#### Scenario: Old pending request is still shown
- **WHEN** an approval requested 30 hours ago is still pending at attach
- **THEN** its approval card is shown even though its turn lies before the window

### Requirement: Users load earlier history on request
While older history exists, the top of the transcript SHALL offer a control to load earlier messages. Each use SHALL prepend the 24 hours before the oldest loaded entry, within the history size budget and at least one part of a turn, without moving the entries the user is reading. The control SHALL show progress while loading, SHALL be disabled while disconnected, and SHALL be replaced by a start-of-conversation marker once nothing older remains.

#### Scenario: Load one more day
- **WHEN** the user activates the load-earlier control in a chat with a week of quiet history
- **THEN** the turns of the preceding 24 hours appear above the previously oldest entry, and the entry the user was looking at stays where it was on screen

#### Scenario: A busy day loads in steps
- **WHEN** the 24 hours before the oldest loaded entry hold 1,500 events and the user activates the control
- **THEN** at most 500 of them appear, the control is still offered, and the next use continues from the new oldest entry

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
- **THEN** it opens on the recent window recomputed at that moment, with the load-earlier control offered

#### Scenario: Reopening keeps history the user loaded
- **WHEN** the user loaded two earlier days of a chat, switched to another chat, and selects it again without reloading the page
- **THEN** it opens from the oldest turn the user had loaded

#### Scenario: Reload starts from the recent window
- **WHEN** the user reloads the page after loading earlier messages
- **THEN** the chat opens on the recent window with the load-earlier control offered

## ADDED Requirements

### Requirement: The history window has a size budget
Empty eligible history SHALL yield no events; otherwise at least one part SHALL be returned. Whole units SHALL fill newest-first within 500 events/512 KiB of serialized events-array UTF-8 (envelope excluded), stopping before older-unit overflow. Only an oversized newest unit SHALL fill by quiet parts newest-first under both caps; its oversized newest part SHALL stand alone. Cuts SHALL be at part boundaries; older units SHALL NOT partly fill leftover space. Widened anchors ignore caps.

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
- **WHEN** the newest unit alone exceeds the budget and its newest part holds a tool call with a single tool result larger than 512 KiB
- **THEN** that part is delivered whole rather than an empty transcript

#### Scenario: Non-ASCII text crosses the byte budget without crossing the event count
- **WHEN** the window's events are small CJK text events forming independent quiet parts, each part within the byte budget, whose combined UTF-8 encoded size crosses 512 KiB while their code-unit count stays far below it
- **THEN** the walk stops before the unit or part whose addition would push the encoded size past 512 KiB, with no single-part exception

### Requirement: Reopening a held chat transfers only what changed
On reattach to a held transcript (same page load), the server SHALL send only the events after the newest held one plus the window's new start while the history generation matches the memo and the held range verifies, and a full snapshot otherwise. The generation SHALL change on population, replacement, release, replay, and restart, never on appends. The client SHALL fold the delta and trim below the new start, matching a full attach. Expansion SHALL NOT be inferred from the held marker alone.

#### Scenario: Switching back after new work
- **WHEN** the user switches back to a chat whose agent added 40 events since the client last showed it
- **THEN** the server sends those 40 events and the window start, not the whole window, and the transcript shows what a full attach would show

#### Scenario: Switching back with nothing new
- **WHEN** the user switches back to a chat that has not changed
- **THEN** the server sends no transcript events, and the transcript is unchanged

#### Scenario: The window slid while away
- **WHEN** the recomputed window starts after the oldest entry the client holds and the user had not loaded earlier history
- **THEN** the client drops the entries before the new start, and the load-earlier control is offered

#### Scenario: The server cannot match the held events
- **WHEN** the newest event the client holds is unknown to the server, for example after a server restart
- **THEN** the server sends a full snapshot and the client replaces the transcript with it

#### Scenario: A replayed interior event keeps the endpoints but not the generation
- **WHEN** a released archived chat is replayed, the replay rewrites an interior event while both held endpoint ids survive, and the client reattaches with its held markers
- **THEN** the stale history generation fails the proof and the server sends a full snapshot whose transcript matches the replayed history

#### Scenario: Expansion is stated, not inferred
- **WHEN** a client reattaches with held markers after the user had loaded earlier history, and another reattaches with held markers but without it
- **THEN** the first resumes from the oldest loaded turn and the second from the recomputed recent window

#### Scenario: Pending requests and rosters stay authoritative
- **WHEN** the server sends only newer events on reattach
- **THEN** pending requests, activity, rosters, and notices are still delivered whole and replace the client's copies

### Requirement: Archived chats release their loaded history
The server SHALL release an archived chat's loaded history once no client has subscribed to it for 10 minutes and exact replay is safe: no agent driver, no load in flight, no live events beyond the replayed transcript, no retryable state. A memo failing this eligibility SHALL be kept intact. Opening the chat again SHALL show the same entries whether or not it was released. A chat that is not archived SHALL keep its loaded history.

#### Scenario: Idle archived chat is released
- **WHEN** an archived chat's last client detaches, 10 minutes pass with no new subscription, and exact replay is safe
- **THEN** the server no longer holds that chat's loaded history

#### Scenario: An archived chat with live-only state is kept
- **WHEN** an archived chat holds event entries its stored transcript does not contain, such as a policy notice emitted while its agent stopped
- **THEN** the memo is not released, and opening the chat still shows those entries

#### Scenario: A load cancelled before subscribing still leaves a timed memo
- **WHEN** an attach to an archived chat starts its history load and detaches before the load completes, and the load still populates the memo
- **THEN** the populated memo is armed with the same eligible-idle deadline and is released when it passes

#### Scenario: Reopening a released chat
- **WHEN** the user opens an archived chat whose history was released
- **THEN** the transcript shows the same entries it showed before the release

#### Scenario: A watched archived chat is kept
- **WHEN** a client stays subscribed to an archived chat for an hour
- **THEN** the server keeps its loaded history

#### Scenario: Restoring a released chat
- **WHEN** the user restores an archived chat whose history was released
- **THEN** the restored chat shows its whole earlier conversation followed by its new turns, with no duplicated entries
