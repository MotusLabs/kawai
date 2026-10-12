// Remote session service: owns the SSH/tmux control plane (runTmux/runSsh),
// the remote poller and its host-status broadcast, the optimistic
// protection/tombstone/override maps the refresh merge consumes, and remote
// session creation. Lifted verbatim from index.ts; the maps are exposed
// read-only-by-reference so the session ops handlers can record optimistic
// kills and renames against the same state the merge reads.
import type { ServerWebSocket } from 'bun'
import { config, isValidHostname } from '../config'
import { logger } from '../logger'
import { composeAutoStartCommand } from '../applyCommand'
import { normalizePaneStartCommand } from '../agentDetection'
import { generateSessionName } from '../nameGenerator'
import { shellQuote } from '../shellQuote'
import { stampLocalSessions } from '../sessionStamp'
import {
  RemoteSessionPoller,
  splitSshOptions,
  buildRemoteSessionId,
} from '../remoteSessions'
import { buildTmuxFormat, splitTmuxFields } from '../tmuxFormat'
import { normalizeCapturedHistory } from '../terminal/tmuxText'
import type { HostStatus, ServerMessage, Session, AutoStartAgent } from '../../shared/types'
import type { WSData } from '../ws/wsTypes'
import type { SessionRegistry } from '../SessionRegistry'
import type { RemoteCommandResult } from '../sessions/context'

// TTLs for the optimistic protection/tombstone/override maps (see the fields below).
const PROTECTED_REMOTE_SESSION_TTL_MS = 30_000
const REMOTE_SESSION_MUTATION_TTL_MS = 30_000

export interface RemoteSessionServiceOptions {
  registry: SessionRegistry
  broadcast: (message: ServerMessage) => void
  send: (ws: ServerWebSocket<WSData>, message: ServerMessage) => void
}

export class RemoteSessionService {
  private readonly registry: RemoteSessionServiceOptions['registry']
  private readonly broadcast: RemoteSessionServiceOptions['broadcast']
  private readonly send: RemoteSessionServiceOptions['send']
  private readonly poller: RemoteSessionPoller | null
  // Captured at construction, as index.ts captured it at module evaluation.
  private readonly localHostLabel = config.hostLabel

  // Remote session create is optimistic (we broadcast `session-created` immediately),
  // but the remote poller snapshot can lag behind. Protect newly-created remote ids
  // so refresh cycles don't drop them until the poller catches up.
  readonly protectedRemoteSessionIds = new Map<string, number>()

  // Remote control operations (kill/rename) are also optimistic, but refresh cycles rebuild
  // remote sessions from the poller snapshot. Track short-lived overrides so stale snapshots
  // don't resurrect killed sessions or revert renames.
  readonly remoteSessionTombstones = new Map<string, number>()
  readonly remoteSessionNameOverrides = new Map<string, { name: string; setAt: number }>()

  private hostStatuses: HostStatus[] = []
  private hostStatusSnapshot = ''

  constructor(options: RemoteSessionServiceOptions) {
    this.registry = options.registry
    this.broadcast = options.broadcast
    this.send = options.send

    this.poller = (config.remoteHosts?.length ?? 0) > 0
      ? new RemoteSessionPoller({
          hosts: config.remoteHosts,
          pollIntervalMs: config.remotePollMs,
          timeoutMs: config.remoteTimeoutMs,
          staleAfterMs: config.remoteStaleMs,
          sshOptions: config.remoteSshOpts,
          tmuxSessionPrefix: config.tmuxSession,
          discoverPrefixes: config.discoverPrefixes,
          onUpdate: (statuses) => this.updateHostStatuses(statuses),
        })
      : null

    if (this.poller) {
      this.poller.start()
      this.updateHostStatuses(this.poller.getHostStatuses())
    } else {
      this.updateHostStatuses([])
    }
  }

  getHostStatuses(): HostStatus[] {
    return this.hostStatuses
  }

  stop(): void {
    this.poller?.stop()
  }

  private updateHostStatuses(remoteStatuses: HostStatus[]) {
    const next = [
      {
        host: this.localHostLabel,
        ok: true,
        lastUpdated: new Date().toISOString(),
      },
      ...remoteStatuses,
    ]
    const snapshot = JSON.stringify(next)
    if (snapshot === this.hostStatusSnapshot) return
    this.hostStatusSnapshot = snapshot
    this.hostStatuses = next
    this.broadcast({ type: 'host-status', hosts: this.hostStatuses })
  }

  mergeSessions(sessions: Session[]): Session[] {
    const remoteSessions = this.poller?.getSessions() ?? []
    const needsMerge =
      this.protectedRemoteSessionIds.size > 0 ||
      this.remoteSessionTombstones.size > 0 ||
      this.remoteSessionNameOverrides.size > 0
    if (!needsMerge) {
      return [...stampLocalSessions(sessions), ...remoteSessions]
    }

    const now = Date.now()
    const remoteIds = new Set(remoteSessions.map((session) => session.id))
    const remoteById = new Map(remoteSessions.map((session) => [session.id, session]))
    const byId = new Map(this.registry.getAll().map((session) => [session.id, session]))
    const protectedSessions: Session[] = []

    for (const [id, killedAt] of this.remoteSessionTombstones) {
      if (now - killedAt > REMOTE_SESSION_MUTATION_TTL_MS) {
        this.remoteSessionTombstones.delete(id)
        continue
      }
      if (!remoteIds.has(id)) {
        // Poller has confirmed it's gone; no longer needs a tombstone.
        this.remoteSessionTombstones.delete(id)
      }
    }

    for (const [id, override] of this.remoteSessionNameOverrides) {
      if (now - override.setAt > REMOTE_SESSION_MUTATION_TTL_MS) {
        this.remoteSessionNameOverrides.delete(id)
        continue
      }
      const polled = remoteById.get(id)
      if (!polled) {
        // Session disappeared (killed/host stale); stop overriding.
        this.remoteSessionNameOverrides.delete(id)
        continue
      }
      if (polled.name === override.name) {
        // Poller has picked up the rename.
        this.remoteSessionNameOverrides.delete(id)
      }
    }

    for (const [id, addedAt] of this.protectedRemoteSessionIds) {
      if (now - addedAt > PROTECTED_REMOTE_SESSION_TTL_MS) {
        this.protectedRemoteSessionIds.delete(id)
        continue
      }
      if (remoteIds.has(id)) {
        // Poller has discovered it; no longer needs protection.
        this.protectedRemoteSessionIds.delete(id)
        continue
      }
      const existing = byId.get(id)
      if (existing?.remote) {
        protectedSessions.push(existing)
      } else {
        // Session disappeared from registry (killed/failed); stop protecting it.
        this.protectedRemoteSessionIds.delete(id)
      }
    }

    const mergedRemote: Session[] = []
    for (const session of remoteSessions) {
      const killedAt = this.remoteSessionTombstones.get(session.id)
      if (killedAt && now - killedAt <= REMOTE_SESSION_MUTATION_TTL_MS) {
        continue
      }
      const override = this.remoteSessionNameOverrides.get(session.id)
      if (override && now - override.setAt <= REMOTE_SESSION_MUTATION_TTL_MS) {
        mergedRemote.push({ ...session, name: override.name })
      } else {
        mergedRemote.push(session)
      }
    }

    return [...stampLocalSessions(sessions), ...protectedSessions, ...mergedRemote]
  }

  sshOptions(): string[] {
    return [
      '-o', 'BatchMode=yes',
      '-o', 'ConnectTimeout=3',
      // Avoid using stale multiplex control sockets for control-plane commands.
      // Users can still enable multiplexing for poller connections via ~/.ssh/config.
      '-o', 'ControlMaster=no',
      '-o', 'ControlPath=none',
      ...splitSshOptions(config.remoteSshOpts),
    ]
  }

  async runTmux(host: string, args: string[]): Promise<RemoteCommandResult> {
    const remoteCmd = `tmux -u ${args.map(a => shellQuote(a)).join(' ')}`
    const opts = this.sshOptions()
    const proc = Bun.spawn(['ssh', ...opts, host, remoteCmd], { stdout: 'pipe', stderr: 'pipe' })

    const timeout = setTimeout(() => { try { proc.kill() } catch {} }, 10_000)
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout!).text(),
        new Response(proc.stderr!).text(),
      ])
      return { exitCode, stdout, stderr }
    } finally {
      clearTimeout(timeout)
    }
  }

  async runSsh(host: string, remoteCmd: string): Promise<RemoteCommandResult> {
    const opts = this.sshOptions()
    const proc = Bun.spawn(['ssh', ...opts, host, remoteCmd], { stdout: 'pipe', stderr: 'pipe' })

    const timeout = setTimeout(() => { try { proc.kill() } catch {} }, 10_000)
    try {
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout!).text(),
        new Response(proc.stderr!).text(),
      ])
      return { exitCode, stdout, stderr }
    } finally {
      clearTimeout(timeout)
    }
  }

  async captureHistoryRemote(target: string, host: string): Promise<string | null> {
    try {
      const colorArgs = config.terminalColorsEnabled ? ['-e'] : []
      const result = await this.runTmux(host, [
        'capture-pane', '-t', target, '-p', '-J', ...colorArgs,
      ])
      if (result.exitCode !== 0) return null
      const output = result.stdout ?? ''
      if (output.trim().length === 0) return null
      return normalizeCapturedHistory(output)
    } catch {
      return null
    }
  }

  async handleCreate(
    host: string,
    projectPath: string,
    name: string | undefined,
    command: string | undefined,
    autoStartAgent: AutoStartAgent | undefined,
    autoStartChange: string | undefined,
    ws: ServerWebSocket<WSData>
  ) {
    if (!config.remoteAllowControl) {
      this.send(ws, { type: 'error', message: 'Remote session creation is disabled' })
      return
    }
    if (!isValidHostname(host)) {
      this.send(ws, { type: 'error', message: 'Invalid hostname' })
      return
    }
    if (!config.remoteHosts.includes(host)) {
      this.send(ws, { type: 'error', message: 'Host is not in the configured remote hosts list' })
      return
    }
    const trimmedPath = projectPath.trim()
    if (!trimmedPath) {
      this.send(ws, { type: 'error', message: 'Project path is required' })
      return
    }
    // Path must be absolute and not contain control characters
    if (!trimmedPath.startsWith('/')) {
      this.send(ws, { type: 'error', message: 'Project path must be an absolute path (starting with /)' })
      return
    }
    if (trimmedPath.includes('\n') || trimmedPath.includes('\r') || trimmedPath.includes('\0')) {
      this.send(ws, { type: 'error', message: 'Project path contains invalid characters' })
      return
    }

    // Validate name format if provided (same rules as rename)
    const windowName = name?.trim() || generateSessionName()
    if (name?.trim() && !/^[\w-]+$/.test(windowName)) {
      this.send(ws, { type: 'error', message: 'Name can only contain letters, numbers, hyphens, and underscores' })
      return
    }

    try {
      // Validate path exists on remote host
      const testResult = await this.runSsh(host, `test -d ${shellQuote(trimmedPath)}`)
      if (testResult.exitCode !== 0) {
        this.send(ws, { type: 'error', message: `Directory does not exist on ${host}: ${trimmedPath}` })
        return
      }

      // Check if tmux session already exists on remote
      const tmuxSession = config.tmuxSession
      const hasSessionResult = await this.runTmux(host, ['has-session', '-t', tmuxSession])
      const sessionExists = hasSessionResult.exitCode === 0

      // Same first-prompt composition as the local path: the selected agent's
      // apply prompt rides in the start command as a launch argument, so the
      // remote bash -lic wrapper re-quotes it without a pending-prompt store.
      const startCommand = composeAutoStartCommand(command, autoStartAgent, autoStartChange)
      const windowCommand = normalizePaneStartCommand(startCommand?.trim() || '') || 'claude'
      // Wrap in interactive login shell so .bashrc PATH is available
      // (non-interactive shells skip .bashrc due to [ -z "$PS1" ] && return guard).
      // Fall back to raw command on systems without bash (e.g. Alpine).
      const bashCheck = await this.runSsh(host, 'command -v bash')
      const wrappedCommand = bashCheck.exitCode === 0
        ? `bash -lic ${shellQuote(windowCommand)}`
        : windowCommand
      let createResult: { exitCode: number; stdout: string; stderr: string }

      // Launch with Claude Code fullscreen ("no-flicker") rendering enabled so its
      // mouse features work in the browser terminal. The login shell inherits the env.
      const noFlickerEnv = config.claudeNoFlicker ? ['-e', 'CLAUDE_CODE_NO_FLICKER=1'] : []

      if (sessionExists) {
        // Session exists — add a new window to it
        createResult = await this.runTmux(host, [
          'new-window', '-P',
          ...noFlickerEnv,
          '-F', buildTmuxFormat(['#{window_index}', '#{window_id}']),
          '-t', tmuxSession, '-n', windowName, '-c', trimmedPath, wrappedCommand,
        ])
      } else {
        // Session doesn't exist — create it with the desired window directly
        // (avoids an orphan window 0 from a separate new-session call)
        createResult = await this.runTmux(host, [
          'new-session', '-d', '-P',
          ...noFlickerEnv,
          '-F', buildTmuxFormat(['#{window_index}', '#{window_id}']),
          '-s', tmuxSession, '-n', windowName, '-c', trimmedPath, wrappedCommand,
        ])
      }
      if (createResult.exitCode !== 0) {
        const stderr = createResult.stderr?.trim() ?? 'Unknown error'
        this.send(ws, { type: 'error', message: `Failed to create remote window: ${stderr}` })
        return
      }

      // Parse window info from -P output (e.g. "3\t@5")
      const printOutput = createResult.stdout?.trim() ?? ''
      const parts = splitTmuxFields(printOutput, 2)
      const now = Date.now()

      if (!parts || !parts[0]) {
        this.send(ws, { type: 'error', message: 'Failed to verify remote session creation' })
        return
      }

      const windowIndex = parts[0].trim()
      const windowId = (parts[1] ?? '').trim()
      const stableTarget = windowId || windowIndex

      // Verify the window actually persists. When adding a new window to an existing session,
      // `tmux has-session -t <session>` can still succeed even if the new window exited
      // immediately (and was cleaned up by tmux).
      const verifyResult = await this.runTmux(host, ['has-session', '-t', `${tmuxSession}:${stableTarget}`])
      if (verifyResult.exitCode !== 0) {
        logger.warn('remote_window_exited_immediately', {
          host,
          tmuxSession,
          windowName,
          windowIndex,
          windowId: windowId || undefined,
          stableTarget,
          command: windowCommand,
          wrappedCommand,
        })
        this.send(ws, {
          type: 'error',
          message: `Remote window exited immediately on ${host} — command "${windowCommand}" may have failed`,
        })
        return
      }
      const id = buildRemoteSessionId(host, tmuxSession, windowIndex, windowId)
      const createdSession: Session = {
        id,
        name: windowName,
        tmuxWindow: `${tmuxSession}:${stableTarget}`,
        projectPath: trimmedPath,
        status: 'unknown',
        lastActivity: new Date(now).toISOString(),
        createdAt: new Date(now).toISOString(),
        source: 'managed',
        host,
        remote: true,
        command: windowCommand,
      }

      this.protectedRemoteSessionIds.set(createdSession.id, now)

      // Add to registry so it appears immediately
      const currentSessions = this.registry.getAll()
      this.registry.replaceSessions([createdSession, ...currentSessions])
      this.send(ws, { type: 'session-created', session: createdSession })
    } catch (error) {
      this.send(ws, {
        type: 'error',
        message: error instanceof Error ? error.message : 'Unable to create remote session',
      })
    }
  }
}
