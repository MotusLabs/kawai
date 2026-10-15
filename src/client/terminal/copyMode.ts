// tmux copy-mode tracking: optimistic enter on scroll-up, debounced and
// polled status checks against the server, mouse-tracking escape writes, the
// paired exit sites, and the wheel-to-SGR scrollback forwarding that drives
// it all. The hook owns the React-facing refs and passes them in (design D2);
// the debounce/poll timers and the wheel accumulator are class-private.
import type { MutableRefObject } from 'react'
import type { Terminal } from '@xterm/xterm'
import type { SendClientMessage } from '@shared/types'

export const ENABLE_MOUSE_TRACKING = '\x1b[?1000h\x1b[?1002h\x1b[?1006h'
export const DISABLE_MOUSE_TRACKING = '\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l'

export interface TmuxCopyModeDeps {
  send: SendClientMessage
  getTerminal: () => Terminal | null
  getReadySession: () => string | null
  getAttachedSession: () => string | null
  inCopyModeRef: MutableRefObject<boolean>
  appMouseRef: MutableRefObject<boolean>
  altScreenRef: MutableRefObject<boolean>
  flushOutputBeforeControl: () => void
  onModeChange: (inCopyMode: boolean) => void
  onScrollPositionChange: () => void
}

export class TmuxCopyModeState {
  private checkTimer: number | null = null
  private pollInterval: ReturnType<typeof setInterval> | null = null
  private wheelAccum = 0

  constructor(private deps: TmuxCopyModeDeps) {}

  /**
   * Set copy-mode state. Entering optimistically disables xterm mouse
   * tracking so clicks do local selection instead of sending sequences;
   * tmux re-enables tracking via its refresh output on exit.
   */
  set(nextValue: boolean): void {
    if (this.deps.inCopyModeRef.current === nextValue) return
    this.deps.inCopyModeRef.current = nextValue
    this.deps.onModeChange(nextValue)

    // Disable all mouse tracking modes (1000=X10, 1002=button-event,
    // 1003=any-event, 1006=SGR). Preserve order with older output held by
    // backpressure; otherwise a buffered enable sequence could undo this
    // disable after entering copy-mode.
    const terminal = this.deps.getTerminal()
    if (terminal && nextValue) {
      this.deps.flushOutputBeforeControl()
      terminal.write(DISABLE_MOUSE_TRACKING)
    }

    this.deps.onScrollPositionChange()
  }

  /** Exit copy-mode before input/paste reaches the pane (paired sites). */
  exit(sessionId: string): void {
    if (!this.deps.inCopyModeRef.current) return
    this.deps.send({ type: 'tmux-cancel-copy-mode', sessionId })
    this.set(false)
  }

  /** Request copy-mode status from the server (debounced 150ms after last scroll). */
  requestCheck(): void {
    const attached = this.deps.getReadySession()
    if (!attached) return

    // Debounce: clear existing timer and set a new one
    if (this.checkTimer !== null) {
      window.clearTimeout(this.checkTimer)
    }
    this.checkTimer = window.setTimeout(() => {
      this.checkTimer = null
      this.deps.send({ type: 'tmux-check-copy-mode', sessionId: attached })
    }, 150)
  }

  /** Clear a pending debounced check (mount cleanup). */
  clearCheckTimer(): void {
    if (this.checkTimer !== null) {
      window.clearTimeout(this.checkTimer)
    }
  }

  /** Stop the copy-mode status poll, if running. */
  stopPoll(): void {
    if (this.pollInterval !== null) {
      globalThis.clearInterval(this.pollInterval)
      this.pollInterval = null
    }
  }

  /** Start the 750ms copy-mode status poll for the attached session. */
  startPoll(sessionId: string): void {
    this.pollInterval = globalThis.setInterval(() => {
      if (this.deps.getAttachedSession() !== sessionId) return
      this.deps.send({ type: 'tmux-check-copy-mode', sessionId })
    }, 750)
  }

  /** Apply a tmux-copy-mode-status report: app-mouse/alt-screen + mode. */
  handleStatus(message: { appMouse?: boolean; inCopyMode: boolean; altScreen?: boolean }): void {
    const nextAppMouse = message.appMouse === true && !message.inCopyMode
    const wasAppMouse = this.deps.appMouseRef.current
    this.deps.appMouseRef.current = nextAppMouse
    this.deps.altScreenRef.current = message.altScreen === true

    if (!wasAppMouse && nextAppMouse) {
      this.deps.flushOutputBeforeControl()
      this.deps.getTerminal()?.write(ENABLE_MOUSE_TRACKING)
    }

    this.set(message.inCopyMode)
  }

  /**
   * True when input data must be dropped: we are in copy-mode and the data is
   * a mouse sequence (SGR/URXVT/normal encodings) — xterm then handles the
   * click as local selection instead of exiting copy-mode (Safari desktop).
   */
  // eslint-disable-next-line no-control-regex
  private static readonly MOUSE_SEQUENCE_REGEX = /^\x1b\[(<[\d;]+[Mm]|[\d;]+M|M[\x20-\xff]{3})$/

  shouldDropInputData(data: string): boolean {
    return this.deps.inCopyModeRef.current && TmuxCopyModeState.MOUSE_SEQUENCE_REGEX.test(data)
  }

  /**
   * Forward wheel events to tmux as SGR mouse sequences (like Blink
   * terminal) so scrolling enters tmux copy-mode instead of using xterm.js
   * local scrollback. Returns false when handled (preventing xterm scroll).
   */
  handleWheelEvent(ev: WheelEvent, terminal: Terminal): boolean {
    const attached = this.deps.getReadySession()
    if (!attached) return true // Let xterm handle it

    // Don't intercept wheel over HTML inputs (like Claude Code's text box)
    const target = ev.target as HTMLElement | null
    if (target?.closest('input, textarea, [contenteditable="true"], .xterm-hover')) {
      return true
    }

    // If user has active selection, let them scroll to extend it
    if (terminal.hasSelection()) return true

    // Shift+scroll = horizontal scroll intent, let browser handle
    if (ev.shiftKey) return true

    // Accumulate wheel delta to avoid spamming on trackpads
    const STEP = 30
    this.wheelAccum += ev.deltaY

    // Get approximate cell position for SGR mouse event
    const cols = terminal.cols
    const rows = terminal.rows
    const col = Math.floor(cols / 2)
    const row = Math.floor(rows / 2)

    let scrolledUp = false
    let didScroll = false
    while (Math.abs(this.wheelAccum) >= STEP) {
      didScroll = true
      const down = this.wheelAccum > 0
      this.wheelAccum += down ? -STEP : STEP

      // SGR mouse wheel: button 64 = scroll up, 65 = scroll down
      const button = down ? 65 : 64
      if (!down) scrolledUp = true
      this.deps.send({
        type: 'terminal-input',
        sessionId: attached,
        data: `\x1b[<${button};${col};${row}M`,
      })
    }

    // Optimistically show button when scrolling up
    if (scrolledUp && !this.deps.appMouseRef.current) {
      this.set(true)
    }
    // Request actual copy-mode status from tmux (debounced) - only if we sent scroll
    if (didScroll && !this.deps.appMouseRef.current) {
      this.requestCheck()
    }
    return false // We handled it, prevent xterm local scroll
  }
}
