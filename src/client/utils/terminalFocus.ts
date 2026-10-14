// Hand keyboard focus back to the terminal after a modal closes. The modals
// call this from a 300 ms close-side timer, so by the time it fires another
// dialog may have opened (New Session over Settings or the reverse): then the
// terminal must stay disabled and unfocused, or it steals the focus — and the
// text being typed — from the dialog's fields.

/** True while any dialog overlay is mounted (each modal renders `role="dialog"` only while open). */
function isDialogOpen(): boolean {
  return typeof document.querySelector === 'function' && document.querySelector('[role="dialog"]') !== null
}

export function restoreTerminalFocus(): void {
  if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return
  if (isDialogOpen()) return
  const textarea = document.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
  if (!textarea) return
  textarea.removeAttribute('disabled')
  textarea.focus()
}
