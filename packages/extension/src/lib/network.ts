// Per-tab Network ring buffer.
//
// Entries are fed by the MAIN-world fetch/XHR patch in
// content-scripts/network-patch.ts: each patched request posts a NetEntry
// to the ISOLATED world peer, which forwards it to the service worker
// (chrome.runtime message type `cs:network`). The SW message handler
// (service-worker/index.ts) calls `appendEntry(tabId, entry)`.
//
// We keep only the most recent N entries per tab and drop the rest. Also
// exposes a waiter so wait_for(requestPattern) can subscribe.

import type { NetworkLogEntry } from '../shared/protocol'

const RING_CAP = 200

interface TabState {
  buf: NetworkLogEntry[]
  waiters: Array<{
    pattern: RegExp
    resolve: (e: NetworkLogEntry) => void
    reject: (e: Error) => void
    timer: number
  }>
}

const tabs = new Map<number, TabState>()

function getState(tabId: number): TabState {
  let s = tabs.get(tabId)
  if (!s) {
    s = { buf: [], waiters: [] }
    tabs.set(tabId, s)
  }
  return s
}

/** Called by the SW when a content script forwards a network entry. */
export function appendEntry(tabId: number, entry: NetworkLogEntry): void {
  const state = getState(tabId)
  state.buf.push(entry)
  if (state.buf.length > RING_CAP) state.buf.shift()
  // fire matching waiters
  for (let i = state.waiters.length - 1; i >= 0; i--) {
    const w = state.waiters[i]!
    if (w.pattern.test(entry.url)) {
      clearTimeout(w.timer)
      state.waiters.splice(i, 1)
      w.resolve(entry)
    }
  }
}

export function getEntries(
  tabId: number,
  opts: { limit?: number; sinceMs?: number } = {}
): NetworkLogEntry[] {
  const state = tabs.get(tabId)
  if (!state) return []
  let out = state.buf
  if (typeof opts.sinceMs === 'number') {
    const cutoff = Date.now() - opts.sinceMs
    out = out.filter((e) => e.ts >= cutoff)
  }
  if (typeof opts.limit === 'number') out = out.slice(-opts.limit)
  return out
}

export function waitForRequest(
  tabId: number,
  urlPattern: string,
  timeoutMs: number
): Promise<NetworkLogEntry> {
  return new Promise((resolve, reject) => {
    const state = getState(tabId)
    const pattern = new RegExp(urlPattern)
    // Check buf first (we may have just missed it)
    for (let i = state.buf.length - 1; i >= 0; i--) {
      if (pattern.test(state.buf[i]!.url)) return resolve(state.buf[i]!)
    }
    const timer = setTimeout(() => {
      const idx = state.waiters.findIndex((w) => w.timer === timer)
      if (idx >= 0) state.waiters.splice(idx, 1)
      reject(new Error(`wait_for_request timeout after ${(timeoutMs / 1000).toFixed(1)}s — no request matched /${urlPattern}/`))
    }, timeoutMs) as unknown as number
    state.waiters.push({ pattern, resolve, reject, timer })
  })
}

export function clearTab(tabId: number): void {
  tabs.delete(tabId)
}
