// Plan reveals own one content scroller. Native scrollIntoView also walks
// hidden outer containers and the document, which can displace the app.
export function scrollWithinContainer(target: HTMLElement | null, align: 'center' | 'start' = 'center'): void {
  if (!target || target.isConnected === false) return
  const container = target.closest?.<HTMLElement>('[data-plan-scroll-container]')
  if (!container || container === target || container.clientHeight <= 0) return
  const targetRect = target.getBoundingClientRect()
  const paneTop = container.getBoundingClientRect().top + container.clientTop
  const leading = align === 'start' || targetRect.height > container.clientHeight
    ? 0 : (container.clientHeight - targetRect.height) / 2
  const top = Math.max(0, Math.min(container.scrollHeight - container.clientHeight,
    container.scrollTop + targetRect.top - paneTop - leading))
  container.scrollTo({ top, behavior: 'instant' })
}
