import { getOrAssignRef } from './refs'
import { isEffectivelyInert } from './visibility'

const roots = new WeakMap<Node, string>()
let nextRoot = 0
const parent = (el: Element): Element | null => el.assignedSlot ?? el.parentElement ?? (el.getRootNode() instanceof ShadowRoot ? (el.getRootNode() as ShadowRoot).host : null)
function visible(el: Element) {
  if (!el.isConnected || isEffectivelyInert(el)) return false
  const rect = el.getBoundingClientRect()
  if (!rect.width || !rect.height) return false
  for (let n: Element | null = el; n; n = parent(n)) {
    const s = getComputedStyle(n)
    if (n.matches('[hidden],[aria-hidden="true"]') || s.display === 'none' || s.visibility !== 'visible' || Number(s.opacity) === 0 || s.contentVisibility === 'hidden') return false
    if (n !== el && /(hidden|clip|scroll|auto)/.test(s.overflowX + s.overflowY)) {
      const r = n.getBoundingClientRect()
      if (rect.right <= r.left || rect.left >= r.right || rect.bottom <= r.top || rect.top >= r.bottom) return false
    }
  }
  return true
}
function readableText(el: Element) {
  const out: string[] = [], walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT), range = document.createRange()
  let length = 0, cut = false
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!n.parentElement || !visible(n.parentElement) || n.parentElement.closest('script,style,template')) continue
    range.selectNodeContents(n)
    if (![...range.getClientRects()].some(r => r.width > 0 && r.height > 0)) continue
    const t = n.textContent?.replace(/\s+/g, ' ').trim()
    if (t) { out.push(t); length += t.length + 1 }
    if (length > 1000) { cut = true; break }
  }
  const text = out.join(' ')
  return { text: text.slice(0, 1000), complete: !cut && text.length <= 1000 }
}
// Read properties only: validity checks must never dispatch invalid events.
export function fieldFeedback(el: Element) {
  const input = el instanceof HTMLInputElement, textarea = el instanceof HTMLTextAreaElement
  const control = input || textarea || el instanceof HTMLSelectElement ? el : null
  if (input && el.type === 'password' || !control && !(el as HTMLElement).isContentEditable) return null
  const root = el.getRootNode() as Document | ShadowRoot
  if (!roots.has(root)) roots.set(root, `root${++nextRoot}`)
  const raw = el.getAttribute('aria-invalid')
  const invalid = raw !== null && raw !== '' && raw !== 'false'
  const descriptions = ['aria-errormessage', 'aria-describedby'].flatMap(source => {
    const attribute = el.getAttribute(source)
    if (attribute && attribute.length > 2000) return [{ source, attribute: attribute.slice(0, 2000), id: '', status: 'attribute_too_long', targetRef: null, text: '', complete: false }]
    const ids = [...new Set(attribute?.trim().split(/\s+/).filter(Boolean) ?? [])]
    if (ids.length > 20) return [{ source, attribute, id: '', status: 'too_many_ids', targetRef: null, text: '', complete: false }]
    return ids.map(id => {
      const matches = Array.from(root.querySelectorAll('[id]')).filter(n => n.id === id)
      const target = matches.length === 1 ? matches[0]! : null
      const status = !matches.length ? 'missing' : matches.length > 1 ? 'ambiguous' : !visible(target!) ? 'hidden' : 'visible'
      return { source, attribute, id, targetRef: target ? getOrAssignRef(target).ref : null, status, ...(status === 'visible' ? readableText(target!) : { text: '', complete: true }) }
    })
  })
  const validity = control ? Object.fromEntries(['badInput', 'customError', 'patternMismatch', 'rangeOverflow', 'rangeUnderflow', 'stepMismatch', 'tooLong', 'tooShort', 'typeMismatch', 'valid', 'valueMissing'].map(k => [k, control.validity[k as keyof ValidityState]])) : null
  return { ownerRef: getOrAssignRef(el).ref, rootId: roots.get(root)!, connected: el.isConnected,
    constraints: { maxLength: input || textarea ? el.maxLength : null, minLength: input || textarea ? el.minLength : null,
      attributes: Object.fromEntries(['maxlength', 'minlength', 'pattern', 'required', 'min', 'max', 'step'].map(k => [k, el.getAttribute(k)?.slice(0, 1000) ?? null])),
      truncatedAttributes: ['maxlength', 'minlength', 'pattern', 'required', 'min', 'max', 'step'].filter(k => (el.getAttribute(k)?.length ?? 0) > 1000) },
    native: { willValidate: control?.willValidate ?? false, validity, validationMessage: control?.validationMessage.slice(0, 1000) ?? '', messageComplete: (control?.validationMessage.length ?? 0) <= 1000 },
    ariaInvalid: { raw, invalid }, descriptions }
}
