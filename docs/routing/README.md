# Profile routing

How kawai decides which agent (and which provider profile) handles a group's
mail, and what happens when a profile hits its limit mid-task.

## Group settings

Group files (`.kawai/groups/<id>.md`) accept, besides the team-task settings:

```yaml
---
profiles: { glm: 2, mimo: 1, claude: 1 }   # or a list: [claude, glm]
workers: { zai/glm: 2, mimo: 1 }           # the new name of profiles; also provider/model
strategy: first-available                  # or profile-order
onLimit: { parkIfResetWithin: 3h, otherwise: forward, forwardTo: architects }
effort: medium                             # low, medium, high, xhigh, max
profileEffort: { haiku: xhigh }            # per-profile effort; beats effort
modelEffort: { claude/haiku: xhigh }       # the new name of profileEffort
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
- `workers` is the new name of `profiles`, and `modelEffort` of `profileEffort`.
  Both old keys keep working. When a file sets both spellings of one key, the
  new one wins and the group shows one warning per ignored old key; `profile`
  beside `workers` is no longer an error, since neither old key is read.
  Under the new keys a worker may be written `provider/model` (`zai/glm`),
  resolved against the profile catalog: it reads as that model's profile id
  when the provider holds the model, and is reported and ignored like an
  unknown id otherwise. Switch a file to the new names only after the live
  server reads them, or keep the old key beside the new one during the
  switch — an older server would ignore `workers` and spawn on the default
  profile.
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
  agent start like `effort`. A bad entry never rejects the file: a value that
  is not a map is ignored whole; a bad profile id, a bad level, or a repeat of
  a profile already listed (the later entry is ignored, even if the first was
  invalid) is ignored alone; and an entry for a profile the group does not list
  is reported but still applies. `modelEffort` takes the same values with the
  same warnings, plus `provider/model` keys resolved like `workers`' qualified
  names. The Members tab shows the group level followed by each override.
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
  worktree, task id, worker choice), never the body.
- `route(ctx)` gets the eligible candidates (idle members and spawn slots per
  allowed profile, already filtered by delivery, staffing, caps, and parking —
  cooling profiles are included with their effective `cooldownUntil`, so a
  provider's cooldown reads on each of its models), the group's caps and live
  counts, and per-profile usage (with its source) and limit events. Beside the
  per-profile entries, `ctx.providers` holds one entry per provider of those
  profiles — its `label`, its profile ids, its usage, its limit events (every
  row recorded for the provider's profiles, model-scoped windows included),
  and its own `cooldownUntil`. It returns `pick`, `hold` (with
  an optional finite, non-negative retry delay in milliseconds; zero retries
  next cycle), or `default`. Both `route` and `onLimit` receive the task
  worktree and `forwardedFromProfile` on carried work.
- Throws, timeouts (`timeoutMs`, default 3 s, at most 10 s), and unknown picks
  fall back to the built-in strategy and are logged. A pick that went stale
  before the claim is routed again once, then by the built-in strategy.
- Rules load at server start and on **Reload routing rules** in the Mailbox
  panel only. Editing a file does nothing until you reload; the reload lists
  each rule's result and which files changed. Reloading also clears existing
  holds so queued work is evaluated under the new policy.

## Limits

Rate-limit, billing, and overload failures (and any 429) are recorded per
profile — kept for 15 days, with routing reading only the last 24 hours —
with the provider owning the profile and the window the rejected report
named (`five_hour`, `seven_day_opus`, …). A final failure
starts a cooldown in every group for the profile's provider — until the
provider's reset when known, else one hour — except a window that covers one
model only (`seven_day_opus`, `seven_day_sonnet`), which cools that profile
alone. A profile is cooling while its provider or the profile itself is: the
latest final event of each window sets that window's end, and the latest end
still ahead decides, so a later short-window event never releases a weekly one
still running. Events recorded before providers (no provider id) cool only
their own profile. Codex profiles are ordinary profile ids whose provider
is the resolved Codex home (`codex-home-<first 12 hex of sha256>`), so a
home limit cools every profile on it; `sessionBudgetExceeded` cools its
profile alone. When the turn handling a message fails that way, the
message is:

- **parked** on the same agent, with a resume message scheduled at the reset;
  the agent shows as paused and takes no group mail; a successful turn (yours
  or the resume) unparks it; after three parks the work is released;
- **released** back to the group queue; a session with no group keeps its
  direct work queued for the same session at the reset time;
- **forwarded** with a handoff package (progress digest, last error, claim
  commit, and an instruction to inspect `git status`/`git diff` first); it
  never routes back to the limited profile, nor to any other model of its
  provider while that provider cools — a **Hand off** to such a session is
  refused — and the original agent is told who took over once its provider
  recovers.

A reset that has already passed retries work immediately without marking the
agent paused. An unrelated peer message does not cancel parked work's resume.

Parked work can be handed to a group or a session on another profile with
**Hand off** in the Mailbox panel. An archived session is restored before
receiving a handoff. Handoffs continue the original thread without consuming
another reply hop. Invalid automatic targets fall back to the same group.
Urgent direct mail to an agent whose profile is cooling is refused with the
cooldown end time, naming the provider when its cooldown decided ("runs on
profile `glm-flash` of provider `zai`, which is cooling down after a provider
limit until …"); normal direct mail waits in the queue until recovery.

### Credit limits (HTTP 402)

A request that fails with HTTP 402 (payment required — OpenRouter's "This
request requires more credits", any prepaid gateway's empty balance) is a
final limit in the `credit` window, whatever error class the agent reports,
with no reset. It cools the provider for at most one hour. The first usage
pull after the event only sets the baseline — a 402 can leave a few cents
that cannot cover a request, and readings from before the event are ignored.
The cooldown ends earlier once a later pull reports more remaining credit
than the lowest earlier post-event pull. Tracking starts when the process
records the event and lives in memory only: an event loaded after a restart
ends at the plain hour, whatever later pulls report. (The OpenRouter usage
pull that feeds them arrives with the provider usage adapter.)

Waiting creates no credit, so credit-limited work is never parked: it takes
the group's `otherwise` outcome (forward, the default, or release) even when
`parkIfResetWithin` would cover the hour, and a rule's `park` answer is read
as `otherwise` too. A credit limit in a turn the agent started itself leaves
its work where it is. Waiting reasons say the provider is out of credit and
when it is retried at the latest, and urgent direct mail is refused with "…
which is out of credit; its cooldown ends by … at the latest."


## Worker choice

Group mail can name the worker it should run on: a provider id (any of that
provider's models the group lists) or `provider/model`. The row stores the
canonical selector in `worker_choice`; it is resolved to the group's model
keys on every pass, so a group edit applies the way any other group edit
does. While it is set:

- **Filter.** Members and spawn slots on other workers are never candidates;
  the filter runs before any rule, so a rule's pick outside it is unknown and
  falls back to the built-in strategy. With a plan role's `allowed_profiles`
  the candidates are the intersection, in the role's order — a choice never
  widens a role. A member inside the role but off the choice reports
  `worker-choice`; one outside the role reports `outside-role`.
- **Holds.** Caps and worktree occupancy still apply: a capped chosen worker
  waits (the reason gives `profile-cap` for it, plus `worker-choice`) instead
  of spawning elsewhere. When every allowed candidate is cooling, the mail
  waits with `worker-choice` naming the selector and the cooldown end as its
  retry time, and routes then with no other change.
- **Forwards.** A limit forward drops the choice; its exclusion of the limited
  profile governs, so the work is not left waiting out that provider's reset.
  A release returns the original message to its group with the choice intact.

Rules see the choice as `ctx.message.worker` (absent without one), in both
`route` and `onLimit`. For example, pinned work prefers an idle member over a
spawn, and a limit on pinned work releases it to wait for its worker:

```ts
import type { RoutingRule } from './kawai-routing'

const rule: RoutingRule = {
  route(ctx) {
    if (!ctx.message.worker) return { type: 'default' }
    // The candidates are already limited to the chosen worker.
    const member = ctx.candidates.find(c => c.kind === 'member')
    return member ? { type: 'pick', candidateId: member.id } : { type: 'default' }
  },
  onLimit(event) {
    return event.message.worker ? { type: 'release' } : { type: 'default' }
  },
}
export default rule
```

## Plan roles and author tags

Mail Kawai dispatches for a plan execution carries the plan role's profiles
in the row's `allowed_profiles` (JSON, in the role's order — the system
sender only; an agent or the human cannot set it). While the list is set:

- members and spawn slots on a profile outside the list are never candidates
  (the waiting reason names the cause `outside-role`, reading "plan role
  allows only …");
- spawn slots are offered only for profiles that are both on the list and
  allowed by the group, in the role's order;
- `profile-order` ranks candidates by the role's order, not the group's;
- a forward keeps the list without the profile that hit the limit, so the
  replacement stays inside the role.

Review handoffs Kawai dispatches carry one `author-profile:<id>` tag per
profile that authored a result of the change, so a rule can send the review
to another model family — e.g. pick the first candidate whose profile is
not in the tags' authors:

```ts
export default {
  async route(ctx) {
    const authors = new Set((ctx.message.tags ?? [])
      .filter(tag => tag.startsWith('author-profile:'))
      .map(tag => tag.replace('author-profile:', '')))
    const pick = ctx.candidates.find(c => !authors.has(c.profileId))
    return pick ? { type: 'pick', candidateId: pick.id } : { type: 'default' }
  },
}
```

Without a rule the tags are metadata only: the built-in strategy routes the
review as usual and the tags show on the mailbox row.
