# chat-session-search Specification

## Purpose

TBD - Update Purpose after archive.

## Requirements

### Requirement: Users search conversation content across active chat sessions
The system SHALL let the user search the conversation content of every active chat session at once. An active chat session is one on this server that is not archived, whether or not its agent is running. The system SHALL NOT search archived chats, killed chats, terminal sessions, or sessions on other hosts.

#### Scenario: Finding the session that opened a PR
- **WHEN** one active chat ran `gh pr create` and its tool result printed `https://github.com/acme/app/pull/147`, and the user searches `pull/147`
- **THEN** that chat appears in the results with a snippet from the tool result containing `pull/147`

#### Scenario: Agent not running
- **WHEN** an active chat's agent has not started since the server restarted and its transcript mentions `#147`
- **THEN** searching `#147` finds that chat without starting its agent

#### Scenario: Archived chat excluded
- **WHEN** the only chat mentioning `#147` is archived
- **THEN** searching `#147` returns no results

### Requirement: Search matches literal text case-insensitively
The system SHALL treat the trimmed query as a literal string, matched case-insensitively as a substring, with no regular-expression or wildcard meaning. The system SHALL search only queries of 2 to 200 characters after trimming. A query outside those bounds SHALL show no results and SHALL NOT be sent to the server.

#### Scenario: Special characters are literal
- **WHEN** the user searches `fix(chat):`
- **THEN** only text containing exactly `fix(chat):`, in any letter case, matches

#### Scenario: Case-insensitive match
- **WHEN** a transcript contains `Pull Request #147` and the user searches `pull request #147`
- **THEN** the chat matches

#### Scenario: Too-short query
- **WHEN** the trimmed query is one character long
- **THEN** no search runs and no results are shown

### Requirement: Searched text covers the whole conversation
The system SHALL search the chat's name and the text of these conversation entries: user and peer messages, assistant text, tool inputs, tool results, command output, notices, and errors. Searched text SHALL include history replayed from the transcript and entries added since then. Partial streaming text SHALL NOT be searched separately from the final message it becomes.

#### Scenario: Match in a tool input
- **WHEN** a chat ran a Bash command containing `gh pr view 147`
- **THEN** searching `pr view 147` matches that tool entry

#### Scenario: Match in a peer message
- **WHEN** a chat received team mail whose body says `opened PR #147`
- **THEN** searching `PR #147` matches that peer message

#### Scenario: Match on the chat name only
- **WHEN** a chat is named `PR 147 review` and nothing in its conversation contains the query `PR 147`
- **THEN** the chat appears in the results as a name match with no snippets

#### Scenario: Entry from the current turn
- **WHEN** a tool result containing `pull/148` arrived in a chat's in-flight turn moments ago
- **THEN** searching `pull/148` finds it

### Requirement: Results are grouped by session with snippets
The system SHALL group results by chat session. A group header SHALL show the chat's name, its worktree name (full path on hover), its match count, and the relative time of its newest match. Below it SHALL be up to three snippets from its newest matching entries, newest first. Groups SHALL be ordered by newest match. At most 50 groups SHALL be returned, and the results SHALL say when that limit was reached.

#### Scenario: Several matches in one chat
- **WHEN** a chat has five entries containing `#147`
- **THEN** its group shows a count of 5 and the three newest matching entries as snippets

#### Scenario: Ordering across chats
- **WHEN** chat A last mentioned `#147` an hour ago and chat B ten minutes ago
- **THEN** chat B's group is listed before chat A's and its header reads `10m ago`

#### Scenario: Worktree name
- **WHEN** a matching chat runs in a subdirectory of the linked worktree `.worktrees/fix-login`
- **THEN** its group header shows `fix-login`, and hovering it shows the chat's full path

#### Scenario: Long entry
- **WHEN** a match falls in the middle of a tool result 20,000 characters long
- **THEN** the snippet shows a bounded excerpt around the match, not the whole output

### Requirement: Snippets name their entry and highlight the match
Each snippet SHALL start with a label naming the entry kind: `You`, `Assistant`, `Team message`, `Command output`, `Notice`, or `Error`. A tool entry's label SHALL add the tool name, as in `Tool input · Bash`, `Tool result · Bash`, or `Approval · Bash`. The excerpt SHALL be clamped to two lines, with every occurrence of the query visibly highlighted in every theme. Hovering a snippet SHALL show the entry's absolute time.

#### Scenario: Tool result label
- **WHEN** the match is in the result of a Bash tool call
- **THEN** the snippet's label reads `Tool result · Bash`

#### Scenario: Highlight visible in each theme
- **WHEN** results are shown in the light theme and in the dark theme
- **THEN** the matched text is distinguishable from the surrounding excerpt in each

#### Scenario: Excerpt clamp
- **WHEN** a snippet's excerpt would wrap to more than two lines in the navigator's width
- **THEN** it is cut to two lines ending with an ellipsis

### Requirement: Results jump to the matched entry
The system SHALL, when the user chooses a snippet, select that chat, open its chat view, scroll the matched entry into view, and highlight it briefly. When the matched entry is a tool input or result, the system SHALL scroll to that tool's entry. Choosing a group's header SHALL open the chat without scrolling to an entry. If the matched entry is no longer in the transcript, the system SHALL still open the chat.

#### Scenario: Jump to a tool result
- **WHEN** the user chooses the snippet for the `gh pr create` result in chat B
- **THEN** chat B is selected, its view scrolls to that tool entry, and the entry is highlighted for a moment

#### Scenario: Entry highlight in the chat palette
- **WHEN** the revealed entry is highlighted in the chat view's reduced-glare palette or in the light theme
- **THEN** the highlight is visible against the transcript background and fades out after about two seconds

#### Scenario: Entry no longer present
- **WHEN** the chosen entry cannot be found after the chat opens
- **THEN** the chat opens at its usual position and no error is raised

### Requirement: Search is read-only and degrades per session
The system SHALL NOT start an agent, change a session's status, or keep a non-loaded transcript in memory as a result of a search. When one chat's transcript is missing or unreadable, the system SHALL still search that chat's name and the other chats. The result SHALL report how many chats could not be fully searched.

#### Scenario: Unreadable transcript
- **WHEN** one active chat's transcript file is missing
- **THEN** results from the other chats are returned, and the results note that one chat could not be fully searched

#### Scenario: No side effects
- **WHEN** a search reads the transcript of a chat nobody has opened since the server restarted
- **THEN** that chat's status and agent state are unchanged after the search
