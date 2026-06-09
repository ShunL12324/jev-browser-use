// Tool: get_cookie — read cookies for a URL (or for the active tab if no
// URL is given). Uses chrome.cookies in the SW directly; no content
// script involvement needed.
//
// Cookies marked HttpOnly ARE returned (the chrome.cookies API has access
// to them — this is what makes it useful for the agent to discover
// session ids and CSRF tokens that would otherwise be invisible to JS).

import type { GetCookieParams, GetCookieResult } from '../../shared/protocol'

export async function getCookie(
  tabId: number,
  params: GetCookieParams
): Promise<GetCookieResult> {
  let target = params.url
  if (!target) {
    const tab = await chrome.tabs.get(tabId)
    target = tab.url ?? ''
  }
  if (!target) {
    return { ok: true, cookies: [] }
  }
  const cookies = await chrome.cookies.getAll({ url: target })
  const filtered = params.name
    ? cookies.filter((c) => c.name === params.name)
    : cookies
  return {
    ok: true,
    cookies: filtered.map((c) => ({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: c.path,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite
    }))
  }
}
