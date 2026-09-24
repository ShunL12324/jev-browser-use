// Action space over one observation: which operations and targets exist, which
// supplied inputs each field could receive, and deterministic risk tiers.
// Only observed element facts are used; there is no site knowledge here.

export const norm = s => String(s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
const usable = e => !e.disabled && !e.modalBlocked && !e.unreachable
const MAX_TARGETS = 254

// Operation id → Jev-facing description. Only operations with targets (or
// page-level ones) are offered in a given cycle.
export const OPERATIONS = {
  CLICK: 'Click an element: button, link, tab, menu item, option, suggestion, checkbox, radio or a field to open it. Offscreen targets are scrolled into view automatically; no separate scroll is needed.',
  TYPE_TEXT: 'Type text that is NOT one of the supplied inputs into an editable field (supplied inputs are applied by their own questions). The caller supplies the text.',
  SELECT: 'Choose an option in a native dropdown.',
  PRESS_ENTER: 'Press Enter in a filled text field, e.g. to run a search.',
  SCROLL_DOWN: 'Scroll the page down to reveal more content.',
  SCROLL_UP: 'Scroll the page up.',
  WAIT: 'Wait briefly for loading or an update that is visibly in progress.',
  GO_BACK: 'Go back to the previous page.',
  SWITCH_TAB: 'Switch to another tab of this task (e.g. one a link opened).',
  CLOSE_TAB: 'Close another tab of this task that is no longer needed.',
  CLOSE_DIALOG: 'Close the open dialog and return to the underlying list.',
  DONE: 'Every requirement of the goal is visibly satisfied now.'
}

export function describe(e) {
  const state = [e.checked === true && 'checked', e.checked === false && 'unchecked', e.expanded === true && 'expanded', e.expanded === false && 'collapsed', e.selected === true && 'selected', e.disabled && 'disabled', !e.inView && 'offscreen'].filter(Boolean)
  return `[${e.ref}] ${e.role} "${e.name}"` + (e.context?.length ? ` in ${e.context.join(' › ')}` : '') + (e.item ? ` (item: ${JSON.stringify(e.item)})` : '') + (e.value ? ` = ${JSON.stringify(String(e.value).slice(0, 80))}` : '') + (state.length ? ` (${state.join(', ')})` : '')
}

// Fields holding an applied supplied input are protected: no operation head
// may retype, reselect or toggle them (bind owns them).
export function targets(page, used = new Set(), visited = new Set()) {
  const out = { CLICK: {}, TYPE_TEXT: {}, SELECT: {}, PRESS_ENTER: {}, SWITCH_TAB: {}, CLOSE_TAB: {} }
  for (const e of page.elements.filter(usable)) {
    if (e.inputType === 'file' || e.password) continue
    if (used.has(e.ref)) { if (e.editable && e.value && (e.tag !== 'textarea' || searchLike(e))) out.PRESS_ENTER[e.ref] = { ref: e.ref }; continue }
    // Unnamed controls give the model nothing to judge; they stay unoffered.
    if (e.tag !== 'select' && e.name && !/^<\w+>$/.test(e.name) && !visited.has(e.visitKey)) out.CLICK[e.ref] = { ref: e.ref }
    if (e.editable) out.TYPE_TEXT[e.ref] = { ref: e.ref }
    if (e.editable && e.value && (e.tag !== 'textarea' || searchLike(e))) out.PRESS_ENTER[e.ref] = { ref: e.ref }
    // Long native lists stay reachable through supplied-input binding.
    if (e.tag === 'select' && e.options?.length <= 40) e.options.forEach((o, i) => { if (!o.disabled && o.value !== '' && o.value !== e.value) out.SELECT[`${e.ref}:${i}`] = { ref: e.ref, value: o.value, label: o.label } })
  }
  // Heads are capped at 254 options; the cut is reported, never silent.
  const omitted = {}
  for (const op of Object.keys(out)) if (Object.keys(out[op]).length > MAX_TARGETS) { omitted[op] = Object.keys(out[op]).length - MAX_TARGETS; out[op] = Object.fromEntries(Object.entries(out[op]).slice(0, MAX_TARGETS)) }
  return Object.defineProperty(out, 'omitted', { value: omitted, enumerable: false })
}

export function pageOperations(page, history, used, visited) {
  const ops = {}
  const t = targets(page, used, visited)
  for (const op of ['CLICK', 'TYPE_TEXT', 'SELECT', 'PRESS_ENTER']) if (Object.keys(t[op]).length) ops[op] = OPERATIONS[op]
  if (page.scroll.y + page.scroll.viewport < page.scroll.height - 2) ops.SCROLL_DOWN = OPERATIONS.SCROLL_DOWN
  if (page.scroll.y > 0) ops.SCROLL_UP = OPERATIONS.SCROLL_UP
  if (page.tabs?.length > 1) {
    for (const tb of page.tabs) if (!tb.current) { t.SWITCH_TAB[`t${tb.id}`] = { tabId: tb.id, label: `${tb.title} (${tb.url})` }; t.CLOSE_TAB[`t${tb.id}`] = { tabId: tb.id, label: `${tb.title} (${tb.url})` } }
    ops.SWITCH_TAB = OPERATIONS.SWITCH_TAB; ops.CLOSE_TAB = OPERATIONS.CLOSE_TAB
  }
  ops.WAIT = OPERATIONS.WAIT
  if (history.some(h => h.navigated)) ops.GO_BACK = OPERATIONS.GO_BACK
  if (page.detail?.kind === 'dialog') ops.CLOSE_DIALOG = OPERATIONS.CLOSE_DIALOG
  // No BLOCKED head: an unsure model spreads mass there. Low confidence and
  // no-progress are routed to the caller by code instead.
  ops.DONE = OPERATIONS.DONE
  return { ops, targets: t }
}

// Fields that could receive one supplied input, with the host operation.
// Search inputs: Enter runs the query (also for single-line search textareas).
export const searchLike = e => !!e && e.editable && (e.role === 'searchbox' || e.inputType === 'search' || /\b(search|query|keyword|find)\b|搜索|検索|검색/i.test(`${e.name} ${e.placeholder ?? ''}`))
// Plausibility of a text for a field, from its input type and label.
export const fits = (e, v) => typed(e, v) && (!/e-?mail/i.test(e.name) || v.includes('@')) && (!/\b(phone|tel|mobile)\b/i.test(e.name) || (v.match(/\d/g) ?? []).length >= 5) && (!/\b(zip|postal|postcode)\b/i.test(e.name) || /\d/.test(v))
const typed = (e, v) => e.inputType === 'date' ? /^\d{4}-\d{2}-\d{2}$/.test(v) : e.inputType === 'number' ? /^-?\d+(\.\d+)?$/.test(v) : e.inputType === 'email' ? v.includes('@') : true
export function bindCandidates(page, input, used) {
  const out = {}
  // Secrets are origin-bound for the acting document, not just at start.
  if (input.secret) { let origin; try { origin = new URL(page.url).origin } catch { return out } if (!input.origins?.includes(origin)) return out }
  for (const e of page.elements.filter(usable)) {
    if (used.has(e.ref)) continue
    if (input.fileId) { if (e.inputType === 'file' && !e.files) out[e.ref] = { ref: e.ref, op: 'upload' }; continue }
    const v = String(input.value)
    if (e.inputType === 'checkbox') { if (['true', 'false'].includes(v) && e.checked !== (v === 'true')) out[e.ref] = { ref: e.ref, op: 'check', checked: v === 'true' }; continue }
    if (e.inputType === 'radio') { if (!e.checked && norm(e.name) === norm(v)) out[e.ref] = { ref: e.ref, op: 'check', checked: true }; continue }
    if (e.tag === 'select') { const o = e.options?.find(o => !o.disabled && (norm(o.label) === norm(v) || norm(o.value) === norm(v))); if (o && o.value !== e.value) out[e.ref] = { ref: e.ref, op: 'select', value: o.value }; continue }
    // Custom choice widgets: an option/radio/tab whose accessible name is the value.
    if (['option', 'menuitemradio', 'radio', 'tab'].includes(e.role) && !e.editable && norm(e.name) === norm(v) && e.selected !== true && e.checked !== true) { out[e.ref] = { ref: e.ref, op: 'click' }; continue }
    if (e.editable && (!e.password || input.secret) && typed(e, v) && e.value !== v) out[e.ref] = { ref: e.ref, op: 'type', text: v }
  }
  return out
}

// Deterministic risk tiers (design §2.3 table). R3 always needs confirmation.
const STRONG = /\b(buy|pay|purchase|place (an )?order|order now|checkout now|complete (the )?(purchase|order|booking)|book now|send|delete|remove|unsubscribe|transfer)\b|支付|付款|购买|下单|删除|发送/i
const PURCHASE = /\b(buy|pay|purchase|place (an )?order|order now|complete (the )?(purchase|order|booking)|book now)\b|支付|付款|购买|下单/i
const GENERIC = /\b(confirm|submit|finish|complete)\b|提交|确认|完成/i
const ADVANCE = /^(continue|next|proceed|下一步|继续)\b/i
export function irreversible(e, page) {
  const finalStep = !page.elements.some(x => x !== e && usable(x) && ADVANCE.test(x.name))
  if (e.submit && page.elements.some(x => x.payment)) return 'payment_form'
  if (PURCHASE.test(e.name) && finalStep) return 'purchase_final_step'
  if (STRONG.test(e.name) && (e.submit || e.dialog || e.formMethod === 'post')) return 'strong_word_commit'
  if (GENERIC.test(e.name) && finalStep && (e.submit || e.dialog || e.formMethod === 'post' || e.tag === 'button')) return 'generic_final_step'
  return null
}
export function tier(op, e, page) {
  if (['SCROLL_DOWN', 'SCROLL_UP', 'WAIT', 'SWITCH_TAB', 'CLOSE_TAB', 'CLOSE_DIALOG'].includes(op)) return 'R0'
  if (['TYPE_TEXT', 'SELECT', 'BIND'].includes(op)) return 'R1'
  if (op === 'GO_BACK') return 'R2'
  if (irreversible(e, page)) return 'R3'
  if (op === 'PRESS_ENTER') return e?.form && irreversible(page.elements.find(x => x.submit && x.form === e.form) ?? { ...e, submit: true, name: '', editable: false }, page) ? 'R3' : 'R2'
  // Dismissing an overlay (close / no thanks / not now) changes no data.
  if (/^(close|dismiss|no,? thanks|not now|maybe later|skip|×|✕|x)$/i.test(e.name.trim())) return 'R0'
  // Closing a picker/dialog with its confirm button (Done/OK/Apply) only
  // commits a selection inside the page: reversible, like an input.
  if (e.dialog !== null && e.dialog !== undefined && /^(done|ok|apply|select|close)\b/i.test(e.name.trim())) return 'R1'
  if (/^(done|ok)\b/i.test(e.name.trim()) && !e.submit) return 'R1'
  // Moving a picker or carousel view (next/previous month, year, slide) changes no data.
  if (/^(next|previous|prev)\s+(month|year|week|day|slide|image|photo)$/i.test(e.name.trim())) return 'R0'
  if (e.editable || e.tag === 'summary' || e.expanded !== null && e.expanded !== undefined || e.hasPopup || e.role === 'tab') return 'R0'
  if (['option', 'menuitemradio', 'menuitemcheckbox', 'checkbox', 'radio', 'switch'].includes(e.role) || ['checkbox', 'radio'].includes(e.inputType)) return 'R1'
  if (e.href) { try { const u = new URL(e.href), p = new URL(page.url); return u.origin + u.pathname + u.search === p.origin + p.pathname + p.search && u.hash ? 'R0' : 'R2' } catch { return 'R2' } }
  if (e.role === 'link') return 'R0'
  return 'R2'
}
// Routing defaults (see docs; calibrated from traces). R2 also needs a margin
// over the runner-up operation/target pair.
export const GATES = { R0: 0, R1: 0.4, R2: 0.5 }
export const R2_MARGIN = 1.3
export const SUBMIT_GATE = 0.6
// Read-only navigation (same-origin GET link or GET form submit) is reversible
// with GO_BACK: argmax at ≥0.4 without a margin (calibrated on few samples).
export const SAFE_NAV_GATE = 0.4
export function safeNavigation(op, e, page) {
  if (!e) return false
  if (op === 'CLICK' && e.href && !e.submit) { try { return new URL(e.href).origin === new URL(page.url).origin } catch { return false } }
  return (op === 'PRESS_ENTER' || e.submit) && String(e.formMethod ?? '').toLowerCase() === 'get'
}
