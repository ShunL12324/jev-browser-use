import { actSetFiles } from './actions'
import { shadowOf } from './shadow'
import { documentId } from './document'
import { buildSnapshot } from './snapshot'
import { buildView } from './view'
import { deriveName, deriveRole, isDisabled, getValue } from './interactive'
import { getBounds, isVisible } from './visibility'
import { findByRef } from './refs'
import { setNativeValue, dispatchInput, dispatchChange } from './events'
import type { Assertion, Locator, S1Request, S1Result } from '../shared/s1'

const textTypes = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date', 'datetime-local', 'month', 'week', 'time'])
const visible = (el: Element) => { const b = getBounds(el); return !!b && isVisible(el, b) }
const dialogs = () => Array.from(document.querySelectorAll('dialog[open], [role="dialog"][aria-modal="true"]')).filter(visible)
export function facts(el: Element, active = dialogs()) {
  const dialog = active.find(d => d.contains(el))
  const input = el instanceof HTMLInputElement, textarea = el instanceof HTMLTextAreaElement
  const name = deriveName(el, 10000)
  const context: string[] = []
  for (let parent = el.parentElement; parent; parent = parent.parentElement) {
    if (parent.matches('fieldset, [role="group"], [role="radiogroup"], [role="row"], section[aria-label], section[aria-labelledby]')) {
      const label = parent instanceof HTMLFieldSetElement ? parent.querySelector(':scope > legend')?.textContent?.trim() : deriveName(parent, 10000)
      if (label) context.unshift(label)
    }
  }
  const rect = el.getBoundingClientRect(), hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
  const select = el instanceof HTMLSelectElement

  const ids = el.getAttribute('aria-labelledby')?.trim().split(/\s+/) ?? []
  const unresolvedLabel = ids.length > 20 || ids.some(id => !document.getElementById(id))
  return {
    tag: el.tagName.toLowerCase(), role: deriveRole(el), name: name.slice(0, 200), nameTruncated: name.length > 200 || unresolvedLabel,
    disabled: isDisabled(el) || el.matches(':disabled'), readonly: input || textarea ? el.readOnly : false,
    inert: !!el.closest('[inert]'), modalBlocked: active.length > 0 && !dialog,
    dialog: dialog ? deriveName(dialog, 200) : null,
    context, contextTruncated: context.some(c => c.length > 200) || context.length > 12,
    centerReachable: !!hit && (hit === el || el.contains(hit)),
    checked: input && ['checkbox', 'radio'].includes(el.type) ? el.checked : null,
    nativeCheck: input && ['checkbox', 'radio'].includes(el.type),
    nativeSelect: select && !el.multiple,
    options: select ? Array.from(el.options).map(o => ({ value: o.value, label: o.label, disabled: o.disabled || !!o.closest('optgroup[disabled]') })) : undefined,
    nativeFile: input && el.type === 'file',
    files: input && el.type === 'file' ? Array.from(el.files ?? []).map(f => ({ name: f.name, size: f.size, type: f.type })) : undefined,
    accept: input && el.type === 'file' ? el.accept : undefined,
    labels: Array.from((el as HTMLInputElement).labels ?? []).map(l => l.textContent?.trim() ?? ''),
    value: getValue(el) ?? null, inputType: input ? el.type : null,
    nativeText: textarea || (input && textTypes.has(el.type)),
    nativeActivate: el instanceof HTMLButtonElement || el instanceof HTMLAnchorElement || ['button', 'option', 'tab', 'menuitem', 'combobox'].includes(el.getAttribute('role') ?? '') && !input && !select,
    href: el instanceof HTMLAnchorElement ? el.href : null,
    visible: visible(el), shadowContext: el.getRootNode() !== document
  }
}
function locate(root: Document | Element, locator: Locator): Element[] {
  if (locator.kind === 'selector') return Array.from(root.querySelectorAll(locator.css))
  return Array.from(root.querySelectorAll('*')).filter(el => visible(el) && deriveRole(el) === locator.role && deriveName(el, 10000) === locator.name)
}
function collect(a: Assertion) {
  const base = { id: a.id, source: a.read === 'value' ? 'dom_property' : 'dom_text', documentId }
  try {
    const roots = locate(document, a.scope.root)
    if (roots.length !== 1) return { ...base, complete: false, reason: 'scope_not_unique' }
    const root = roots[0]!
    // S1 does not claim absence through shadow/frame boundaries.
    if (root.matches('iframe') || shadowOf(root) || root.querySelector('iframe') || Array.from(root.querySelectorAll('*')).some(el => shadowOf(el))) return { ...base, complete: false, reason: 'unsupported_scope' }
    const subjects = a.subject === 'scope' ? [root] : locate(root, a.subject)
    if (subjects.length > 1) return { ...base, complete: false, reason: 'subject_not_unique' }
    const el = subjects[0]
    if (a.read === 'exists') return { ...base, complete: true, value: !!el }
    if (!el) return { ...base, complete: false, reason: 'subject_missing' }
    const value = a.read === 'value' ? getValue(el) : (el as HTMLElement).innerText?.trim()
    if (value === undefined) return { ...base, complete: false, reason: 'property_missing' }
    return { ...base, value: value.slice(0, 4000), complete: value.length <= 4000, reason: value.length > 4000 ? 'text_cut' : undefined }
  } catch { return { ...base, complete: false, reason: 'locator_invalid' } }
}
function reject(code: string): S1Result { return { ok: true, execution: 'not_sent', code } }
export async function handleS1(request: S1Request): Promise<S1Result> {
  if (request.action === 'observe') {
    const snapshot = buildSnapshot({ budget: request.limit ?? 500 }), view = buildView()
    const active = dialogs()
    const objects = snapshot.interactables.map(it => ({ ref: it.ref, facts: facts(findByRef(it.ref)!, active) }))
    const relations = objects.flatMap(o => [
      ...o.facts.labels.map(label => ({ from: o.ref, kind: 'labelled_by', label })),
      ...(o.facts.dialog ? [{ from: o.ref, kind: 'in_dialog', label: o.facts.dialog }] : [])
    ])
    return { ok: true, documentId, url: location.href, title: document.title, snapshot, view: { ...view, documentId }, objects, relations,
      assertions: request.assertions.map(collect), scroll: { x: scrollX, y: scrollY }, capturedAt: new Date().toISOString() }
  }
  if (request.documentId !== documentId || request.url !== location.href) return reject('PAGE_CHANGED')
  if (!request.allowedOrigins.includes(location.origin)) return reject('ORIGIN_CHANGED')
  let el: Element | undefined
  if (request.ref) {
    el = findByRef(request.ref) ?? undefined
    if (!el) return reject('STALE_REF')
    const current = facts(el)
    if (JSON.stringify(current) !== JSON.stringify(request.expected)) return reject('STALE_REF')
    if (current.shadowContext || current.disabled || current.readonly && request.operation === 'replace_text' || current.inert || current.modalBlocked || !current.visible || current.nameTruncated || current.contextTruncated) return reject('UNREACHABLE')
    if (request.operation !== 'scroll_into_view') {
      const rect = el.getBoundingClientRect(), hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
      if (!hit || !(hit === el || el.contains(hit))) return reject('UNREACHABLE')
    }
    if (current.href && !request.allowedOrigins.includes(new URL(current.href).origin)) return reject('ORIGIN_CHANGED')
  }
  // No await between final facts/identity check and dispatch. This guarantees
  // document/DOM preconditions, not atomicity of the site's business handler.
  switch (request.operation) {
    case 'activate':
      if (!el || !facts(el).nativeActivate) return reject('WRONG_KIND');
      (el as HTMLElement).click()
      break
    case 'replace_text':
      if (!el || !facts(el).nativeText || typeof request.text !== 'string') return reject('WRONG_KIND');
      (el as HTMLElement).focus()
      setNativeValue(el as HTMLInputElement, request.text)
      dispatchInput(el, request.text); dispatchChange(el)
      break
    case 'select_option': {
      if (!(el instanceof HTMLSelectElement) || el.multiple || typeof request.text !== 'string') return reject('WRONG_KIND')
      const matches = Array.from(el.options).filter(o => o.value === request.text && !o.disabled && !o.closest('optgroup[disabled]'))
      if (matches.length !== 1) return reject('BAD_VALUE_DOMAIN')
      el.value = request.text
      el.dispatchEvent(new Event('input', { bubbles: true })); dispatchChange(el)
      break
    }
    case 'set_checked':
      if (!(el instanceof HTMLInputElement) || !facts(el).nativeCheck || typeof request.checked !== 'boolean' || el.type === 'radio' && !request.checked) return reject('WRONG_KIND')
      if (el.checked !== request.checked) el.click()
      break
    case 'upload_file':
      if (!el || !facts(el).nativeFile || !request.files?.length) return reject('WRONG_KIND')
      actSetFiles({ ref: request.ref!, files: request.files })
      break
    case 'scroll_into_view':
      if (!el) return reject('WRONG_KIND')
      el.scrollIntoView({ block: 'center', behavior: 'instant' }); break
    case 'scroll_down': window.scrollBy(0, 550); break
    case 'scroll_up': window.scrollBy(0, -550); break
    case 'wait': await new Promise(resolve => setTimeout(resolve, 400)); break
    default: return reject('UNSUPPORTED')
  }
  return { ok: true, execution: 'returned', documentId }
}
