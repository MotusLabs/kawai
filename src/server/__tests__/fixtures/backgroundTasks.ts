// Wire fixtures for background shell and Monitor tasks, captured 2026-10-13
// against the real CLI (2.1.296) through the SDK (0.3.289) with kawai's
// wireTap spawn. Each `<name>.jsonl` holds `{ dir, raw }` lines exactly as
// recorded (`in` = CLI to SDK, `out` = SDK to CLI); bulky fields of init
// frames are trimmed. Sources:
// - shell / monitor / controls: a scratch probe session that started two
//   backgrounded `Bash` calls and one `Monitor`, then read output, stopped a
//   task, and fired the Monitor trigger, capturing the self-started wake
//   turns (kept in `src/server/__tests__/fixtures/` only as trimmed copies).
// - foreground: a production chat-wire capture of a foreground `Bash` task
//   (task_started `is_backgrounded: false` + its settle notification).
//
// Empirical notes pinned by these fixtures (design.md Open Questions):
// - A Monitor's `task_started` is `task_type: "local_bash"` with
//   `is_backgrounded: true`; only the tool-call join tells it from a shell.
// - The CLI answers `get_task_output` (also while the task runs).
// - `stopTask` settles as `task_updated` `patch.status: "killed"` plus a
//   `task_notification` with `status: "stopped"`.
// - Foreground tasks emit `task_started`/`task_notification` too, so only
//   `is_backgrounded` decides visibility.
// - `session_state_changed` frames are `sdk_host_only`: the SDK consumes
//   them internally and never yields them to the message iterator. They stay
//   in the fixtures to document the wire, but `consumerMessages` drops them
//   (with control frames) to mirror what a driver's stream loop sees; a wake
//   turn's first consumer-visible frame is `system/init`.
import fs from 'node:fs'
import path from 'node:path'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'

export interface FixtureFrame {
  dir: 'in' | 'out'
  raw: string
}

const fixturesDir = import.meta.dir

/** All recorded frames of a fixture, in wire order. */
export function loadFixtureFrames(name: string): FixtureFrame[] {
  const file = path.join(fixturesDir, `backgroundTasks.${name}.jsonl`)
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as FixtureFrame)
}

/**
 * The frames a driver-side `for await` over the SDK query would see, in
 * order: CLI-to-SDK frames minus `control_*` traffic (answered inside the
 * SDK) minus `sdk_host_only` frames (consumed internally, never yielded).
 */
export function consumerMessages(name: string): SDKMessage[] {
  return loadFixtureFrames(name)
    .filter((frame) => frame.dir === 'in')
    .map((frame) => JSON.parse(frame.raw) as SDKMessage & { sdk_host_only?: boolean })
    .filter((message) => !message.type.startsWith('control_'))
    .filter((message) => message.sdk_host_only !== true)
}
