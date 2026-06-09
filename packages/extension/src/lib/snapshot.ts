// Snapshot orchestrator.
//
// Fan a snapshot request out to every frame in the tab via
// `chrome.webNavigation.getAllFrames` + `chrome.tabs.sendMessage({frameId})`.
// Each frame's content script walks its own document (piercing shadow DOM
// but stopping at iframe boundaries — sub-frames answer separately).
// We prefix sub-frame refs with `fN:` so the agent can address them later
// for click/type/etc., and the SW knows which frame to route to.

import { getAllFrames, qualifyRef } from './frames'
import { sendToFrame } from './tab-message'
import { createLogger } from './logger'
import type { Interactable, SnapshotParams, SnapshotResult } from '../shared/protocol'
import type { SnapshotPayload } from '../content-scripts/protocol'

const log = createLogger('snapshot')

const FRAME_TIMEOUT_MS = 6_000

export async function snapshot(tabId: number, params: SnapshotParams = {}): Promise<SnapshotResult> {
  const t0 = performance.now()
  // No default cap — match view's "emit everything visible" behaviour so the
  // agent sees the full ref list after an action. An explicit `limit` is still
  // honoured if the agent passes one. The large finite sentinel survives
  // chrome.tabs.sendMessage's structured-clone transport cleanly.
  const NO_LIMIT = 1_000_000
  const limit = typeof params.limit === 'number' && Number.isFinite(params.limit)
    ? Math.max(1, Math.floor(params.limit))
    : NO_LIMIT

  const frames = await getAllFrames(tabId)
  if (frames.length === 0) {
    log.warn(`no frames for tab=${tabId}`)
    return { ok: true, url: '', title: '', interactables: [], total_interactables: 0 }
  }

  // Per-frame budget = limit. We could divide by frame count to be miserly,
  // but we don't know in advance which frame holds the interesting elements
  // (top frame? a deep iframe?). Each frame returns up to `limit`; we slice
  // the merged result at the end.
  const results = await Promise.allSettled(
    frames.map((f) =>
      sendToFrame<SnapshotPayload>(tabId, f.frameId, { op: 'snapshot', budget: limit }, FRAME_TIMEOUT_MS)
        .then((data) => ({ frameId: f.frameId, data }))
    )
  )

  const collected: Interactable[] = []
  let topUrl = ''
  let topTitle = ''
  let topAnswered = false

  for (const r of results) {
    if (r.status !== 'fulfilled') {
      log.debug('frame snapshot failed', r.reason)
      continue
    }
    const { frameId, data } = r.value
    if (frameId === 0) {
      topUrl = data.url
      topTitle = data.title
      topAnswered = true
    }
    for (const it of data.interactables) {
      collected.push({
        ...it,
        ref: qualifyRef(frameId, it.ref),
        frame_id: frameId === 0 ? undefined : `f${frameId}`
      })
    }
  }

  if (!topAnswered) {
    // Top frame didn't reply (e.g. content script not yet ready on a
    // brand-new tab). Pull url/title from tab info as a fallback.
    try {
      const tab = await chrome.tabs.get(tabId)
      topUrl = tab.url ?? ''
      topTitle = tab.title ?? ''
    } catch {
      /* ignore */
    }
  }

  const total = collected.length
  const interactables = total > limit ? collected.slice(0, limit) : collected

  const elapsed = (performance.now() - t0).toFixed(0)
  log.info(`snapshot complete: ${interactables.length}/${total} interactables across ${frames.length} frame(s) in ${elapsed}ms`, {
    url: topUrl,
    title: topTitle,
    limit
  })

  return { ok: true, url: topUrl, title: topTitle, interactables, total_interactables: total }
}
