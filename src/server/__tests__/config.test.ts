import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import os from 'node:os'
import path from 'node:path'

const ORIGINAL_ENV = {
  PORT: process.env.PORT,
  HOSTNAME: process.env.HOSTNAME,
  TMUX_SESSION: process.env.TMUX_SESSION,
  REFRESH_INTERVAL_MS: process.env.REFRESH_INTERVAL_MS,
  DISCOVER_PREFIXES: process.env.DISCOVER_PREFIXES,
  PRUNE_WS_SESSIONS: process.env.PRUNE_WS_SESSIONS,
  TERMINAL_MODE: process.env.TERMINAL_MODE,
  TERMINAL_MONITOR_TARGETS: process.env.TERMINAL_MONITOR_TARGETS,
  TLS_CERT: process.env.TLS_CERT,
  TLS_KEY: process.env.TLS_KEY,
  AGENTBOARD_LOG_POLL_MS: process.env.AGENTBOARD_LOG_POLL_MS,
  AGENTBOARD_LOG_POLL_MAX: process.env.AGENTBOARD_LOG_POLL_MAX,
  AGENTBOARD_RG_THREADS: process.env.AGENTBOARD_RG_THREADS,
  AGENTBOARD_LOG_MATCH_WORKER: process.env.AGENTBOARD_LOG_MATCH_WORKER,
  AGENTBOARD_LOG_MATCH_PROFILE: process.env.AGENTBOARD_LOG_MATCH_PROFILE,
  AGENTBOARD_LOG_WATCH_MODE: process.env.AGENTBOARD_LOG_WATCH_MODE,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CODEX_HOME: process.env.CODEX_HOME,
  CLAUDE_RESUME_CMD: process.env.CLAUDE_RESUME_CMD,
  CODEX_RESUME_CMD: process.env.CODEX_RESUME_CMD,
  PI_RESUME_CMD: process.env.PI_RESUME_CMD,
  AGENTBOARD_HOST: process.env.AGENTBOARD_HOST,
  AGENTBOARD_REMOTE_HOSTS: process.env.AGENTBOARD_REMOTE_HOSTS,
  AGENTBOARD_REMOTE_POLL_MS: process.env.AGENTBOARD_REMOTE_POLL_MS,
  AGENTBOARD_REMOTE_TIMEOUT_MS: process.env.AGENTBOARD_REMOTE_TIMEOUT_MS,
  AGENTBOARD_REMOTE_STALE_MS: process.env.AGENTBOARD_REMOTE_STALE_MS,
  AGENTBOARD_REMOTE_SSH_OPTS: process.env.AGENTBOARD_REMOTE_SSH_OPTS,
  AGENTBOARD_REMOTE_ALLOW_CONTROL: process.env.AGENTBOARD_REMOTE_ALLOW_CONTROL,
  AGENTBOARD_TMUX_TIMEOUT_MS: process.env.AGENTBOARD_TMUX_TIMEOUT_MS,
  AGENTBOARD_TMUX_MUTATION_TIMEOUT_MS: process.env.AGENTBOARD_TMUX_MUTATION_TIMEOUT_MS,
  AGENTBOARD_PASTE_IMAGE_MAX_BYTES: process.env.AGENTBOARD_PASTE_IMAGE_MAX_BYTES,
  AGENTBOARD_PROJECT_DIR: process.env.AGENTBOARD_PROJECT_DIR,
  AGENTBOARD_CHAT_ENV: process.env.AGENTBOARD_CHAT_ENV,
  AGENTBOARD_WS_DEFLATE: process.env.AGENTBOARD_WS_DEFLATE,
  AGENTBOARD_LOG_MATCH_YIELD_MS: process.env.AGENTBOARD_LOG_MATCH_YIELD_MS,
}

const ENV_KEYS = Object.keys(ORIGINAL_ENV) as Array<keyof typeof ORIGINAL_ENV>

function restoreEnv() {
  for (const key of ENV_KEYS) {
    const value = ORIGINAL_ENV[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

async function loadConfig(tag: string) {
  const modulePath = `../config?${tag}`
  const module = await import(modulePath)
  return module.config as {
    port: number
    hostname: string
    tmuxSession: string
    refreshIntervalMs: number
    discoverPrefixes: string[]
    pruneWsSessions: boolean
    terminalMode: string
    terminalMonitorTargets: boolean
    terminalColorsEnabled: boolean
    tlsCert: string
    tlsKey: string
    logPollIntervalMs: number
    logPollMax: number
    rgThreads: number
    logMatchWorker: boolean
    logMatchProfile: boolean
    logWatchMode: 'watch' | 'poll'
    claudeConfigDir: string
    codexHomeDir: string
    claudeResumeCmd: string
    codexResumeCmd: string
    piResumeCmd: string
    hostLabel: string
    remoteHosts: string[]
    remotePollMs: number
    remoteTimeoutMs: number
    remoteStaleMs: number
    remoteSshOpts: string
    remoteAllowControl: boolean
    tmuxTimeoutMs: number
    tmuxMutationTimeoutMs: number
    pasteImageMaxBytes: number
    defaultProjectDir: string
    chatProviderEnv: Record<string, string>
    wsPerMessageDeflate: boolean
    logMatchYieldMs: number
  }
}

afterEach(() => {
  restoreEnv()
})

describe('config', () => {
  test('uses defaults when env is unset', async () => {
    for (const key of ENV_KEYS) {
      delete process.env[key]
    }

    const config = await loadConfig('defaults')
    expect(config.port).toBe(4040)
    expect(config.hostname).toBe('127.0.0.1')
    expect(config.tmuxSession).toBe('agentboard')
    expect(config.refreshIntervalMs).toBe(2000)
    expect(config.discoverPrefixes).toEqual([])
    expect(config.pruneWsSessions).toBe(true)
    expect(config.terminalMode).toBe('pty')
    expect(config.terminalMonitorTargets).toBe(true)
    expect(config.terminalColorsEnabled).toBe(true)
    expect(config.tlsCert).toBe('')
    expect(config.tlsKey).toBe('')
    expect(config.logPollIntervalMs).toBe(5000)
    expect(config.logPollMax).toBe(25)
    expect(config.rgThreads).toBe(1)
    expect(config.logMatchWorker).toBe(true)
    expect(config.logMatchProfile).toBe(false)
    expect(config.logWatchMode).toBe('watch')
    expect(config.claudeResumeCmd).toBe('claude --resume {sessionId}')
    expect(config.codexResumeCmd).toBe('codex resume {sessionId}')
    expect(config.piResumeCmd).toBe('pi --session {logFilePath}')
    expect(config.hostLabel).toBe(os.hostname())
    expect(config.remoteHosts).toEqual([])
    expect(config.remotePollMs).toBe(2000)
    expect(config.remoteTimeoutMs).toBe(4000)
    expect(config.remoteStaleMs).toBe(15000)
    expect(config.remoteSshOpts).toBe('')
    expect(config.remoteAllowControl).toBe(false)
    expect(config.tmuxTimeoutMs).toBe(3000)
    expect(config.tmuxMutationTimeoutMs).toBe(15000)
    expect(config.pasteImageMaxBytes).toBe(40 * 1024 * 1024)
    expect(config.defaultProjectDir).toBe('')
  })

  test('parses env overrides and trims discover prefixes', async () => {
    process.env.PORT = '9090'
    process.env.HOSTNAME = '127.0.0.1'
    process.env.TMUX_SESSION = 'demo'
    process.env.REFRESH_INTERVAL_MS = '3000'
    process.env.DISCOVER_PREFIXES = ' alpha, beta ,,gamma '
    process.env.PRUNE_WS_SESSIONS = 'false'
    process.env.TERMINAL_MODE = 'pipe-pane'
    process.env.TERMINAL_MONITOR_TARGETS = 'false'
    process.env.TLS_CERT = '/tmp/cert.pem'
    process.env.TLS_KEY = '/tmp/key.pem'
    process.env.AGENTBOARD_LOG_POLL_MS = '7000'
    process.env.AGENTBOARD_LOG_POLL_MAX = '123'
    process.env.AGENTBOARD_RG_THREADS = '4'
    process.env.AGENTBOARD_LOG_MATCH_WORKER = 'false'
    process.env.AGENTBOARD_LOG_MATCH_PROFILE = 'true'
    process.env.AGENTBOARD_LOG_WATCH_MODE = 'poll'
    process.env.CLAUDE_CONFIG_DIR = '/tmp/claude'
    process.env.CODEX_HOME = '/tmp/codex'
    process.env.CLAUDE_RESUME_CMD = 'claude --resume={sessionId}'
    process.env.CODEX_RESUME_CMD = 'codex --resume={sessionId}'
    process.env.PI_RESUME_CMD = 'pi --session={logFilePath}'
    process.env.AGENTBOARD_HOST = 'blade'
    process.env.AGENTBOARD_REMOTE_HOSTS = 'mba,carbon,worm'
    process.env.AGENTBOARD_REMOTE_POLL_MS = '12000'
    process.env.AGENTBOARD_REMOTE_TIMEOUT_MS = '9000'
    process.env.AGENTBOARD_REMOTE_STALE_MS = '50000'
    process.env.AGENTBOARD_REMOTE_SSH_OPTS = '-o StrictHostKeyChecking=accept-new'
    process.env.AGENTBOARD_REMOTE_ALLOW_CONTROL = 'true'
    process.env.AGENTBOARD_TMUX_TIMEOUT_MS = '4500'
    process.env.AGENTBOARD_TMUX_MUTATION_TIMEOUT_MS = '12000'
    process.env.AGENTBOARD_PASTE_IMAGE_MAX_BYTES = '4096'

    const config = await loadConfig('overrides')
    expect(config.port).toBe(9090)
    expect(config.hostname).toBe('127.0.0.1')
    expect(config.tmuxSession).toBe('demo')
    expect(config.refreshIntervalMs).toBe(3000)
    expect(config.discoverPrefixes).toEqual(['alpha', 'beta', 'gamma'])
    expect(config.pruneWsSessions).toBe(false)
    expect(config.terminalMode).toBe('pipe-pane')
    expect(config.terminalMonitorTargets).toBe(false)
    expect(config.tlsCert).toBe('/tmp/cert.pem')
    expect(config.tlsKey).toBe('/tmp/key.pem')
    expect(config.logPollIntervalMs).toBe(7000)
    expect(config.logPollMax).toBe(123)
    expect(config.rgThreads).toBe(4)
    expect(config.logMatchWorker).toBe(false)
    expect(config.logMatchProfile).toBe(true)
    expect(config.logWatchMode).toBe('poll')
    expect(config.claudeConfigDir).toBe('/tmp/claude')
    expect(config.codexHomeDir).toBe('/tmp/codex')
    expect(config.claudeResumeCmd).toBe('claude --resume={sessionId}')
    expect(config.codexResumeCmd).toBe('codex --resume={sessionId}')
    expect(config.piResumeCmd).toBe('pi --session={logFilePath}')
    expect(config.hostLabel).toBe('blade')
    expect(config.remoteHosts).toEqual(['mba', 'carbon', 'worm'])
    expect(config.remotePollMs).toBe(12000)
    expect(config.remoteTimeoutMs).toBe(9000)
    expect(config.remoteStaleMs).toBe(50000)
    expect(config.remoteSshOpts).toBe('-o StrictHostKeyChecking=accept-new')
    expect(config.remoteAllowControl).toBe(true)
    expect(config.tmuxTimeoutMs).toBe(4500)
    expect(config.tmuxMutationTimeoutMs).toBe(12000)
    expect(config.pasteImageMaxBytes).toBe(4096)
  })

  test('ignores ambient HOSTNAME that echoes the machine hostname', async () => {
    process.env.HOSTNAME = os.hostname()
    delete process.env.AGENTBOARD_REMOTE_HOSTS
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const config = await loadConfig('ambient-hostname')
      expect(config.hostname).toBe('127.0.0.1')
      expect(warnSpy).toHaveBeenCalledTimes(1)
    } finally {
      warnSpy.mockRestore()
    }
  })

  test('treats empty HOSTNAME as unset', async () => {
    process.env.HOSTNAME = ''

    const config = await loadConfig('empty-hostname')
    expect(config.hostname).toBe('127.0.0.1')
  })

  test('wsPerMessageDeflate defaults to false and only literal true enables it', async () => {
    delete process.env.AGENTBOARD_WS_DEFLATE
    expect((await loadConfig('deflate-default')).wsPerMessageDeflate).toBe(false)

    process.env.AGENTBOARD_WS_DEFLATE = 'true'
    expect((await loadConfig('deflate-true')).wsPerMessageDeflate).toBe(true)

    for (const junk of ['TRUE', '1', 'yes', 'on', ' false', '']) {
      process.env.AGENTBOARD_WS_DEFLATE = junk
      expect((await loadConfig(`deflate-junk-${junk || 'empty'}`)).wsPerMessageDeflate).toBe(false)
    }
  })

  test('logMatchYieldMs defaults to 25 and clamps to 0-250', async () => {
    delete process.env.AGENTBOARD_LOG_MATCH_YIELD_MS
    expect((await loadConfig('yield-default')).logMatchYieldMs).toBe(25)

    process.env.AGENTBOARD_LOG_MATCH_YIELD_MS = '0'
    expect((await loadConfig('yield-zero')).logMatchYieldMs).toBe(0)

    process.env.AGENTBOARD_LOG_MATCH_YIELD_MS = '80'
    expect((await loadConfig('yield-80')).logMatchYieldMs).toBe(80)

    process.env.AGENTBOARD_LOG_MATCH_YIELD_MS = '9999'
    expect((await loadConfig('yield-high')).logMatchYieldMs).toBe(250)

    process.env.AGENTBOARD_LOG_MATCH_YIELD_MS = '-5'
    expect((await loadConfig('yield-negative')).logMatchYieldMs).toBe(0)

    process.env.AGENTBOARD_LOG_MATCH_YIELD_MS = 'junk'
    expect((await loadConfig('yield-junk')).logMatchYieldMs).toBe(25)
  })

  test('honors deliberately set HOSTNAME values', async () => {
    process.env.HOSTNAME = '0.0.0.0'
    delete process.env.AGENTBOARD_REMOTE_HOSTS
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

    try {
      const config = await loadConfig('deliberate-hostname')
      expect(config.hostname).toBe('0.0.0.0')
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  test('keeps honoring HOSTNAME=localhost', async () => {
    process.env.HOSTNAME = 'localhost'

    const config = await loadConfig('localhost-hostname')
    expect(config.hostname).toBe('localhost')
  })

  test('defaults to watch mode for invalid AGENTBOARD_LOG_WATCH_MODE', async () => {
    process.env.AGENTBOARD_LOG_WATCH_MODE = 'invalid'

    const config = await loadConfig('invalid-watch-mode')
    expect(config.logWatchMode).toBe('watch')
  })

  test('falls back to default paste image cap for invalid values', async () => {
    process.env.AGENTBOARD_PASTE_IMAGE_MAX_BYTES = '0'
    expect((await loadConfig('paste-zero')).pasteImageMaxBytes).toBe(40 * 1024 * 1024)

    process.env.AGENTBOARD_PASTE_IMAGE_MAX_BYTES = '-1'
    expect((await loadConfig('paste-negative')).pasteImageMaxBytes).toBe(40 * 1024 * 1024)

    process.env.AGENTBOARD_PASTE_IMAGE_MAX_BYTES = 'lots'
    expect((await loadConfig('paste-nan')).pasteImageMaxBytes).toBe(40 * 1024 * 1024)

    process.env.AGENTBOARD_PASTE_IMAGE_MAX_BYTES = '1024.9'
    expect((await loadConfig('paste-fractional')).pasteImageMaxBytes).toBe(1024)
  })

  test('resolves AGENTBOARD_PROJECT_DIR to an absolute path', async () => {
    process.env.AGENTBOARD_PROJECT_DIR = '  /srv/work/projects  '

    const config = await loadConfig('project-dir-absolute')
    expect(config.defaultProjectDir).toBe('/srv/work/projects')
  })

  test('expands a leading ~ in AGENTBOARD_PROJECT_DIR', async () => {
    const home = process.env.HOME || process.env.USERPROFILE || ''
    process.env.AGENTBOARD_PROJECT_DIR = '~/work'

    const config = await loadConfig('project-dir-tilde')
    expect(config.defaultProjectDir).toBe(path.join(home, 'work'))
  })

  test('treats a blank AGENTBOARD_PROJECT_DIR as unset', async () => {
    process.env.AGENTBOARD_PROJECT_DIR = '   '

    const config = await loadConfig('project-dir-blank')
    expect(config.defaultProjectDir).toBe('')
  })

  test('chatProviderEnv is empty when AGENTBOARD_CHAT_ENV is unset', async () => {
    delete process.env.AGENTBOARD_CHAT_ENV
    expect((await loadConfig('chat-env-unset')).chatProviderEnv).toEqual({})
  })

  test('parses AGENTBOARD_CHAT_ENV into chatProviderEnv', async () => {
    process.env.AGENTBOARD_CHAT_ENV =
      'ANTHROPIC_BASE_URL=https://gw.example/anthropic;ANTHROPIC_MODEL=gw-pro'
    expect((await loadConfig('chat-env-set')).chatProviderEnv).toEqual({
      ANTHROPIC_BASE_URL: 'https://gw.example/anthropic',
      ANTHROPIC_MODEL: 'gw-pro',
    })
  })
})
