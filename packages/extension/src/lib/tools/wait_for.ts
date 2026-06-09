// Tool: wait_for — block until any of the requested conditions hold:
//   - text:           a substring appears in the top frame's body innerText
//   - refExists:      an element with the given ref reappears (frame-qualified)
//   - urlPattern:     current URL matches a regex
//   - requestPattern: an outgoing network request URL matches a regex
//                     (uses the network capture from lib/network.ts)
//
// If multiple conditions are given, the first to fire wins.
//
// SLEEP MODE: when no conditions are given, this degrades to a plain
// timeout sleep — LLMs sometimes need a brief defensive pause after an
// action they can't pin a specific signal to (e.g. "wait for the modal's
// fade-in animation to land"). Result returns `matched: 'timeout'` so the
// caller can tell sleep mode apart from a real condition hit.
// Capped at SLEEP_MAX_MS so a buggy call can't lock the agent for minutes.

import { sendToFrame } from '../tab-message'
import { parseRef } from '../frames'
import { waitForRequest } from '../network'
import type { WaitForParams, WaitForResult } from '../../shared/protocol'
import type { WaitForPayload } from '../../content-scripts/protocol'

/** Upper bound on plain-sleep mode. Real condition waits can go longer
 *  (they default to 10s, callers can override). The sleep cap is tight
 *  because "just pause" without a signal is almost always a code smell. */
const SLEEP_MAX_MS = 30_000

export async function waitFor(tabId: number, params: WaitForParams): Promise<WaitForResult> {
  const timeoutMs = params.timeoutMs ?? 10_000
  const t0 = performance.now()
  const racers: Array<Promise<WaitForResult>> = []

  // Content-script side conditions (text / ref / url).
  if (params.text || params.refExists || params.urlPattern) {
    let frameId = 0
    let refExists = params.refExists
    if (refExists) {
      const parsed = parseRef(refExists)
      frameId = parsed.frameId
      refExists = parsed.localRef
    }
    racers.push(
      sendToFrame<WaitForPayload>(
        tabId,
        frameId,
        {
          op: 'wait_for',
          text: params.text,
          refExists,
          urlPattern: params.urlPattern,
          timeoutMs
        },
        timeoutMs + 2_000
      ).then((data) => ({
        ok: true as const,
        matched: data.matched,
        elapsedMs: data.elapsedMs
      }))
    )
  }

  // Network condition — fed by the MAIN-world fetch/XHR patch.
  if (params.requestPattern) {
    racers.push(
      (async () => {
        await waitForRequest(tabId, params.requestPattern!, timeoutMs)
        return {
          ok: true as const,
          matched: 'request' as const,
          elapsedMs: Math.round(performance.now() - t0)
        }
      })()
    )
  }

  // No conditions = plain sleep. Cap defensively.
  if (racers.length === 0) {
    const sleepMs = Math.min(Math.max(timeoutMs, 0), SLEEP_MAX_MS)
    await new Promise((r) => setTimeout(r, sleepMs))
    return {
      ok: true,
      matched: 'timeout',
      elapsedMs: Math.round(performance.now() - t0)
    }
  }

  return Promise.race(racers)
}
