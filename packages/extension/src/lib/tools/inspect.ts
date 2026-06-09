// Tool: inspect — read multiple fields off a single ref in one round trip.
// Replaces the older get_text + get_attribute pair.
//
// Supported fields:
//   text, value, tag, role, name, checked, disabled, html, innerHtml,
//   <any attribute name>  (e.g. 'href', 'src', 'data-id', 'aria-pressed')

import { sendToFrame } from '../tab-message'
import { parseRef } from '../frames'
import type { InspectParams, InspectResult } from '../../shared/protocol'
import type { InspectPayload } from '../../content-scripts/protocol'

export async function inspect(
  tabId: number,
  params: InspectParams
): Promise<InspectResult> {
  const { frameId, localRef } = parseRef(params.ref)
  const data = await sendToFrame<InspectPayload>(tabId, frameId, {
    op: 'inspect',
    ref: localRef,
    fields: params.fields
  })
  return { ok: true, values: data.values }
}
