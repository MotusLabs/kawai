// Paste channel: the per-request resolver promise machinery that pairs a
// paste keydown with the capture-phase paste listener (grabbing
// clipboardData synchronously, no permissions, no double-paste), the
// mac-desktop image paste path, image upload/pasteboard resolution, and the
// clipboard metadata helpers. Constructed once per hook instance.
import type { AgentType, ClipboardOfferSource, SendClientMessage } from '@shared/types'
import { getIsMac } from '../utils/device'
import { bracketedPaste, sanitizeImagePath } from '../utils/paste'
import { clipboardFiles } from '../utils/browserFiles'
import { clientLog } from '../utils/clientLog'

/** Empty bracket paste sequence — signals a paste event without text content. */
const BRACKET_PASTE_EMPTY = '\x1b[200~\x1b[201~'
const CTRL_V = '\x16'

/**
 * Upload an image blob to the server and return the stored file path.
 * Returns null on any failure. Bun derives the multipart File.type from the
 * filename extension (not the declared blob type), so the filename carries the
 * real extension.
 */
async function uploadImageBlob(blob: Blob): Promise<string | null> {
  try {
    const ext = (blob.type.split('/')[1] || 'png').toLowerCase()
    const form = new FormData()
    form.append('image', blob, `paste.${ext}`)
    const res = await fetch('/api/paste-image', { method: 'POST', body: form })
    if (!res.ok) return null
    const data = (await res.json()) as { path?: unknown }
    return typeof data.path === 'string' ? data.path : null
  } catch {
    return null
  }
}

/** Raw `/api/clipboard-file-path` payload, or null when unavailable (any failure). */
type ClipboardFilePayload = { path: unknown; isImage: unknown } | null

/**
 * Ask the server to read the macOS pasteboard. One fetch seam shared by the
 * image-path resolution and the Finder-file paste flow (which needs the raw
 * path/isImage fields, not just the image case).
 */
async function fetchClipboardFile(): Promise<ClipboardFilePayload> {
  try {
    const res = await fetch('/api/clipboard-file-path')
    if (!res.ok) return null
    return (await res.json()) as { path: unknown; isImage: unknown }
  } catch {
    /* not on macOS or endpoint unavailable */
    return null
  }
}

/** Pasteboard file path for an image, or null when the clipboard holds no image. */
async function fetchClipboardImagePath(): Promise<string | null> {
  const data = await fetchClipboardFile()
  if (data && data.isImage === true && typeof data.path === 'string') return data.path
  return null
}

/**
 * Resolve the terminal-input payload that makes the attached agent attach a
 * pasted image.
 *
 * Claude Code attaches an image when it receives the image's file PATH inside a
 * bracketed paste — not as raw-typed text, and not via an empty bracket paste.
 * The old empty-bracket signal relied on Claude reading the macOS system
 * clipboard itself, which its fullscreen/no-flicker renderer no longer does, so
 * we now deliver an explicit path: upload the clipboard blob when we have it,
 * otherwise ask the server to resolve a pasteboard path. Codex keeps its
 * literal Ctrl+V signal (its own native image-paste path).
 */
async function resolveImagePasteData(
  agentType: AgentType | undefined,
  source: { blob?: Blob | null; path?: string | null }
): Promise<string | null> {
  if (agentType === 'codex') return CTRL_V
  let path = source.path ?? null
  if (!path && source.blob) path = await uploadImageBlob(source.blob)
  if (!path) path = await fetchClipboardImagePath()
  // Fall back to the empty-bracket signal so the classic renderer's native
  // clipboard read still works when no path could be resolved.
  return path ? bracketedPaste(sanitizeImagePath(path)) : BRACKET_PASTE_EMPTY
}

const MAC_SHARED_PASTEBOARD_PATH_PATTERN =
  /\/Users\/[^/\n]+\/Library\/Group Containers\/group\.com\.apple\.coreservices\.useractivityd\/shared-pasteboard\/items\//

function isMacSharedPasteboardPathText(text: string): boolean {
  return MAC_SHARED_PASTEBOARD_PATH_PATTERN.test(text)
}

export interface PastePayload {
  files: File[]
  text: string
  hasImage: boolean
  hasFiles: boolean
  imageBlob: Blob | null
}

function clipboardHasImage(clipboardData: DataTransfer | null | undefined): boolean {
  if (!clipboardData) return false

  for (const file of Array.from(clipboardData.files ?? [])) {
    if (file?.type?.startsWith('image/')) return true
  }

  for (const item of Array.from(clipboardData.items ?? [])) {
    if (item?.type?.startsWith('image/')) return true
  }
  return false
}

/**
 * Extract the first image blob from clipboard data, if one is present and
 * directly readable. Returns null when the image can't be pulled as a File
 * (e.g. metadata-only items), in which case callers fall back to a
 * server-side pasteboard read.
 */
function getClipboardImageBlob(
  clipboardData: DataTransfer | null | undefined
): Blob | null {
  if (!clipboardData) return null

  for (const file of Array.from(clipboardData.files ?? [])) {
    if (file?.type?.startsWith('image/')) return file
  }

  for (const item of Array.from(clipboardData.items ?? [])) {
    if (item?.kind === 'file' && item.type?.startsWith('image/')) {
      const file = item.getAsFile?.()
      if (file) return file
    }
  }
  return null
}

export interface PasteChannelDeps {
  send: SendClientMessage
  getReadySession: () => string | null
  getAttachedSession: () => string | null
  getAgentType: () => AgentType | undefined
  getOnPasteFiles: () => ((payload: { text: string; files: File[] }) => void) | undefined
  onPasteError: (message: string) => void
  canReadHostClipboard: () => boolean
  isIOS: boolean
  isInCopyMode: () => boolean
  setCopyMode: (value: boolean) => void
}

export class PasteChannel {
  private pasteResolver: ((payload: PastePayload) => void) | null = null
  private pasteTimeoutId: ReturnType<typeof setTimeout> | null = null
  private readonly pasteModifier = getIsMac() ? 'metaKey' : 'ctrlKey' as const

  constructor(private deps: PasteChannelDeps) {}

  /**
   * Paste delivery often resolves after async work (clipboard read, image
   * upload). Only forward input if the session captured when the paste began
   * is still the attached one, so a mid-paste session switch can't deliver to
   * the wrong (or a no-longer-viewed) session.
   */
  private sendInputIfStillAttached(expected: string, data: string | null): void {
    if (
      data &&
      this.deps.getAttachedSession() === expected &&
      this.deps.getReadySession() === expected
    ) {
      if (this.deps.isInCopyMode()) {
        this.deps.send({ type: 'tmux-cancel-copy-mode', sessionId: expected })
        this.deps.setCopyMode(false)
      }
      this.deps.send({ type: 'terminal-input', sessionId: expected, data })
    }
  }

  /**
   * Ctrl+V on macOS desktop: dedicated image-paste shortcut. There's no
   * browser paste event (so no clipboard blob), so we ask the server to
   * resolve a pasteboard image path and deliver it as a bracketed paste for
   * Claude to attach natively; Codex gets a literal Ctrl+V byte.
   * Ctrl+V doesn't trigger a browser paste event, so there's no double-paste risk.
   * Excluded on iOS: no Finder/osascript, and Ctrl+V with hardware keyboard
   * should not trigger desktop image paste behavior.
   * Returns !attached: only swallow the key when a session is attached.
   */
  handleMacImagePasteKey(): boolean {
    const attached = this.deps.getReadySession()
    if (attached) {
      if (!this.deps.canReadHostClipboard()) {
        this.deps.onPasteError('Use browser paste or choose a file from this device.')
        return false
      }
      if (this.deps.isInCopyMode()) {
        this.deps.send({ type: 'tmux-cancel-copy-mode', sessionId: attached })
        this.deps.setCopyMode(false)
      }
      void (async () => {
        const data = await resolveImagePasteData(this.deps.getAgentType(), {})
        this.sendInputIfStillAttached(attached, data)
      })()
    }
    return !attached // Only swallow when attached
  }

  /**
   * Cmd+V on macOS / Ctrl+V on other platforms: intercept paste to handle
   * Finder file copies and normal text paste. Creates a per-request promise
   * the capture-phase paste listener fulfills; returns whether xterm should
   * keep the key's default browser action (Safari needs it to dispatch the
   * native paste event for file uploads).
   */
  handlePasteKey(): boolean {
    // Create a per-request promise so the capture-phase paste listener
    // can deliver clipboardData text directly to this paste attempt.
    // Timeout ensures we don't hang if the paste event never fires.
    // Cancel any pending paste request to prevent overlapping resolvers
    if (this.pasteTimeoutId !== null) {
      clearTimeout(this.pasteTimeoutId)
      this.pasteTimeoutId = null
    }
    this.pasteResolver = null
    const pastePromise = new Promise<PastePayload | null>((resolve) => {
      this.pasteTimeoutId = setTimeout(() => {
        this.pasteTimeoutId = null
        this.pasteResolver = null
        resolve(null)
      }, 100)
      this.pasteResolver = (payload: PastePayload) => {
        if (this.pasteTimeoutId !== null) {
          clearTimeout(this.pasteTimeoutId)
          this.pasteTimeoutId = null
        }
        resolve(payload)
      }
    })
    void (async () => {
      try {
        const attached = this.deps.getReadySession()
        if (!attached) return

        // Wait for the paste event to deliver text (up to 100ms timeout).
        // Falls back to clipboard API if paste event didn't fire.
        const payload = await pastePromise
        // With browser uploads enabled, native paste owns clipboard access.
        // Do not issue a second asynchronous read if the browser is slow.
        if (!payload && this.deps.getOnPasteFiles()) return
        let text = payload?.text ?? null
        if (text === null) {
          try { text = await navigator.clipboard.readText() } catch { text = '' }
        }

        if (payload?.files.length && this.deps.getOnPasteFiles()) {
          if (this.deps.getAttachedSession() === attached && this.deps.getReadySession() === attached) {
            // File copies can also expose just their names as text. Do not
            // insert those names alongside their uploaded paths.
            const names = payload.files.map((file) => file.name).join('\n')
            this.deps.getOnPasteFiles()?.({ files: payload.files, text: text.trim() === names ? '' : text })
          }
          return
        }

        if (payload?.hasImage && getIsMac() && !this.deps.isIOS) {
          if (!this.deps.canReadHostClipboard()) {
            if (payload.imageBlob) {
              const blob = payload.imageBlob
              this.deps.getOnPasteFiles()?.({ text: '', files: [new File([blob], `clipboard.${blob.type.split('/')[1] || 'png'}`, { type: blob.type })] })
            } else this.deps.onPasteError('The browser did not provide image data. Choose the file to upload it.')
            return
          }
          // Upload the clipboard image and deliver its path as a bracketed
          // paste so Claude attaches it natively (works in both renderers).
          const data = await resolveImagePasteData(this.deps.getAgentType(), { blob: payload.imageBlob })
          this.sendInputIfStillAttached(attached, data)
          return
        }

        // Finder copies may expose the filename as text alongside file metadata.
        // Resolve the full path before treating that filename as ordinary text.
        if (payload?.hasFiles && !this.deps.canReadHostClipboard()) {
          this.deps.onPasteError('The browser did not provide file data. Drop the file onto the terminal or choose it to upload.')
          return
        }
        if ((!text || payload?.hasFiles) && getIsMac() && !this.deps.isIOS && this.deps.canReadHostClipboard()) {
          const file = await fetchClipboardFile()
          if (file && file.path) {
            if (file.isImage) {
              // Deliver the resolved image path as a bracketed paste.
              const data = await resolveImagePasteData(this.deps.getAgentType(), { path: file.path as string })
              this.sendInputIfStillAttached(attached, data)
              return
            }
            // Send as raw input (no bracket paste) so Claude Code
            // doesn't detect a paste and read the system clipboard
            this.sendInputIfStillAttached(attached, sanitizeImagePath(file.path as string))
            return
          }
        }

        if (text && !isMacSharedPasteboardPathText(text)) {
          // Deliver as an explicit paste so the server can bracket it via
          // tmux (paste-buffer -p). Relying on xterm's terminal.paste()
          // would only bracket when the browser's own bracketedPasteMode is
          // on — which it isn't when we attach to an already-running app
          // (e.g. Claude Code in no-flicker/fullscreen), causing multi-line
          // pastes to auto-submit on the first newline. Guard on the live
          // refs (like sendInputIfStillAttached) so a session switch during
          // the async clipboard read doesn't paste into the wrong session.
          if (
            this.deps.getAttachedSession() === attached &&
            this.deps.getReadySession() === attached
          ) {
            // Exit tmux copy-mode first (as onData does for typed input):
            // paste-buffer into a pane still in copy-mode is swallowed by
            // the copy-mode key table instead of reaching the program.
            if (this.deps.isInCopyMode()) {
              this.deps.send({ type: 'tmux-cancel-copy-mode', sessionId: attached })
              this.deps.setCopyMode(false)
            }
            this.deps.send({ type: 'terminal-paste', sessionId: attached, data: text })
          }
          return
        }

        // Shared Mac clipboard image pastes can expose only a protected
        // useractivityd path to the browser. Sending that path to an agent
        // is useless; ask the server to resolve a real pasteboard image path
        // (falling back to the empty-bracket signal) so the CLI can attach it.
        if (getIsMac() && !this.deps.isIOS && this.deps.canReadHostClipboard()) {
          const data = await resolveImagePasteData(this.deps.getAgentType(), {})
          this.sendInputIfStillAttached(attached, data)
        }
      } finally {
        this.pasteResolver = null
      }
    })()
    // Browser file uploads are handled by the capture-phase paste listener.
    // Safari needs the key's default action to dispatch that native event.
    // On Windows/Linux, continuing through xterm would emit ^V and cancel
    // the browser default. macOS Cmd+V has no such xterm mapping.
    return Boolean(this.deps.getOnPasteFiles()) && this.pasteModifier === 'metaKey'
  }

  /**
   * Capture-phase paste listener: when a paste keydown has an active
   * resolver, grab the clipboard text synchronously from clipboardData
   * (no permissions needed) and suppress the event so ClipboardAddon doesn't
   * also paste. Without a resolver (no pending paste), browser-native file
   * uploads are forwarded to the host app.
   */
  handlePasteEvent(e: ClipboardEvent): void {
    if (!this.pasteResolver) {
      const files = clipboardFiles(e.clipboardData)
      const text = e.clipboardData?.getData('text/plain') ?? ''
      if ((!files.length && !text) || !this.deps.getOnPasteFiles()) return
      e.preventDefault()
      e.stopPropagation()
      if (this.deps.getReadySession() && this.deps.getReadySession() === this.deps.getAttachedSession()) {
        const names = files.map(file => file.name).join('\n')
        this.deps.getOnPasteFiles()?.({ text: files.length && text.trim() === names ? '' : text, files })
      }
      return
    }
    e.preventDefault()
    e.stopPropagation()
    const text = e.clipboardData?.getData('text/plain') ?? ''
    const imageBlob = getClipboardImageBlob(e.clipboardData)
    const hasImage = imageBlob !== null || clipboardHasImage(e.clipboardData)
    const resolver = this.pasteResolver
    this.pasteResolver = null
    const hasFiles = (e.clipboardData?.files?.length ?? 0) > 0
      || Array.from(e.clipboardData?.items ?? []).some((item) => item.kind === 'file')
      || Array.from(e.clipboardData?.types ?? []).includes('Files')
    resolver({ text, hasImage, hasFiles, imageBlob, files: clipboardFiles(e.clipboardData) })
  }

  /** Install the capture-phase paste listener; returns its remover. */
  installCaptureListener(container: HTMLElement): () => void {
    const handler = (e: Event) => this.handlePasteEvent(e as ClipboardEvent)
    container.addEventListener('paste', handler, { capture: true })
    return () => container.removeEventListener('paste', handler, true)
  }

  /** Cancel a pending paste request (mount cleanup). */
  cancelPending(): void {
    if (this.pasteTimeoutId !== null) {
      clearTimeout(this.pasteTimeoutId)
      this.pasteTimeoutId = null
    }
    this.pasteResolver = null
  }
}

export interface ClipboardOfferOptions {
  isIOS: boolean
  /** Fallback when a direct clipboard write is impossible or failed. */
  onManualCopy: (text: string, source: ClipboardOfferSource) => void
}

/**
 * Deliver a server clipboard offer: write to the system clipboard when the
 * platform allows it, logging success/failure; otherwise (or on failure)
 * surface the manual-copy fallback. Empty offers are ignored.
 */
export function deliverClipboardOffer(
  text: string | undefined,
  source: ClipboardOfferSource,
  opts: ClipboardOfferOptions
): void {
  if (!text?.trim()) return

  if (!opts.isIOS && navigator.clipboard?.writeText) {
    const startedAt = performance.now()
    void navigator.clipboard.writeText(text)
      .then(() => {
        clientLog('clipboard_write_success', {
          source,
          chars: text.length,
          durationMs: Math.round(performance.now() - startedAt),
        })
      })
      .catch((error) => {
        clientLog('clipboard_write_failed', {
          source,
          chars: text.length,
          error: error instanceof Error ? error.message : String(error),
        }, 'warn')
        opts.onManualCopy(text, source)
      })
  } else {
    opts.onManualCopy(text, source)
  }
}
