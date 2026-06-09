// Per-tool handlers running in the page's content script.
//
// All ref-based ops look up via refs.findByRef() (which walks shadow DOM
// but stops at iframe boundaries — iframes have their own content script).
// Indicators (flashPoint / flashElement) are drawn directly with DOM
// operations now instead of being injected via Runtime.evaluate.

import { findByRef } from './refs'
import { deriveRole, deriveName, isInteractive } from './interactive'
import {
  dispatchClick,
  dispatchHover,
  dispatchInput,
  dispatchChange,
  dispatchKey,
  focusByClick,
  setNativeValue,
  centerOf
} from './events'
import { updateCursorPos } from './indicators'
import type {
  ClickPayload,
  TypePayload,
  HoverPayload,
  ScrollPayload,
  SelectPayload,
  EvalJsPayload,
  WaitForPayload,
  PressKeyPayload,
  InspectPayload,
  RequestPayload,
  SetFilesPayload,
  ActionEffects,
} from './protocol'

// ── Timing constants ─────────────────────────────────────────────────
//
// Centralised so visual feedback stays coherent across actions and the
// LLM-visible effects-window length is easy to tune in one place.

/** Window we observe for DOM/URL/focus changes after a click/type. */
const EFFECTS_WINDOW_MS = 400
/** Pre-click flash duration on the target ref. */
const FLASH_CLICK_MS = 350
/** Pre-type flash duration on the target ref (slightly longer — typing visibly takes longer than clicking). */
const FLASH_TYPE_MS = 400
/** Pre-hover flash duration (longest — hover effects often have a delay). */
const FLASH_HOVER_MS = 600
/** Default flash duration when an external caller doesn't specify. */
const FLASH_DEFAULT_MS = 450
/** wait_for poll loop interval and total timeout. */
const WAIT_POLL_INTERVAL_MS = 200
const WAIT_DEFAULT_TIMEOUT_MS = 10_000
/** eval_js: ping budget to confirm MAIN world is responsive, and outer timeout. */
const EVAL_PING_TIMEOUT_MS = 500
const EVAL_REQUEST_TIMEOUT_MS = 15_000

/**
 * Content-script-side error. Carries the same `code` / `short_term` shape
 * as the SW-side `ToolFault` so the dispatcher in `isolated.ts` can forward
 * it through CSResponse → sendToFrame → executeTool unchanged.
 *
 * Default `short_term: true` matches bare `Error` semantics — transient.
 * Pass `{ short_term: false }` for permanent facts (wrong element kind,
 * malformed selector, etc.) the LLM shouldn't retry blindly.
 */
class ActionError extends Error {
  readonly code?: string
  readonly short_term: boolean
  constructor(
    message: string,
    opts: { code?: string; short_term?: boolean } = {}
  ) {
    super(message)
    this.name = 'ActionError'
    this.code = opts.code
    this.short_term = opts.short_term ?? true
  }
}

function resolveRef(ref: string): Element {
  const el = findByRef(ref)
  if (!el) throw new ActionError(
    `ref "${ref}" not found in DOM. The page may have changed — re-run snapshot or find before retrying.`,
    { code: 'STALE_REF', short_term: true }
  )
  return el
}

function isTypable(el: Element): el is HTMLInputElement | HTMLTextAreaElement {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
}

// ── click ────────────────────────────────────────────────────────────

/**
 * Observe side-effects after an action. Resolves with what changed in the
 * page during the observation window — lets the LLM tell "click did
 * nothing visible" apart from "click triggered something".
 *
 * Bucketed counts: `attr_mutations` (className/aria/style flips — cheap,
 * often ambient) vs `added_nodes` / `removed_nodes` (structural — strong
 * signal real content changed). `target_subtree_changed` answers "did the
 * action's TARGET element actually react?" — without it, you can't tell
 * a real tab-switch from a hover-style flip.
 *
 * Bfcache race: if the click triggers navigation, the page is about to be
 * destroyed (or suspended into bfcache) and our `sendResponse` callback
 * will lose its channel. We listen for `pagehide` and resolve immediately
 * so the response can flush before Chrome closes the port — otherwise the
 * SW sees "tab.sendMessage failed: page moved into back/forward cache"
 * and the LLM gets a spurious error even though the click landed.
 */
function observeEffects(target?: Element): { stop: () => Promise<ActionEffects> } {
  const beforeUrl = location.href
  const beforeActive = document.activeElement
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const beforeDialogs = ((window as { __quarry_dialogs__?: { captured: unknown[] } }).__quarry_dialogs__?.captured.length) ?? 0
  let attrMutations = 0
  let addedNodes = 0
  let removedNodes = 0
  let targetSubtreeChanged = false
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === 'childList') {
        addedNodes += r.addedNodes.length
        removedNodes += r.removedNodes.length
        // The mutation target IS the parent whose children changed; check
        // whether it's inside (or equal to) our action target. `contains`
        // returns true for the node itself too — exactly what we want.
        if (target && target.contains(r.target)) targetSubtreeChanged = true
      } else if (r.type === 'attributes' || r.type === 'characterData') {
        attrMutations += 1
      }
    }
  })
  try {
    observer.observe(document.documentElement, {
      childList: true, subtree: true,
      attributes: true, characterData: true
    })
  } catch {
    /* observer not installable — fall through with zero mutations */
  }
  return {
    stop: () =>
      new Promise<ActionEffects>((resolve) => {
        let settled = false
        const finish = (urlChangedHint?: boolean) => {
          if (settled) return
          settled = true
          observer.disconnect()
          window.removeEventListener('pagehide', earlyResolve)
          const afterDialogs = ((window as { __quarry_dialogs__?: { captured: unknown[] } }).__quarry_dialogs__?.captured.length) ?? 0
          resolve({
            mutations: attrMutations + addedNodes + removedNodes,
            attr_mutations: attrMutations,
            added_nodes: addedNodes,
            removed_nodes: removedNodes,
            target_subtree_changed: targetSubtreeChanged,
            url_changed: urlChangedHint || location.href !== beforeUrl,
            focus_changed: document.activeElement !== beforeActive,
            dialog_opened: afterDialogs > beforeDialogs
          })
        }
        // pagehide fires synchronously RIGHT BEFORE Chrome puts the page
        // into bfcache (or destroys it on hard navigation). Resolving here
        // lets actClick's promise chain settle and the content-script's
        // `sendResponse` flush BEFORE the message port closes.
        const earlyResolve = () => finish(true)
        window.addEventListener('pagehide', earlyResolve, { once: true })
        setTimeout(() => finish(), EFFECTS_WINDOW_MS)
      })
  }
}

export async function actClick(p: {
  ref: string
  button?: 'left' | 'right' | 'middle'
  double?: boolean
}): Promise<ClickPayload> {
  const el = resolveRef(p.ref)
  try {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior })
  } catch {
    /* ignore */
  }
  flashElement(p.ref, FLASH_CLICK_MS)
  const point = centerOf(el)
  // Animate the phantom cursor to the click point BEFORE dispatching the
  // click — the 180ms transition runs in parallel with the humanised
  // pointer sequence, so by press-time the cursor visibly "arrived."
  updateCursorPos(point.x, point.y)
  const watcher = observeEffects(el)
  await dispatchClick(el, { button: p.button, double: p.double })
  flashPoint(point.x, point.y)
  const effects = await watcher.stop()
  return { point, effects }
}

// ── type ─────────────────────────────────────────────────────────────

export async function actType(p: {
  ref: string
  text: string
  clear?: boolean
  submit?: boolean
}): Promise<TypePayload> {
  const el = resolveRef(p.ref)
  try {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior })
  } catch {
    /* ignore */
  }
  flashElement(p.ref, FLASH_TYPE_MS)

  const watcher = observeEffects(el)
  await focusByClick(el)

  if (p.clear && isTypable(el)) {
    setNativeValue(el, '')
    dispatchInput(el, '', 'deleteContentBackward')
  } else if (p.clear && (el as HTMLElement).isContentEditable) {
    const sel = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(el)
    sel?.removeAllRanges()
    sel?.addRange(range)
    document.execCommand?.('delete')
  }

  if (p.text.length > 0) {
    if (isTypable(el)) {
      setNativeValue(el, (el.value || '') + p.text)
      dispatchInput(el, p.text, 'insertText')
    } else if ((el as HTMLElement).isContentEditable) {
      document.execCommand?.('insertText', false, p.text)
    } else {
      // Generic: focus + key dispatch char-by-char.
      for (const ch of p.text) {
        try {
          dispatchKey(document, { key: ch })
        } catch {
          /* ignore unknown chars in fallback path */
        }
      }
    }
  }

  if (p.submit) {
    dispatchKey(el, { key: 'Enter' })
  }

  dispatchChange(el)

  const effects = await watcher.stop()
  return { typed: p.text, effects }
}

// ── hover ────────────────────────────────────────────────────────────

export async function actHover(p: { ref: string }): Promise<HoverPayload> {
  const el = resolveRef(p.ref)
  try {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior })
  } catch {
    /* ignore */
  }
  flashElement(p.ref, FLASH_HOVER_MS)
  const point = centerOf(el)
  updateCursorPos(point.x, point.y)
  await dispatchHover(el)
  flashPoint(point.x, point.y)
  return { point }
}

// ── press_key ────────────────────────────────────────────────────────

export function actPressKey(p: {
  key: string
  modifiers?: Array<'alt' | 'ctrl' | 'meta' | 'shift'>
}): PressKeyPayload {
  const target = document.activeElement && document.activeElement !== document.body
    ? document.activeElement
    : document
  dispatchKey(target, { key: p.key, modifiers: p.modifiers })
  return { key: p.key }
}

// ── scroll ───────────────────────────────────────────────────────────
//
// Real scroll semantics by case:
//
//   ref only            → scroll ref INTO VIEW (use its scrollable ancestor).
//   ref + dy/y          → treat ref AS the container; scroll it BY dy / TO y.
//   dy/y only           → try window; if window can't scroll, find the page's
//                         primary scrollable container and scroll that.
//   {} empty            → no-op.
//
// Why: modern SPAs (LinkedIn, Gmail, Slack, ...) frequently set
// <body>{overflow:hidden} and put the real scroll on an inner <div>. Just
// calling window.scrollBy returns "success" with 0 movement. Our finder
// covers four candidate paths so most pages just work.

/**
 * CSS-only scrollability check — cheap; used as a fast reject pass before
 * the more expensive probe. Treats `overflow: hidden` as potentially
 * scrollable (modern SPAs hide native scrollbars and drive scroll via JS
 * + scrollTop on hidden containers — LinkedIn / Gmail / Slack all do this).
 * Only `visible` / `clip` are definitively non-scrollable.
 */
function isCssScrollable(el: Element): boolean {
  const s = getComputedStyle(el)
  const yOK = s.overflowY !== 'visible' && s.overflowY !== 'clip'
  const xOK = s.overflowX !== 'visible' && s.overflowX !== 'clip'
  if (!yOK && !xOK) return false
  const yContent = el.scrollHeight - el.clientHeight > 10
  const xContent = el.scrollWidth - el.clientWidth > 10
  return (yOK && yContent) || (xOK && xContent)
}

/**
 * Behavioural scrollability test — set scrollTop +1 and see whether it
 * sticks. Reverts immediately. Sub-frame and invisible to users, but the
 * only reliable way to distinguish "scrollHeight > clientHeight but
 * scrollTop is pinned" (html/body on overflow-hidden SPAs) from "actually
 * responds to scrollTop assignment" (the inner container that LinkedIn
 * et al. scroll programmatically).
 */
function isScrollable(el: Element): boolean {
  if (!isCssScrollable(el)) return false
  const beforeY = el.scrollTop
  el.scrollTop = beforeY + 1
  const movedY = el.scrollTop !== beforeY
  el.scrollTop = beforeY
  if (movedY) return true
  const beforeX = el.scrollLeft
  el.scrollLeft = beforeX + 1
  const movedX = el.scrollLeft !== beforeX
  el.scrollLeft = beforeX
  return movedX
}

/** Nearest scrollable ancestor of `el` (excluding `el` itself). */
function findScrollableAncestor(el: Element): Element | null {
  let cur: Element | null = el.parentElement
  while (cur) {
    if (isScrollable(cur)) return cur
    cur = cur.parentElement
  }
  return null
}

/** Largest scrollable descendant — covers drawer/modal wrappers whose real scroller is a child (LinkedIn All Filters: aside > div > LazyColumn). */
function findScrollableDescendant(el: Element): Element | null {
  const queue: Element[] = [...Array.from(el.children)]
  let best: { el: Element; area: number } | null = null
  while (queue.length) {
    const cur = queue.shift()!
    if (isCssScrollable(cur) && isScrollable(cur)) {
      const r = cur.getBoundingClientRect()
      const area = r.width * r.height
      if (!best || area > best.area) best = { el: cur, area }
    }
    for (const child of cur.children) queue.push(child)
  }
  return best?.el ?? null
}

/**
 * Find the page's primary scrollable container. We probe the "obvious"
 * candidates in order of likelihood — putting `<main>` first because on
 * modern SPAs it's usually the real scroller; document.scrollingElement
 * is often a red herring (CSS says it's scrollable but scrollTop is pinned).
 *
 * If no named candidate probes scrollable, we scan the document and pick
 * the largest CSS-scrollable element that passes the behavioural probe.
 */
function findPrimaryScrollable(): Element | null {
  const quick: Array<Element | null> = [
    document.querySelector('main'),
    document.querySelector('[role="main"]'),
    document.scrollingElement as Element | null,
    document.documentElement,
    document.body
  ]
  for (const c of quick) {
    if (c instanceof Element && isScrollable(c)) return c
  }
  // Fallback: rank by visible area, probe the top candidates.
  const candidates: Array<{ el: Element; area: number }> = []
  const all = document.querySelectorAll('*')
  for (let i = 0; i < all.length; i++) {
    const el = all[i]!
    if (!isCssScrollable(el)) continue
    const r = el.getBoundingClientRect()
    if (r.width < 200 || r.height < 200) continue  // skip tiny widgets
    candidates.push({ el, area: r.width * r.height })
  }
  candidates.sort((a, b) => b.area - a.area)
  for (const c of candidates.slice(0, 8)) {
    if (isScrollable(c.el)) return c.el
  }
  return null
}

function describeScrollTarget(el: Element): string {
  const tag = el.tagName.toLowerCase()
  if (el.id) return `${tag}#${el.id}`
  // First class is usually meaningful (BEM root)
  if (typeof el.className === 'string' && el.className.trim()) {
    const first = el.className.trim().split(/\s+/)[0]
    if (first) return `${tag}.${first}`
  }
  return tag
}

/** Apply a scroll to an Element container by dy/dx OR to absolute y. */
function applyContainerScroll(
  container: Element,
  dx: number,
  dy: number,
  absoluteY: number | undefined
): ScrollPayload {
  const beforeTop = container.scrollTop
  const beforeLeft = container.scrollLeft
  if (typeof absoluteY === 'number') {
    container.scrollTop = absoluteY
  } else {
    container.scrollTop = beforeTop + dy
    container.scrollLeft = beforeLeft + dx
  }
  const scrolled = container.scrollTop !== beforeTop || container.scrollLeft !== beforeLeft
  return {
    scrollX: container.scrollLeft,
    scrollY: container.scrollTop,
    scrolled,
    target: scrolled ? describeScrollTarget(container) : 'none'
  }
}

/** Apply a scroll to the window by dy/dx OR to absolute y. */
function applyWindowScroll(
  dx: number,
  dy: number,
  absoluteY: number | undefined
): ScrollPayload {
  const beforeX = window.scrollX
  const beforeY = window.scrollY
  if (typeof absoluteY === 'number') {
    window.scrollTo(0, absoluteY)
  } else {
    window.scrollBy(dx, dy)
  }
  const scrolled = window.scrollX !== beforeX || window.scrollY !== beforeY
  return {
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    scrolled,
    target: scrolled ? 'window' : 'none'
  }
}

/** Bring an element into the centre of its scrollable view. */
function scrollIntoView(el: Element): ScrollPayload {
  const container = isScrollable(el) ? el : findScrollableAncestor(el)
  if (
    container &&
    container !== document.scrollingElement &&
    container !== document.documentElement &&
    container !== document.body
  ) {
    const beforeTop = container.scrollTop
    const beforeLeft = container.scrollLeft
    const elRect = el.getBoundingClientRect()
    const cRect = container.getBoundingClientRect()
    const targetTop = beforeTop + (elRect.top - cRect.top) - (container.clientHeight - elRect.height) / 2
    const targetLeft = beforeLeft + (elRect.left - cRect.left) - (container.clientWidth - elRect.width) / 2
    container.scrollTop = Math.max(0, targetTop)
    container.scrollLeft = Math.max(0, targetLeft)
    const scrolled = container.scrollTop !== beforeTop || container.scrollLeft !== beforeLeft
    return {
      scrollX: container.scrollLeft,
      scrollY: container.scrollTop,
      scrolled,
      target: scrolled ? describeScrollTarget(container) : 'none'
    }
  }
  // Document-level scrollIntoView (will affect document.scrollingElement)
  const beforeY = window.scrollY
  const beforeX = window.scrollX
  try {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior })
  } catch { /* ignore */ }
  const scrolled = window.scrollX !== beforeX || window.scrollY !== beforeY
  return {
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    scrolled,
    target: scrolled ? 'window' : 'none'
  }
}

export function actScroll(p: {
  ref?: string
  y?: number
  dx?: number
  dy?: number
  until?: 'page_end'
  max_steps?: number
  step_wait_ms?: number
}): ScrollPayload | Promise<ScrollPayload> {
  // ── sweep mode → async stepped scroll for lazy-load triggers ──
  if (p.until === 'page_end') {
    return sweepToPageEnd(p.max_steps ?? 25, p.step_wait_ms ?? 250)
  }

  const dx = p.dx ?? 0
  const dy = p.dy ?? 0
  const hasDelta = dx !== 0 || dy !== 0
  const hasAbsolute = typeof p.y === 'number'

  // ── ref + delta/absolute → scroll ref AS the container ──
  if (p.ref && (hasDelta || hasAbsolute)) {
    const el = resolveRef(p.ref)
    const container =
      (isScrollable(el) ? el : null) ??
      findScrollableDescendant(el) ??
      findScrollableAncestor(el)
    if (container) return applyContainerScroll(container, dx, dy, p.y)
    return applyWindowScroll(dx, dy, p.y)
  }

  // ── ref only → scroll ref into view ──
  if (p.ref) {
    return scrollIntoView(resolveRef(p.ref))
  }

  // ── delta/absolute only → find the right scroller ──
  if (hasDelta || hasAbsolute) {
    // 1) Try window first. Works for plain pages.
    const winResult = applyWindowScroll(dx, dy, p.y)
    if (winResult.scrolled) return winResult
    // 2) Window didn't move — find the primary scroller and use it.
    const primary = findPrimaryScrollable()
    if (primary) {
      return applyContainerScroll(primary, dx, dy, p.y)
    }
    return winResult
  }

  // ── {} → no-op ──
  return {
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    scrolled: false,
    target: 'none'
  }
}

/** Step downward by 80% viewport with a pause between steps so IntersectionObserver-driven lazy loads actually fire. Empirically: a single `scrollTo(bottom)` materialises ~13% of IO-gated slots on a 30-item test; this loop hits 100%. The pause is load-bearing — a tight scrollBy loop without `await` lands at the same 13%. */
async function sweepToPageEnd(maxSteps: number, stepWaitMs: number): Promise<ScrollPayload> {
  const scroller = findPrimaryScrollable() ?? document.scrollingElement ?? document.documentElement
  const isWindow = scroller === document.scrollingElement || scroller === document.documentElement
  const stepPx = Math.max(120, Math.floor(window.innerHeight * 0.8))
  const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

  let steps = 0
  let idleStreak = 0
  let stopReason: 'page_end' | 'idle' | 'max_steps' = 'max_steps'

  for (let i = 0; i < maxSteps; i++) {
    const beforeY = isWindow ? window.scrollY : (scroller as HTMLElement).scrollTop
    if (isWindow) window.scrollBy(0, stepPx)
    else (scroller as HTMLElement).scrollTop = beforeY + stepPx
    await sleep(stepWaitMs)
    steps++

    const afterY = isWindow ? window.scrollY : (scroller as HTMLElement).scrollTop
    const moved = afterY !== beforeY
    if (!moved) {
      idleStreak++
      if (idleStreak >= 2) { stopReason = 'idle'; break }
    } else {
      idleStreak = 0
    }

    const max = isWindow
      ? document.documentElement.scrollHeight - window.innerHeight
      : (scroller as HTMLElement).scrollHeight - (scroller as HTMLElement).clientHeight
    if (afterY >= max - 1) { stopReason = 'page_end'; break }
  }

  return {
    scrollX: isWindow ? window.scrollX : (scroller as HTMLElement).scrollLeft,
    scrollY: isWindow ? window.scrollY : (scroller as HTMLElement).scrollTop,
    scrolled: steps > 0,
    target: isWindow ? 'window' : (scroller as Element).tagName.toLowerCase(),
    steps,
    stop_reason: stopReason
  }
}

// ── select ───────────────────────────────────────────────────────────

export function actSelect(p: { ref: string; values: string[] }): SelectPayload {
  const el = resolveRef(p.ref)
  if (!(el instanceof HTMLSelectElement)) {
    throw new ActionError(
      `target is not a <select> element (got <${el.tagName.toLowerCase()}>)`,
      { code: 'WRONG_ELEMENT_KIND', short_term: false }
    )
  }
  const seen: string[] = []
  let changed = false
  for (const opt of Array.from(el.options)) {
    const wanted = p.values.includes(opt.value) || p.values.includes(opt.label)
    if (opt.selected !== wanted) changed = true
    opt.selected = wanted
    if (wanted) seen.push(opt.value)
  }
  if (changed) {
    dispatchInput(el, '', 'insertText')
    dispatchChange(el)
  }
  return { values: seen }
}

// ── inspect (replaces get_text + get_attribute) ──────────────────────

export function actInspect(p: { ref: string; fields: string[] }): InspectPayload {
  const el = resolveRef(p.ref)
  const values: Record<string, string | null> = {}
  for (const field of p.fields) {
    values[field] = readField(el, field)
  }
  return { values }
}

function readField(el: Element, field: string): string | null {
  switch (field) {
    case 'text': {
      const tag = el.tagName.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        const v = (el as HTMLInputElement).value
        return typeof v === 'string' ? v : null
      }
      const t = ((el as HTMLElement).innerText ?? el.textContent ?? '').trim()
      return t || null
    }
    case 'value': {
      const v = (el as HTMLInputElement).value
      return typeof v === 'string' ? v : null
    }
    case 'tag':
      return el.tagName.toLowerCase()
    case 'role':
      return deriveRole(el)
    case 'name':
      return deriveName(el)
    case 'checked':
      return (el as HTMLInputElement).checked ? 'true' : 'false'
    case 'disabled':
      return ((el as HTMLInputElement).disabled || el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled')) ? 'true' : 'false'
    case 'html':
      return serializeHtml(el, 'outer')
    case 'innerHtml':
      return serializeHtml(el, 'inner')
    case 'has_handler':
      return detectHandlerKind(el)
    default:
      return el.getAttribute(field)
  }
}

// Attributes we keep when serialising HTML for the LLM. Everything else
// (class, style, componentkey, framework metadata like `_ngcontent`,
// data-* except testid) is dropped — they balloon obfuscated-class-heavy
// pages (LinkedIn, etc.) without adding signal.
const KEEP_ATTRS = new Set([
  'id', 'role', 'href', 'src', 'type', 'name', 'value', 'placeholder',
  'alt', 'title', 'target', 'rel', 'disabled', 'readonly', 'checked',
  'required', 'selected', 'multiple', 'hidden', 'for', 'lang', 'dir',
  'contenteditable', 'tabindex', 'open', 'data-testid'
])
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
  'meta', 'param', 'source', 'track', 'wbr'
])

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}
function escapeText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Serialize an Element keeping only semantic attributes. Mirrors `outerHTML` /
 *  `innerHTML` shape but strips class / style / framework noise. Shadow-root
 *  content is not descended (matches native innerHTML behaviour). */
function serializeHtml(el: Element, mode: 'outer' | 'inner'): string {
  const inner = (e: Element): string => {
    let out = ''
    for (const node of e.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) out += escapeText(node.nodeValue || '')
      else if (node.nodeType === Node.ELEMENT_NODE) out += outer(node as Element)
      // comments / cdata dropped
    }
    return out
  }
  const outer = (e: Element): string => {
    const tag = e.tagName.toLowerCase()
    let attrs = ''
    for (const a of Array.from(e.attributes)) {
      if (KEEP_ATTRS.has(a.name) || a.name.startsWith('aria-')) {
        attrs += ` ${a.name}="${escapeAttr(a.value)}"`
      }
    }
    if (VOID_TAGS.has(tag)) return `<${tag}${attrs}>`
    return `<${tag}${attrs}>${inner(e)}</${tag}>`
  }
  return mode === 'outer' ? outer(el) : inner(el)
}

/**
 * Best-effort check for "does this element have a click handler?" Returns a
 * descriptor string so the LLM can reason about why a click might or might
 * not work:
 *
 *   • 'native'   — `el.onclick` is a function (set via JS, not attribute)
 *   • 'inline'   — `onclick="..."` attribute present in markup
 *   • 'react'    — a `__reactProps$*` fiber slot exposes `onClick`
 *   • 'semantic' — natively interactive (<button>, <a>, <input>, etc.)
 *   • 'none'     — no observable handler signal
 *
 * Not exhaustive — addEventListener-attached listeners are invisible to JS
 * (DevTools-only API). The 'semantic' fallback catches a lot of cases the
 * other probes miss (Vue, Angular, vanilla addEventListener on a <button>).
 * Use as a hint, not a guarantee.
 */
function detectHandlerKind(el: Element): string {
  if (typeof (el as HTMLElement).onclick === 'function') return 'native'
  if (el.hasAttribute('onclick')) return 'inline'
  // React 17+ stores props on the DOM node under `__reactProps$<hash>`.
  // React 16 used `__reactInternalInstance$<hash>` (fiber, not props) —
  // accept either as evidence of React-owned event delegation.
  for (const key of Object.keys(el)) {
    if (key.startsWith('__reactProps')) {
      const props = (el as unknown as Record<string, unknown>)[key]
      if (props && typeof props === 'object' && 'onClick' in props) return 'react'
    }
    if (key.startsWith('__reactInternalInstance') || key.startsWith('__reactFiber')) {
      // Fiber present but we can't read props cheaply — assume React owns
      // events here. Still better than 'none'.
      return 'react'
    }
  }
  if (isInteractive(el)) return 'semantic'
  return 'none'
}

// ── set_files (DataTransfer trick replaces CDP DOM.setFileInputFiles) ─

function base64ToBlob(b64: string, mimeType: string): Blob {
  const bin = atob(b64)
  const buf = new ArrayBuffer(bin.length)
  const view = new Uint8Array(buf)
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i)
  return new Blob([buf], { type: mimeType })
}

export function actSetFiles(p: {
  ref: string
  files: Array<{ name: string; mimeType?: string; data: string }>
}): SetFilesPayload {
  const el = resolveRef(p.ref)
  if (!(el instanceof HTMLInputElement) || el.type !== 'file') {
    throw new ActionError(
      `target is not an <input type="file"> (got <${el.tagName.toLowerCase()} type="${(el as HTMLInputElement).type ?? ''}">)`,
      { code: 'WRONG_ELEMENT_KIND', short_term: false }
    )
  }
  const fileList: File[] = []
  for (const f of p.files) {
    const mime = f.mimeType || 'application/octet-stream'
    const blob = base64ToBlob(f.data, mime)
    fileList.push(new File([blob], f.name, { type: mime }))
  }
  const dt = new DataTransfer()
  for (const file of fileList) dt.items.add(file)
  el.files = dt.files
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return { count: fileList.length, names: fileList.map((f) => f.name) }
}

// ── request (HTTP via content-script fetch, user cookies) ───────────
//
// Called only after the SW has validated same-origin against the active
// tab's URL. The content script's fetch() inherits the frame's origin
// and cookies are sent automatically. We always include credentials and
// return the body as text (LLM JSON.parses if it wants structured data).

export async function actRequest(p: {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  json?: unknown
}): Promise<RequestPayload> {
  const method = (p.method ?? 'GET').toUpperCase()
  const headers: Record<string, string> = { ...(p.headers ?? {}) }
  let body: BodyInit | undefined
  if (p.json !== undefined) {
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/json'
    body = JSON.stringify(p.json)
  } else if (typeof p.body === 'string') {
    body = p.body
  }
  const init: RequestInit = {
    method,
    headers,
    credentials: 'include' as RequestCredentials,
    mode: 'same-origin' as RequestMode
  }
  if (body !== undefined && method !== 'GET' && method !== 'HEAD') init.body = body

  let resp: Response
  try {
    resp = await fetch(p.url, init)
  } catch (e) {
    throw new ActionError(`fetch failed: ${e instanceof Error ? e.message : String(e)}`)
  }
  const outHeaders: Record<string, string> = {}
  resp.headers.forEach((v, k) => { outHeaders[k] = v })
  const text = await resp.text().catch(() => '')
  return {
    status: resp.status,
    ok: resp.ok,
    headers: outHeaders,
    body: text
  }
}

// ── wait_for ─────────────────────────────────────────────────────────

export function actWaitFor(p: {
  text?: string
  refExists?: string
  urlPattern?: string
  timeoutMs?: number
}): Promise<WaitForPayload> {
  const timeoutMs = p.timeoutMs ?? WAIT_DEFAULT_TIMEOUT_MS
  const t0 = performance.now()

  const check = (): WaitForPayload['matched'] | null => {
    if (p.text && document.body && document.body.innerText.includes(p.text)) return 'text'
    if (p.refExists && findByRef(p.refExists)) return 'ref'
    if (p.urlPattern && new RegExp(p.urlPattern).test(location.href)) return 'url'
    return null
  }

  return new Promise((resolve, reject) => {
    const first = check()
    if (first) return resolve({ matched: first, elapsedMs: 0 })

    const timer = setInterval(() => {
      const v = check()
      if (v) {
        clearInterval(timer)
        resolve({ matched: v, elapsedMs: Math.round(performance.now() - t0) })
        return
      }
      if (performance.now() - t0 >= timeoutMs) {
        clearInterval(timer)
        reject(new ActionError(`wait_for timeout after ${timeoutMs}ms`))
      }
    }, WAIT_POLL_INTERVAL_MS)
  })
}

// ── eval_js ──────────────────────────────────────────────────────────
//
// Runs in the MAIN world via postMessage. ISOLATED world owns the message
// router and bridges through a token-correlated postMessage handshake.

const PENDING_EVAL = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
const EVAL_CHANNEL = '__quarry_eval__'

let evalListenerInstalled = false
function ensureEvalListener() {
  if (evalListenerInstalled) return
  evalListenerInstalled = true
  // Do NOT check `event.source === window` — ISOLATED and MAIN worlds have
  // separate `window` object identities, so cross-world messages fail that
  // check. Filter on origin + our channel marker instead.
  window.addEventListener('message', (event) => {
    if (event.origin !== window.location.origin) return
    const data = event.data
    if (!data || data.channel !== EVAL_CHANNEL || data.kind !== 'result') return
    const pend = PENDING_EVAL.get(data.id)
    if (!pend) return
    PENDING_EVAL.delete(data.id)
    clearTimeout(pend.timer)
    if (data.ok) pend.resolve(data.value)
    else pend.reject(new Error(String(data.message ?? 'eval error')))
  })
}

/**
 * Ping the MAIN-world content script with a short timeout. Used both as a
 * pre-flight check before eval and for diagnosing whether timeouts are
 * caused by an absent MAIN script vs. a hung eval.
 */
function pingMainWorld(timeoutMs = EVAL_PING_TIMEOUT_MS): Promise<boolean> {
  const id = `ping_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
  return new Promise<boolean>((resolve) => {
    const listener = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return
      const d = event.data
      if (!d || d.channel !== EVAL_CHANNEL || d.kind !== 'pong' || d.id !== id) return
      window.removeEventListener('message', listener)
      clearTimeout(timer)
      resolve(true)
    }
    const timer = setTimeout(() => {
      window.removeEventListener('message', listener)
      resolve(false)
    }, timeoutMs)
    window.addEventListener('message', listener)
    window.postMessage(
      { channel: EVAL_CHANNEL, kind: 'ping', id },
      window.location.origin
    )
  })
}

export async function actEvalJs(p: { expression: string; awaitPromise?: boolean }): Promise<EvalJsPayload> {
  ensureEvalListener()

  // Pre-flight: confirm MAIN world is responsive before queueing the eval.
  const alive = await pingMainWorld(EVAL_PING_TIMEOUT_MS)
  if (!alive) {
    throw new ActionError(
      'MAIN-world content script unreachable. The extension was reloaded but this tab still has stale content scripts. Refresh the tab (⌘+Shift+R) and try again.',
      { code: 'MAIN_UNREACHABLE', short_term: false }
    )
  }

  const id = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
  return new Promise<EvalJsPayload>((resolve, reject) => {
    const timer = setTimeout(async () => {
      PENDING_EVAL.delete(id)
      // Re-check MAIN to give a more useful timeout message.
      const stillAlive = await pingMainWorld(EVAL_PING_TIMEOUT_MS)
      const secs = (EVAL_REQUEST_TIMEOUT_MS / 1000).toFixed(0)
      if (!stillAlive) {
        reject(new ActionError(
          `timed out after ${secs}s: MAIN world stopped responding mid-request. The page may have navigated away during the eval.`
        ))
      } else {
        reject(new ActionError(
          `timed out after ${secs}s: MAIN world is alive but the expression did not return. Likely causes: (a) page CSP blocks new Function/eval, (b) expression returns a Promise (set awaitPromise:true), (c) expression hangs synchronously.`
        ))
      }
    }, EVAL_REQUEST_TIMEOUT_MS)
    PENDING_EVAL.set(id, {
      resolve: (v: unknown) => resolve({ value: v }),
      reject,
      timer
    })
    window.postMessage(
      {
        channel: EVAL_CHANNEL,
        kind: 'request',
        id,
        expression: p.expression,
        awaitPromise: !!p.awaitPromise
      },
      window.location.origin
    )
  })
}

// ── indicators (port from src/lib/indicators.ts) ────────────────────

const ACCENT = '#b88150'
const ACCENT_SOFT = 'rgba(184,129,80,0.10)'

export function flashPoint(x: number, y: number): void {
  try {
    const id = '__rip_' + Date.now() + Math.random().toString(36).slice(2, 6)
    const s = document.createElement('style')
    s.id = id + '_s'
    s.textContent = `@keyframes ${id}{0%{transform:scale(0.6);opacity:0.95;border-width:1.5px}100%{transform:scale(1.9);opacity:0;border-width:0.5px}}`
    document.head.appendChild(s)
    const d = document.createElement('div')
    d.style.cssText = [
      'position:fixed',
      `left:${x}px`,
      `top:${y}px`,
      'width:18px',
      'height:18px',
      'margin:-9px 0 0 -9px',
      'border-radius:50%',
      `border:1.5px solid ${ACCENT}`,
      'background:transparent',
      'pointer-events:none',
      'z-index:2147483647',
      'will-change:transform,opacity',
      `animation:${id} 620ms cubic-bezier(0.16,1,0.3,1) forwards`
    ].join(';')
    document.documentElement.appendChild(d)
    setTimeout(() => {
      try { d.remove(); s.remove() } catch { /* ignore */ }
    }, 700)
  } catch {
    /* ignore */
  }
}

export function flashElement(ref: string, durationMs: number = FLASH_DEFAULT_MS): void {
  try {
    const el = findByRef(ref)
    if (!el) return
    const r = el.getBoundingClientRect()
    if (r.width <= 0 || r.height <= 0) return
    const d = document.createElement('div')
    d.style.cssText = [
      'position:fixed',
      `left:${r.left - 1}px`,
      `top:${r.top - 1}px`,
      `width:${r.width}px`,
      `height:${r.height}px`,
      `border:1px solid ${ACCENT}`,
      `background:${ACCENT_SOFT}`,
      'border-radius:3px',
      'pointer-events:none',
      'z-index:2147483647',
      'opacity:0',
      'transition:opacity 140ms cubic-bezier(0.4,0,0.2,1)'
    ].join(';')
    document.documentElement.appendChild(d)
    requestAnimationFrame(() => { d.style.opacity = '1' })
    setTimeout(() => {
      try {
        d.style.opacity = '0'
        setTimeout(() => { try { d.remove() } catch { /* ignore */ } }, 160)
      } catch {
        /* ignore */
      }
    }, durationMs)
  } catch {
    /* ignore */
  }
}


