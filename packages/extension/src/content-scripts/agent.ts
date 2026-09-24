// browser_task page side: one synchronous observation of the top document
// (shadow roots included), guarded execution and a short event-driven settle.
// The bridge decides; this file only reads facts and performs one operation.
import { buildSnapshot } from './snapshot'
import { facts } from './s1'
import { documentId } from './document'
import { findByRef, getOrAssignRef } from './refs'
import { shadowOf } from './shadow'
import { actSetFiles } from './actions'
import { setNativeValue, dispatchInput, dispatchChange } from './events'
import { setConfirmPolicy, takeDenied, recentDialogs } from './guard'
import { AGENT_PROTOCOL, BUILD_ID } from '../shared/agent-protocol'

type Req = { action: string; [k: string]: unknown }
const textTypes = new Set(['text', 'search', 'email', 'url', 'tel', 'number', 'date', 'datetime-local', 'month', 'week', 'time', 'password', ''])
const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) } return (h >>> 0).toString(36) }
const inView = (r: DOMRect) => r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth
const editable = (el: Element) => el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement && textTypes.has(el.type) || (el as HTMLElement).isContentEditable
// Target plus nearby form/dialog/row text: unrelated page updates stay fresh.
function guard(el: Element) {
  const f = facts(el), scope = el.closest('form,dialog,[role="dialog"],fieldset,li,tr,[role="row"],[role="listbox"]') ?? el.parentElement
  return hash(JSON.stringify([f.role, f.name, f.value, f.checked, f.selected, f.expanded, f.disabled, f.readonly, f.context, f.dialog, scope?.textContent?.replace(/\s+/g, ' ').slice(0, 2000) ?? '']))
}
// Text of the list item / row / card holding a control, when it adds to the
// control's own name (e.g. which reservation a "Cancel" button belongs to).
function itemText(el: Element, name: string) {
  const item = el.parentElement?.closest('li,tr,article,section,[role="row"],[role="listitem"],[role="article"]') as HTMLElement | null
  const text = item?.innerText?.replace(/\s+/g, ' ').trim()
  return text && text !== name && text.length > name.length ? text.slice(0, 120) : null
}
function visibleText(limit = 6000) {
  const out: string[] = []; let length = 0
  const range = document.createRange()
  const visit = (root: Node) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT)
    for (let n = walker.nextNode(); n && length < limit; n = walker.nextNode()) {
      if (n.nodeType === 1) { const s = shadowOf(n as Element); if (s) visit(s); continue }
      const value = n.textContent?.trim(), parent = n.parentElement
      if (!value || !parent || parent.closest('script,style,noscript,template,[aria-hidden="true"]')) continue
      range.selectNodeContents(n)
      const r = range.getBoundingClientRect()
      if (r.width > 0 && r.height > 0 && inView(r) && getComputedStyle(parent).visibility !== 'hidden') { out.push(value); length += value.length + 1 }
    }
  }
  if (document.body) visit(document.body)
  return out.join('\n').slice(0, limit)
}
const shown = (el: Element) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden' }
// Read the active detail surface, never the surrounding feed. Semantic HTML
// and ARIA identify the surface; no site-specific structure is assumed.
function detail() {
  const dialogs = Array.from(document.querySelectorAll('dialog[open],[role="dialog"],[aria-modal="true"]')).filter(shown)
  const articles = Array.from(document.querySelectorAll('article,[role="article"]')).filter(shown)
  const root = (dialogs.at(-1) || (articles.length === 1 ? articles[0] : null)) as HTMLElement | null
  if (!root) return null
  const heading = root.querySelector('h1,h2,h3,[role="heading"]') as HTMLElement | null
  const author = root.querySelector('[rel="author"],[itemprop="author"],[data-author],.author') as HTMLElement | null
  const date = root.querySelector('time,[itemprop="datePublished"]') as HTMLElement | null
  const link = root.querySelector('a[rel="canonical"]') as HTMLAnchorElement | null
  return { kind: dialogs.length ? 'dialog' : 'page', title: heading?.innerText?.trim() || root.getAttribute('aria-label') || document.title,
    author: author?.innerText?.trim() || author?.getAttribute('data-author') || '', date: date?.getAttribute('datetime') || date?.innerText?.trim() || '',
    url: link?.href && link.href !== location.href ? link.href : location.href, text: root.innerText?.trim().slice(0, 16000) ?? '' }
}
// Elements within one viewport height of the visible area, nearest first,
// capped; the rest is reported as omitted (reachable by scrolling).
// Month/grid label for a cell (e.g. "November 2026"): the grid's own name,
// else the nearest short heading-like text before it.
function groupLabel(el: Element): string | null {
  const grid = el.closest('[role="grid"],table,[role="rowgroup"]')
  if (!grid) return null
  const labelled = (grid.getAttribute('aria-labelledby') ?? '').split(/\s+/).map(id => document.getElementById(id)?.textContent?.trim() ?? '').join(' ').trim()
  const own = grid.getAttribute('aria-label') || labelled || (grid.querySelector('caption') as HTMLElement | null)?.innerText
  if (own?.trim()) return own.trim().slice(0, 60)
  for (let n: Element | null = grid, d = 0; n && d < 3; n = n.parentElement, d++) {
    for (let s = n.previousElementSibling; s; s = s.previousElementSibling) {
      const t = (s as HTMLElement).innerText?.trim().split('\n')[0]?.trim()
      if (t && t.length >= 3 && t.length <= 40 && !/^[\d\s$.,]+$/.test(t)) return t
      if (t) break
    }
  }
  return null
}
const isCell = (el: Element) => el.matches('[role="gridcell"],td,[role="gridcell"] *,td *')
function observe(limit: number) {
  const snapshot = buildSnapshot({ budget: limit * 3 })
  const near = snapshot.interactables.filter(it => {
    const el = findByRef(it.ref)!, r = el.getBoundingClientRect()
    if (!(r.bottom > -innerHeight && r.top < 2 * innerHeight)) return false
    // A grid cell wrapping its own button is the same target twice.
    return !(el.getAttribute('role') === 'gridcell' && el.querySelector('button,[role="button"],a[href]'))
  })
  // Nearest first, but large grids (calendars, tables) may take at most half
  // the budget so the controls around them (Done, next month) still fit.
  let cells = 0
  const picked = near.filter(it => !isCell(findByRef(it.ref)!) || cells++ < limit / 2).slice(0, limit)
  const elements = picked.map(it => {
    const el = findByRef(it.ref)!, f = facts(el), r = el.getBoundingClientRect()
    const input = el instanceof HTMLInputElement ? el : null
    return { ref: it.ref, role: f.role, name: f.name, tag: f.tag, inputType: f.inputType, value: input?.type === 'password' ? (input.value ? '•••' : '') : f.role === 'combobox' && !(el instanceof HTMLInputElement || el instanceof HTMLSelectElement) ? (el as HTMLElement).innerText?.trim().slice(0, 120) || null : f.value,
      checked: f.checked, selected: f.selected, expanded: f.expanded, hasPopup: f.hasPopup, disabled: f.disabled || f.inert, readonly: f.readonly, required: f.required, valid: f.valid,
      modalBlocked: f.modalBlocked, dialog: f.dialog, context: f.context, href: f.href, options: f.options, files: f.files?.length, editable: editable(el) && !f.readonly,
      password: input?.type === 'password', submit: f.buttonType === 'submit' || input?.type === 'submit' || input?.type === 'image', formMethod: (el as HTMLInputElement).form?.method ?? null,
      payment: /^cc-/.test(el.getAttribute('autocomplete') ?? ''), inView: inView(r), shadow: f.shadowContext, nameTruncated: f.nameTruncated, form: (el as HTMLInputElement).form ? getOrAssignRef((el as HTMLInputElement).form!).ref : null, item: isCell(el) ? groupLabel(el) : itemText(el, f.name), placeholder: el.getAttribute('placeholder'), guard: guard(el), top: Math.round(r.top + scrollY), left: Math.round(r.left + scrollX) }
  })
  // The budget keeps the elements nearest the viewport; the model reads them
  // in page order, which is how forms and lists make sense.
  elements.sort((a, b) => a.top - b.top || a.left - b.left)
  const marker = hash(JSON.stringify([location.href, scrollY, elements.map(e => [e.ref, e.role, e.name, e.value, e.checked, e.expanded, e.disabled])]))
  return { ok: true, agentProtocol: AGENT_PROTOCOL, build: BUILD_ID, documentId, url: location.href, title: document.title, readyState: document.readyState, text: visibleText(),
    detail: detail(),
    dialogs: recentDialogs(),
    scroll: { y: Math.round(scrollY), height: document.documentElement.scrollHeight, viewport: innerHeight }, elements, omitted: snapshot.coverage.matched - picked.length, marker }
}
const reject = (code: string) => ({ ok: true as const, execution: 'not_sent', code })
// Returns null when the center is hit-testable, else a short description of
// what covers it (reported to the model instead of retrying blindly).
let lastHit: Element | null = null
function occluder(el: Element): string | null {
  let r = el.getBoundingClientRect()
  if (!(r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth)) { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); r = el.getBoundingClientRect() }
  const root = el.getRootNode() as Document | ShadowRoot, hit = root.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
  lastHit = hit
  const labels = Array.from((el as HTMLInputElement).labels ?? [])
  if (hit && (hit === el || el.contains(hit) || labels.some(l => l === hit || l.contains(hit)))) return null
  const cover = hit?.closest('[role="dialog"],dialog,[role="listbox"],[role="menu"],[aria-modal="true"]') ?? hit
  return cover ? `${cover.getAttribute('role') ?? cover.tagName.toLowerCase()} "${((cover as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)}"` : 'nothing hit-testable'
}
function press(el: HTMLElement) {
  const r = el.getBoundingClientRect(), init = { bubbles: true, cancelable: true, composed: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2, button: 0, pointerType: 'mouse' }
  el.dispatchEvent(new PointerEvent('pointerdown', { ...init, buttons: 1 })); el.dispatchEvent(new MouseEvent('mousedown', { ...init, buttons: 1 }))
  try { el.focus({ preventScroll: true }) } catch { /* not focusable */ }
  el.dispatchEvent(new PointerEvent('pointerup', init)); el.dispatchEvent(new MouseEvent('mouseup', init))
  el.click()
}
function key(el: HTMLElement, name: string) {
  const init = { key: name, code: name, keyCode: name === 'Enter' ? 13 : name === 'Escape' ? 27 : 0, bubbles: true, cancelable: true, composed: true }
  const accepted = el.dispatchEvent(new KeyboardEvent('keydown', init))
  if (name === 'Enter') el.dispatchEvent(new KeyboardEvent('keypress', { ...init, charCode: 13 }))
  el.dispatchEvent(new KeyboardEvent('keyup', init))
  // Native implicit submission for a text field whose keydown was not handled.
  if (accepted && name === 'Enter' && el instanceof HTMLInputElement && el.form) el.form.requestSubmit()
}
let navigating = false
addEventListener('beforeunload', () => { navigating = true })
async function execute(q: Req) {
  // Native confirm() during agent actions is denied and reported (main.ts);
  // without the private guard channel, committing actions fail closed.
  const committing = ['click', 'key'].includes(q.op as string)
  if (committing && !await setConfirmPolicy(q.acceptConfirm ? 'accept-once' : 'deny')) return reject('CONFIRM_GUARD_UNAVAILABLE')
  const result = run(q)
  if (committing) { const denied = await takeDenied(); await setConfirmPolicy('deny'); if (denied !== undefined && result.execution === 'returned') return { ...result, confirmDenied: denied } }
  return result
}
function run(q: Req): { ok: true; execution: string; [k: string]: unknown } {
  // Same-document URL updates (history API) keep the judgment usable; the
  // target guard below still protects the element itself.
  if (q.documentId !== documentId || new URL(q.url as string).origin !== location.origin) return reject('PAGE_CHANGED')
  const op = q.op as string
  let el: HTMLElement | null = null, redirected: string | null = null
  if (q.ref) {
    el = findByRef(q.ref as string) as HTMLElement | null
    if (!el?.isConnected) return reject('STALE_REF')
    if (guard(el) !== q.guard) return reject('STALE_REF')
    const f = facts(el)
    if (f.disabled || f.inert || f.modalBlocked || !f.visible || (op === 'type' && !editable(el))) return reject('UNREACHABLE')
    const covered = op === 'hover' ? null : occluder(el)
    // Typing into a field covered by another editable element (a search box
    // under a transparent textarea overlay): type where a user's click lands.
    const hit = lastHit as HTMLElement | null
    if (covered && (op === 'type' || op === 'key') && hit && editable(hit) && !(hit as HTMLInputElement).readOnly && facts(hit).visible && !facts(hit).disabled) { el = hit; redirected = covered }
    else if (covered) return { ...reject('UNREACHABLE'), coveredBy: covered }
  }
  // Navigation API reports same-tick cross-document navigations. A native
  // form submission is detected exactly: a submit event that no handler
  // prevented will navigate (SPA handlers call preventDefault).
  let submitEvent: Event | null = null
  const onSubmit = (e: Event) => { submitEvent = e }
  addEventListener('submit', onSubmit, true)
  const nav = (window as unknown as { navigation?: EventTarget }).navigation
  let crossDocument = false
  const onNavigate = (e: Event) => { if (!(e as unknown as { destination: { sameDocument: boolean } }).destination.sameDocument) crossDocument = true }
  nav?.addEventListener('navigate', onNavigate)
  try {
    switch (op) {
      case 'click': press(el!); break
      case 'type':
        el!.focus()
        if (el!.isContentEditable) { document.execCommand('selectAll'); document.execCommand('insertText', false, q.text as string) }
        else { setNativeValue(el as HTMLInputElement, q.text as string); dispatchInput(el!, q.text as string); dispatchChange(el!) }
        break
      case 'select': {
        if (!(el instanceof HTMLSelectElement) || !Array.from(el.options).some(o => o.value === q.value && !o.disabled)) return reject('BAD_VALUE')
        el.value = q.value as string; el.dispatchEvent(new Event('input', { bubbles: true })); dispatchChange(el); break
      }
      case 'check':
        if (!(el instanceof HTMLInputElement) || !['checkbox', 'radio'].includes(el.type)) return reject('WRONG_KIND')
        if (el.checked !== q.checked) el.click()
        break
      case 'upload':
        if (!(el instanceof HTMLInputElement) || el.type !== 'file') return reject('WRONG_KIND')
        actSetFiles({ ref: q.ref as string, files: q.files as Array<{ name: string; mimeType?: string; data: string }> }); break
      case 'key': key(el!, q.key as string); break
      case 'hover': for (const t of ['pointerover', 'mouseover', 'pointerenter', 'mouseenter', 'mousemove']) el!.dispatchEvent(new MouseEvent(t, { bubbles: !t.endsWith('enter'), composed: true })); break
      case 'scroll_down': scrollBy(0, Math.round(innerHeight * 0.8)); break
      case 'scroll_up': scrollBy(0, -Math.round(innerHeight * 0.8)); break
      case 'back': history.back(); break
      case 'close_dialog': {
        const dialogs = Array.from(document.querySelectorAll('dialog[open],[role="dialog"],[aria-modal="true"]')).filter(shown)
        const dialog = dialogs.at(-1) as HTMLElement | undefined
        if (!dialog) return reject('NO_DIALOG')
        const close = Array.from(dialog.querySelectorAll('button,[role="button"]')).find(node => /^(close|dismiss|cancel|back|×|✕|x|关闭|返回)$/i.test((node.getAttribute('aria-label') || (node as HTMLElement).innerText || '').trim())) as HTMLElement | undefined
        if (close) press(close)
        else { key(dialog, 'Escape'); if (dialog instanceof HTMLDialogElement && dialog.open) dialog.close() }
        break
      }
      case 'wait': break
      default: return reject('UNSUPPORTED')
    }
  } finally { nav?.removeEventListener('navigate', onNavigate); removeEventListener('submit', onSubmit, true) }
  const formNavigates = !!submitEvent && !(submitEvent as Event).defaultPrevented
  // Postcondition read here, on the live element: never on redacted observations.
  const target = el as HTMLInputElement | null
  const applied = op === 'type' ? (target!.isContentEditable ? target!.innerText.trim() === String(q.text).trim() : target!.value === q.text)
    : op === 'select' ? target!.value === q.value : op === 'check' ? target!.checked === q.checked : op === 'upload' ? !!target!.files?.length : undefined
  return { ok: true as const, execution: 'returned', crossDocument: crossDocument || formNavigates, ...(applied !== undefined ? { applied } : {}), ...(redirected ? { redirectedTo: redirected } : {}) }
}
// Settle state, answered immediately: the bridge does all waiting with its
// own (unthrottled) timers and polls this. A MutationObserver counter tells
// when the page has gone quiet, so background/unfocused windows, where page
// timers and animation frames are throttled, do not slow the agent down.
let mutations = 0
new MutationObserver(records => { mutations += records.length }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
async function settle() {
  const options = Array.from(document.querySelectorAll('[role="option"]')).filter(o => inView(o.getBoundingClientRect()))
  const denied = await takeDenied()
  return { ok: true, navigating, mutations, options: options.length, optionsSig: hash(options.map(o => o.textContent).join('|')),
    visibility: document.visibilityState, focused: document.hasFocus(), ...(denied !== undefined ? { confirmDenied: denied } : {}) }
}
export async function handleAgent(q: Req) {
  if (q.action === 'agent_observe') return observe(Number(q.limit ?? 400))
  if (q.action === 'agent_execute') return execute(q)
  if (q.action === 'agent_settle') return settle()
  return reject('UNSUPPORTED')
}
