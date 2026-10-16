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
effort: medium                             # low, medium, high, xhigh, max
profileEffort: { haiku: xhigh }            # per-profile effort; beats effort
releaseOnTaskClose: true                   # default; false keeps spawned members
worktreeScoped: true                       # default; false takes task mail anywhere
canReleaseMembers: true                    # default; false opts out of release_member
canManageMailbox: true                     # default false
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
- `effort` is the reasoning effort every member's agent launches with (the
  Claude Code `--effort` flag), whether a member was spawned or created by you.
  It is read at each agent start, restart, or resume, so an edit reaches only
  later starts. Without it, Claude Code's own settings decide. The flag beats a
  saved `effortLevel` default, but `CLAUDE_CODE_EFFORT_LEVEL` in the server
  environment overrides it and a settings maximum clamps it. `/effort` in a
  chat still changes that running agent. An invalid value is reported and
  ignored. Gateway models (GLM, MiMo, ...) may ignore effort.
- `profileEffort` is a single-line map from profile id to an effort level. A
  member whose session profile has an entry launches at that level instead of
  `effort`, spawned or created by you; members on other profiles keep
  `effort`, and with neither they get no effort from kawai. It is read at each
  agent start like `effort`. A bad entry never
  rejects the file: a value that is not a map is ignored whole, a bad profile
  id, a bad level, or a repeated profile (the first is kept) is ignored alone,
  and an entry for a profile the group does not list is reported but still
  applies. The Members tab shows the group level followed by each override.
- `releaseOnTaskClose` (default `true`): when a task becomes `done` or
  `cancelled`, its live spawned members are released — archived, never killed —
  once each has settled (idle, no pending approval or answer, no live
  background worker or running background task, no claimed or parked mail,
  no due direct mail). The
  pending release is durable across a restart, is cancelled by reopening the
  task or restoring the member, and is journaled on the task by kawai. A group
  setting `false` keeps its spawned members after their tasks close.
- `worktreeScoped` (default `true`): task mail to a group setting `false` goes
  to any idle member of the group wherever it runs, and never causes a spawn.
  Use it for groups whose members never live in task worktrees (a lead or
  reviewer group working in the main checkout), so reports and killed-sender
  reply fallbacks reach them; the default keeps worktree routing and spawning.
- `canReleaseMembers` (default `true`): members of the group may call the
  `release_member` tool, archiving one settled spawned member of the team
  immediately (never themselves, never human-created sessions; refused with
  the reason when the member is busy, awaiting an answer, running a background
  worker, or holding mail). A group setting `false` opts out.
- `canManageMailbox` (`true`/`false`, default `false`) lets a group's members
  cancel any team message that is still undelivered (queued, scheduled, or
  awaiting a request) and parked work (its waiting resume mail is cancelled
  with it), and discard dead or uncertain mail, through the `cancel_message` and
  `discard_message` tools, each with a reason. Every agent can list the mail it
  sent, received, or holds with `list_mailbox` (managers see the whole team) and
  withdraw its own undelivered mail. Retry and hand-off stay with the human. It
  is read from the group file at each call, so an edit applies to running
  members. An invalid value is reported as a warning and treated as `false`.

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
  It returns `pick`, `hold` (with an optional finite, non-negative retry delay
  in milliseconds; zero retries next cycle), or `default`. Both `route` and
  `onLimit` receive the task worktree and `forwardedFromProfile` on carried work.
- Throws, timeouts (`timeoutMs`, default 3 s, at most 10 s), and unknown picks
  fall back to the built-in strategy and are logged. A pick that went stale
  before the claim is routed again once, then by the built-in strategy.
- Rules load at server start and on **Reload routing rules** in the Mailbox
  panel only. Editing a file does nothing until you reload; the reload lists
  each rule's result and which files changed. Reloading also clears existing
  holds so queued work is evaluated under the new policy.

## Limits

Rate-limit, billing, and overload failures (and any 429) are recorded per
profile for 24 hours. A final failure starts a cooldown for that profile in
every group — until the provider's reset when known, else one hour. When the
turn handling a message fails that way, the message is:

- **parked** on the same agent, with a resume message scheduled at the reset;
  the agent shows as paused and takes no group mail; a successful turn (yours
  or the resume) unparks it; after three parks the work is released;
- **released** back to the group queue; a session with no group keeps its
  direct work queued for the same session at the reset time;
- **forwarded** with a handoff package (progress digest, last error, claim
  commit, and an instruction to inspect `git status`/`git diff` first); it
  never routes back to the limited profile, and the original agent is told who
  took over once its profile recovers.

A reset that has already passed retries work immediately without marking the
agent paused. An unrelated peer message does not cancel parked work's resume.

Parked work can be handed to a group or a session on another profile with
**Hand off** in the Mailbox panel. An archived session is restored before
receiving a handoff. Handoffs continue the original thread without consuming
another reply hop. Invalid automatic targets fall back to the same group.
Urgent direct mail to an agent whose profile is cooling is refused with the
cooldown end time; normal direct mail waits in the queue until recovery.
