import { selectionCandidate } from './selection-candidate'
// A click may replace a combobox with a chip. Keep the explicitly labelled
// field scope, never a page-wide text match, as a read-only selection witness.
import { facts } from './s1'
import { getOrAssignRef } from './refs'

const norm = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
const fieldSelector = 'input:not([type="hidden"]),textarea,select,[role="combobox"],[contenteditable="true"]'
const parent = (el: Element): Element | null => el.assignedSlot ?? el.parentElement ?? (el.getRootNode() instanceof ShadowRoot ? (el.getRootNode() as ShadowRoot).host : null)
const visible = (el: Element) => {
  const r = el.getBoundingClientRect()
  if (r.width <= 0 || r.height <= 0 || el.closest('[hidden],[aria-hidden="true"]')) return false
  for (let node: Element | null = el; node; node = parent(node)) {
    if (node.matches('[hidden],[aria-hidden="true"]')) return false
    const style = getComputedStyle(node)
    if (style.display === 'none' || ['hidden', 'collapse'].includes(style.visibility) || Number(style.opacity) === 0 || style.clip !== 'auto' || style.clipPath !== 'none') return false
  }
  return true
}
type Witness = { owner: Element; scope: Element; labels: Element[]; lists: Element[]; option: string; baseline: Set<string>; root: Document | ShadowRoot; ownerId: string; labelledBy: string | null; labelFor: (string | null)[]; controlIds: string[]; revoked?: boolean }
const watches = new Map<string, Witness>()
function display(w: Witness): Set<string> {
  const values = new Set<string>()
  for (const el of [w.scope, ...w.scope.querySelectorAll('*')]) {
    if (!visible(el) || w.labels.includes(el) || el.matches('input,textarea,select') || el.closest('[role="listbox"],[role="grid"],[role="option"]')) continue
    // Text must belong to this display node, not an ancestor aggregating the
    // field label, unrelated help text and a query's value.
    const ownText = Array.from(el.childNodes).filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent ?? '').join(' ').trim()
    for (const value of [ownText, el.getAttribute('title'), el.getAttribute('aria-label')]) if (value?.trim()) values.add(norm(value))
  }
  return values
}
export function watchSelection(option: Element) {
  const candidate = selectionCandidate(option)
  if (!candidate) return
  const list = candidate.popup
  if (!list?.id) return
  const root = option.getRootNode() as Document | ShadowRoot
  if (Array.from(root.querySelectorAll('[id]')).filter(e => e.id === list.id).length !== 1) return
  const owners = Array.from(root.querySelectorAll('[aria-controls]')).filter(e => (e.getAttribute('aria-controls') ?? '').split(/\s+/).includes(list.id))
  if (owners.length !== 1) return
  const owner = owners[0]!, f = facts(owner)
  if (!(f.role === 'combobox' || ['listbox', 'grid'].includes(f.hasPopup ?? '') || ['list', 'both'].includes(owner.getAttribute('aria-autocomplete') ?? '')) || f.controls.status !== 'known') return
  const labels = Array.from((owner as HTMLInputElement).labels ?? []) as Element[]
  for (const id of (owner.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean)) {
    const matches = Array.from(root.querySelectorAll('[id]')).filter(e => e.id === id)
    if (matches.length !== 1) return
    labels.push(matches[0]!)
  }
  let scope: Element | null = owner
  if (owner.matches('input,textarea')) {
    if (!labels.length) return
    for (let depth = 0; scope && depth < 6 && !labels.every(l => scope!.contains(l)); depth++) scope = scope.parentElement
    if (!scope || !labels.every(l => scope!.contains(l))) return
  }
  if (scope.matches('form,body,html') || Array.from(scope.querySelectorAll(fieldSelector)).some(e => e !== owner)) return
  const ids = (owner.getAttribute('aria-controls') ?? '').split(/\s+/)
  const lists = Array.from(root.querySelectorAll('[id]')).filter(e => ids.includes(e.id))
  const w: Witness = { owner, scope, labels, lists, option: candidate.label, baseline: new Set(), root, ownerId: owner.id, labelledBy: owner.getAttribute('aria-labelledby'), labelFor: labels.map(l => l.getAttribute('for')), controlIds: ids }
  w.baseline = display(w)
  watches.set(getOrAssignRef(owner).ref, w)
  // Bound retained DOM nodes for long-lived pages.
  if (watches.size > 100) watches.delete(watches.keys().next().value!)
}
export function selectionWitnesses() {
  return Array.from(watches, ([ref, w]) => {
    const currentIds = (w.owner.getAttribute('aria-controls') ?? '').split(/\s+/).filter(Boolean)
    const listsCurrent = w.controlIds.every(id => {
      const matches = Array.from(w.root.querySelectorAll('[id]')).filter(e => e.id === id)
      return matches.length === 0 || matches.length === 1 && w.lists.includes(matches[0]!)
    })
    const exclusive = !Array.from(w.root.querySelectorAll('[aria-controls]')).some(e => e !== w.owner && (e.getAttribute('aria-controls') ?? '').split(/\s+/).some(id => w.controlIds.includes(id)))
    const uniqueId = (id: string, node: Element) => { const matches = Array.from(w.root.querySelectorAll('[id]')).filter(e => e.id === id); return matches.length === 1 && matches[0] === node }
    const explicitLabels = (w.labelledBy ?? '').split(/\s+/).filter(Boolean)
    const nativeLabels = Array.from((w.owner as HTMLInputElement).labels ?? []) as Element[]
    const labelsCurrent = (!w.ownerId || uniqueId(w.ownerId, w.owner)) && explicitLabels.every(id => w.labels.some(l => l.id === id && uniqueId(id, l))) && w.labels.every(l => explicitLabels.includes(l.id) || nativeLabels.includes(l)) && w.owner.id === w.ownerId && w.owner.getAttribute('aria-labelledby') === w.labelledBy && w.labels.every((l, i) => l.getAttribute('for') === w.labelFor[i])
    const associated = w.owner.isConnected && w.scope.contains(w.owner) && w.owner.getRootNode() === w.root && labelsCurrent && listsCurrent && exclusive && (!currentIds.length || currentIds.length === w.controlIds.length && currentIds.every(id => w.controlIds.includes(id))) && w.scope.isConnected && w.labels.every(l => l.isConnected && w.scope.contains(l)) && !Array.from(w.scope.querySelectorAll(fieldSelector)).some(e => e !== w.owner)
    if (!associated) w.revoked = true
    const closed = w.lists.length > 0 && w.lists.every(l => !l.isConnected || !visible(l)) && (!w.owner.isConnected || w.owner.getAttribute('aria-expanded') !== 'true')
    const invalid = w.scope.matches('[aria-invalid="true"]') || !!w.scope.querySelector('[aria-invalid="true"]') || w.owner.isConnected && facts(w.owner).valid === false
    const expected = norm(w.option)
    return { ref, option: w.option, source: 'labelled_field_display', committed: !!(!w.revoked && associated && closed && !invalid && !w.baseline.has(expected) && display(w).has(expected)) }
  })
}
