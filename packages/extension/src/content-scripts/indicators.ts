// Visual indicators that overlay the page during an agent run.
//
// Three pieces, all painted into the top frame's <body> as fixed elements:
//   • Glow border — orange pulsing inset shadow around the viewport edge;
//     ambient signal "agent is active here right now"
//   • Phantom cursor — SVG arrow that animates to the agent's last action
//     point; cubic-bezier transition makes movement feel intentional
//   • Stop button — pill bottom-center; click sends agent.stop upward
//
// Pure additive — no model contract change, no manifest change (rides the
// existing isolated-world content script bundle, top-frame-only).
//
// State is module-local. Idempotent installation via a window flag so a
// repeat injection (SPA route change re-running document_start scripts)
// doesn't stack multiple overlays.

const INSTALL_FLAG = '__quarry_indicators_installed__'

let glowEl: HTMLDivElement | null = null
let cursorEl: HTMLDivElement | null = null
let stopEl: HTMLDivElement | null = null
let visible = false
let cursorX = -1
let cursorY = -1

const Z = 2147483646  // one below max — leaves room for emergency overlays
const Z_STOP = 2147483647

/** Top-frame-only. Subframe indicators would stack and look chaotic. */
function isTopFrame(): boolean {
  return window.top === window
}

/** Install once per page. Returns immediately on subframes or repeat calls. */
export function installIndicators(): void {
  if (!isTopFrame()) return
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if ((window as any)[INSTALL_FLAG]) return
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any)[INSTALL_FLAG] = true
  ensureStyles()
}

function ensureStyles(): void {
  if (document.getElementById('__quarry_indicators_styles__')) return
  const css = `
    @keyframes __quarry_glow_pulse {
      0%, 100% { box-shadow:
        inset 0 0 12px rgba(217, 119, 87, 0.45),
        inset 0 0 24px rgba(217, 119, 87, 0.28),
        inset 0 0 36px rgba(217, 119, 87, 0.12); }
      50%      { box-shadow:
        inset 0 0 18px rgba(217, 119, 87, 0.65),
        inset 0 0 30px rgba(217, 119, 87, 0.45),
        inset 0 0 42px rgba(217, 119, 87, 0.18); }
    }
    @keyframes __quarry_fade_in  { from { opacity: 0 } to { opacity: 1 } }
    @keyframes __quarry_fade_out { from { opacity: 1 } to { opacity: 0 } }
    @keyframes __quarry_slide_up { from { transform: translate(-50%, 16px); opacity: 0 } to { transform: translate(-50%, 0); opacity: 1 } }
  `
  const style = document.createElement('style')
  style.id = '__quarry_indicators_styles__'
  style.textContent = css
  ;(document.head || document.documentElement).appendChild(style)
}

function ensureGlow(): HTMLDivElement {
  if (glowEl && glowEl.isConnected) return glowEl
  const el = document.createElement('div')
  el.id = '__quarry_glow__'
  el.setAttribute('aria-hidden', 'true')
  Object.assign(el.style, {
    position: 'fixed',
    inset: '0',
    pointerEvents: 'none',
    zIndex: String(Z),
    opacity: '0',
    transition: 'opacity 240ms cubic-bezier(0.2, 0, 0, 1)',
    animation: '__quarry_glow_pulse 2.4s ease-in-out infinite'
  } as Partial<CSSStyleDeclaration>)
  document.body.appendChild(el)
  glowEl = el
  return el
}

function ensureCursor(): HTMLDivElement {
  if (cursorEl && cursorEl.isConnected) return cursorEl
  const el = document.createElement('div')
  el.id = '__quarry_cursor__'
  el.setAttribute('aria-hidden', 'true')
  Object.assign(el.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    width: '20px',
    height: '26px',
    pointerEvents: 'none',
    zIndex: String(Z),
    opacity: '0',
    transform: 'translate3d(-100px, -100px, 0)',
    transition: 'transform 180ms cubic-bezier(0.2, 0, 0, 1), opacity 200ms ease-out',
    willChange: 'transform, opacity'
  } as Partial<CSSStyleDeclaration>)
  // Two stacked SVG paths for the cursor: an outer stroke for contrast and
  // an inner fill. Color matches Anthropic's coral so the user can tell
  // "this is the agent's mouse" at a glance.
  el.innerHTML = `
    <svg width="20" height="26" viewBox="0 0 20 26" style="position:absolute;top:0;left:0;overflow:visible;
        filter: drop-shadow(0 0 4px rgba(217,119,87,0.55)) drop-shadow(0 1px 3px rgba(0,0,0,0.35));">
      <path d="M0 0 L0 18 L4.5 14 L7.5 21.5 L11 20 L8 13 L14 13 Z"
            stroke="white" stroke-width="2.5" stroke-linejoin="round" fill="#D97757"/>
    </svg>
  `
  document.body.appendChild(el)
  cursorEl = el
  return el
}

function ensureStop(): HTMLDivElement {
  if (stopEl && stopEl.isConnected) return stopEl
  const wrap = document.createElement('div')
  wrap.id = '__quarry_stop__'
  Object.assign(wrap.style, {
    position: 'fixed',
    bottom: '20px',
    left: '50%',
    transform: 'translate(-50%, 16px)',
    pointerEvents: 'none',
    zIndex: String(Z_STOP),
    opacity: '0',
    transition: 'opacity 200ms ease-out, transform 240ms cubic-bezier(0.2, 0, 0, 1)'
  } as Partial<CSSStyleDeclaration>)

  const btn = document.createElement('button')
  btn.type = 'button'
  btn.id = '__quarry_stop_btn__'
  btn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 256 256" fill="currentColor" style="margin-right:8px;vertical-align:middle">
      <path d="M128 20a108 108 0 1 0 108 108A108.12 108.12 0 0 0 128 20Zm0 192a84 84 0 1 1 84-84 84.09 84.09 0 0 1-84 84Zm40-112v56a12 12 0 0 1-12 12h-56a12 12 0 0 1-12-12v-56a12 12 0 0 1 12-12h56a12 12 0 0 1 12 12Z"/>
    </svg>
    <span style="vertical-align:middle">Stop Quarry</span>
  `
  Object.assign(btn.style, {
    pointerEvents: 'auto',
    cursor: 'pointer',
    userSelect: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    padding: '10px 16px',
    fontSize: '13px',
    fontWeight: '600',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    color: '#141413',
    background: '#FAF9F5',
    border: '0.5px solid rgba(31, 30, 29, 0.30)',
    borderRadius: '12px',
    boxShadow:
      '0 24px 48px rgba(217, 119, 87, 0.28), 0 4px 14px rgba(217, 119, 87, 0.20)',
    transition: 'background 160ms ease-out, transform 120ms ease-out'
  } as Partial<CSSStyleDeclaration>)
  btn.addEventListener('mouseenter', () => { btn.style.background = '#F5F4F0' })
  btn.addEventListener('mouseleave', () => { btn.style.background = '#FAF9F5' })
  btn.addEventListener('mousedown',  () => { btn.style.transform = 'scale(0.97)' })
  btn.addEventListener('mouseup',    () => { btn.style.transform = 'scale(1)' })
  btn.addEventListener('click', () => {
    try {
      chrome.runtime.sendMessage({ source: 'content', type: 'agent.stop' })
    } catch {
      /* SW asleep — best effort */
    }
  })
  wrap.appendChild(btn)
  document.body.appendChild(wrap)
  stopEl = wrap
  return wrap
}

export function showIndicators(): void {
  if (!isTopFrame()) return
  if (!document.body) {
    // document_idle should have fired, but defensively wait for body if not.
    document.addEventListener('DOMContentLoaded', () => showIndicators(), { once: true })
    return
  }
  ensureStyles()
  const glow = ensureGlow()
  const cursor = ensureCursor()
  const stop = ensureStop()

  requestAnimationFrame(() => {
    glow.style.opacity = '1'
    if (cursorX >= 0 && cursorY >= 0) cursor.style.opacity = '1'
    stop.style.opacity = '1'
    stop.style.transform = 'translate(-50%, 0)'
  })
  visible = true
}

export function hideIndicators(): void {
  if (!isTopFrame()) return
  visible = false
  if (glowEl) glowEl.style.opacity = '0'
  if (cursorEl) cursorEl.style.opacity = '0'
  if (stopEl) {
    stopEl.style.opacity = '0'
    stopEl.style.transform = 'translate(-50%, 16px)'
  }
  // Hard cleanup after the fade so the next show doesn't get stale animations.
  setTimeout(() => {
    if (visible) return  // re-shown in the meantime
    try { glowEl?.remove() } catch { /* ignore */ }
    try { cursorEl?.remove() } catch { /* ignore */ }
    try { stopEl?.remove() } catch { /* ignore */ }
    glowEl = null
    cursorEl = null
    stopEl = null
  }, 360)
}

/** Move the phantom cursor to (x, y) in viewport coords. No-op in subframes
 *  and when indicators aren't visible — we still record the latest coord so
 *  a subsequent showIndicators() can place the cursor immediately. */
export function updateCursorPos(x: number, y: number): void {
  if (!isTopFrame()) return
  cursorX = x
  cursorY = y
  if (!visible) return
  const cursor = ensureCursor()
  // Offset by -2,-2 so the cursor TIP (top-left of the SVG) lands on the
  // target point, not the cursor body's origin.
  cursor.style.transform = `translate3d(${x - 2}px, ${y - 2}px, 0)`
  cursor.style.opacity = '1'
}
