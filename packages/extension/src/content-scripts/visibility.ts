// Visibility filtering for the DOM walker. Ported verbatim from the rules
// in `src/lib/snapshot.ts:173-183` — bounds non-empty, display not none,
// visibility not hidden, opacity > 0.
//
// In-viewport check is used by the walker's viewport-priority ordering so
// the budget keeps interactables the user can actually see.

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

// A native modal escapes inherited inertness. Its own explicit inert flag,
// or an inert subtree inside it, still applies (HTML inert-subtree rules).
export function isEffectivelyInert(el: Element): boolean {
  for (let node: Element | null = el; node; node = node.assignedSlot ?? node.parentElement ?? (node.getRootNode() instanceof ShadowRoot ? (node.getRootNode() as ShadowRoot).host : null)) {
    if (node.hasAttribute('inert')) return true
    if (node instanceof HTMLDialogElement && node.matches(':modal')) return false
  }
  return false
}

export function getBounds(el: Element): Bounds | null {
  const r = el.getBoundingClientRect()
  if (r.width <= 0 || r.height <= 0) return null
  return { x: r.left, y: r.top, width: r.width, height: r.height }
}

export function isVisible(el: Element, bounds: Bounds): boolean {
  if (bounds.width <= 0 || bounds.height <= 0) return false
  const style = getComputedStyle(el)
  if (style.display === 'none') return false
  if (style.visibility === 'hidden' || style.visibility === 'collapse') return false
  if (parseFloat(style.opacity || '1') === 0) return false
  return true
}

export function isInViewport(bounds: Bounds): boolean {
  const vw = window.innerWidth
  const vh = window.innerHeight
  return (
    bounds.x < vw &&
    bounds.y < vh &&
    bounds.x + bounds.width > 0 &&
    bounds.y + bounds.height > 0
  )
}

/** Viewport-priority score: 0 for in-view, distance-from-viewport for out-of-view. */
export function viewportDistance(bounds: Bounds): number {
  const vw = window.innerWidth
  const vh = window.innerHeight
  if (isInViewport(bounds)) return 0
  const cx = bounds.x + bounds.width / 2
  const cy = bounds.y + bounds.height / 2
  const dx = Math.max(0, cx < 0 ? -cx : cx > vw ? cx - vw : 0)
  const dy = Math.max(0, cy < 0 ? -cy : cy > vh ? cy - vh : 0)
  return Math.sqrt(dx * dx + dy * dy)
}
