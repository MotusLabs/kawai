// Link hover/activation for the terminal: the URL tooltip, the OSC 8
// linkHandler, WebLinksAddon auto-detection, and the mousedown-first open
// path that beats the race where xterm sends mouse sequences to tmux
// (exiting copy-mode) before the link addon's click handler fires.
import { WebLinksAddon } from '@xterm/addon-web-links'
import type { Terminal } from '@xterm/xterm'
import { getIsMac } from '../utils/device'
import { sanitizeLink } from './linkSanitize'

// URL regex that matches standard URLs and IP:port patterns
const URL_REGEX = /https?:\/\/[^\s"'<>]+|\b(?:localhost|\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}(?:\/[^\s"'<>]*)?\b/

export interface LinkTooltipParts {
  root: HTMLDivElement
  url: HTMLDivElement
  hint: HTMLDivElement
}

/**
 * Create the hover tooltip element (with xterm-hover class to prevent
 * interference). Returns null in test environments without DOM APIs.
 */
export function createLinkTooltip(): LinkTooltipParts | null {
  // Guard for test environments where document.createElement may not be available
  if (typeof document === 'undefined' || !document.createElement) return null

  const root = document.createElement('div')
  root.className = 'xterm-hover'
  root.style.cssText = `
    position: absolute;
    display: none;
    z-index: 20;
    padding: 4px 8px;
    font-size: 12px;
    border-radius: 4px;
    background: var(--bg-surface);
    border: 1px solid var(--border);
    box-shadow: 0 2px 8px rgba(0,0,0,0.15);
    color: var(--text-primary);
    pointer-events: none;
    max-width: 400px;
    word-break: break-all;
  `
  const url = document.createElement('div')
  root.appendChild(url)

  const hint = document.createElement('div')
  hint.style.color = 'var(--text-muted)'
  hint.style.marginTop = '2px'
  hint.style.fontSize = '11px'
  root.appendChild(hint)

  return { root, url, hint }
}

/**
 * Wire hover/leave/activate link handling and the capture-phase mousedown
 * opener onto the terminal. Returns a cleanup that removes the listener and
 * the WebLinksAddon.
 */
export function installLinkHandlers(
  terminal: Terminal,
  container: HTMLDivElement,
  tooltip: LinkTooltipParts | null
): () => void {
  const showTooltip = (event: MouseEvent, text: string) => {
    if (!terminal.element || !tooltip) return
    const sanitized = sanitizeLink(text)
    if (!sanitized) return
    const rect = terminal.element.getBoundingClientRect()
    // Truncate long URLs
    const displayUrl = sanitized.length > 60 ? sanitized.slice(0, 57) + '...' : sanitized
    tooltip.url.textContent = displayUrl
    tooltip.hint.textContent = `${getIsMac() ? '⌘' : 'Ctrl'}+click to open`
    tooltip.root.style.left = `${event.clientX - rect.left + 10}px`
    tooltip.root.style.top = `${event.clientY - rect.top + 10}px`
    tooltip.root.style.display = 'block'
  }

  const hideTooltip = () => {
    if (tooltip) tooltip.root.style.display = 'none'
  }

  // Track the currently hovered link URL so we can open it on mousedown
  // before xterm.js sends mouse sequences to tmux that exit copy-mode
  let hoveredLinkUrl: string | null = null
  let linkOpenedOnMouseDown = false
  let linkOpenedResetTimer: ReturnType<typeof setTimeout> | null = null

  // Link handler with hover/leave callbacks - used for both OSC 8 and WebLinksAddon
  const linkHandler = {
    activate: (event: MouseEvent, text: string) => {
      // Skip if already opened by mousedown handler (prevents double-open)
      if (linkOpenedOnMouseDown) return
      // Fallback for cases where mousedown didn't intercept
      if (event.metaKey || event.ctrlKey) {
        const sanitized = sanitizeLink(text)
        if (!sanitized) return
        window.open(sanitized, '_blank', 'noopener')
      }
    },
    hover: (event: MouseEvent, text: string) => {
      const sanitized = sanitizeLink(text)
      hoveredLinkUrl = sanitized || null
      showTooltip(event, text)
    },
    leave: () => {
      hoveredLinkUrl = null
      hideTooltip()
    },
  }

  // Open links on mousedown instead of click to beat the race condition where
  // xterm.js sends mouse sequences to tmux (exiting copy-mode) before the
  // link addon's click handler fires
  const handleLinkMouseDown = (e: MouseEvent) => {
    if (hoveredLinkUrl && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      e.stopPropagation()
      linkOpenedOnMouseDown = true
      window.open(hoveredLinkUrl, '_blank', 'noopener')
      // Reset flag after a short delay (in case click event still fires)
      if (linkOpenedResetTimer) clearTimeout(linkOpenedResetTimer)
      linkOpenedResetTimer = setTimeout(() => { linkOpenedOnMouseDown = false }, 100)
    }
  }
  container.addEventListener('mousedown', handleLinkMouseDown, true)

  // Set linkHandler for OSC 8 hyperlinks
  terminal.options.linkHandler = linkHandler

  // WebLinksAddon for auto-detected URLs (pass linkHandler for hover/leave)
  const webLinksAddon = new WebLinksAddon(
    (event, uri) => linkHandler.activate(event, uri),
    {
      urlRegex: URL_REGEX,
      hover: (event, text) => linkHandler.hover(event, text),
      leave: () => linkHandler.leave(),
    }
  )
  terminal.loadAddon(webLinksAddon)

  return () => {
    // Clean up link handling state
    if (linkOpenedResetTimer) clearTimeout(linkOpenedResetTimer)
    hoveredLinkUrl = null
    // Remove link mousedown handler
    container.removeEventListener('mousedown', handleLinkMouseDown, true)
    // Remove tooltip element
    if (tooltip) tooltip.root.remove()
    try {
      webLinksAddon.dispose()
    } catch {
      // Ignore
    }
  }
}
