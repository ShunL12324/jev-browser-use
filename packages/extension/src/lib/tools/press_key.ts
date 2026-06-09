// Tool: press_key — dispatched to the top frame's content script, which
// fires keydown/[keypress]/keyup on document.activeElement (falling back
// to document). For now we don't try to route to a sub-frame because
// keyboard focus is global to the top frame.

import { sendToTop } from '../tab-message'
import type { PressKeyParams, PressKeyResult } from '../../shared/protocol'
import type { PressKeyPayload } from '../../content-scripts/protocol'

export async function pressKey(
  tabId: number,
  params: PressKeyParams
): Promise<PressKeyResult> {
  const data = await sendToTop<PressKeyPayload>(tabId, {
    op: 'press_key',
    key: params.key,
    modifiers: params.modifiers
  })
  return { ok: true, key: data.key }
}
