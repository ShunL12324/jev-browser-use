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
// Elements within one viewport height of the visible area, nearest first,
// capped; the rest is reported as omitted (reachable by scrolling).
function observe(limit: number) {
  const snapshot = buildSnapshot({ budget: limit })
  const near = snapshot.interactables.filter(it => { const r = findByRef(it.ref)!.getBoundingClientRect(); return r.bottom > -innerHeight && r.top < 2 * innerHeight })
  const elements = near.map(it => {
    const el = findByRef(it.ref)!, f = facts(el), r = el.getBoundingClientRect()
    const input = el instanceof HTMLInputElement ? el : null
    return { ref: it.ref, role: f.role, name: f.name, tag: f.tag, inputType: f.inputType, value: input?.type === 'password' ? (input.value ? '•••' : '') : f.role === 'combobox' && !(el instanceof HTMLInputElement || el instanceof HTMLSelectElement) ? (el as HTMLElement).innerText?.trim().slice(0, 120) || null : f.value,
      checked: f.checked, selected: f.selected, expanded: f.expanded, hasPopup: f.hasPopup, disabled: f.disabled || f.inert, readonly: f.readonly, required: f.required, valid: f.valid,
      modalBlocked: f.modalBlocked, dialog: f.dialog, context: f.context, href: f.href, options: f.options, files: f.files?.length, editable: editable(el) && !f.readonly,
      password: input?.type === 'password', submit: f.buttonType === 'submit' || input?.type === 'submit' || input?.type === 'image', formMethod: (el as HTMLInputElement).form?.method ?? null,
      payment: /^cc-/.test(el.getAttribute('autocomplete') ?? ''), inView: inView(r), shadow: f.shadowContext, nameTruncated: f.nameTruncated, form: (el as HTMLInputElement).form ? getOrAssignRef((el as HTMLInputElement).form!).ref : null, guard: guard(el), top: Math.round(r.top + scrollY), left: Math.round(r.left + scrollX) }
  })
  // The budget keeps the elements nearest the viewport; the model reads them
  // in page order, which is how forms and lists make sense.
  elements.sort((a, b) => a.top - b.top || a.left - b.left)
  const marker = hash(JSON.stringify([location.href, scrollY, elements.map(e => [e.ref, e.role, e.name, e.value, e.checked, e.expanded, e.disabled])]))
  return { ok: true, documentId, url: location.href, title: document.title, readyState: document.readyState, text: visibleText(),
    dialogs: (() => { try { return JSON.parse(document.documentElement.getAttribute('data-jev-dialogs') ?? '[]') } catch { return [] } })(),
    scroll: { y: Math.round(scrollY), height: document.documentElement.scrollHeight, viewport: innerHeight }, elements, omitted: snapshot.coverage.matched - near.length, marker }
}
const reject = (code: string) => ({ ok: true, execution: 'not_sent', code })
function reachable(el: Element) {
  let r = el.getBoundingClientRect()
  if (!(r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth)) { el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' }); r = el.getBoundingClientRect() }
  const root = el.getRootNode() as Document | ShadowRoot, hit = root.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
  const labels = Array.from((el as HTMLInputElement).labels ?? [])
  return !!hit && (hit === el || el.contains(hit) || labels.some(l => l === hit || l.contains(hit)))
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
function execute(q: Req) {
  // Same-document URL updates (history API) keep the judgment usable; the
  // target guard below still protects the element itself.
  if (q.documentId !== documentId || new URL(q.url as string).origin !== location.origin) return reject('PAGE_CHANGED')
  const op = q.op as string
  let el: HTMLElement | null = null
  if (q.ref) {
    el = findByRef(q.ref as string) as HTMLElement | null
    if (!el?.isConnected) return reject('STALE_REF')
    if (guard(el) !== q.guard) return reject('STALE_REF')
    const f = facts(el)
    if (f.disabled || f.inert || f.modalBlocked || !f.visible || (op === 'type' && !editable(el))) return reject('UNREACHABLE')
    if (op !== 'hover' && !reachable(el)) return reject('UNREACHABLE')
  }
  // Navigation API reports same-tick cross-document navigations; the settle
  // step also listens for beforeunload of later scheduled ones.
  // Native confirm() during this action is answered by policy (see main.ts):
  // denied by default so a page-level commit cannot pass without a handoff.
  const root = document.documentElement
  root.setAttribute('data-jev-confirm', q.acceptConfirm ? 'accept-once' : 'deny'); root.removeAttribute('data-jev-confirm-denied')
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
      case 'wait': break
      default: return reject('UNSUPPORTED')
    }
  } finally { nav?.removeEventListener('navigate', onNavigate) }
  const confirmDenied = root.getAttribute('data-jev-confirm-denied')
  return { ok: true, execution: 'returned', crossDocument, ...(confirmDenied !== null ? { confirmDenied } : {}) }
}
// Up to two frames or 50 ms. After typing into a combobox, wait until its
// visible options exist and stop changing (async suggestions), at most 800 ms.
// Timers bound the waits because background tabs may not run animation frames.
function settle(q: Req) {
  return new Promise(resolve => {
    const start = performance.now(), el = q.ref ? findByRef(q.ref as string) : null
    const combobox = q.op === 'type' && (el?.getAttribute('role') === 'combobox' || el?.hasAttribute('aria-autocomplete') || el?.hasAttribute('list'))
    let frames = 0, done = false
    const finish = () => { if (!done) { done = true; const denied = document.documentElement.getAttribute('data-jev-confirm-denied'); resolve({ ok: true, navigating, ms: Math.round(performance.now() - start), ...(denied !== null ? { confirmDenied: denied } : {}) }) } }
    if (combobox) {
      let last = '', stable = 0
      const poll = () => {
        if (done) return
        const now = Array.from(document.querySelectorAll('[role="option"]')).filter(o => inView(o.getBoundingClientRect())).map(o => o.textContent).join('|')
        stable = now && now === last ? stable + 1 : 0; last = now
        if (stable >= 2 || performance.now() - start > 800) finish(); else setTimeout(poll, 50)
      }
      setTimeout(poll, 50); return
    }
    // watch: after a submit, keep listening for a navigation start this long.
    const watch = Number(q.watch ?? 0)
    if (watch) { const poll = () => { if (done) return; if (navigating || performance.now() - start >= watch) finish(); else setTimeout(poll, 25) }; setTimeout(poll, 25); return }
    setTimeout(finish, q.op === 'wait' ? 300 : q.quick ? 16 : 50)
    const tick = () => { if (done) return; if (++frames >= 2 && q.op !== 'wait') finish(); else requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
  })
}
export async function handleAgent(q: Req) {
  if (q.action === 'agent_observe') return observe(Number(q.limit ?? 400))
  if (q.action === 'agent_execute') return execute(q)
  if (q.action === 'agent_settle') return settle(q)
  return reject('UNSUPPORTED')
}
