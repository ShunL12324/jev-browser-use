// Per-frame ref ID assignment and lookup.
//
// Refs (`e1`, `e2`, ...) are stored as a Symbol-keyed JS expando on each
// tagged DOM element, NOT as a `data-*` attribute. The key is a fresh
// `Symbol()` (no global registry), so page JS cannot reach it. Per
// Chromium's V8 binding design, every world owns its own DOM wrapper for
// the shared underlying C++ DOM node — expandos live on the ISOLATED
// wrapper and are invisible to MAIN, with no MutationObserver fire-back.
//
// Refs are stable across snapshots for the lifetime of the content
// script. The counter never resets; only dead WeakRefs are purged.
// `getOrAssignRef` reports whether an element is reused (`is_new: false`)
// or freshly observed (`is_new: true`).

import { shadowOf } from './shadow'

const REF_KEY = Symbol('quarry.ref')

const refToEl = new Map<string, WeakRef<Element>>()
let counter = 0

/** Drop reverse-map entries whose target was garbage-collected or detached.
 *  Bounds memory on long-running SPA sessions; preserves the counter. */
export function purgeDead(): void {
  for (const [ref, weak] of refToEl) {
    const el = weak.deref()
    if (!el || !el.isConnected) refToEl.delete(ref)
  }
}

function nextRef(): string {
  counter += 1
  return `e${counter}`
}

function assignRef(el: Element, ref: string): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(el as any)[REF_KEY] = ref
  } catch {
    /* Frozen / read-only proxies can reject expandos; the next snapshot
     * will simply re-walk and mint a fresh ref. */
  }
  refToEl.set(ref, new WeakRef(el))
}

/**
 * Look up an existing ref for `el` or mint a new one.
 *
 * Resolution: element's expando (REF_KEY) → mint via nextRef + assignRef.
 * `is_new: true` lets the snapshot output flag elements the LLM hasn't
 * seen before.
 */
export function getOrAssignRef(el: Element): { ref: string; is_new: boolean } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const existing = (el as any)[REF_KEY] as string | undefined
  if (typeof existing === 'string') {
    if (!refToEl.has(existing)) {
      // Backfill after a content-script reinit. Bump `counter` past the
      // observed ordinal so future mints don't collide.
      refToEl.set(existing, new WeakRef(el))
      const n = parseInt(existing.slice(1), 10)
      if (Number.isFinite(n) && n > counter) counter = n
    }
    return { ref: existing, is_new: false }
  }
  const ref = nextRef()
  assignRef(el, ref)
  return { ref, is_new: true }
}

/**
 * Resolve a ref to its Element, walking through shadow roots on cache
 * miss. A `fN:` frame qualifier is stripped first — frame routing has
 * already targeted this content script.
 */
export function findByRef(ref: string): Element | null {
  const local = ref.includes(':') ? ref.split(':')[1]! : ref

  const cached = refToEl.get(local)
  if (cached) {
    const el = cached.deref()
    if (el && el.isConnected) return el
    refToEl.delete(local)
  }

  const found = findWithRef(document, local)
  if (found) refToEl.set(local, new WeakRef(found))
  return found
}

function findWithRef(root: Document | ShadowRoot, ref: string): Element | null {
  const els = root.querySelectorAll('*')
  for (let i = 0; i < els.length; i++) {
    const el = els[i]!
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if ((el as any)[REF_KEY] === ref) return el
    // Recurse only into shadow roots. Iframes have their own content
    // script + ref namespace, addressed via chrome.tabs.sendMessage with
    // {frameId} — not by walking from here.
    const sr = shadowOf(el)
    if (sr) {
      const hit = findWithRef(sr, ref)
      if (hit) return hit
    }
  }
  return null
}
