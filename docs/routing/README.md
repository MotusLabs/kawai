# Profile routing

How kawai decides which agent (and which provider profile) handles a group's
mail, and what happens when a profile hits its limit mid-task.

## Group settings

Group files (`.kawai/groups/<id>.md`) accept, besides the team-task settings:

```yaml
---
profiles: { glm: 2, mimo: 1, claude: 1 }   # or a list: [claude, glm]
strategy: first-available                  # or profile-order
onLimit: { parkIfResetWithin: 3h, otherwise: forward, forwardTo: architects }
---
```

- `profiles` lists the profiles spawned members may use, preferred first. The
  map form also caps live members of the group per profile: every non-archived
  member counts, user-created or spawned, busy or parked. `max` then defaults
  to the sum of the caps. A single `profile: glm` still works. Unknown profile
  ids are reported and ignored. kawai never spawns past a cap; the new-session
  dialog warns before you do.
- `strategy` is the built-in routing without a rule: `first-available` takes
  the longest-idle member, else spawns on the first allowed profile;
  `profile-order` prefers members whose profile comes earlier. Both skip
  profiles in cooldown.
- `onLimit` is the built-in limit policy: park when the agent made progress and
  the reset is within `parkIfResetWithin` (`<n>m`/`<n>h`, default `3h`);
  otherwise `forward` (default) or `release`; with no progress, release.
  `forwardTo` is a group id or a team session id (default: the same group).
  Invalid values are reported and the defaults used.

## Routing rules

A rule for group `<id>` lives only in `~/.kawai/routing/<id>.ts`; repository
files are never loaded. It default-exports `{ route, onLimit?, env?, timeoutMs? }`
(types: `kawai-routing.d.ts`, written next to your rules on each load). See
[`devs.example.ts`](devs.example.ts).

- Rules run in a Worker with an empty environment plus only the variables
  listed in `env`. They see message metadata (priority, sender group, tags,
  worktree, task id), never the body.
- `route(ctx)` gets the eligible candidates (idle members and spawn slots per
  allowed profile, already filtered by delivery, staffing, caps, and parking —
  cooling profiles are included with their `cooldownUntil`), the group's caps
  and live counts, and per-profile usage (with its source) and limit events.
  It returns `pick`, `hold` (with an optional retry delay), or `default`.
- Throws, timeouts (`timeoutMs`, default 3 s, at most 10 s), and unknown picks
  fall back to the built-in strategy and are logged. A pick that went stale
  before the claim is routed again once, then by the built-in strategy.
- Rules load at server start and on **Reload routing rules** in the Mailbox
  panel only. Editing a file does nothing until you reload; the reload lists
  each rule's result and which files changed.

## Limits

Rate-limit, billing, and overload failures (and any 429) are recorded per
profile for 24 hours. A final failure starts a cooldown for that profile in
every group — until the provider's reset when known, else one hour. When the
turn handling a message fails that way, the message is:

- **parked** on the same agent, with a resume message scheduled at the reset;
  the agent shows as paused and takes no group mail; a successful turn (yours
  or the resume) unparks it; after three parks the work is released;
- **released** back to the group queue;
- **forwarded** with a handoff package (progress digest, last error, claim
  commit, and an instruction to inspect `git status`/`git diff` first); it
  never routes back to the limited profile, and the original agent is told who
  took over once its profile recovers.

Parked work can be handed to any group or session with **Hand off** in the
Mailbox panel. Urgent direct mail to an agent whose profile is cooling is
refused with the cooldown end time.
