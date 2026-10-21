import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

// The kawai server's private tmux server (TMUX_TMPDIR points into the
// spec's root) outlives the server process, pins its cwd to this checkout,
// and so blocks `git worktree remove` until it is killed. Kill it through
// its own socket path, built from the spec's root and uid: `-S` never
// falls back to the default socket, so no other tmux server is ever
// addressed. A socket with no server just errors — spawnSync reports that
// in its result and never throws — so callers need no try/catch.
export function killPrivateTmuxServer(root: string): void {
  spawnSync('tmux', ['-S', join(root, `tmux-${process.getuid()}`, 'default'), 'kill-server'], { stdio: 'ignore' })
}
