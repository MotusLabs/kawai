# Spec Delta

## Purpose

Defines the versioned implementation contract a task revision may carry: its
five parts with stable clause ids, its text grammar and limits, its canonical
hash and identity, and the fallback identity of a revision without a contract,
so that results, reviews, and later findings can cite exactly what they are
judged against.

## ADDED Requirements

### Requirement: A contract has five parts with clause ids
A contract SHALL have five parts: Acceptance (clauses `A1`, `A2`, …), Invariants (`I*`), Scope (repository path globs), Verification (`V*`), and Excluded (`X*`). Acceptance, Scope, and Verification SHALL each have at least one entry; Invariants and Excluded MAY be empty. A clause id SHALL be its part's letter and a positive integer, unique within the contract. Each clause SHALL have non-empty text.

#### Scenario: Complete contract
- **WHEN** a contract has clauses A1 and A2, invariant I1, scope `src/server/team/**`, verification V1, and no excluded clauses
- **THEN** it is accepted with clauses A1, A2, I1, V1 and one scope glob

#### Scenario: Missing scope
- **WHEN** a contract has acceptance and verification clauses but no scope glob
- **THEN** it is refused naming the Scope part

#### Scenario: Duplicate clause id
- **WHEN** a contract has two clauses with id A2
- **THEN** it is refused naming A2

#### Scenario: Id with the wrong part letter
- **WHEN** the Invariants part lists a clause with id `A3`
- **THEN** it is refused naming `A3` and the Invariants part

### Requirement: Contracts are written in one Markdown grammar
A contract SHALL be Markdown: a `## Implementation contract` heading, then `###` headings `Acceptance`, `Invariants`, `Scope`, `Verification`, `Excluded`, all present, in that order. A clause SHALL be a bullet `- <id>: <text>`, optionally continued on indented lines; a scope entry, a bullet holding one glob. Any other non-blank line in the section SHALL be a problem. The parser SHALL report every problem with its line number.

#### Scenario: Parse a section
- **WHEN** a contract's text has the five headings in order, with bullets `- A1: Lists tasks` and `- src/server/**`
- **THEN** it parses into clause A1 with text `Lists tasks` and the scope glob `src/server/**`

#### Scenario: Several problems at once
- **WHEN** the text lacks the Verification heading and has a bullet without an id under Acceptance
- **THEN** the parser reports both problems, each with its line number, and yields no contract

#### Scenario: Continued clause
- **WHEN** clause I1's bullet is followed by an indented line `  and never twice`
- **THEN** I1's text is the bullet's text and `and never twice` joined by one space

#### Scenario: Prose inside a part
- **WHEN** a plain paragraph appears under the Invariants heading
- **THEN** the parser reports that line as neither a bullet nor a continuation

#### Scenario: Heading out of order
- **WHEN** the Scope heading comes before the Invariants heading
- **THEN** the parser reports the out-of-order heading with its line number

### Requirement: Contracts are bounded
A contract SHALL be refused when it exceeds 16,384 bytes of normalized text, has more than 50 clauses in one part or more than 40 scope globs, or has a clause longer than 1,000 characters. A scope glob SHALL be a relative POSIX path pattern whose only wildcards are `*` (within a segment), `**` (across segments), and `?`; an absolute path, a `.` or `..` segment, a backslash, or any of `!`, `[`, `]`, `{`, `}` SHALL be refused.

#### Scenario: Too many clauses
- **WHEN** a contract's Acceptance part has 51 clauses
- **THEN** it is refused naming the Acceptance part and the limit of 50

#### Scenario: Escaping glob
- **WHEN** a scope entry is `../other/**`
- **THEN** it is refused naming that glob

#### Scenario: Brace pattern
- **WHEN** a scope entry is `src/{server,shared}/**`
- **THEN** it is refused naming that glob and the `{` character

### Requirement: A contract has a canonical hash and an identity
Kawai SHALL compute a contract's hash as the SHA-256 of a canonical form that ignores line-ending style, trailing whitespace, and blank lines, and keeps clause order and text. A contract's identity SHALL be `r<revision>#<the first 12 hex digits of its hash>`, and a clause's identity SHALL be the contract's identity, ` › `, and the clause id.

#### Scenario: Formatting does not change the hash
- **WHEN** two contract texts differ only in CRLF versus LF line endings, trailing spaces, and blank lines between bullets
- **THEN** they have the same hash

#### Scenario: Wording changes the hash
- **WHEN** two contracts differ only in the text of clause I1
- **THEN** their hashes differ

#### Scenario: Clause identity
- **WHEN** revision 3 of a task carries a contract whose hash starts with `4f1c09ab22de`
- **THEN** its invariant I2 is identified as `r3#4f1c09ab22de › I2`

### Requirement: A revision without a contract has a text identity
A task revision without a contract SHALL have an identity of the same form, computed from the SHA-256 of its direction and acceptance text. It SHALL have no clauses and no scope, and every reader SHALL label it as having no contract.

#### Scenario: Legacy task
- **WHEN** a task created before contracts existed is read at revision 2
- **THEN** it shows an identity `r2#<12 hex digits>` derived from its direction and acceptance, is labeled as having no contract, and lists no clauses
