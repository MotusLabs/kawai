# Spec Delta

## ADDED Requirements

### Requirement: Debug view groups consecutive frames of the same type
The debug view SHALL show two or more consecutive frames that share a
direction and message type as one collapsed group row. The row SHALL state the
type, the number of frames, and their sequence and time range. Expanding the
group SHALL list every member frame in sequence order, with each member
behaving as an ungrouped frame row. Grouping SHALL NOT hide, reorder, or alter
any frame.

#### Scenario: A streamed response collapses into one row
- **WHEN** the debug view holds 20 consecutive inbound `stream_event · content_block_delta` frames
- **THEN** the panel shows one row for them stating the type, a count of 20, and the first and last sequence numbers and timestamps

#### Scenario: Expanding a group shows its frames
- **WHEN** the user expands a group row
- **THEN** each member frame is listed in sequence order with its direction, timestamp, sequence number, and type, and each still expands to pretty-printed JSON and copies its original line exactly

#### Scenario: A lone frame is not grouped
- **WHEN** a frame's neighbours have a different direction or message type
- **THEN** the frame is shown as an individual row, not as a group of one

#### Scenario: Direction separates groups
- **WHEN** consecutive frames share a message type but differ in direction
- **THEN** they are not placed in the same group

#### Scenario: Thinking token updates do not break a delta run
- **WHEN** inbound `content_block_delta` frames alternate with inbound `system · thinking_tokens` frames
- **THEN** they form one group counted under the delta type, the row reports how many `thinking_tokens` frames it contains, and expanding it lists both kinds in sequence order

#### Scenario: Copy all copies the group's raw lines
- **WHEN** the user chooses Copy all on an expanded group
- **THEN** the clipboard receives every member frame's original line in sequence order, separated by newlines

### Requirement: Frame groups stay stable while frames arrive
Groups in the debug view SHALL extend in place when live frames or older pages
continue a run, rather than adding a row per frame. A group the user has
expanded SHALL stay expanded, and a frame the user has expanded SHALL stay
expanded, as the group grows or as older frames load.

#### Scenario: A live run grows in place
- **WHEN** the debug view is open, the newest row is a group, and more frames of the same direction and type arrive
- **THEN** that row's count and ranges update and no new row is added

#### Scenario: Expanded group survives growth
- **WHEN** the user has expanded a group and more frames join it, from the live tail or from Load older
- **THEN** the group remains expanded and lists the new members in sequence order

#### Scenario: A different frame ends the run
- **WHEN** a frame of a different direction or type arrives after a group
- **THEN** it starts a new row, and later frames of the earlier type start a new group rather than rejoining the earlier one
