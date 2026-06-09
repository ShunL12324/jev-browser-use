// Shadow-root piercing. The extension-only `chrome.dom.openOrClosedShadowRoot`
// API returns the shadow root even when `{mode:'closed'}` — a regular page
// script gets `null` for closed shadows. This is what lets us walk into
// modern Web Components (Lit / Salesforce Lightning / SAP UI5) that the
// previous CDP-only snapshot couldn't see.
//
// Availability: Chrome 88+. We feature-detect once and fall back to
// `element.shadowRoot` (which only returns open roots).

// chrome.dom is an undocumented but stable extension API on Chrome 88+.
// We type it inline via `as any` since @types/chrome doesn't include it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const chromeDom = (chrome as any)?.dom as
  | { openOrClosedShadowRoot?: (element: Element) => ShadowRoot | null }
  | undefined

const piercer: ((el: Element) => ShadowRoot | null) | undefined =
  chromeDom?.openOrClosedShadowRoot?.bind?.(chromeDom)

/** Get the shadow root (open or closed) for an element, or null. */
export function shadowOf(el: Element): ShadowRoot | null {
  // Open shadow is cheap — try that first.
  if (el.shadowRoot) return el.shadowRoot
  if (piercer) {
    try {
      return piercer(el)
    } catch {
      return null
    }
  }
  return null
}
