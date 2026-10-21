import { defineConfig } from '@playwright/test'
import { accessSync, constants as fsConstants, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const port = Number(process.env.E2E_PORT) || 4173
const tmuxSession =
  process.env.E2E_TMUX_SESSION || `agentboard-e2e-${Date.now()}`

process.env.E2E_TMUX_SESSION = tmuxSession

// Run the whole suite against a private tmux server. The agentboard server
// creates per-connection grouped sessions (`<base>-ws-<uuid>`) that only its
// own dispose() or its next startup's pruner can reap; when Playwright
// SIGKILLs the webServer they used to leak onto the user's live tmux server
// (which also received the server-global set-clipboard write). With a private
// socket, teardown just kill-servers it — nothing to enumerate, nothing shared.
//
// TMUX_TMPDIR is silently ignored unless the directory exists, and an
// inherited $TMUX (suite run from inside a tmux session) overrides the socket
// choice entirely — hence the mkdir and the delete. Both propagate to the
// webServer, the test workers (paste.spec shells out to tmux), and teardown.
const tmuxTmpDir =
  process.env.E2E_TMUX_TMPDIR || join(tmpdir(), `abe2e-${Date.now()}`)
process.env.E2E_TMUX_TMPDIR = tmuxTmpDir
mkdirSync(tmuxTmpDir, { recursive: true })
process.env.TMUX_TMPDIR = tmuxTmpDir
delete process.env.TMUX

// The tmux server isn't the only shared state: without these, the e2e
// webServer opens the user's live ~/.agentboard/agentboard.db and watches
// their real Claude/Codex/Pi logs. It then rewrites each agent session's
// current_window mapping against ITS tmux view — which contains none of the
// user's windows — desyncing the live dashboard's status and last-message
// display until every session's log happens to grow again. Point all of it
// into the same throwaway directory teardown already removes. Set via
// process.env (like TMUX_TMPDIR above) so the webServer, the test workers,
// and any future setup/teardown code all see the same isolated paths.
const claudeDir = join(tmuxTmpDir, 'claude')
const codexDir = join(tmuxTmpDir, 'codex')
const piDir = join(tmuxTmpDir, 'pi')
mkdirSync(claudeDir, { recursive: true })
mkdirSync(codexDir, { recursive: true })
mkdirSync(piDir, { recursive: true })
process.env.AGENTBOARD_DB_PATH = `${tmuxTmpDir}/agentboard.db`
process.env.LOG_FILE = `${tmuxTmpDir}/agentboard.log`
process.env.AGENTBOARD_TMUX_PID_FILE = `${tmuxTmpDir}/tmux-server.pid`
process.env.CLAUDE_CONFIG_DIR = claudeDir
process.env.CODEX_HOME = codexDir
process.env.PI_HOME = piDir

// Codex e2e (codex-chat-sessions 8.1): a fake auth.json in the temporary
// codexHome — never the user's ~/.codex — passes the login gate, and the
// fake app-server stands in for the Codex executable so the carve-out
// (ChatSessionManager's codexGatesApply) runs the real Codex path and gates
// under AGENTBOARD_CHAT_FIXTURE. The spec writes FAKE_TRANSCRIPT before
// creating its chat; every new app-server child replays run 1 of it. Specs
// that never write the file make any Codex child they start exit at once —
// harmless for their header-only assertions.
writeFileSync(join(codexDir, 'auth.json'), JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: 'fake' } }))
process.env.KAWAI_CODEX_PATH = fileURLToPath(new URL('./tests/fixtures/fake-codex-app-server.ts', import.meta.url))
process.env.FAKE_TRANSCRIPT = join(tmuxTmpDir, 'codex-transcript.jsonl')

// A fake remote host so the Remote pane can render rows in e2e. The real
// poller shells out to `ssh <host> tmux -u list-windows ...`; this stub on
// the webServer's PATH answers listing queries for E2E_REMOTE_HOST with a
// batch of tab-separated windows (the managed session name arrives via
// $TMUX_SESSION, inherited from the server process). Every other ssh use —
// pane capture, unknown hosts — fails like an unreachable host would.
const remoteHost = 'e2e-fake-box'
const stubBinDir = join(tmuxTmpDir, 'stub-bin')
mkdirSync(stubBinDir, { recursive: true })
// plan-validation e2e: a stub OpenSpec CLI the SERVER's adapter spawns. It
// answers ONLY the calls the validation adapter makes — the probe
// (--version), strict validate, and show-deltas, the last serving canned
// deltas per change from a JSON file the spec rewrites between steps. Every
// other invocation execs the REAL openspec with the original args: the
// stub-bin dir is first on the SERVER's PATH for every spec, so workspace
// discovery (`openspec list --json`) and anything else must keep working,
// or change sections vanish from every e2e (CI caught exactly that). The
// real executable is resolved from PATH as it is BEFORE stubBinDir is
// prefixed; with no real CLI installed, the fallback keeps today's
// unknown-command failure rather than looping back into the stub.
const realOpenspec = (() => {
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    if (dir === stubBinDir) continue
    const candidate = join(dir, 'openspec')
    try {
      accessSync(candidate, fsConstants.X_OK)
      return realpathSync(candidate)
    } catch {
      // not present or not executable in this directory
    }
  }
  return null
})()
writeFileSync(
  join(stubBinDir, 'openspec'),
  [
    '#!/bin/sh',
    '# e2e stub: only the validation adapter calls are canned; everything',
    '# else must reach the real openspec (workspace discovery depends on it).',
    'case "$1" in',
    '  --version)',
    '    echo "1.14.2"',
    '    exit 0',
    '    ;;',
    '  validate)',
    `    change="$2"`,
    `    printf '{"items":[{"id":"%s","type":"change","valid":true,"issues":[]}],"summary":{}}' "$change"`,
    '    exit 0',
    '    ;;',
    '  show)',
    `    change="$2"`,
    `    deltas="$(cat '${join(tmuxTmpDir, 'openspec-deltas')}'/"$change".json 2>/dev/null || echo '[]')"`,
    `    printf '{"id":"%s","deltas":%s}' "$change" "$deltas"`,
    '    exit 0',
    '    ;;',
    'esac',
    realOpenspec
      ? `exec '${realOpenspec}' "$@"`
      : [
          'printf "unknown command" >&2',
          'exit 2',
        ].join('\n'),
  ].join('\n'),
  { mode: 0o755 },
)
writeFileSync(
  join(stubBinDir, 'ssh'),
  [
    '#!/bin/sh',
    '# e2e stub: answers tmux window listings for the fake remote host',
    'for arg in "$@"; do',
    '  case "$arg" in',
    '    *list-windows*)',
    '      i=0',
    `      while [ "$i" -lt 16 ]; do`,
    '        printf \'%s\\t%s\\t@%s\\tremote-agent-%s\\t/home/agent/project-%s\\t1700000000\\t1700000000\\tclaude\\n\' "$TMUX_SESSION" "$i" "$i" "$i" "$i"',
    '        i=$((i + 1))',
    '      done',
    '      exit 0',
    '      ;;',
    '  esac',
    'done',
    'exit 255',
    '',
  ].join('\n'),
  { mode: 0o755 }
)

export default defineConfig({
  testDir: 'tests/e2e',
  // HTML report only in CI: ci.yml uploads playwright-report/ when the suite
  // fails. Locally a report dir nobody reads is just clutter, so stdout only.
  reporter: process.env.CI ? [['dot'], ['html', { open: 'never' }]] : 'list',
  timeout: 30000,
  expect: {
    timeout: 5000,
  },
  use: {
    baseURL: `http://localhost:${port}`,
    headless: true,
  },
  webServer: {
    // AGENTBOARD_STATIC_DIR is pinned to the repo build: when e2e runs from a
    // shell inside a live agentboard session, the inherited env points at the
    // installed npm package's bundle and the tests would exercise stale code.
    // AGENTBOARD_REMOTE_HOSTS + the stub-bin PATH front give the Remote pane
    // its sessions (see the ssh stub above). A fresh server is required for
    // those to be active — with reuseExistingServer an older server may
    // answer without them; run on a fresh E2E_PORT when that bites.
    // Auth is pinned empty so the suite is hermetic: bun auto-loads the repo's
    // .env, which may carry a real CLAUDE_CODE_OAUTH_TOKEN, and that would make
    // chat creation silently succeed against the developer's own credentials.
    // Chat tests that need a working backend opt in via AGENTBOARD_CHAT_FIXTURE,
    // which injects its own authCheck. chat-real.spec.ts spawns its own server
    // and is unaffected.
    command: `[ -d dist/client ] || bun run build && PATH=${stubBinDir}:$PATH LC_ALL=C LANG=C PORT=${port} TMUX_SESSION=${tmuxSession} AGENTBOARD_REMOTE_HOSTS=${remoteHost} AGENTBOARD_STATIC_DIR=dist/client CLAUDE_CODE_OAUTH_TOKEN= ANTHROPIC_API_KEY= bun src/server/index.ts`,
    url: `http://localhost:${port}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120000,
  },
  globalSetup: './tests/e2e/setup.ts',
  globalTeardown: './tests/e2e/teardown.ts',
})
