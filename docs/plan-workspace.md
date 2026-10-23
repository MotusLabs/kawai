# Plan workspace: contextual chat delivery

How a chat message carries plan context (the plan-workspace change, §4):
what the server stores, what the SDK receives, and what a context never
does. The workspace pages, bindings, and document reader are §2–3; the
client composer integration is §5–7.

## The wire and the store

A `chat-send` may carry a `workspaceContext` envelope: the team, plan,
version (revision or draft, with the content hash the sender saw), and
optionally an execution, a change name, and a document ref. The server
validates the envelope whole before anything is minted or stored: the team
must be the session's own repository, the version must still stand at the
named hash, a named execution must belong to the plan, a named change must
be part of the named version, and a local document must still hash to what
the sender read (fail-closed). A refusal stores no row, opens no turn, and
leaves the client draft intact.

On success the driver mints a user-message UUID (independent of the turn
id), records the immutable context row keyed by it, opens (or reuses) the
turn, emits the visible `user_message` event with the context attached, and
only then enqueues the SDK message. Two messages in one active turn keep
distinct contexts; there is no ambient current-plan state.

## What the SDK receives

`message.content` is exactly the typed text — a slash command stays a
slash command. The context rides only in a separate `pasted_content`
entry, and `client_composed` is never set. Every user message carries the
minted `uuid`, unscoped ones included: the replay join key must exist on
every message that could ever carry context.

## Replay

The durable copy of a user message is the CLI transcript; replay
reconstructs `messageUuid` from the record's `uuid` and joins the stored
context by it. Legacy lines without a uuid read as no context, and a
context row whose message never reached the transcript renders nothing. A
stored context is immutable: a later plan rename or file change never
rewrites what an old message showed.

A command-output turn's transcript holds the user record (with its uuid)
before the command output; the attachment joins the user message, never
the `command_output` event.

## What a context never does

An attachment carries no authority. It does not set the session's task
association, never moves the turn-usage pin, and authorizes no execution —
it is a label on a message, not a grant. Validation only reads the plan
stores; a contextual send writes nothing outside its own context row.

Two properties rest on schema facts worth naming: an execution's stored
context needs no revision field because `plan_executions.revision` is
INSERT-only — the id is the revision snapshot; and the uuid echo
suppression consumes both the uuid and the typed-text token, so a foreign
same-text frame after a contextual send is kept.

## Runtime support

A chat runtime without the contextual seam (a Codex thread) refuses a
contextual send with an explicit error; it is never a silent drop or an
unscoped send. The local `/clear`, `/reset`, and `/new` commands stay
client-intercepted; the server treats their text literally.
