// updateRestart.ts - restart the running deployment through whichever
// supervisor launched it, so a completed update actually takes over: the
// systemd unit for a systemd deployment, the launchd agent for a launchd
// deployment, and a detached re-exec of the new binary otherwise. The bare
// wrapper sleeps briefly before exec so the exiting process releases the
// port first; a failed restart surfaces a named error instead of leaving a
// swapped install that keeps serving the old build.

import { UpdateError } from './updateErrors'

export type RestartMode = 'systemd' | 'launchd' | 'bare'

export interface RestartContext {
  mode: RestartMode
  /** Unit to restart when running under systemd. */
  systemdUnit?: string
  /** Agent label to kick when running under launchd. */
  launchdLabel?: string
}

/**
 * Which supervisor launched this process. systemd sets `$INVOCATION_ID` for
 * every unit invocation; launchd provides the agent label as
 * `$XPC_SERVICE_NAME`. Installers may pin the exact unit/label through the
 * AGENTBOARD_* overrides when a deployment renames them.
 */
export function detectRestartContext(env: NodeJS.ProcessEnv = process.env): RestartContext {
  if (env.INVOCATION_ID !== undefined && env.INVOCATION_ID !== '') {
    return { mode: 'systemd', systemdUnit: env.AGENTBOARD_SYSTEMD_UNIT || 'agentboard.service' }
  }
  if (typeof env.XPC_SERVICE_NAME === 'string' && env.XPC_SERVICE_NAME !== '') {
    return { mode: 'launchd', launchdLabel: env.AGENTBOARD_LAUNCHD_LABEL || env.XPC_SERVICE_NAME }
  }
  return { mode: 'bare' }
}

/** The unit file the systemd installer generates (see systemd/install.sh). */
export const DEFAULT_SYSTEMD_UNIT = 'agentboard.service'
/** The agent label the launchd installer generates (see launchd/install.sh). */
export const DEFAULT_LAUNCHD_LABEL = 'com.agentboard'

export interface PlanRestartOptions {
  execPath?: string
  argv?: string[]
  uid?: number | null
  /** Grace period before a bare re-exec, so the old process releases the port. */
  bareDelayMs?: number
}

export interface RestartPlan {
  mode: RestartMode
  command: string[]
  /** True when this process exits after spawning the successor (bare mode). */
  exitsAfterSpawn: boolean
}

/** Select the restart verb for a context; pure, for unit testing. */
export function planRestart(
  context: RestartContext,
  options: PlanRestartOptions = {},
): RestartPlan {
  const uid = options.uid !== undefined && options.uid !== null ? options.uid : process.getuid?.() ?? 0
  const { execPath = process.execPath, argv = process.argv.slice(1), bareDelayMs = 750 } = options
  switch (context.mode) {
    case 'systemd':
      return {
        mode: 'systemd',
        command: ['systemctl', '--user', 'restart', context.systemdUnit ?? DEFAULT_SYSTEMD_UNIT],
        exitsAfterSpawn: false,
      }
    case 'launchd':
      return {
        mode: 'launchd',
        command: ['launchctl', 'kickstart', '-k', `gui/${uid}/${context.launchdLabel ?? DEFAULT_LAUNCHD_LABEL}`],
        exitsAfterSpawn: false,
      }
    case 'bare':
      return {
        mode: 'bare',
        // Detached successor: wait out the old process's teardown, then exec
        // the (already swapped) binary in its place.
        command: ['sh', '-c', `sleep ${Math.max(0, bareDelayMs) / 1000}; exec "$0" "$@"`, execPath, ...argv],
        exitsAfterSpawn: true,
      }
  }
}

export interface SpawnResult {
  exitCode: number | null
  stderr: string
}

export type RestartSpawner = (command: string[]) => Promise<SpawnResult>

async function spawnForRestart(command: string[]): Promise<SpawnResult> {
  const proc = Bun.spawn(command, {
    env: process.env,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'pipe',
  })
  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr as ReadableStream<Uint8Array> | null).text(),
    proc.exited,
  ])
  return { exitCode, stderr }
}

export interface PerformRestartOptions {
  spawn?: RestartSpawner
  /** Overridable exit for bare mode (tests). */
  exit?: (code: number) => void
}

/**
 * Run the restart plan. Under a supervisor the verb may terminate this
 * process as part of the restart — that is the expected outcome, not an
 * error. Bare mode spawns the successor and exits.
 */
export async function performRestart(
  plan: RestartPlan,
  options: PerformRestartOptions = {},
): Promise<void> {
  const spawn = options.spawn ?? spawnForRestart
  const exit = options.exit ?? ((code: number) => process.exit(code))

  let result: SpawnResult
  try {
    result = await spawn(plan.command)
  } catch (cause) {
    throw new UpdateError(
      'ERR_UPDATE_RESTART_FAILED',
      `Restarting via ${plan.mode} failed to run (${cause instanceof Error ? cause.message : String(cause)})`,
    )
  }

  if (plan.exitsAfterSpawn) {
    // The successor is on its way; step aside so it can take the port.
    exit(0)
    return
  }

  // Under a supervisor a non-zero exit means the verb itself failed (a zero
  // exit, or never returning because we were restarted, is success).
  if (result.exitCode !== 0) {
    throw new UpdateError(
      'ERR_UPDATE_RESTART_FAILED',
      `Restarting via ${plan.mode} failed (exit ${result.exitCode}${result.stderr.trim() ? `: ${result.stderr.trim()}` : ''})`,
    )
  }
}
