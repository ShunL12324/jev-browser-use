// Recursive DOM walker — yields every Element under a root, piercing
// shadow DOM (open + closed via chrome.dom.openOrClosedShadowRoot) but
// NOT descending into iframes. Iframes have their own content script
// running in their own frame, which the SW addresses separately via
// chrome.tabs.sendMessage({frameId}).

import { shadowOf } from './shadow'

export function* walkElements(root: Document | ShadowRoot | Element): Generator<Element> {
  // For Document / ShadowRoot, start from their root element. For Element,
  // include self.
  const start: Element | null =
    root instanceof Element
      ? root
      : (root as Document | ShadowRoot).firstElementChild

  if (!start) return

  // Iterative DFS using an explicit stack to keep memory bounded on
  // deep trees. We push siblings + descendants in reverse so visitation
  // order matches source order.
  const stack: Element[] = [start]
  if (root instanceof Element) {
    // included as `start` above
  } else {
    // also walk any later siblings (e.g. document with both <head> and <body>)
    let next = start.nextElementSibling
    while (next) {
      stack.push(next)
      next = next.nextElementSibling
    }
    stack.reverse()
  }

  while (stack.length > 0) {
    const el = stack.pop()!
    yield el

    // Push children in reverse so we pop them in source order.
    const kids = el.children
    for (let i = kids.length - 1; i >= 0; i--) {
      stack.push(kids[i]!)
    }

    // Pierce shadow roots.
    const sr = shadowOf(el)
    if (sr) {
      const shadowKids = sr.children
      for (let i = shadowKids.length - 1; i >= 0; i--) {
        stack.push(shadowKids[i]!)
      }
    }
  }
}
