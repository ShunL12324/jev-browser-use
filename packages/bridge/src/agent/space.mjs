// Action space over one observation: which operations and targets exist, which
// supplied inputs each field could receive, and deterministic risk tiers.
// Only observed element facts are used; there is no site knowledge here.

export const norm = s => String(s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
const usable = e => !e.disabled && !e.modalBlocked
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
  DONE: 'Every requirement of the goal is visibly satisfied now.'
}

export function describe(e) {
  const state = [e.checked === true && 'checked', e.checked === false && 'unchecked', e.expanded === true && 'expanded', e.expanded === false && 'collapsed', e.selected === true && 'selected', e.disabled && 'disabled', !e.inView && 'offscreen'].filter(Boolean)
  return `[${e.ref}] ${e.role} "${e.name}"` + (e.context?.length ? ` in ${e.context.join(' › ')}` : '') + (e.value ? ` = ${JSON.stringify(String(e.value).slice(0, 80))}` : '') + (state.length ? ` (${state.join(', ')})` : '')
}

// Fields holding an applied supplied input are protected: no operation head
// may retype, reselect or toggle them (bind owns them).
export function targets(page, used = new Set()) {
  const out = { CLICK: {}, TYPE_TEXT: {}, SELECT: {}, PRESS_ENTER: {} }
  for (const e of page.elements.filter(usable)) {
    if (e.inputType === 'file' || e.password) continue
    if (used.has(e.ref)) { if (e.editable && e.value && e.tag !== 'textarea') out.PRESS_ENTER[e.ref] = { ref: e.ref }; continue }
    if (e.tag !== 'select') out.CLICK[e.ref] = { ref: e.ref }
    if (e.editable) out.TYPE_TEXT[e.ref] = { ref: e.ref }
    if (e.editable && e.value && e.tag !== 'textarea') out.PRESS_ENTER[e.ref] = { ref: e.ref }
    // Long native lists stay reachable through supplied-input binding.
    if (e.tag === 'select' && e.options?.length <= 40) e.options.forEach((o, i) => { if (!o.disabled && o.value !== '' && o.value !== e.value) out.SELECT[`${e.ref}:${i}`] = { ref: e.ref, value: o.value, label: o.label } })
  }
  for (const op of Object.keys(out)) if (Object.keys(out[op]).length > MAX_TARGETS) out[op] = Object.fromEntries(Object.entries(out[op]).slice(0, MAX_TARGETS))
  return out
}

export function pageOperations(page, history, used) {
  const ops = {}
  const t = targets(page, used)
  for (const op of ['CLICK', 'TYPE_TEXT', 'SELECT', 'PRESS_ENTER']) if (Object.keys(t[op]).length) ops[op] = OPERATIONS[op]
  if (page.scroll.y + page.scroll.viewport < page.scroll.height - 2) ops.SCROLL_DOWN = OPERATIONS.SCROLL_DOWN
  if (page.scroll.y > 0) ops.SCROLL_UP = OPERATIONS.SCROLL_UP
  ops.WAIT = OPERATIONS.WAIT
  if (history.some(h => h.navigated)) ops.GO_BACK = OPERATIONS.GO_BACK
  // No BLOCKED head: an unsure model spreads mass there. Low confidence and
  // no-progress are routed to the caller by code instead.
  ops.DONE = OPERATIONS.DONE
  return { ops, targets: t }
}

// Fields that could receive one supplied input, with the host operation.
const typed = (e, v) => e.inputType === 'date' ? /^\d{4}-\d{2}-\d{2}$/.test(v) : e.inputType === 'number' ? /^-?\d+(\.\d+)?$/.test(v) : e.inputType === 'email' ? v.includes('@') : true
export function bindCandidates(page, input, used) {
  const out = {}
  for (const e of page.elements.filter(usable)) {
    if (used.has(e.ref)) continue
    if (input.fileId) { if (e.inputType === 'file' && !e.files) out[e.ref] = { ref: e.ref, op: 'upload' }; continue }
    const v = String(input.value)
    if (e.inputType === 'checkbox') { if (['true', 'false'].includes(v) && e.checked !== (v === 'true')) out[e.ref] = { ref: e.ref, op: 'check', checked: v === 'true' }; continue }
    if (e.inputType === 'radio') { if (!e.checked && norm(e.name) === norm(v)) out[e.ref] = { ref: e.ref, op: 'check', checked: true }; continue }
    if (e.tag === 'select') { const o = e.options?.find(o => !o.disabled && (norm(o.label) === norm(v) || norm(o.value) === norm(v))); if (o && o.value !== e.value) out[e.ref] = { ref: e.ref, op: 'select', value: o.value }; continue }
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
  if (['SCROLL_DOWN', 'SCROLL_UP', 'WAIT'].includes(op)) return 'R0'
  if (['TYPE_TEXT', 'SELECT', 'BIND'].includes(op)) return 'R1'
  if (op === 'GO_BACK') return 'R2'
  if (irreversible(e, page)) return 'R3'
  if (op === 'PRESS_ENTER') return 'R2'
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
