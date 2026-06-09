// Native event synthesis and the React-friendly value setter.
//
// rtrvr.ai's trick: use the *target frame's* Event constructors
// (`el.ownerDocument.defaultView.PointerEvent`) so the event is `instanceof`
// the page's expected class. This matters for cross-frame click dispatch
// and for sites that check event types defensively.
//
// Native value setter trick: bypass React's onChange shim by calling the
// prototype's setter directly. Works from ISOLATED world because DOM
// prototype identity is shared across worlds.
//
// Humanisation: click/hover sequences include coordinate jitter, multi-step
// mousemove approach paths, and randomised inter-event delays. Total ~150ms
// per click — invisible to humans, defensive against behavioural anti-bot.

// ── Humanisation tuning ──────────────────────────────────────────────

/** ±half-range of coordinate jitter applied to click point. */
const CLICK_JITTER_PX = 4
/** How many intermediate mousemove events to dispatch before pressing. */
const APPROACH_STEPS = 3
/** Inter-mousemove delay range (random within). */
const MOVE_DELAY_MIN_MS = 8
const MOVE_DELAY_MAX_MS = 20
/** Settle pause between arrival and mousedown. */
const SETTLE_MIN_MS = 30
const SETTLE_MAX_MS = 80
/** Press duration: how long mousedown stays held before mouseup. */
const PRESS_MIN_MS = 50
const PRESS_MAX_MS = 130
/** Gap between the two clicks of a double-click. */
const DOUBLE_CLICK_GAP_MIN_MS = 80
const DOUBLE_CLICK_GAP_MAX_MS = 120

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min)
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function viewOf(el: Element): Window {
  return (el.ownerDocument?.defaultView as Window) || window
}

export function centerOf(el: Element): { x: number; y: number } {
  const r = el.getBoundingClientRect()
  return {
    x: r.left + r.width / 2,
    y: r.top + r.height / 2
  }
}

interface PointerInit {
  clientX: number
  clientY: number
  button?: number
  buttons?: number
  pointerType?: 'mouse' | 'touch' | 'pen'
}

function basePointerInit(init: PointerInit) {
  return {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: init.clientX,
    clientY: init.clientY,
    screenX: init.clientX,
    screenY: init.clientY,
    button: init.button ?? 0,
    buttons: init.buttons ?? 0,
    pointerType: init.pointerType ?? ('mouse' as const),
    isPrimary: true
  }
}

/**
 * Dispatch a full pointer+mouse press/release sequence on the element.
 * Humanised: coordinate jitter, multi-step approach mousemove, randomised
 * settle/press durations. ~150ms total per click.
 */
export async function dispatchClick(
  el: Element,
  opts: { button?: 'left' | 'right' | 'middle'; double?: boolean } = {}
): Promise<void> {
  const view = viewOf(el)
  const PE = (view as Window & typeof globalThis).PointerEvent || PointerEvent
  const ME = (view as Window & typeof globalThis).MouseEvent || MouseEvent

  // Coordinate jitter — don't always hit exact center.
  const center = centerOf(el)
  const targetX = center.x + (Math.random() - 0.5) * CLICK_JITTER_PX
  const targetY = center.y + (Math.random() - 0.5) * CLICK_JITTER_PX

  const buttonNum = opts.button === 'right' ? 2 : opts.button === 'middle' ? 1 : 0
  const buttonsBit = opts.button === 'right' ? 2 : opts.button === 'middle' ? 4 : 1

  // ── Arrival: enter + over ──
  const arrival = basePointerInit({ clientX: targetX, clientY: targetY })
  el.dispatchEvent(new PE('pointerover', arrival))
  el.dispatchEvent(new ME('mouseover', arrival))
  el.dispatchEvent(new PE('pointerenter', arrival))
  el.dispatchEvent(new ME('mouseenter', arrival))

  // ── Approach: a few mousemoves converging on the target ──
  // Simulates the final inches of pointer travel that a real user produces.
  for (let i = 1; i <= APPROACH_STEPS; i++) {
    const t = i / APPROACH_STEPS
    const offsetScale = 6 * (1 - t)  // shrinks as we approach
    const mx = targetX + (Math.random() - 0.5) * offsetScale
    const my = targetY + (Math.random() - 0.5) * offsetScale
    const moveInit = basePointerInit({ clientX: mx, clientY: my })
    el.dispatchEvent(new PE('pointermove', moveInit))
    el.dispatchEvent(new ME('mousemove', moveInit))
    await delay(rand(MOVE_DELAY_MIN_MS, MOVE_DELAY_MAX_MS))
  }

  // ── Settle before press ──
  await delay(rand(SETTLE_MIN_MS, SETTLE_MAX_MS))

  // ── Press ──
  const downInit = basePointerInit({ clientX: targetX, clientY: targetY, button: buttonNum, buttons: buttonsBit })
  el.dispatchEvent(new PE('pointerdown', downInit))
  el.dispatchEvent(new ME('mousedown', downInit))

  // Some custom widgets need explicit focus before click can do anything.
  try { (el as HTMLElement).focus({ preventScroll: true }) } catch { /* ignore */ }

  // ── Press duration ──
  await delay(rand(PRESS_MIN_MS, PRESS_MAX_MS))

  // ── Release ──
  const upInit = basePointerInit({ clientX: targetX, clientY: targetY, button: buttonNum, buttons: 0 })
  el.dispatchEvent(new PE('pointerup', upInit))
  el.dispatchEvent(new ME('mouseup', upInit))

  // ── Synthesise the click event (browsers don't auto-fire from synthetic mousedown/mouseup). ──
  const clickInit = basePointerInit({ clientX: targetX, clientY: targetY, button: buttonNum, buttons: 0 })
  if (opts.button !== 'right') {
    el.dispatchEvent(new ME('click', clickInit))
    if (opts.double) {
      await delay(rand(DOUBLE_CLICK_GAP_MIN_MS, DOUBLE_CLICK_GAP_MAX_MS))
      el.dispatchEvent(new ME('click', clickInit))
      el.dispatchEvent(new ME('dblclick', clickInit))
    }
  } else {
    el.dispatchEvent(new ME('contextmenu', clickInit))
  }
}

/**
 * Dispatch a hover sequence (no press). Humanised with an approach path so
 * hover-triggered tooltips and dropdowns see realistic pointer activity.
 */
export async function dispatchHover(el: Element): Promise<void> {
  const view = viewOf(el)
  const PE = (view as Window & typeof globalThis).PointerEvent || PointerEvent
  const ME = (view as Window & typeof globalThis).MouseEvent || MouseEvent
  const center = centerOf(el)
  const targetX = center.x + (Math.random() - 0.5) * CLICK_JITTER_PX
  const targetY = center.y + (Math.random() - 0.5) * CLICK_JITTER_PX

  const arrival = basePointerInit({ clientX: targetX, clientY: targetY })
  el.dispatchEvent(new PE('pointerover', arrival))
  el.dispatchEvent(new ME('mouseover', arrival))
  el.dispatchEvent(new PE('pointerenter', arrival))
  el.dispatchEvent(new ME('mouseenter', arrival))

  for (let i = 1; i <= APPROACH_STEPS; i++) {
    const t = i / APPROACH_STEPS
    const offsetScale = 6 * (1 - t)
    const mx = targetX + (Math.random() - 0.5) * offsetScale
    const my = targetY + (Math.random() - 0.5) * offsetScale
    const moveInit = basePointerInit({ clientX: mx, clientY: my })
    el.dispatchEvent(new PE('pointermove', moveInit))
    el.dispatchEvent(new ME('mousemove', moveInit))
    await delay(rand(MOVE_DELAY_MIN_MS, MOVE_DELAY_MAX_MS))
  }
}

/**
 * Set an input/textarea value via the prototype's native setter so React's
 * `_valueTracker` records the change and onChange fires.
 */
export function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype
  const desc = Object.getOwnPropertyDescriptor(proto, 'value')
  const setter = desc?.set
  if (setter) {
    setter.call(el, value)
  } else {
    // Last-ditch fallback — bypasses React tracking but at least sets the value.
    ;(el as { value: string }).value = value
  }
}

/** Dispatch beforeinput/input pair after a value change. */
export function dispatchInput(el: Element, data: string, inputType = 'insertText'): void {
  const view = viewOf(el)
  const IE = (view as Window & typeof globalThis).InputEvent || InputEvent
  try {
    el.dispatchEvent(new IE('beforeinput', { bubbles: true, cancelable: true, composed: true, data, inputType }))
  } catch {
    /* Some browsers throw on synthetic InputEvent — ignore */
  }
  try {
    el.dispatchEvent(new IE('input', { bubbles: true, cancelable: false, composed: true, data, inputType }))
  } catch {
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }
}

/**
 * Dispatch a synthetic `change` event. Fired after `input` events when a
 * field's edit is finalised (typically on blur or Enter). React's
 * controlled-input tracker reads from `input`, but many third-party form
 * libraries (legacy jQuery, some Vue plugins) listen on `change` instead.
 */
export function dispatchChange(el: Element): void {
  el.dispatchEvent(new Event('change', { bubbles: true }))
}

interface KeyParams {
  key: string
  modifiers?: Array<'alt' | 'ctrl' | 'meta' | 'shift'>
}

interface KeyMap {
  key: string
  code: string
  keyCode?: number
  text?: string
}

const KEY_TABLE: Record<string, KeyMap> = {
  Enter:     { key: 'Enter',     code: 'Enter',     keyCode: 13, text: '\r' },
  Tab:       { key: 'Tab',       code: 'Tab',       keyCode: 9,  text: '\t' },
  Escape:    { key: 'Escape',    code: 'Escape',    keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete:    { key: 'Delete',    code: 'Delete',    keyCode: 46 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight:{ key: 'ArrowRight',code: 'ArrowRight',keyCode: 39 },
  ArrowUp:   { key: 'ArrowUp',   code: 'ArrowUp',   keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  Home:      { key: 'Home',      code: 'Home',      keyCode: 36 },
  End:       { key: 'End',       code: 'End',       keyCode: 35 },
  PageUp:    { key: 'PageUp',    code: 'PageUp',    keyCode: 33 },
  PageDown:  { key: 'PageDown',  code: 'PageDown',  keyCode: 34 },
  Space:     { key: ' ',         code: 'Space',     keyCode: 32, text: ' ' }
}

function resolveKey(key: string): KeyMap {
  if (KEY_TABLE[key]) return KEY_TABLE[key]!
  if (key.length === 1) {
    const upper = key.toUpperCase()
    const isAlpha = /[A-Z]/.test(upper)
    return {
      key,
      code: isAlpha ? `Key${upper}` : `Digit${key}`,
      keyCode: upper.charCodeAt(0),
      text: key
    }
  }
  throw new Error(`unknown key: ${key}`)
}

/** Dispatch a single keydown / (keypress) / keyup sequence on the target. */
export function dispatchKey(target: Element | Document, params: KeyParams): void {
  const map = resolveKey(params.key)
  const view =
    target instanceof Element
      ? viewOf(target)
      : (target.defaultView as Window) || window
  const KE = (view as Window & typeof globalThis).KeyboardEvent || KeyboardEvent

  const modifierFlags = {
    altKey: params.modifiers?.includes('alt') ?? false,
    ctrlKey: params.modifiers?.includes('ctrl') ?? false,
    metaKey: params.modifiers?.includes('meta') ?? false,
    shiftKey: params.modifiers?.includes('shift') ?? false
  }

  const base = {
    key: map.key,
    code: map.code,
    keyCode: map.keyCode ?? 0,
    which: map.keyCode ?? 0,
    bubbles: true,
    cancelable: true,
    composed: true,
    ...modifierFlags
  }

  target.dispatchEvent(new KE('keydown', base))
  if (map.text) {
    target.dispatchEvent(new KE('keypress', base))
  }
  target.dispatchEvent(new KE('keyup', base))
}

/**
 * Click-to-focus an element. dispatchClick is humanised + async; we await
 * it so the press / release events land before subsequent input dispatch.
 */
export async function focusByClick(el: Element): Promise<boolean> {
  try {
    await dispatchClick(el)
    try { (el as HTMLElement).focus({ preventScroll: true }) } catch { /* ignore */ }
    return true
  } catch {
    return false
  }
}

