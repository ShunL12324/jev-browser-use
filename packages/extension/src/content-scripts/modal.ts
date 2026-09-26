import { walkElements } from './dom-walker'

const parent = (el: Element): Element | null => el.assignedSlot ?? el.parentElement ?? (el.getRootNode() instanceof ShadowRoot ? (el.getRootNode() as ShadowRoot).host : null)
export function composedContains(container: Element, el: Element) {
  for (let node: Element | null = el; node; node = parent(node)) if (node === container) return true
  return false
}
function presented(el: Element) {
  const rect = el.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return false
  for (let node: Element | null = el; node; node = parent(node)) {
    const style = getComputedStyle(node)
    if (node.matches('[hidden],[inert],[aria-hidden="true"]') || style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0 || style.contentVisibility === 'hidden') return false
  }
  return true
}
export function activeModals(): Element[] {
  return Array.from(walkElements(document)).filter(el => {
    // Native top-layer modality remains a browser barrier even if author CSS
    // hides the dialog. A nonmodal dialog opened with show() is not a barrier.
    if (el instanceof HTMLDialogElement && el.matches(':modal')) return true
    return el.matches('[role="dialog"][aria-modal="true"],[role="alertdialog"][aria-modal="true"],dialog[aria-modal="true"]') && presented(el)
  })
}
