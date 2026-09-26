import { walkElements } from './dom-walker'
import { shadowOf } from './shadow'
import { isEffectivelyInert } from './visibility'

const parent = (el: Element): Element | null => el.assignedSlot ?? el.parentElement ?? (el.getRootNode() instanceof ShadowRoot ? (el.getRootNode() as ShadowRoot).host : null)
export function composedContains(container: Element, el: Element) {
  for (let node: Element | null = el; node; node = parent(node)) if (node === container) return true
  return false
}
function presented(el: Element) {
  const rect = el.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0 || isEffectivelyInert(el)) return false
  for (let node: Element | null = el; node; node = parent(node)) {
    const style = getComputedStyle(node)
    if (node.matches('[hidden],[aria-hidden="true"]') || style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0 || style.contentVisibility === 'hidden') return false
  }
  return true
}
export function activeModals(): Element[] {
  const elements = Array.from(walkElements(document))
  const native = elements.filter(isNativeModal)
  const top = native.length === 1 ? native[0] : topNativeModal(native)
  // With no trustworthy top-layer hit, retain all barriers. blockersFor()
  // treats multiple native barriers as unknown order and refuses all targets.
  const barriers = top ? [top] : native
  const aria = elements.filter(el => !isNativeModal(el) && el.matches('[role="dialog"][aria-modal="true"],[role="alertdialog"][aria-modal="true"],dialog[aria-modal="true"]') && presented(el))
  // An ARIA dialog behind the native top layer is inert too; it cannot block
  // controls inside the actual native modal. Nested ARIA dialogs still can.
  return [...barriers, ...aria.filter(el => !native.length || !!top && composedContains(top, el))]
}
const isNativeModal = (el: Element) => el instanceof HTMLDialogElement && el.matches(':modal')
function topNativeModal(native: Element[]) {
  if (!native.length) return null
  // If native dialogs are DOM-nested, the top one's entire flat subtree
  // escapes inertness: hitting the inner modal cannot prove opening order.
  if (native.some(a => native.some(b => a !== b && composedContains(a, b)))) return null
  const width = document.documentElement.clientWidth, height = document.documentElement.clientHeight
  if (!width || !height) return null
  const points = [[0, 0], [width / 2, height / 2], [width - 1, height - 1]]
  for (const el of native) {
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < width && r.top < height) points.push([Math.max(0, Math.min(width - 1, r.left + r.width / 2)), Math.max(0, Math.min(height - 1, r.top + r.height / 2))])
  }
  const hits = new Set<Element>()
  for (const [x, y] of points) {
    let hit = document.elementFromPoint(x!, y!)
    const seen = new Set<Element>()
    while (hit && !seen.has(hit)) {
      seen.add(hit)
      const inner = shadowOf(hit)?.elementFromPoint(x!, y!)
      if (!inner || inner === hit) break
      hit = inner
    }
    for (let el = hit; el; el = parent(el)) if (native.includes(el)) { hits.add(el); break }
  }
  // Inert lower layers cannot participate in hit-testing (HTML §6.3).
  // Never infer stacking from DOM order, focus, or an element's z-index.
  return hits.size === 1 ? [...hits][0]! : null
}
export function blockersFor(el: Element, active: Element[]) {
  if (active.filter(isNativeModal).length > 1) return active
  return active.filter(d => !composedContains(d, el))
}
