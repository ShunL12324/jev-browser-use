// Tool: view — unified "see the page" call.
//
// Image capture is temporarily disabled — the screenshot pulled ~250KB on
// cold-opens where the text walker already had what the agent needed. The
// captureViewport() implementation is preserved below in case we want to
// flip it back on. To re-enable: uncomment the block below + the call site.

import { sendToTop } from '../tab-message'
import type { ViewParams, ViewResult } from '../../shared/protocol'
import type { ViewPayload } from '../../content-scripts/protocol'

export async function view(_tabId: number, _params: ViewParams): Promise<ViewResult> {
  const data = await sendToTop<ViewPayload>(_tabId, { op: 'view' })
  const base: ViewResult = { ok: true, ...data }
  // if (_params.image !== false) {
  //   base.image = await captureViewport(_tabId)
  // }
  return base
}

// async function captureViewport(tabId: number): Promise<ViewResult['image']> {
//   const tab = await chrome.tabs.get(tabId)
//   if (typeof tab.windowId !== 'number') return undefined
//   try {
//     const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
//       format: 'jpeg',
//       quality: 70
//     })
//     if (!dataUrl) return undefined
//     const commaIdx = dataUrl.indexOf(',')
//     const b64 = commaIdx >= 0 ? dataUrl.slice(commaIdx + 1) : dataUrl
//     const bytes = Math.floor((b64.length * 3) / 4)
//     return { data: b64, mime: 'image/jpeg', bytes }
//   } catch {
//     return undefined
//   }
// }
