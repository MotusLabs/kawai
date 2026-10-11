# Backlog

Follow-ups too small for an OpenSpec change of their own. Promote an item to
a change when it grows scope; delete it when done.

## team_messages retention

`team_messages` keeps every row forever — `delivered`, `cancelled`, and
`discarded` mail is never pruned. The hot paths no longer scale with table
size (the `(to_id, state)` and `(claimed_by, state)` indexes landed with the
PR #72 review fixes), so this is pure housekeeping with no correctness impact
today.

Design constraints:

- Delivered rows must stay readable: `thread()` (`src/server/team/mailboxStore.ts`)
  reads them to attach thread context to group replies.
- Dead and uncertain rows surface in the mailbox UI for human review;
  uncertain rows should stay until a human resolves them.

Rough shape: a retention window for delivered rows older than any plausible
reply chain, plus a cap or archive path for cancelled/discarded rows.
