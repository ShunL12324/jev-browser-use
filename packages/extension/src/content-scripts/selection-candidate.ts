// A structural candidate contract shared by observation and click witnessing.
// No site classes, handlers or page-wide text matching are used.
import { deriveName } from './interactive'
import { getOrAssignRef } from './refs'
const parent = (el: Element): Element | null => el.assignedSlot ?? el.parentElement ?? (el.getRootNode() instanceof ShadowRoot ? (el.getRootNode() as ShadowRoot).host : null)
const visible = (el: Element) => {
  const r = el.getBoundingClientRect()
  if (r.width <= 0 || r.height <= 0) return false
  for (let n: Element | null = el; n; n = parent(n)) {
    const s = getComputedStyle(n)
    if (n.matches('[hidden],[aria-hidden="true"],[inert]') || s.display === 'none' || s.visibility !== 'visible' || Number(s.opacity) === 0) return false
  }
  return true
}
function semanticText(el: Element): string {
  if (!visible(el)) return ''
  const label = el.getAttribute('aria-label')?.trim()
  if (label) return label
  return Array.from(el.childNodes).map(n => n.nodeType === Node.TEXT_NODE ? n.textContent : n instanceof Element ? semanticText(n) : '').filter(Boolean).join(' ').replace(/\s+/g, ' ').trim()
}
const choiceOwner = '[role="combobox"],[aria-autocomplete="list"],[aria-autocomplete="both"],[aria-haspopup="listbox"],[aria-haspopup="grid"]'
const disabledPath = (entry: Element, popup: Element) => {
  for (let node: Element | null = entry; node; node = node.parentElement) {
    if (node.matches('[aria-disabled="true"],:disabled,[inert]')) return true
    if (node === popup) break
  }
  return false
}
export function selectionCandidate(el: Element) {
  const popup = el.parentElement?.closest('[role="listbox"],[role="grid"]')
  if (!popup?.id || !visible(el) || !visible(popup)) return null
  const root = el.getRootNode() as Document | ShadowRoot
  if (popup.getRootNode() !== root || Array.from(root.querySelectorAll('[id]')).filter(n => n.id === popup.id).length !== 1) return null
  const owners = Array.from(root.querySelectorAll('[aria-controls]')).filter(n => (n.getAttribute('aria-controls') ?? '').split(/\s+/).includes(popup.id))
  if (owners.length !== 1) return null
  const owner = owners[0]!
  if (!owner.matches(choiceOwner)) return null
  let entry = el, label: string
  if (popup.getAttribute('role') === 'listbox') {
    if (el.getAttribute('role') !== 'option') return null
    label = deriveName(el, 10000)
  } else {
    // A generic wrapper may contain a single semantic row/cell. Multiple-cell
    // tables, headers, nested popups and arbitrary descendants are not options.
    let wrapper = el
    while (wrapper.parentElement && wrapper.parentElement !== popup) wrapper = wrapper.parentElement
    const rows = [wrapper, ...wrapper.querySelectorAll('[role="row"]')].filter(n => n.getAttribute('role') === 'row')
    if (rows.length !== 1) return null
    const cells = Array.from(rows[0]!.querySelectorAll('[role="gridcell"]'))
    if (cells.length !== 1 || !visible(cells[0]!)) return null
    entry = cells[0]!
    if (el !== wrapper && el !== entry && el !== rows[0]) return null
    if (wrapper.querySelector('[role="grid"],[role="listbox"]') || wrapper.querySelector('input,textarea,select,button,a[href],[role="button"]')) return null
    label = semanticText(entry)
  }
  if (!label || label.length > 200) return null
  const disabled = disabledPath(entry, popup) || disabledPath(el, popup) || owner.matches('[aria-disabled="true"],:disabled,[inert]')
  return { owner, popup, entry, label, disabled,
    facts: { source: 'explicit_controlled_popup', ownerRef: getOrAssignRef(owner).ref, popupRef: getOrAssignRef(popup).ref,
      entryRef: getOrAssignRef(entry).ref, disabled, kind: popup.getAttribute('role'), label } }
}

// Rejected popup members must not become ordinary CLICK targets. Remember
// membership on the actual node so removing its popup role cannot bypass it.
type Membership = { popupRef: string; status: 'eligible' | 'rejected'; reason: string }
const members = new WeakMap<Element, Membership>()
export function selectionMembership(el: Element, candidate = selectionCandidate(el)): Membership | null {
  const popup = el.closest('[role="listbox"],[role="grid"]')
  if (!popup) {
    const previous = members.get(el)
    return previous ? { ...previous, status: 'rejected', reason: 'association_lost' } : null
  }
  const root = el.getRootNode() as Document | ShadowRoot
  const controlled = popup.id && Array.from(root.querySelectorAll('[aria-controls]')).some(n => n.matches(choiceOwner) && (n.getAttribute('aria-controls') ?? '').split(/\s+/).includes(popup.id))
  // Ordinary calendar/table buttons outside a choice popup keep their normal
  // action semantics. Generic row wrappers do not gain this exception.
  const nativeAction = 'button,a[href],input,select,textarea,[role="button"]'
  if (popup.getAttribute('role') === 'grid' && !controlled && (el.matches(nativeAction) || el.getAttribute('role') === 'gridcell' && el.querySelector(nativeAction)) && !members.has(el)) return null
  const reason = !candidate ? 'unqualified_popup_member' : candidate.disabled ? 'disabled_entry' : candidate.owner.getAttribute('aria-busy') === 'true' || popup.getAttribute('aria-busy') === 'true' ? 'busy_popup' : ''
  const membership: Membership = { popupRef: getOrAssignRef(popup).ref, status: reason ? 'rejected' : 'eligible', reason }
  members.set(el, membership)
  return membership
}
