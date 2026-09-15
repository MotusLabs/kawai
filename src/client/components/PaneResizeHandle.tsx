// PaneResizeHandle.tsx - Keyboard- and pointer-accessible resize control
// sitting on the top edge of a docked fallback pane. Dragging or the arrow
// keys adjusts the pane's stored height fraction of the navigator body;
// the flow region above absorbs the difference. Pointer capture keeps the
// drag alive when the pointer leaves the sidebar, and touch-action none
// keeps a touch drag from scrolling the pane or drawer underneath.

import { useRef } from 'react'
import { PANE_MAX_FRACTION, PANE_MIN_FRACTION } from '../stores/settingsStore'

/** Keyboard resize step, as a fraction of the navigator body height. */
const KEYBOARD_STEP = 0.02

export interface PaneResizeHandleProps {
  /** Accessible name of the resized pane, e.g. "Remote". */
  label: string
  /** Current pane height as a fraction of the navigator body height. */
  fraction: number
  /** Receives the next fraction, already clamped to [min, max]. */
  onResize: (fraction: number) => void
  /** Ref to the navigator body whose height the fraction resolves against. */
  containerRef: React.RefObject<HTMLElement | null>
  min?: number
  max?: number
}

function clampFraction(fraction: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, fraction))
}

export default function PaneResizeHandle({
  label,
  fraction,
  onResize,
  containerRef,
  min = PANE_MIN_FRACTION,
  max = PANE_MAX_FRACTION,
}: PaneResizeHandleProps) {
  // Drag state is captured on pointerdown: the start Y, the starting
  // fraction, and the container height read once for the whole drag.
  const dragRef = useRef<{
    startY: number
    startFraction: number
    containerHeight: number
  } | null>(null)

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const container = containerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()
    if (rect.height <= 0) return
    dragRef.current = {
      startY: event.clientY,
      startFraction: fraction,
      containerHeight: rect.height,
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    // Dragging the top edge upward grows the pane below it.
    const delta = drag.startY - event.clientY
    onResize(clampFraction(drag.startFraction + delta / drag.containerHeight, min, max))
  }

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return
    dragRef.current = null
    const currentTarget = event.currentTarget
    if (
      typeof currentTarget.hasPointerCapture === 'function' &&
      currentTarget.hasPointerCapture(event.pointerId)
    ) {
      currentTarget.releasePointerCapture(event.pointerId)
    }
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null
    if (event.key === 'ArrowUp') next = fraction + KEYBOARD_STEP
    else if (event.key === 'ArrowDown') next = fraction - KEYBOARD_STEP
    else if (event.key === 'Home') next = min
    else if (event.key === 'End') next = max
    if (next === null) return
    event.preventDefault()
    onResize(clampFraction(next, min, max))
  }

  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label={`Resize ${label} pane`}
      aria-valuenow={Math.round(clampFraction(fraction, min, max) * 100)}
      aria-valuemin={Math.round(min * 100)}
      aria-valuemax={Math.round(max * 100)}
      tabIndex={0}
      data-testid="pane-resize-handle"
      data-pane={label}
      style={{ touchAction: 'none' }}
      className="h-1.5 shrink-0 cursor-row-resize transition-colors hover:bg-accent/40"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={handleKeyDown}
    />
  )
}
