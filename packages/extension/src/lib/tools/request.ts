// Tool: request — HTTP request from the user's active tab origin (cookies
// included). Same-origin enforcement: the URL's origin must match the
// active tab's URL origin. The actual fetch runs in the top frame's
// content script.
//
// This is the highest-leverage new tool: when the LLM observes (via
// network_log) what API endpoint the UI hits, it can call this directly
// instead of clicking through. e.g. POST /apply rather than the whole
// 5-step UI dance.

import { sendToTop } from '../tab-message'
import { permanent } from '../tool-error'
import type { RequestParams, RequestResult } from '../../shared/protocol'
import type { RequestPayload } from '../../content-scripts/protocol'

/** Network calls can be heavier than DOM ops — give them a longer budget. */
const REQUEST_TIMEOUT_MS = 30_000

export async function request(
  tabId: number,
  params: RequestParams
): Promise<RequestResult> {
  // Same-origin guard.
  const tab = await chrome.tabs.get(tabId)
  const tabUrl = tab.url
  if (!tabUrl) throw new Error('active tab has no URL')
  let target: URL
  let pageOrigin: URL
  try {
    target = new URL(params.url, tabUrl)
    pageOrigin = new URL(tabUrl)
  } catch (e) {
    throw permanent(
      `invalid URL "${params.url}": ${e instanceof Error ? e.message : String(e)}`,
      'INVALID_URL'
    )
  }
  if (target.origin !== pageOrigin.origin) {
    throw permanent(
      `cross-origin not allowed. Active tab is ${pageOrigin.origin}, request is to ${target.origin}. Navigate to the target origin first.`,
      'CROSS_ORIGIN_DENIED'
    )
  }

  const data = await sendToTop<RequestPayload>(tabId, {
    op: 'request',
    url: target.toString(),
    method: params.method,
    headers: params.headers,
    body: typeof params.body === 'string' ? params.body : undefined,
    json: params.json
  }, REQUEST_TIMEOUT_MS)
  return {
    ok: true,
    status: data.status,
    response_ok: data.ok,
    headers: data.headers,
    body: data.body
  }
}
