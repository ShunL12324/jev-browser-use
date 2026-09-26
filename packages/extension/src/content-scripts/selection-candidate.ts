// A structural candidate contract shared by observation and click witnessing.
// No site classes, handlers or page-wide text matching are used.
import { deriveName } from './interactive'
import { getOrAssignRef } from './refs'
import { walkElements } from './dom-walker'
import { isEffectivelyInert } from './visibility'
const parent = (el: Element): Element | null => el.assignedSlot ?? el.parentElement ?? (el.getRootNode() instanceof ShadowRoot ? (el.getRootNode() as ShadowRoot).host : null)
const visible = (el: Element) => {
  const r = el.getBoundingClientRect()
  if (r.width <= 0 || r.height <= 0 || isEffectivelyInert(el)) return false
  for (let n: Element | null = el; n; n = parent(n)) {
    const s = getComputedStyle(n)
    if (n.matches('[hidden],[aria-hidden="true"]') || s.display === 'none' || s.visibility !== 'visible' || Number(s.opacity) === 0) return false
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
  for (let node: Element | null = entry; node; node = parent(node)) {
    if (node.matches('[aria-disabled="true"],:disabled,[inert]')) return true
    if (node === popup) break
  }
  return false
}
function inspectCandidate(el: Element) {
  const reject = (reason: string) => ({ candidate: null, reason })
  const popup = el.parentElement?.closest('[role="listbox"],[role="grid"]')
  if (!popup) return reject('popup_missing')
  if (!popup.id) return reject('popup_id_missing')
  if (!visible(el) || !visible(popup)) return reject('candidate_or_popup_hidden')
  const root = el.getRootNode() as Document | ShadowRoot
  if (popup.getRootNode() !== root) return reject('cross_root_popup')
  if (Array.from(root.querySelectorAll('[id]')).filter(n => n.id === popup.id).length !== 1) return reject('popup_id_not_unique')
  const owners = Array.from(root.querySelectorAll('[aria-controls]')).filter(n => (n.getAttribute('aria-controls') ?? '').split(/\s+/).includes(popup.id))
  if (owners.length !== 1) return reject(owners.length ? 'multiple_popup_owners' : 'popup_owner_missing')
  const owner = owners[0]!
  if (!owner.matches(choiceOwner)) return reject('owner_not_choice_field')
  let entry = el, label: string
  if (popup.getAttribute('role') === 'listbox') {
    if (el.getAttribute('role') !== 'option') return reject('not_listbox_option')
    label = deriveName(el, 10000)
  } else {
    // A generic wrapper may contain a single semantic row/cell. Multiple-cell
    // tables, headers, nested popups and arbitrary descendants are not options.
    let wrapper = el
    while (wrapper.parentElement && wrapper.parentElement !== popup) wrapper = wrapper.parentElement
    const rows = [wrapper, ...wrapper.querySelectorAll('[role="row"]')].filter(n => n.getAttribute('role') === 'row')
    if (rows.length !== 1) return reject(rows.length ? 'multiple_entry_rows' : 'entry_row_missing')
    const cells = Array.from(rows[0]!.querySelectorAll('[role="gridcell"]'))
    if (cells.length !== 1) return reject(cells.length ? 'multiple_entry_cells' : 'entry_cell_missing')
    if (!visible(cells[0]!)) return reject('entry_cell_hidden')
    entry = cells[0]!
    // Rendering wrappers between the popup child and its single row are the
    // same entry. Text/icon descendants inside the cell are not new targets.
    if (el !== entry && el !== rows[0] && !el.contains(rows[0]!)) return reject('not_semantic_entry_target')
    if (wrapper.querySelector('[role="grid"],[role="listbox"]')) return reject('nested_entry_popup')
    if (wrapper.querySelector('input,textarea,select,button,a[href],[role="button"]')) return reject('nested_entry_action')
    label = semanticText(entry)
  }
  if (!label || label.length > 200) return reject(label ? 'entry_label_too_long' : 'entry_label_missing')
  const disabled = disabledPath(entry, popup) || disabledPath(el, popup) || owner.matches('[aria-disabled="true"],:disabled,[inert]')
  return { reason: '', candidate: { owner, popup, entry, label, disabled,
    facts: { source: 'explicit_controlled_popup', ownerRef: getOrAssignRef(owner).ref, popupRef: getOrAssignRef(popup).ref,
      entryRef: getOrAssignRef(entry).ref, disabled, kind: popup.getAttribute('role'), label } } }
}

export function selectionCandidate(el: Element) { return inspectCandidate(el).candidate }

// Rejected popup members must not become ordinary CLICK targets. Remember
// membership on the actual node so removing its popup role cannot bypass it.
type Membership = { popupRef: string; status: 'eligible' | 'rejected'; reason: string }
const members = new WeakMap<Element, Membership>()
const choicePopups = new WeakSet<Element>()
function isChoicePopup(node: Element) {
  if (choicePopups.has(node)) return true
  if (!node.matches('[role="listbox"],[role="grid"]')) return false
  const root = node.getRootNode() as Document | ShadowRoot
  const controlled = node.id && Array.from(root.querySelectorAll('[aria-controls]')).some(n => n.matches(choiceOwner) && (n.getAttribute('aria-controls') ?? '').split(/\s+/).includes(node.id))
  if (!controlled && node.getAttribute('role') !== 'listbox') return false
  choicePopups.add(node)
  return true
}
function descendantsOf(el: Element) {
  const nodes = Array.from(walkElements(el)), seen = new Set(nodes)
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!
    if (!(node instanceof HTMLSlotElement)) continue
    for (const assigned of node.assignedElements({ flatten: true })) for (const child of walkElements(assigned)) {
      if (!seen.has(child)) { seen.add(child); nodes.push(child) }
    }
  }
  return nodes
}
export function selectionMembership(el: Element, candidate = selectionCandidate(el)): Membership | null {
  // Walk composed ancestors: an unowned inner grid cannot turn a descendant
  // of an outer choice popup into a standalone calendar button.
  const popups: Element[] = []
  for (let node: Element | null = el; node; node = parent(node)) {
    if (node.matches('[role="listbox"],[role="grid"]')) {
      isChoicePopup(node)
      popups.push(node)
    } else if (choicePopups.has(node)) popups.push(node)
  }
  const popup = popups[0]
  // An outer card/search panel containing a choice popup is not a choice.
  // Preserve actual owner controls so opening/closing their popup still works.
  const descendants = descendantsOf(el).filter(child => child !== el && isChoicePopup(child) && visible(child))
  for (const child of descendants) {
    const root = child.getRootNode() as Document | ShadowRoot
    const owners = child.id ? Array.from(root.querySelectorAll('[aria-controls]')).filter(n => (n.getAttribute('aria-controls') ?? '').split(/\s+/).includes(child.id)) : []
    const uniqueId = child.id && Array.from(root.querySelectorAll('[id]')).filter(n => n.id === child.id).length === 1
    if (descendants.length === 1 && uniqueId && owners.length === 1 && owners[0] === el && el.matches(choiceOwner)) continue
    const membership: Membership = { popupRef: getOrAssignRef(child).ref, status: 'rejected', reason: 'aggregate_popup_container' }
    members.set(el, membership)
    return membership
  }
  if (!popup) {
    const previous = members.get(el)
    if (previous) return { ...previous, status: 'rejected', reason: 'association_lost' }
    return null
  }
  const nativeAction = 'button,a[href],input,select,textarea,[role="button"],[role="checkbox"],[role="radio"],[role="switch"]'
  const choiceContext = popups.some(n => choicePopups.has(n))
  // Only genuinely standalone, never-choice grids qualify. Remembered popup
  // roots protect descendants first observed after its role/owner is removed.
  if (popups.length === 1 && popup.getAttribute('role') === 'grid' && !choiceContext && (el.matches(nativeAction) || el.getAttribute('role') === 'gridcell' && el.querySelector(nativeAction)) && !members.has(el)) {
    if (disabledPath(el, popup)) return { popupRef: getOrAssignRef(popup).ref, status: 'rejected', reason: 'disabled_entry' }
    return null
  }
  const reason = popups.length > 1 ? 'nested_popup' : !popup.matches('[role="grid"],[role="listbox"]') ? 'association_lost' : !candidate ? inspectCandidate(el).reason || 'unqualified_popup_member' : candidate.disabled ? 'disabled_entry' : candidate.owner.getAttribute('aria-busy') === 'true' || popup.getAttribute('aria-busy') === 'true' ? 'busy_popup' : ''
  const membership: Membership = { popupRef: getOrAssignRef(popup).ref, status: reason ? 'rejected' : 'eligible', reason }
  members.set(el, membership)
  return membership
}
