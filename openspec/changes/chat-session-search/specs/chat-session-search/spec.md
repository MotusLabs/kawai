## ADDED Requirements

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
The system SHALL group results by chat session. Each group SHALL show the chat's name, its project directory, its total match count, and up to three snippets from its most recent matching entries, newest first. Each snippet SHALL show the entry kind and the matched text with surrounding context, with the match highlighted. Groups SHALL be ordered by most recent matching entry, newest first, and at most 50 groups SHALL be returned. A result set that reached a limit SHALL say so.

#### Scenario: Several matches in one chat
- **WHEN** a chat has five entries containing `#147`
- **THEN** its group shows a count of 5 and the three newest matching entries as snippets

#### Scenario: Ordering across chats
- **WHEN** chat A last mentioned `#147` an hour ago and chat B ten minutes ago
- **THEN** chat B's group is listed before chat A's

#### Scenario: Long entry
- **WHEN** a match falls in the middle of a tool result 20,000 characters long
- **THEN** the snippet shows a bounded excerpt around the match, not the whole output

### Requirement: Results jump to the matched entry
The system SHALL, when the user chooses a snippet, select that chat, open its chat view, scroll the matched entry into view, and highlight it briefly. When the matched entry is a tool input or result, the system SHALL scroll to that tool's entry. Choosing a group's header SHALL open the chat without scrolling to an entry. If the matched entry is no longer in the transcript, the system SHALL still open the chat.

#### Scenario: Jump to a tool result
- **WHEN** the user chooses the snippet for the `gh pr create` result in chat B
- **THEN** chat B is selected, its view scrolls to that tool entry, and the entry is highlighted for a moment

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
