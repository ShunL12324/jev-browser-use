// SW-side helper that sends a CSRequest to a specific frame's content
// script and resolves with its CSResponse payload (or rejects on error).
//
// Wraps chrome.tabs.sendMessage(tabId, msg, {frameId}) — Chrome's frame
// routing crosses origins transparently because the same extension is
// installed in every frame.

import type { CSRequest, CSRequestEnvelope, CSResponse } from '../content-scripts/protocol'
import { createLogger } from './logger'
import { ToolFault, transient } from './tool-error'

const log = createLogger('tab-message')

const DEFAULT_TIMEOUT_MS = 30_000

export async function sendToFrame<T = unknown>(
  tabId: number,
  frameId: number,
  request: CSRequest,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<T> {
  const envelope: CSRequestEnvelope = { __quarry: true, ...request }

  const where = `tab=${tabId} frame=${frameId}`

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(transient(
        `content-script timeout after ${(timeoutMs / 1000).toFixed(1)}s (${where})`,
        'TIMEOUT'
      ))
    }, timeoutMs)

    // chrome.tabs.sendMessage uses a callback. We wrap manually instead of
    // relying on its returned promise because the latter swallows undefined
    // responses (e.g. when no listener answered).
    try {
      chrome.tabs.sendMessage(
        tabId,
        envelope,
        { frameId },
        (response: CSResponse<T> | undefined) => {
          clearTimeout(timer)
          const lastError = chrome.runtime.lastError
          if (lastError) {
            const errMsg = lastError.message ?? 'unknown error'
            // Bfcache race: the page entered Chrome's back/forward cache
            // (or got destroyed by a hard navigation) before the content
            // script's response could flush. In practice this means the
            // ACTION TOOK EFFECT (it's what triggered the navigation),
            // but we lost the result payload. Surface it as a permanent
            // fact so the LLM re-snapshots the new page instead of retrying
            // the same call on a now-stale ref.
            if (/back\/?forward[\s_-]?cache|message channel.*closed/i.test(errMsg)) {
              return reject(new ToolFault(
                `action triggered navigation; result payload lost as the page entered the back/forward cache (${where}). The action likely took effect — re-snapshot the new page.`,
                { code: 'NAVIGATION_RACE', short_term: false }
              ))
            }
            return reject(transient(
              `tab.sendMessage failed (${where}): ${errMsg}`,
              'SEND_MESSAGE_FAILED'
            ))
          }
          if (!response) {
            return reject(transient(
              `no response from content script (${where}). The tab may need a hard refresh (⌘+Shift+R) after the extension was reloaded.`,
              'NO_LISTENER'
            ))
          }
          if (!response.ok) {
            // Forward the content-script's structured error fields verbatim.
            // Default short_term = true (matches bare-Error semantics from
            // pre-Phase-1 throws).
            return reject(new ToolFault(response.message, {
              code: response.code,
              short_term: response.short_term ?? true
            }))
          }
          resolve(response.data)
        }
      )
    } catch (e) {
      clearTimeout(timer)
      log.warn(`sendToFrame threw for ${where}`, e)
      reject(e instanceof Error ? e : new Error(String(e)))
    }
  })
}

/** Sends to top frame (frameId 0). Convenience wrapper. */
export function sendToTop<T = unknown>(
  tabId: number,
  request: CSRequest,
  timeoutMs?: number
): Promise<T> {
  return sendToFrame<T>(tabId, 0, request, timeoutMs)
}
