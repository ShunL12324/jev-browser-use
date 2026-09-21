import { documentId } from './document'
// Frame-local snapshot builder.
//
// Each frame's content script walks its own document (piercing shadow DOM
// but NOT iframes), filters to interactive + visible elements, assigns
// refs, and returns an Interactable[] to the SW. The SW prefixes refs
// with a frame qualifier and merges results from all frames.

import type { Interactable } from '../shared/protocol'
import { walkElements } from './dom-walker'
import { isInteractive, deriveRole, deriveName, isDisabled, getValue } from './interactive'
import { getBounds, isVisible, viewportDistance, type Bounds } from './visibility'
import { purgeDead, getOrAssignRef } from './refs'
import type { SnapshotPayload } from './protocol'

interface Candidate {
  el: Element
  bounds: Bounds
  distance: number
}

// Belt-and-suspenders default if SW omits budget; SW now always supplies one.
const SNAPSHOT_BUDGET_DEFAULT = 1_000_000

export function buildSnapshot(opts: { budget?: number } = {}): SnapshotPayload {
  // Drop dead WeakRefs so the map doesn't grow unboundedly on SPA sessions.
  // The counter is NOT reset — refs assigned in a prior snapshot stay valid
  // for elements that are still in the DOM. `getOrAssignRef` decides whether
  // each element reuses its old ref (`is_new: false`) or gets a fresh one.
  purgeDead()
  const budget = opts.budget ?? SNAPSHOT_BUDGET_DEFAULT

  const candidates: Candidate[] = []

  for (const el of walkElements(document)) {
    if (!isInteractive(el)) continue
    const bounds = getBounds(el)
    if (!bounds) continue
    if (!isVisible(el, bounds)) continue
    candidates.push({ el, bounds, distance: viewportDistance(bounds) })
  }

  // Viewport-priority sort: in-view first (distance 0), then by distance.
  // Ties keep insertion order (which is source order).
  candidates.sort((a, b) => a.distance - b.distance)

  const interactables: Interactable[] = []
  const limit = Math.min(candidates.length, budget)
  for (let i = 0; i < limit; i++) {
    const c = candidates[i]!
    const { ref, is_new } = getOrAssignRef(c.el)
    interactables.push({
      ref,
      role: deriveRole(c.el),
      name: deriveName(c.el),
      tag: c.el.tagName.toLowerCase(),
      value: getValue(c.el),
      disabled: isDisabled(c.el),
      bounds: [c.bounds.x, c.bounds.y, c.bounds.x + c.bounds.width, c.bounds.y + c.bounds.height],
      // Only stamp the field when true — saves bytes when the SW serialises.
      // The LLM treats absent as "not new" (i.e. seen before or unknown).
      ...(is_new ? { is_new: true as const } : {})
    })
  }

  return {
    documentId,
    coverage: { matched: candidates.length, returned: interactables.length, truncated: candidates.length > limit },
    url: location.href,
    title: document.title,
    interactables
  }
}

/** Wait until DOM is at least parsed (document_start runs before that). */
export function whenReady(): Promise<void> {
  return new Promise((resolve) => {
    if (document.readyState !== 'loading') return resolve()
    document.addEventListener('DOMContentLoaded', () => resolve(), { once: true })
  })
}
