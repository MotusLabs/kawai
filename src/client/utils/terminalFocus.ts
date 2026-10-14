// Hand keyboard focus back to the terminal after a modal closes. The modals
// call this from a 300 ms close-side timer, so by the time it fires another
// dialog may have opened (New Session over Settings or the reverse): then the
// terminal must stay disabled and unfocused, or it steals the focus — and the
// text being typed — from the dialog's fields. The restore also waits until
// the LAST open dialog has closed: while any dialog is open it retries every
// 300 ms, so a dialog that closes later (the mobile drawer, the update panel,
// the branch browser) still gets the terminal its focus back.

const RETRY_DELAY_MS = 300

let retryTimer: ReturnType<typeof setTimeout> | null = null

/**
 * True while any dialog is open. Relies on every `role="dialog"` renderer
 * exposing the role only while open (modals return null when closed; the
 * always-mounted SessionDrawer drops the role while closed). A new always-mounted
 * dialog must do the same, or this helper never restores terminal focus.
 */
function isDialogOpen(): boolean {
  return typeof document.querySelector === 'function' && document.querySelector('[role="dialog"]') !== null
}

function clearRetry(): void {
  if (retryTimer !== null) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
}

/** Drop a pending retry; for tests' afterEach and teardown paths. */
export function cancelTerminalFocusRestore(): void {
  clearRetry()
}

export function restoreTerminalFocus(): void {
  if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return
  if (isDialogOpen()) {
    // Another dialog is open now; try again shortly, in case it closes while
    // no modal re-arms a fresh restore. Re-arming keeps at most one retry pending.
    clearRetry()
    retryTimer = setTimeout(() => {
      retryTimer = null
      restoreTerminalFocus()
    }, RETRY_DELAY_MS)
    return
  }
  clearRetry()
  const textarea = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
  if (!textarea) return
  textarea.removeAttribute('disabled')
  textarea.focus()
}
